import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  HealthMonitor,
  createHealthMonitor,
  type HealthMetrics,
  type HealthCheckResult,
  DEFAULT_HEALTH_THRESHOLDS,
} from "../health.js";
import type { ResourceUsage, ResourceLimits } from "../agent-context.js";

const createTestMetrics = (overrides: Partial<HealthMetrics> = {}): HealthMetrics => ({
  agentId: "agent-1",
  state: "ready",
  usage: {
    inputTokens: 1000,
    outputTokens: 500,
    requestCount: 10,
    estimatedCostUSD: 0.05,
    currentMemoryMB: 100,
    activeRequests: 1,
    tokensThisMinute: 500,
    minuteWindowStart: new Date(),
  } as ResourceUsage,
  limits: {
    maxTokensPerRequest: 4096,
    tokensPerMinute: 100000,
    maxMemoryMB: 512,
    maxConcurrentRequests: 5,
    costBudgetUSD: 10,
  } as ResourceLimits,
  uptimeSeconds: 3600,
  idleSeconds: 10,
  errorCountLastHour: 0,
  transitionCountLastHour: 5,
  avgResponseTimeMs: 200,
  successRateLastHour: 1.0,
  ...overrides,
});

describe("HealthMonitor", () => {
  let monitor: HealthMonitor;

  beforeEach(() => {
    vi.useFakeTimers();
    monitor = new HealthMonitor();
  });

  afterEach(() => {
    monitor.stop();
    vi.useRealTimers();
  });

  describe("check", () => {
    it("should return healthy status for normal metrics", () => {
      const result = monitor.check(createTestMetrics());

      expect(result.status).toBe("healthy");
      expect(result.checks.every((c) => c.passed)).toBe(true);
    });

    it("should check state", () => {
      const readyResult = monitor.check(createTestMetrics({ state: "ready" }));
      expect(readyResult.checks.find((c) => c.name === "state")?.passed).toBe(true);

      const errorResult = monitor.check(createTestMetrics({ state: "error" }));
      expect(errorResult.checks.find((c) => c.name === "state")?.passed).toBe(false);

      const terminatedResult = monitor.check(createTestMetrics({ state: "terminated" }));
      expect(terminatedResult.checks.find((c) => c.name === "state")?.passed).toBe(false);
    });

    it("should check token usage", () => {
      const normalResult = monitor.check(createTestMetrics({
        usage: {
          ...createTestMetrics().usage,
          tokensThisMinute: 50000, // 50% of limit
        },
      }));
      expect(normalResult.checks.find((c) => c.name === "token_usage")?.passed).toBe(true);

      const warningResult = monitor.check(createTestMetrics({
        usage: {
          ...createTestMetrics().usage,
          tokensThisMinute: 75000, // 75% of limit (above warning threshold)
        },
      }));
      expect(warningResult.checks.find((c) => c.name === "token_usage")?.passed).toBe(false);
      expect(warningResult.checks.find((c) => c.name === "token_usage")?.severity).toBe("warning");

      const criticalResult = monitor.check(createTestMetrics({
        usage: {
          ...createTestMetrics().usage,
          tokensThisMinute: 95000, // 95% of limit (above critical threshold)
        },
      }));
      expect(criticalResult.checks.find((c) => c.name === "token_usage")?.severity).toBe("critical");
    });

    it("should check memory usage", () => {
      const normalResult = monitor.check(createTestMetrics({
        usage: {
          ...createTestMetrics().usage,
          currentMemoryMB: 200, // ~40% of 512MB limit
        },
      }));
      expect(normalResult.checks.find((c) => c.name === "memory_usage")?.passed).toBe(true);

      const warningResult = monitor.check(createTestMetrics({
        usage: {
          ...createTestMetrics().usage,
          currentMemoryMB: 400, // ~78% of 512MB limit
        },
      }));
      expect(warningResult.checks.find((c) => c.name === "memory_usage")?.passed).toBe(false);
    });

    it("should check cost budget", () => {
      const normalResult = monitor.check(createTestMetrics({
        usage: {
          ...createTestMetrics().usage,
          estimatedCostUSD: 5, // 50% of $10 limit
        },
      }));
      expect(normalResult.checks.find((c) => c.name === "cost_budget")?.passed).toBe(true);

      const warningResult = monitor.check(createTestMetrics({
        usage: {
          ...createTestMetrics().usage,
          estimatedCostUSD: 8.5, // 85% of $10 limit
        },
      }));
      expect(warningResult.checks.find((c) => c.name === "cost_budget")?.passed).toBe(false);
    });

    it("should check idle time", () => {
      const activeResult = monitor.check(createTestMetrics({ idleSeconds: 60 }));
      expect(activeResult.checks.find((c) => c.name === "idle_time")?.passed).toBe(true);

      const warningResult = monitor.check(createTestMetrics({
        idleSeconds: DEFAULT_HEALTH_THRESHOLDS.maxIdleTimeWarning + 60,
      }));
      expect(warningResult.checks.find((c) => c.name === "idle_time")?.passed).toBe(false);
    });

    it("should check error rate", () => {
      const normalResult = monitor.check(createTestMetrics({
        errorCountLastHour: 1,
        successRateLastHour: 0.95,
      }));
      expect(normalResult.checks.find((c) => c.name === "error_rate")?.passed).toBe(true);

      const warningResult = monitor.check(createTestMetrics({
        errorCountLastHour: 5,
        successRateLastHour: 0.85, // 15% error rate
      }));
      expect(warningResult.checks.find((c) => c.name === "error_rate")?.passed).toBe(false);

      const criticalResult = monitor.check(createTestMetrics({
        errorCountLastHour: 10,
        successRateLastHour: 0.6, // 40% error rate
      }));
      expect(criticalResult.checks.find((c) => c.name === "error_rate")?.severity).toBe("critical");
    });

    it("should include recommendations for failed checks", () => {
      const result = monitor.check(createTestMetrics({
        usage: {
          ...createTestMetrics().usage,
          tokensThisMinute: 95000,
        },
      }));

      expect(result.recommendations.length).toBeGreaterThan(0);
    });

    it("should record duration", () => {
      const result = monitor.check(createTestMetrics());
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("status determination", () => {
    it("should return healthy when all checks pass", () => {
      const result = monitor.check(createTestMetrics());
      expect(result.status).toBe("healthy");
    });

    it("should return degraded when there are warnings", () => {
      const result = monitor.check(createTestMetrics({
        idleSeconds: DEFAULT_HEALTH_THRESHOLDS.maxIdleTimeWarning + 60,
      }));
      expect(result.status).toBe("degraded");
    });

    it("should return unhealthy when there are errors", () => {
      const result = monitor.check(createTestMetrics({ state: "error" }));
      expect(result.status).toBe("unhealthy");
    });

    it("should return critical when there are critical issues", () => {
      const result = monitor.check(createTestMetrics({ state: "terminated" }));
      expect(result.status).toBe("critical");
    });
  });

  describe("getStatus", () => {
    it("should return undefined for unknown agent", () => {
      expect(monitor.getStatus("unknown")).toBeUndefined();
    });

    it("should return status after check", () => {
      monitor.check(createTestMetrics());
      expect(monitor.getStatus("agent-1")).toBe("healthy");
    });
  });

  describe("getHistory", () => {
    it("should return empty array for unknown agent", () => {
      expect(monitor.getHistory("unknown")).toEqual([]);
    });

    it("should return history after checks", () => {
      monitor.check(createTestMetrics());
      monitor.check(createTestMetrics());

      const history = monitor.getHistory("agent-1");
      expect(history).toHaveLength(2);
    });

    it("should limit history", () => {
      for (let i = 0; i < 5; i++) {
        monitor.check(createTestMetrics());
      }

      const history = monitor.getHistory("agent-1", 3);
      expect(history).toHaveLength(3);
    });
  });

  describe("getLastResult", () => {
    it("should return undefined for unknown agent", () => {
      expect(monitor.getLastResult("unknown")).toBeUndefined();
    });

    it("should return last result", () => {
      monitor.check(createTestMetrics({ idleSeconds: 10 }));
      monitor.check(createTestMetrics({ idleSeconds: 100 }));

      const lastResult = monitor.getLastResult("agent-1");
      expect(lastResult?.checks.find((c) => c.name === "idle_time")?.value).toBe(100);
    });
  });

  describe("onEvent", () => {
    it("should emit check events", () => {
      const listener = vi.fn();
      monitor.onEvent(listener);

      monitor.check(createTestMetrics());

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "check",
          agentId: "agent-1",
        })
      );
    });

    it("should emit status change events", () => {
      const listener = vi.fn();
      monitor.onEvent(listener);

      // First check - establishes baseline
      monitor.check(createTestMetrics());

      // Second check with different status
      monitor.check(createTestMetrics({ state: "error" }));

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "status_change",
          previousStatus: "healthy",
          newStatus: "unhealthy",
        })
      );
    });

    it("should return unsubscribe function", () => {
      const listener = vi.fn();
      const unsubscribe = monitor.onEvent(listener);

      monitor.check(createTestMetrics());
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();

      monitor.check(createTestMetrics());
      expect(listener).toHaveBeenCalledTimes(1); // Still 1
    });
  });

  describe("clearHistory", () => {
    it("should clear history for agent", () => {
      monitor.check(createTestMetrics());
      monitor.clearHistory("agent-1");

      expect(monitor.getHistory("agent-1")).toHaveLength(0);
      expect(monitor.getStatus("agent-1")).toBeUndefined();
    });
  });

  describe("clearAllHistory", () => {
    it("should clear all history", () => {
      monitor.check(createTestMetrics({ agentId: "agent-1" }));
      monitor.check(createTestMetrics({ agentId: "agent-2" }));

      monitor.clearAllHistory();

      expect(monitor.getHistory("agent-1")).toHaveLength(0);
      expect(monitor.getHistory("agent-2")).toHaveLength(0);
    });
  });

  describe("start and stop", () => {
    it("should start periodic checks", () => {
      const metricsProvider = vi.fn().mockReturnValue(createTestMetrics());
      monitor.setMetricsProvider(metricsProvider);

      monitor.start(() => ["agent-1"]);

      // Advance timers
      vi.advanceTimersByTime(60000); // 2 intervals (30s each)

      expect(metricsProvider).toHaveBeenCalled();
    });

    it("should stop periodic checks", () => {
      const metricsProvider = vi.fn().mockReturnValue(createTestMetrics());
      monitor.setMetricsProvider(metricsProvider);

      monitor.start(() => ["agent-1"]);
      monitor.stop();

      const callCount = metricsProvider.mock.calls.length;

      vi.advanceTimersByTime(60000);

      expect(metricsProvider.mock.calls.length).toBe(callCount);
    });
  });
});

describe("createHealthMonitor", () => {
  it("should create monitor with default config", () => {
    const monitor = createHealthMonitor();
    expect(monitor).toBeInstanceOf(HealthMonitor);
  });

  it("should create monitor with custom config", () => {
    const monitor = createHealthMonitor({
      checkIntervalMs: 60000,
      thresholds: {
        ...DEFAULT_HEALTH_THRESHOLDS,
        tokenUsageWarning: 0.8,
      },
    });
    expect(monitor).toBeInstanceOf(HealthMonitor);
  });
});

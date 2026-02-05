// Health — agent health monitoring
// Periodic health checks and anomaly detection

import type { AgentId, ResourceLimits, ResourceUsage } from "./agent-context.js";
import type { AgentState } from "./state-machine.js";

/** Health check result */
export interface HealthCheckResult {
  /** Agent ID */
  agentId: AgentId;
  /** Overall health status */
  status: HealthStatus;
  /** Individual check results */
  checks: HealthCheck[];
  /** Timestamp of check */
  timestamp: Date;
  /** Time taken for health check in ms */
  durationMs: number;
  /** Recommendations for improving health */
  recommendations: string[];
}

/** Overall health status */
export type HealthStatus = "healthy" | "degraded" | "unhealthy" | "critical";

/** Individual health check */
export interface HealthCheck {
  /** Check name */
  name: string;
  /** Check passed */
  passed: boolean;
  /** Check details/message */
  message: string;
  /** Severity if failed */
  severity?: "warning" | "error" | "critical";
  /** Metric value (if applicable) */
  value?: number;
  /** Threshold (if applicable) */
  threshold?: number;
}

/** Health metrics for trend analysis */
export interface HealthMetrics {
  /** Agent ID */
  agentId: AgentId;
  /** Current state */
  state: AgentState;
  /** Resource usage */
  usage: ResourceUsage;
  /** Limits */
  limits: ResourceLimits;
  /** Uptime in seconds */
  uptimeSeconds: number;
  /** Time since last activity in seconds */
  idleSeconds: number;
  /** Error count in last hour */
  errorCountLastHour: number;
  /** State transition count in last hour */
  transitionCountLastHour: number;
  /** Average response time in last hour (ms) */
  avgResponseTimeMs: number;
  /** Success rate in last hour (0-1) */
  successRateLastHour: number;
}

/** Health check thresholds */
export interface HealthThresholds {
  /** Token usage warning threshold (0-1 of limit) */
  tokenUsageWarning: number;
  /** Token usage critical threshold (0-1 of limit) */
  tokenUsageCritical: number;
  /** Memory usage warning threshold (0-1 of limit) */
  memoryUsageWarning: number;
  /** Memory usage critical threshold (0-1 of limit) */
  memoryUsageCritical: number;
  /** Cost budget warning threshold (0-1 of limit) */
  costBudgetWarning: number;
  /** Cost budget critical threshold (0-1 of limit) */
  costBudgetCritical: number;
  /** Max idle time before warning (seconds) */
  maxIdleTimeWarning: number;
  /** Max idle time before unhealthy (seconds) */
  maxIdleTimeCritical: number;
  /** Error rate warning threshold (0-1) */
  errorRateWarning: number;
  /** Error rate critical threshold (0-1) */
  errorRateCritical: number;
  /** Max consecutive errors before critical */
  maxConsecutiveErrors: number;
}

/** Default health thresholds */
export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = {
  tokenUsageWarning: 0.7,
  tokenUsageCritical: 0.9,
  memoryUsageWarning: 0.7,
  memoryUsageCritical: 0.9,
  costBudgetWarning: 0.8,
  costBudgetCritical: 0.95,
  maxIdleTimeWarning: 300, // 5 minutes
  maxIdleTimeCritical: 3600, // 1 hour
  errorRateWarning: 0.1,
  errorRateCritical: 0.3,
  maxConsecutiveErrors: 5,
};

/** Health monitor configuration */
export interface HealthMonitorConfig {
  /** Check interval in ms */
  checkIntervalMs: number;
  /** Health thresholds */
  thresholds: HealthThresholds;
  /** Max history entries to keep per agent */
  maxHistorySize: number;
  /** Enable anomaly detection */
  enableAnomalyDetection: boolean;
}

/** Default health monitor configuration */
export const DEFAULT_HEALTH_MONITOR_CONFIG: HealthMonitorConfig = {
  checkIntervalMs: 30000, // 30 seconds
  thresholds: DEFAULT_HEALTH_THRESHOLDS,
  maxHistorySize: 1000,
  enableAnomalyDetection: true,
};

/** Listener for health events */
export type HealthEventListener = (event: HealthEvent) => void;

/** Health event */
export interface HealthEvent {
  type: "check" | "status_change" | "anomaly";
  agentId: AgentId;
  timestamp: Date;
  result?: HealthCheckResult;
  previousStatus?: HealthStatus;
  newStatus?: HealthStatus;
  anomaly?: AnomalyDetection;
}

/** Anomaly detection result */
export interface AnomalyDetection {
  type: "spike" | "drop" | "trend" | "pattern";
  metric: string;
  description: string;
  severity: "low" | "medium" | "high";
  value: number;
  expectedRange: { min: number; max: number };
}

/**
 * Health monitor for tracking agent health.
 * Provides periodic health checks and anomaly detection.
 */
export class HealthMonitor {
  private readonly config: HealthMonitorConfig;
  private readonly history: Map<AgentId, HealthCheckResult[]> = new Map();
  private readonly currentStatus: Map<AgentId, HealthStatus> = new Map();
  private readonly listeners: HealthEventListener[] = [];
  private checkTimer: NodeJS.Timeout | null = null;
  private metricsProvider: ((agentId: AgentId) => HealthMetrics | null) | null = null;

  constructor(config: Partial<HealthMonitorConfig> = {}) {
    this.config = {
      ...DEFAULT_HEALTH_MONITOR_CONFIG,
      ...config,
      thresholds: {
        ...DEFAULT_HEALTH_THRESHOLDS,
        ...config.thresholds,
      },
    };
  }

  /** Set metrics provider function */
  setMetricsProvider(provider: (agentId: AgentId) => HealthMetrics | null): void {
    this.metricsProvider = provider;
  }

  /** Perform health check for an agent */
  check(metrics: HealthMetrics): HealthCheckResult {
    const startTime = Date.now();
    const checks: HealthCheck[] = [];
    const recommendations: string[] = [];
    const { thresholds } = this.config;

    // Check state
    const stateCheck = this.checkState(metrics.state);
    checks.push(stateCheck);
    if (!stateCheck.passed && stateCheck.message) {
      recommendations.push(`Consider recovering agent from ${metrics.state} state`);
    }

    // Check token usage
    const tokenRatio =
      metrics.limits.tokensPerMinute > 0
        ? metrics.usage.tokensThisMinute / metrics.limits.tokensPerMinute
        : 0;

    if (tokenRatio >= thresholds.tokenUsageCritical) {
      checks.push({
        name: "token_usage",
        passed: false,
        message: `Token usage critical: ${(tokenRatio * 100).toFixed(1)}% of limit`,
        severity: "critical",
        value: tokenRatio,
        threshold: thresholds.tokenUsageCritical,
      });
      recommendations.push("Reduce request frequency or increase token limit");
    } else if (tokenRatio >= thresholds.tokenUsageWarning) {
      checks.push({
        name: "token_usage",
        passed: false,
        message: `Token usage high: ${(tokenRatio * 100).toFixed(1)}% of limit`,
        severity: "warning",
        value: tokenRatio,
        threshold: thresholds.tokenUsageWarning,
      });
    } else {
      checks.push({
        name: "token_usage",
        passed: true,
        message: `Token usage normal: ${(tokenRatio * 100).toFixed(1)}%`,
        value: tokenRatio,
      });
    }

    // Check memory usage
    const memoryRatio =
      metrics.limits.maxMemoryMB > 0
        ? metrics.usage.currentMemoryMB / metrics.limits.maxMemoryMB
        : 0;

    if (memoryRatio >= thresholds.memoryUsageCritical) {
      checks.push({
        name: "memory_usage",
        passed: false,
        message: `Memory usage critical: ${(memoryRatio * 100).toFixed(1)}% of limit`,
        severity: "critical",
        value: memoryRatio,
        threshold: thresholds.memoryUsageCritical,
      });
      recommendations.push("Increase memory limit or optimize memory usage");
    } else if (memoryRatio >= thresholds.memoryUsageWarning) {
      checks.push({
        name: "memory_usage",
        passed: false,
        message: `Memory usage high: ${(memoryRatio * 100).toFixed(1)}% of limit`,
        severity: "warning",
        value: memoryRatio,
        threshold: thresholds.memoryUsageWarning,
      });
    } else {
      checks.push({
        name: "memory_usage",
        passed: true,
        message: `Memory usage normal: ${(memoryRatio * 100).toFixed(1)}%`,
        value: memoryRatio,
      });
    }

    // Check cost budget
    if (metrics.limits.costBudgetUSD > 0) {
      const costRatio = metrics.usage.estimatedCostUSD / metrics.limits.costBudgetUSD;

      if (costRatio >= thresholds.costBudgetCritical) {
        checks.push({
          name: "cost_budget",
          passed: false,
          message: `Cost budget critical: ${(costRatio * 100).toFixed(1)}% used`,
          severity: "critical",
          value: costRatio,
          threshold: thresholds.costBudgetCritical,
        });
        recommendations.push("Increase budget or reduce usage");
      } else if (costRatio >= thresholds.costBudgetWarning) {
        checks.push({
          name: "cost_budget",
          passed: false,
          message: `Cost budget warning: ${(costRatio * 100).toFixed(1)}% used`,
          severity: "warning",
          value: costRatio,
          threshold: thresholds.costBudgetWarning,
        });
      } else {
        checks.push({
          name: "cost_budget",
          passed: true,
          message: `Cost budget OK: ${(costRatio * 100).toFixed(1)}% used`,
          value: costRatio,
        });
      }
    }

    // Check idle time
    if (metrics.idleSeconds > thresholds.maxIdleTimeCritical) {
      checks.push({
        name: "idle_time",
        passed: false,
        message: `Agent idle for ${formatDuration(metrics.idleSeconds)}`,
        severity: "warning",
        value: metrics.idleSeconds,
        threshold: thresholds.maxIdleTimeCritical,
      });
      recommendations.push("Consider pausing or terminating idle agent");
    } else if (metrics.idleSeconds > thresholds.maxIdleTimeWarning) {
      checks.push({
        name: "idle_time",
        passed: false,
        message: `Agent idle for ${formatDuration(metrics.idleSeconds)}`,
        severity: "warning",
        value: metrics.idleSeconds,
        threshold: thresholds.maxIdleTimeWarning,
      });
    } else {
      checks.push({
        name: "idle_time",
        passed: true,
        message: `Agent active (idle ${formatDuration(metrics.idleSeconds)})`,
        value: metrics.idleSeconds,
      });
    }

    // Check error rate
    if (metrics.errorCountLastHour > 0 && metrics.usage.requestCount > 0) {
      const errorRate = 1 - metrics.successRateLastHour;

      if (errorRate >= thresholds.errorRateCritical) {
        checks.push({
          name: "error_rate",
          passed: false,
          message: `Error rate critical: ${(errorRate * 100).toFixed(1)}%`,
          severity: "critical",
          value: errorRate,
          threshold: thresholds.errorRateCritical,
        });
        recommendations.push("Investigate errors and improve error handling");
      } else if (errorRate >= thresholds.errorRateWarning) {
        checks.push({
          name: "error_rate",
          passed: false,
          message: `Error rate elevated: ${(errorRate * 100).toFixed(1)}%`,
          severity: "warning",
          value: errorRate,
          threshold: thresholds.errorRateWarning,
        });
      } else {
        checks.push({
          name: "error_rate",
          passed: true,
          message: `Error rate OK: ${(errorRate * 100).toFixed(1)}%`,
          value: errorRate,
        });
      }
    } else {
      checks.push({
        name: "error_rate",
        passed: true,
        message: "No errors recorded",
        value: 0,
      });
    }

    // Determine overall status
    const status = this.determineStatus(checks);

    const result: HealthCheckResult = {
      agentId: metrics.agentId,
      status,
      checks,
      timestamp: new Date(),
      durationMs: Date.now() - startTime,
      recommendations,
    };

    // Update history
    this.recordResult(metrics.agentId, result);

    // Emit event
    this.emitEvent({
      type: "check",
      agentId: metrics.agentId,
      timestamp: result.timestamp,
      result,
    });

    // Check for status change
    const previousStatus = this.currentStatus.get(metrics.agentId);
    if (previousStatus && previousStatus !== status) {
      this.emitEvent({
        type: "status_change",
        agentId: metrics.agentId,
        timestamp: result.timestamp,
        previousStatus,
        newStatus: status,
      });
    }
    this.currentStatus.set(metrics.agentId, status);

    // Run anomaly detection
    if (this.config.enableAnomalyDetection) {
      const anomaly = this.detectAnomaly(metrics);
      if (anomaly) {
        this.emitEvent({
          type: "anomaly",
          agentId: metrics.agentId,
          timestamp: new Date(),
          anomaly,
        });
      }
    }

    return result;
  }

  /** Start periodic health checks */
  start(agentIds: () => AgentId[]): void {
    if (this.checkTimer) return;

    this.checkTimer = setInterval(() => {
      if (!this.metricsProvider) return;

      for (const agentId of agentIds()) {
        const metrics = this.metricsProvider(agentId);
        if (metrics) {
          this.check(metrics);
        }
      }
    }, this.config.checkIntervalMs);
  }

  /** Stop periodic health checks */
  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  /** Get current status for an agent */
  getStatus(agentId: AgentId): HealthStatus | undefined {
    return this.currentStatus.get(agentId);
  }

  /** Get health history for an agent */
  getHistory(agentId: AgentId, limit?: number): HealthCheckResult[] {
    const history = this.history.get(agentId) ?? [];
    return limit ? history.slice(-limit) : history;
  }

  /** Get last health check result for an agent */
  getLastResult(agentId: AgentId): HealthCheckResult | undefined {
    const history = this.history.get(agentId);
    return history?.[history.length - 1];
  }

  /** Register event listener */
  onEvent(listener: HealthEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index > -1) {
        this.listeners.splice(index, 1);
      }
    };
  }

  /** Clear history for an agent */
  clearHistory(agentId: AgentId): void {
    this.history.delete(agentId);
    this.currentStatus.delete(agentId);
  }

  /** Clear all history */
  clearAllHistory(): void {
    this.history.clear();
    this.currentStatus.clear();
  }

  /** Check agent state */
  private checkState(state: AgentState): HealthCheck {
    switch (state) {
      case "ready":
      case "running":
        return {
          name: "state",
          passed: true,
          message: `Agent state: ${state}`,
        };
      case "initializing":
      case "paused":
        return {
          name: "state",
          passed: true,
          message: `Agent state: ${state}`,
          severity: "warning",
        };
      case "error":
        return {
          name: "state",
          passed: false,
          message: "Agent is in error state",
          severity: "error",
        };
      case "terminated":
        return {
          name: "state",
          passed: false,
          message: "Agent is terminated",
          severity: "critical",
        };
      case "created":
        return {
          name: "state",
          passed: false,
          message: "Agent not initialized",
          severity: "warning",
        };
    }
  }

  /** Determine overall status from checks */
  private determineStatus(checks: HealthCheck[]): HealthStatus {
    let hasCritical = false;
    let hasError = false;
    let hasWarning = false;

    for (const check of checks) {
      if (!check.passed) {
        switch (check.severity) {
          case "critical":
            hasCritical = true;
            break;
          case "error":
            hasError = true;
            break;
          case "warning":
            hasWarning = true;
            break;
        }
      }
    }

    if (hasCritical) return "critical";
    if (hasError) return "unhealthy";
    if (hasWarning) return "degraded";
    return "healthy";
  }

  /** Record health check result */
  private recordResult(agentId: AgentId, result: HealthCheckResult): void {
    let history = this.history.get(agentId);
    if (!history) {
      history = [];
      this.history.set(agentId, history);
    }

    history.push(result);

    // Trim history
    while (history.length > this.config.maxHistorySize) {
      history.shift();
    }
  }

  /** Emit health event */
  private emitEvent(event: HealthEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Don't crash on listener errors
      }
    }
  }

  /** Simple anomaly detection based on historical trends */
  private detectAnomaly(metrics: HealthMetrics): AnomalyDetection | null {
    const history = this.history.get(metrics.agentId);
    if (!history || history.length < 10) return null;

    // Get last 10 token usage values
    const recentTokenUsage: number[] = [];
    for (const result of history.slice(-10)) {
      const tokenCheck = result.checks.find((c) => c.name === "token_usage");
      if (tokenCheck?.value !== undefined) {
        recentTokenUsage.push(tokenCheck.value);
      }
    }

    if (recentTokenUsage.length < 5) return null;

    // Calculate mean and standard deviation
    const mean = recentTokenUsage.reduce((a, b) => a + b, 0) / recentTokenUsage.length;
    const variance =
      recentTokenUsage.reduce((a, b) => a + (b - mean) ** 2, 0) / recentTokenUsage.length;
    const stdDev = Math.sqrt(variance);

    // Current value
    const currentRatio =
      metrics.limits.tokensPerMinute > 0
        ? metrics.usage.tokensThisMinute / metrics.limits.tokensPerMinute
        : 0;

    // Check for spike (> 2 standard deviations from mean)
    if (stdDev > 0 && Math.abs(currentRatio - mean) > 2 * stdDev) {
      const isSpikeUp = currentRatio > mean;
      return {
        type: isSpikeUp ? "spike" : "drop",
        metric: "token_usage",
        description: isSpikeUp
          ? "Unusual spike in token usage detected"
          : "Unusual drop in token usage detected",
        severity: "medium",
        value: currentRatio,
        expectedRange: {
          min: Math.max(0, mean - 2 * stdDev),
          max: mean + 2 * stdDev,
        },
      };
    }

    return null;
  }
}

/** Format duration in human-readable format */
function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)}m`;
  }
  return `${(seconds / 3600).toFixed(1)}h`;
}

/**
 * Create a health monitor with default configuration.
 */
export function createHealthMonitor(config?: Partial<HealthMonitorConfig>): HealthMonitor {
  return new HealthMonitor(config);
}

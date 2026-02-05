import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ComponentHealth,
  type HealthChecker,
  type HealthManager,
  createHealthManager,
  createSimpleHealthChecker,
} from "../health.js";

describe("HealthManager", () => {
  let manager: HealthManager;

  beforeEach(() => {
    manager = createHealthManager();
  });

  afterEach(() => {
    manager.stopPeriodicChecks();
  });

  describe("register/unregister", () => {
    it("should register a health checker", () => {
      const checker: HealthChecker = async () => ({
        name: "test",
        healthy: true,
        latencyMs: 1,
        lastCheck: new Date(),
      });

      manager.register("test", checker);
      // No direct way to check, but checkComponent should work
    });

    it("should unregister a health checker", async () => {
      const checker: HealthChecker = async () => ({
        name: "test",
        healthy: true,
        latencyMs: 1,
        lastCheck: new Date(),
      });

      manager.register("test", checker);
      manager.unregister("test");

      const result = await manager.checkComponent("test");
      expect(result).toBeNull();
    });
  });

  describe("checkComponent", () => {
    it("should return null for unknown component", async () => {
      const result = await manager.checkComponent("unknown");
      expect(result).toBeNull();
    });

    it("should check a registered component", async () => {
      const checker: HealthChecker = async () => ({
        name: "test",
        healthy: true,
        latencyMs: 5,
        lastCheck: new Date(),
      });

      manager.register("test", checker);
      const result = await manager.checkComponent("test");

      expect(result).not.toBeNull();
      expect(result?.name).toBe("test");
      expect(result?.healthy).toBe(true);
    });

    it("should handle checker timeout", async () => {
      const slowChecker: HealthChecker = async () => {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return {
          name: "slow",
          healthy: true,
          latencyMs: 1000,
          lastCheck: new Date(),
        };
      };

      manager.register("slow", slowChecker);
      const result = await manager.checkComponent("slow", { timeoutMs: 50 });

      expect(result).not.toBeNull();
      expect(result?.healthy).toBe(false);
      expect(result?.error).toContain("timed out");
    });

    it("should handle checker errors", async () => {
      const failingChecker: HealthChecker = async () => {
        throw new Error("Checker failed");
      };

      manager.register("failing", failingChecker);
      const result = await manager.checkComponent("failing");

      expect(result).not.toBeNull();
      expect(result?.healthy).toBe(false);
      expect(result?.error).toBe("Checker failed");
    });
  });

  describe("checkAll", () => {
    it("should return healthy status when all components are healthy", async () => {
      manager.register("comp1", async () => ({
        name: "comp1",
        healthy: true,
        latencyMs: 1,
        lastCheck: new Date(),
      }));

      manager.register("comp2", async () => ({
        name: "comp2",
        healthy: true,
        latencyMs: 2,
        lastCheck: new Date(),
      }));

      const health = await manager.checkAll();

      expect(health.status).toBe("healthy");
      expect(health.components).toHaveLength(2);
      expect(health.uptimeSeconds).toBeGreaterThanOrEqual(0);
      expect(health.memory).toBeDefined();
    });

    it("should return degraded status when some components are unhealthy", async () => {
      manager.register("healthy", async () => ({
        name: "healthy",
        healthy: true,
        latencyMs: 1,
        lastCheck: new Date(),
      }));

      manager.register("unhealthy", async () => ({
        name: "unhealthy",
        healthy: false,
        latencyMs: 1,
        error: "Not working",
        lastCheck: new Date(),
      }));

      const health = await manager.checkAll();

      expect(health.status).toBe("degraded");
    });

    it("should return unhealthy status when all components are unhealthy", async () => {
      manager.register("bad1", async () => ({
        name: "bad1",
        healthy: false,
        latencyMs: 1,
        error: "Error 1",
        lastCheck: new Date(),
      }));

      manager.register("bad2", async () => ({
        name: "bad2",
        healthy: false,
        latencyMs: 1,
        error: "Error 2",
        lastCheck: new Date(),
      }));

      const health = await manager.checkAll();

      expect(health.status).toBe("unhealthy");
    });

    it("should include memory stats", async () => {
      const health = await manager.checkAll();

      expect(health.memory.heapUsedMB).toBeGreaterThan(0);
      expect(health.memory.heapTotalMB).toBeGreaterThan(0);
      expect(health.memory.rssMB).toBeGreaterThan(0);
      expect(health.memory.percentUsed).toBeGreaterThan(0);
      expect(health.memory.percentUsed).toBeLessThanOrEqual(100);
    });

    it("should run checks in parallel", async () => {
      const startTimes: number[] = [];

      manager.register("slow1", async () => {
        startTimes.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {
          name: "slow1",
          healthy: true,
          latencyMs: 50,
          lastCheck: new Date(),
        };
      });

      manager.register("slow2", async () => {
        startTimes.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {
          name: "slow2",
          healthy: true,
          latencyMs: 50,
          lastCheck: new Date(),
        };
      });

      const start = Date.now();
      await manager.checkAll();
      const duration = Date.now() - start;

      // If run in parallel, total time should be ~50ms, not ~100ms
      expect(duration).toBeLessThan(100);
      // Both should start at about the same time
      expect(Math.abs(startTimes[0]! - startTimes[1]!)).toBeLessThan(20);
    });
  });

  describe("getLastCheck", () => {
    it("should return null before any checks", () => {
      const result = manager.getLastCheck();
      expect(result).toBeNull();
    });

    it("should return last check result after checkAll", async () => {
      manager.register("test", async () => ({
        name: "test",
        healthy: true,
        latencyMs: 1,
        lastCheck: new Date(),
      }));

      await manager.checkAll();
      const lastCheck = manager.getLastCheck();

      expect(lastCheck).not.toBeNull();
      expect(lastCheck?.status).toBe("healthy");
    });
  });

  describe("onHealthChange", () => {
    it("should notify listeners when health status changes", async () => {
      let callCount = 0;
      let lastHealth: any = null;

      manager.onHealthChange((health) => {
        callCount++;
        lastHealth = health;
      });

      // Register a component
      manager.register("test", async () => ({
        name: "test",
        healthy: true,
        latencyMs: 1,
        lastCheck: new Date(),
      }));

      // First check - should notify (status goes from undefined to healthy)
      await manager.checkAll();
      expect(callCount).toBe(1);
      expect(lastHealth.status).toBe("healthy");

      // Second check with same status - should not notify
      await manager.checkAll();
      expect(callCount).toBe(1);

      // Change to unhealthy
      manager.unregister("test");
      manager.register("test", async () => ({
        name: "test",
        healthy: false,
        latencyMs: 1,
        error: "Now failing",
        lastCheck: new Date(),
      }));

      await manager.checkAll();
      expect(callCount).toBe(2);
      expect(lastHealth.status).toBe("unhealthy");
    });

    it("should return unsubscribe function", async () => {
      let callCount = 0;

      const unsubscribe = manager.onHealthChange(() => {
        callCount++;
      });

      manager.register("test", async () => ({
        name: "test",
        healthy: true,
        latencyMs: 1,
        lastCheck: new Date(),
      }));

      await manager.checkAll();
      expect(callCount).toBe(1);

      unsubscribe();

      // Change status to trigger notification
      manager.unregister("test");
      manager.register("test", async () => ({
        name: "test",
        healthy: false,
        latencyMs: 1,
        error: "Failing",
        lastCheck: new Date(),
      }));

      await manager.checkAll();
      // Should not increase because we unsubscribed
      expect(callCount).toBe(1);
    });
  });

  describe("periodic checks", () => {
    it("should start and stop periodic checks", async () => {
      let checkCount = 0;

      manager.register("counter", async () => {
        checkCount++;
        return {
          name: "counter",
          healthy: true,
          latencyMs: 1,
          lastCheck: new Date(),
        };
      });

      manager.startPeriodicChecks(50);

      // Wait for a few checks
      await new Promise((resolve) => setTimeout(resolve, 160));

      manager.stopPeriodicChecks();

      const countAfterStop = checkCount;

      // Wait more time
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Count should not increase after stop
      expect(checkCount).toBe(countAfterStop);
      expect(checkCount).toBeGreaterThan(1);
    });
  });
});

describe("createSimpleHealthChecker", () => {
  it("should create a checker from a boolean function", async () => {
    const checker = createSimpleHealthChecker("simple", () => true);
    const result = await checker();

    expect(result.name).toBe("simple");
    expect(result.healthy).toBe(true);
  });

  it("should create a checker from an async function", async () => {
    const checker = createSimpleHealthChecker("async", async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return true;
    });

    const result = await checker();
    expect(result.healthy).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(5);
  });

  it("should include details when provided", async () => {
    const checker = createSimpleHealthChecker(
      "detailed",
      () => true,
      () => ({ connections: 5, uptime: 1000 }),
    );

    const result = await checker();
    expect(result.details).toEqual({ connections: 5, uptime: 1000 });
  });

  it("should handle errors in check function", async () => {
    const checker = createSimpleHealthChecker("failing", () => {
      throw new Error("Check failed");
    });

    const result = await checker();
    expect(result.healthy).toBe(false);
    expect(result.error).toBe("Check failed");
  });
});

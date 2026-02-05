// Graceful Degradation Tests
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DegradationManager,
  getDegradationManager,
  resetDegradationManager,
  withCachedFallback,
  withFallback,
} from "./degradation.js";

describe("DegradationManager", () => {
  let manager: DegradationManager;

  beforeEach(() => {
    manager = new DegradationManager({
      checkInterval: 1000, // Must be >= 1000
      maxDegradedServices: 2,
      emergencyThreshold: 3,
    });
  });

  afterEach(() => {
    manager.stopMonitoring();
    resetDegradationManager();
  });

  describe("Initial State", () => {
    it("should start in normal level", () => {
      expect(manager.getLevel()).toBe("normal");
    });

    it("should not be degraded initially", () => {
      expect(manager.isDegraded()).toBe(false);
    });

    it("should not be in emergency initially", () => {
      expect(manager.isEmergency()).toBe(false);
    });

    it("should have empty services map", () => {
      const state = manager.getState();
      expect(state.services.size).toBe(0);
    });
  });

  describe("Service Registration", () => {
    it("should register service with health check", () => {
      manager.registerService("database", async () => true);

      const state = manager.getState();
      expect(state.services.has("database")).toBe(true);
    });

    it("should mark service as available on registration", () => {
      manager.registerService("database", async () => true);

      expect(manager.isServiceAvailable("database")).toBe(true);
    });

    it("should register service with fallback", () => {
      const fallback = vi.fn();
      manager.registerService("database", async () => true, fallback);

      const state = manager.getState();
      expect(state.services.get("database")?.fallbackActive).toBe(false);
    });
  });

  describe("Health Checking", () => {
    it("should mark service unavailable on health check failure", async () => {
      manager.registerService("database", async () => false);

      await manager.checkAllServices();

      expect(manager.isServiceAvailable("database")).toBe(false);
    });

    it("should mark service unavailable on health check error", async () => {
      manager.registerService("database", async () => {
        throw new Error("Connection failed");
      });

      await manager.checkAllServices();

      expect(manager.isServiceAvailable("database")).toBe(false);
    });

    it("should keep service available on successful check", async () => {
      manager.registerService("database", async () => true);

      await manager.checkAllServices();

      expect(manager.isServiceAvailable("database")).toBe(true);
    });

    it("should activate fallback when service becomes unavailable", async () => {
      const fallback = vi.fn();
      manager.registerService("database", async () => false, fallback);

      await manager.checkAllServices();

      expect(fallback).toHaveBeenCalled();
    });
  });

  describe("Degradation Levels", () => {
    it("should remain normal when all services healthy", async () => {
      manager.registerService("db", async () => true);
      manager.registerService("cache", async () => true);

      await manager.checkAllServices();

      expect(manager.getLevel()).toBe("normal");
      expect(manager.isDegraded()).toBe(false);
    });

    it("should become degraded when one service fails", async () => {
      manager.registerService("db", async () => true);
      manager.registerService("cache", async () => false);

      await manager.checkAllServices();

      expect(manager.getLevel()).toBe("degraded");
      expect(manager.isDegraded()).toBe(true);
    });

    it("should become emergency when threshold exceeded", async () => {
      manager.registerService("db", async () => false);
      manager.registerService("cache", async () => false);
      manager.registerService("vector", async () => false);

      await manager.checkAllServices();

      expect(manager.getLevel()).toBe("emergency");
      expect(manager.isEmergency()).toBe(true);
    });

    it("should recover to normal when services recover", async () => {
      let dbHealthy = false;

      manager.registerService("db", async () => dbHealthy);

      await manager.checkAllServices();
      expect(manager.getLevel()).toBe("degraded");

      dbHealthy = true;
      await manager.checkAllServices();
      expect(manager.getLevel()).toBe("normal");
    });
  });

  describe("Manual Service Control", () => {
    it("should manually mark service unavailable", () => {
      manager.registerService("db", async () => true);

      manager.markServiceUnavailable("db", "Maintenance");

      expect(manager.isServiceAvailable("db")).toBe(false);
      expect(manager.getLevel()).toBe("degraded");
    });

    it("should manually mark service available", async () => {
      manager.registerService("db", async () => false);
      await manager.checkAllServices();

      manager.markServiceAvailable("db");

      expect(manager.isServiceAvailable("db")).toBe(true);
      expect(manager.getLevel()).toBe("normal");
    });
  });

  describe("State Information", () => {
    it("should include reason when degraded", async () => {
      manager.registerService("db", async () => false);
      await manager.checkAllServices();

      const state = manager.getState();
      expect(state.reason).toContain("1 service(s) unavailable");
    });

    it("should include startedAt when degraded", async () => {
      manager.registerService("db", async () => false);
      await manager.checkAllServices();

      const state = manager.getState();
      expect(state.startedAt).toBeInstanceOf(Date);
    });

    it("should return copy of services map", () => {
      manager.registerService("db", async () => true);

      const state1 = manager.getState();
      const state2 = manager.getState();

      expect(state1.services).not.toBe(state2.services);
    });
  });

  describe("Monitoring", () => {
    it("should start and stop monitoring", () => {
      manager.registerService("db", async () => true);

      manager.startMonitoring();
      manager.startMonitoring(); // Should be idempotent

      manager.stopMonitoring();
    });

    it("should perform periodic checks while monitoring", async () => {
      let checkCount = 0;
      manager.registerService("db", async () => {
        checkCount++;
        return true;
      });

      manager.startMonitoring();

      // Wait for at least 2 check intervals (initial + 1 periodic)
      await new Promise((resolve) => setTimeout(resolve, 2100));

      manager.stopMonitoring();

      expect(checkCount).toBeGreaterThan(1);
    });
  });
});

describe("Global Degradation Manager", () => {
  afterEach(() => {
    resetDegradationManager();
  });

  it("should get or create global manager", () => {
    const manager1 = getDegradationManager();
    const manager2 = getDegradationManager();

    expect(manager1).toBe(manager2);
  });

  it("should reset global manager", () => {
    const manager1 = getDegradationManager();
    resetDegradationManager();
    const manager2 = getDegradationManager();

    expect(manager1).not.toBe(manager2);
  });
});

describe("Fallback Utilities", () => {
  describe("withFallback", () => {
    it("should return primary result on success", async () => {
      const result = await withFallback(
        async () => "primary",
        async () => "fallback",
        "test-service",
      );

      expect(result).toBe("primary");
    });

    it("should return fallback result on primary failure", async () => {
      const result = await withFallback(
        async () => {
          throw new Error("Primary failed");
        },
        async () => "fallback",
        "test-service",
      );

      expect(result).toBe("fallback");
    });

    it("should propagate fallback error if fallback also fails", async () => {
      await expect(
        withFallback(
          async () => {
            throw new Error("Primary failed");
          },
          async () => {
            throw new Error("Fallback failed");
          },
          "test-service",
        ),
      ).rejects.toThrow("Fallback failed");
    });
  });

  describe("withCachedFallback", () => {
    it("should return primary result on success", async () => {
      const result = await withCachedFallback(
        async () => "fresh",
        () => "cached",
        "test-service",
      );

      expect(result).toBe("fresh");
    });

    it("should return cached value on primary failure", async () => {
      const result = await withCachedFallback(
        async () => {
          throw new Error("Primary failed");
        },
        () => "cached",
        "test-service",
      );

      expect(result).toBe("cached");
    });

    it("should throw if no cached value and primary fails", async () => {
      await expect(
        withCachedFallback(
          async () => {
            throw new Error("Primary failed");
          },
          () => undefined,
          "test-service",
        ),
      ).rejects.toThrow("Primary failed");
    });

    it("should handle null cached value differently from undefined", async () => {
      // null is a valid cached value
      const result = await withCachedFallback(
        async () => {
          throw new Error("Primary failed");
        },
        () => null as unknown as string,
        "test-service",
      );

      expect(result).toBe(null);
    });
  });
});

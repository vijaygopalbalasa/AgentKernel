import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createShutdownManager,
  createDrainHandler,
  SHUTDOWN_PRIORITIES,
  type ShutdownManager,
} from "../shutdown.js";

describe("ShutdownManager", () => {
  let manager: ShutdownManager;

  beforeEach(() => {
    manager = createShutdownManager({
      timeoutMs: 5000,
      signals: [], // Don't register signal handlers in tests
    });
  });

  describe("register/unregister", () => {
    it("should register a shutdown handler", () => {
      const handler = vi.fn();
      manager.register("test", handler);

      expect(manager.getHandlers()).toContain("test");
    });

    it("should unregister a shutdown handler", () => {
      const handler = vi.fn();
      manager.register("test", handler);
      manager.unregister("test");

      expect(manager.getHandlers()).not.toContain("test");
    });

    it("should allow registering with priority", () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      manager.register("low", handler1, SHUTDOWN_PRIORITIES.LOW);
      manager.register("high", handler2, SHUTDOWN_PRIORITIES.HIGH);

      expect(manager.getHandlers()).toContain("low");
      expect(manager.getHandlers()).toContain("high");
    });
  });

  describe("shutdown", () => {
    it("should call all registered handlers", async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      manager.register("handler1", handler1);
      manager.register("handler2", handler2);

      await manager.shutdown("test");

      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });

    it("should call handlers in priority order (high to low)", async () => {
      const callOrder: string[] = [];

      manager.register("low", () => {
        callOrder.push("low");
      }, SHUTDOWN_PRIORITIES.LOW);
      manager.register("high", () => {
        callOrder.push("high");
      }, SHUTDOWN_PRIORITIES.HIGH);
      manager.register("normal", () => {
        callOrder.push("normal");
      }, SHUTDOWN_PRIORITIES.NORMAL);

      await manager.shutdown("test");

      expect(callOrder).toEqual(["high", "normal", "low"]);
    });

    it("should handle async handlers", async () => {
      const results: string[] = [];

      manager.register("async", async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        results.push("done");
      });

      await manager.shutdown("test");

      expect(results).toContain("done");
    });

    it("should continue even if a handler throws", async () => {
      const results: string[] = [];

      manager.register("first", () => {
        throw new Error("First handler failed");
      }, SHUTDOWN_PRIORITIES.HIGH);

      manager.register("second", () => {
        results.push("second");
      }, SHUTDOWN_PRIORITIES.NORMAL);

      await manager.shutdown("test");

      expect(results).toContain("second");
    });

    it("should not run handlers twice if shutdown called twice", async () => {
      let callCount = 0;

      manager.register("counter", () => {
        callCount++;
      });

      await manager.shutdown("first");
      await manager.shutdown("second");

      expect(callCount).toBe(1);
    });

    it("should set isShuttingDown flag", async () => {
      expect(manager.isShuttingDown()).toBe(false);

      const shutdownPromise = manager.shutdown("test");
      expect(manager.isShuttingDown()).toBe(true);

      await shutdownPromise;
      expect(manager.isShuttingDown()).toBe(true);
    });
  });

  describe("SHUTDOWN_PRIORITIES", () => {
    it("should have correct priority values", () => {
      expect(SHUTDOWN_PRIORITIES.IMMEDIATE).toBe(100);
      expect(SHUTDOWN_PRIORITIES.HIGH).toBe(75);
      expect(SHUTDOWN_PRIORITIES.NORMAL).toBe(50);
      expect(SHUTDOWN_PRIORITIES.LOW).toBe(25);
      expect(SHUTDOWN_PRIORITIES.FINAL).toBe(0);
    });
  });
});

describe("createDrainHandler", () => {
  it("should complete immediately when no pending operations", async () => {
    const handler = createDrainHandler("test", () => 0);

    const start = Date.now();
    await handler();
    const duration = Date.now() - start;

    expect(duration).toBeLessThan(50);
  });

  it("should wait for pending operations to complete", async () => {
    let pending = 3;

    // Decrement every 50ms
    const interval = setInterval(() => {
      pending--;
      if (pending <= 0) clearInterval(interval);
    }, 50);

    const handler = createDrainHandler("test", () => pending, {
      checkIntervalMs: 20,
    });

    const start = Date.now();
    await handler();
    const duration = Date.now() - start;

    clearInterval(interval);

    // Should wait ~150ms (3 decrements * 50ms each)
    expect(duration).toBeGreaterThanOrEqual(100);
    expect(pending).toBe(0);
  });

  it("should respect maxWaitMs", async () => {
    // Always return pending
    const handler = createDrainHandler("test", () => 10, {
      checkIntervalMs: 20,
      maxWaitMs: 100,
    });

    const start = Date.now();
    await handler();
    const duration = Date.now() - start;

    // Should stop at maxWaitMs
    expect(duration).toBeGreaterThanOrEqual(100);
    expect(duration).toBeLessThan(200);
  });
});

describe("Integration scenarios", () => {
  it("should handle typical shutdown sequence", async () => {
    const events: string[] = [];

    const manager = createShutdownManager({
      signals: [],
    });

    // Stop accepting new requests
    manager.register("http-server", async () => {
      events.push("http-server-close");
    }, SHUTDOWN_PRIORITIES.IMMEDIATE);

    // Drain pending requests
    manager.register("request-drain", async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push("requests-drained");
    }, SHUTDOWN_PRIORITIES.HIGH);

    // Close database
    manager.register("database", async () => {
      events.push("database-closed");
    }, SHUTDOWN_PRIORITIES.NORMAL);

    // Flush logs
    manager.register("logger", () => {
      events.push("logs-flushed");
    }, SHUTDOWN_PRIORITIES.FINAL);

    await manager.shutdown("SIGTERM");

    expect(events).toEqual([
      "http-server-close",
      "requests-drained",
      "database-closed",
      "logs-flushed",
    ]);
  });
});

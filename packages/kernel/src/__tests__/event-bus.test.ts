import { describe, expect, it, vi } from "vitest";
import type { RedisConfig } from "../config.js";
import {
  type EventBus,
  type EventBusStats,
  type EventMessage,
  type Subscription,
  checkEventBusHealth,
  createEventBus,
  waitForEventBus,
} from "../event-bus.js";

// Note: These tests verify API contracts without requiring a real Redis connection.
// Integration tests with real Redis should be in a separate test suite.

describe("EventBus Module API Contracts", () => {
  const mockConfig: RedisConfig = {
    host: "localhost",
    port: 6379,
    password: undefined,
    db: 0,
    keyPrefix: "test:",
    mode: "standalone",
  };

  describe("createEventBus", () => {
    it("should return an EventBus object with all required methods", () => {
      const bus = createEventBus(mockConfig);

      // Verify interface completeness
      expect(bus).toHaveProperty("publish");
      expect(bus).toHaveProperty("subscribe");
      expect(bus).toHaveProperty("subscribePattern");
      expect(bus).toHaveProperty("getHistory");
      expect(bus).toHaveProperty("isConnected");
      expect(bus).toHaveProperty("getStats");
      expect(bus).toHaveProperty("close");

      // Verify types are functions
      expect(typeof bus.publish).toBe("function");
      expect(typeof bus.subscribe).toBe("function");
      expect(typeof bus.subscribePattern).toBe("function");
      expect(typeof bus.getHistory).toBe("function");
      expect(typeof bus.isConnected).toBe("function");
      expect(typeof bus.getStats).toBe("function");
      expect(typeof bus.close).toBe("function");
    });

    it("should accept optional logger parameter", () => {
      const mockLogger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };

      // Should not throw
      expect(() => createEventBus(mockConfig, mockLogger as any)).not.toThrow();
    });
  });

  describe("EventBus.getStats", () => {
    it("should return EventBusStats with all required fields", () => {
      const bus = createEventBus(mockConfig);
      const stats = bus.getStats();

      expect(stats).toHaveProperty("connected");
      expect(stats).toHaveProperty("subscriptions");
      expect(stats).toHaveProperty("published");
      expect(stats).toHaveProperty("received");

      expect(typeof stats.connected).toBe("boolean");
      expect(typeof stats.subscriptions).toBe("number");
      expect(typeof stats.published).toBe("number");
      expect(typeof stats.received).toBe("number");
    });

    it("should start with zero counts", () => {
      const bus = createEventBus(mockConfig);
      const stats = bus.getStats();

      expect(stats.subscriptions).toBe(0);
      expect(stats.published).toBe(0);
      expect(stats.received).toBe(0);
    });
  });

  describe("EventBus.isConnected", () => {
    it("should return a boolean", () => {
      const bus = createEventBus(mockConfig);
      const result = bus.isConnected();
      expect(typeof result).toBe("boolean");
    });
  });

  describe("checkEventBusHealth", () => {
    it("should return health status object", async () => {
      const bus = createEventBus(mockConfig);
      const health = await checkEventBusHealth(bus);

      expect(health).toHaveProperty("healthy");
      expect(health).toHaveProperty("latencyMs");
      expect(typeof health.healthy).toBe("boolean");
      expect(typeof health.latencyMs).toBe("number");
    });

    it("should include stats when healthy", async () => {
      const bus = createEventBus(mockConfig);
      const health = await checkEventBusHealth(bus);

      // May or may not be healthy depending on Redis availability
      if (health.healthy) {
        expect(health.stats).toBeDefined();
      }
    });
  });

  describe("waitForEventBus", () => {
    it("should return false when Redis never connects", async () => {
      const bus = createEventBus({
        ...mockConfig,
        host: "nonexistent-host-12345",
      });

      const result = await waitForEventBus(bus, {
        maxRetries: 1,
        retryDelayMs: 10,
      });

      expect(result).toBe(false);
    });

    it("should accept logger option", async () => {
      const mockLogger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };

      const bus = createEventBus(mockConfig);

      await waitForEventBus(bus, {
        maxRetries: 1,
        retryDelayMs: 10,
        logger: mockLogger as any,
      });

      // Logger should have been called
      expect(mockLogger.debug).toHaveBeenCalled();
    });
  });
});

describe("EventMessage type", () => {
  it("should have correct structure", () => {
    const message: EventMessage<{ test: string }> = {
      id: "test-id",
      type: "test.event",
      data: { test: "value" },
      timestamp: new Date(),
    };

    expect(message.id).toBe("test-id");
    expect(message.type).toBe("test.event");
    expect(message.data.test).toBe("value");
    expect(message.timestamp).toBeInstanceOf(Date);
  });

  it("should support optional fields", () => {
    const message: EventMessage = {
      id: "test-id",
      type: "test.event",
      data: null,
      timestamp: new Date(),
      source: "test-source",
      correlationId: "corr-123",
    };

    expect(message.source).toBe("test-source");
    expect(message.correlationId).toBe("corr-123");
  });
});

describe("Subscription type", () => {
  it("should have correct structure", () => {
    const mockUnsubscribe = vi.fn();

    const subscription: Subscription = {
      channel: "test-channel",
      isPattern: false,
      unsubscribe: mockUnsubscribe,
    };

    expect(subscription.channel).toBe("test-channel");
    expect(subscription.isPattern).toBe(false);
    expect(typeof subscription.unsubscribe).toBe("function");
  });

  it("should support pattern subscriptions", () => {
    const subscription: Subscription = {
      channel: "test:*",
      isPattern: true,
      unsubscribe: vi.fn(),
    };

    expect(subscription.isPattern).toBe(true);
  });
});

describe("EventBusStats type", () => {
  it("should have correct structure", () => {
    const stats: EventBusStats = {
      connected: true,
      subscriptions: 5,
      published: 100,
      received: 50,
    };

    expect(stats.connected).toBe(true);
    expect(stats.subscriptions).toBe(5);
    expect(stats.published).toBe(100);
    expect(stats.received).toBe(50);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { RedisEventBus, createRedisEventBus } from "./redis-bus.js";
import type { AgentKernelEvent, EventHandler } from "./types.js";

// Mock the kernel module
vi.mock("@agentkernel/kernel", () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  })),
  createEventBus: vi.fn(() => ({
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue({ unsubscribe: vi.fn() }),
    subscribePattern: vi.fn().mockResolvedValue({ unsubscribe: vi.fn() }),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

describe("RedisEventBus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("in-memory fallback mode", () => {
    it("should work without Redis configuration", () => {
      const bus = createRedisEventBus();
      expect(bus.isRedisEnabled()).toBe(false);
    });

    it("should publish events successfully", async () => {
      const bus = createRedisEventBus();

      const event: AgentKernelEvent = {
        id: "evt-1",
        channel: "test.channel",
        type: "test.event",
        timestamp: new Date(),
        agentId: "agent-1",
        data: { foo: "bar" },
      };

      const result = await bus.publish(event);
      expect(result.ok).toBe(true);
    });

    it("should subscribe and receive events", async () => {
      const bus = createRedisEventBus();

      const received: AgentKernelEvent[] = [];
      const handler: EventHandler = async (event) => {
        received.push(event);
      };

      const subResult = bus.subscribe("test.channel", handler);
      expect(subResult.ok).toBe(true);

      const event: AgentKernelEvent = {
        id: "evt-2",
        channel: "test.channel",
        type: "test.event",
        timestamp: new Date(),
        agentId: "agent-1",
        data: { message: "hello" },
      };

      await bus.publish(event);

      // Give handlers time to execute
      await new Promise((r) => setTimeout(r, 10));

      expect(received.length).toBe(1);
      expect(received[0].data).toEqual({ message: "hello" });
    });

    it("should support wildcard subscriptions", async () => {
      const bus = createRedisEventBus();

      const received: AgentKernelEvent[] = [];
      bus.subscribe("test.*", async (event) => {
        received.push(event);
      });

      await bus.publish({
        id: "evt-3",
        channel: "test.foo",
        type: "test.event",
        timestamp: new Date(),
        agentId: "agent-1",
        data: {},
      });

      await bus.publish({
        id: "evt-4",
        channel: "test.bar",
        type: "test.event",
        timestamp: new Date(),
        agentId: "agent-1",
        data: {},
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(received.length).toBe(2);
    });

    it("should support once() for single-fire subscriptions", async () => {
      const bus = createRedisEventBus();

      const received: AgentKernelEvent[] = [];
      bus.once("single.channel", async (event) => {
        received.push(event);
      });

      await bus.publish({
        id: "evt-5",
        channel: "single.channel",
        type: "test",
        timestamp: new Date(),
        agentId: "agent-1",
        data: {},
      });

      await bus.publish({
        id: "evt-6",
        channel: "single.channel",
        type: "test",
        timestamp: new Date(),
        agentId: "agent-1",
        data: {},
      });

      await new Promise((r) => setTimeout(r, 10));

      // Should only receive first event
      expect(received.length).toBe(1);
    });

    it("should support on() for type-filtered subscriptions", async () => {
      const bus = createRedisEventBus();

      const received: AgentKernelEvent[] = [];
      bus.on("typed.channel", "specific.type", async (event) => {
        received.push(event);
      });

      await bus.publish({
        id: "evt-7",
        channel: "typed.channel",
        type: "specific.type",
        timestamp: new Date(),
        agentId: "agent-1",
        data: {},
      });

      await bus.publish({
        id: "evt-8",
        channel: "typed.channel",
        type: "other.type",
        timestamp: new Date(),
        agentId: "agent-1",
        data: {},
      });

      await new Promise((r) => setTimeout(r, 10));

      // Should only receive events of specific type
      expect(received.length).toBe(1);
    });

    it("should unsubscribe correctly", async () => {
      const bus = createRedisEventBus();

      const received: AgentKernelEvent[] = [];
      const subResult = bus.subscribe("unsub.channel", async (event) => {
        received.push(event);
      });

      expect(subResult.ok).toBe(true);
      const subscriptionId = subResult.value;

      await bus.publish({
        id: "evt-9",
        channel: "unsub.channel",
        type: "test",
        timestamp: new Date(),
        agentId: "agent-1",
        data: {},
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(received.length).toBe(1);

      await bus.unsubscribe(subscriptionId);

      await bus.publish({
        id: "evt-10",
        channel: "unsub.channel",
        type: "test",
        timestamp: new Date(),
        agentId: "agent-1",
        data: {},
      });

      await new Promise((r) => setTimeout(r, 10));
      // Should not receive second event
      expect(received.length).toBe(1);
    });

    it("should track event history", async () => {
      const bus = createRedisEventBus({ maxHistorySize: 100 });

      await bus.publish({
        id: "evt-11",
        channel: "history.channel",
        type: "test",
        timestamp: new Date(),
        agentId: "agent-1",
        data: { n: 1 },
      });

      await bus.publish({
        id: "evt-12",
        channel: "history.channel",
        type: "test",
        timestamp: new Date(),
        agentId: "agent-1",
        data: { n: 2 },
      });

      const historyResult = bus.getHistory({ channel: "history.channel" });
      expect(historyResult.ok).toBe(true);
      expect(historyResult.value.length).toBe(2);
    });

    it("should provide stats", async () => {
      const bus = createRedisEventBus();

      await bus.publish({
        id: "evt-13",
        channel: "stats.channel",
        type: "test",
        timestamp: new Date(),
        agentId: "agent-1",
        data: {},
      });

      bus.subscribe("stats.channel", async () => {});

      const stats = bus.getStats();
      expect(stats.totalEventsPublished).toBe(1);
      expect(stats.totalSubscriptions).toBe(1);
      expect(stats.redisEnabled).toBe(false);
    });

    it("should clear history", async () => {
      const bus = createRedisEventBus();

      await bus.publish({
        id: "evt-14",
        channel: "clear.channel",
        type: "test",
        timestamp: new Date(),
        agentId: "agent-1",
        data: {},
      });

      let history = bus.getHistory();
      expect(history.value.length).toBe(1);

      bus.clearHistory();

      history = bus.getHistory();
      expect(history.value.length).toBe(0);
    });

    it("should close gracefully", async () => {
      const bus = createRedisEventBus();

      bus.subscribe("close.channel", async () => {});

      await bus.close();

      // Should not throw
      expect(true).toBe(true);
    });
  });

  describe("event ID and timestamp generation", () => {
    it("should auto-generate event ID if missing", async () => {
      const bus = createRedisEventBus();

      const event: Partial<AgentKernelEvent> = {
        channel: "auto.channel",
        type: "test",
        agentId: "agent-1",
        data: {},
      };

      await bus.publish(event as AgentKernelEvent);

      const history = bus.getHistory();
      expect(history.value[0].event.id).toMatch(/^evt-/);
    });

    it("should auto-generate timestamp if missing", async () => {
      const bus = createRedisEventBus();

      const beforePublish = new Date();

      const event: Partial<AgentKernelEvent> = {
        id: "evt-manual",
        channel: "auto.channel",
        type: "test",
        agentId: "agent-1",
        data: {},
      };

      await bus.publish(event as AgentKernelEvent);

      const history = bus.getHistory();
      expect(history.value[0].event.timestamp.getTime()).toBeGreaterThanOrEqual(
        beforePublish.getTime()
      );
    });
  });

  describe("error handling", () => {
    it("should return error for unsubscribing unknown subscription", async () => {
      const bus = createRedisEventBus();

      const result = await bus.unsubscribe("unknown-subscription-id");
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("NOT_FOUND");
    });
  });
});

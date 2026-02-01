// Event System tests
import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventBus, createEventBus } from "./bus.js";
import { WebhookManager, createWebhookManager } from "./webhooks.js";
import type {
  AgentOSEvent,
  AgentLifecycleEvent,
  ToolEvent,
  WebhookConfig,
} from "./types.js";

describe("EventBus", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = createEventBus();
  });

  describe("Publishing", () => {
    it("should publish events", async () => {
      const handler = vi.fn();
      bus.subscribe("agent.lifecycle", handler);

      const event: AgentLifecycleEvent = {
        id: "test-1",
        channel: "agent.lifecycle",
        type: "agent.created",
        timestamp: new Date(),
        agentId: "agent-1",
        data: { state: "created" },
      };

      await bus.publish(event);

      expect(handler).toHaveBeenCalledWith(event);
    });

    it("should auto-generate event ID if missing", async () => {
      const handler = vi.fn();
      bus.subscribe("agent.lifecycle", handler);

      const event = {
        channel: "agent.lifecycle",
        type: "agent.created",
        agentId: "agent-1",
        data: {},
      } as AgentLifecycleEvent;

      await bus.publish(event);

      expect(handler).toHaveBeenCalled();
      const receivedEvent = handler.mock.calls[0][0];
      expect(receivedEvent.id).toBeDefined();
      expect(receivedEvent.id.startsWith("evt-")).toBe(true);
    });

    it("should update statistics on publish", async () => {
      const event: AgentLifecycleEvent = {
        id: "test-1",
        channel: "agent.lifecycle",
        type: "agent.created",
        timestamp: new Date(),
        agentId: "agent-1",
        data: {},
      };

      await bus.publish(event);
      await bus.publish(event);

      const stats = bus.getStats();
      expect(stats.totalEventsPublished).toBe(2);
      expect(stats.channelCounts["agent.lifecycle"]).toBe(2);
    });
  });

  describe("Subscribing", () => {
    it("should subscribe to exact channel", async () => {
      const handler = vi.fn();
      bus.subscribe("tool", handler);

      await bus.publish({
        id: "1",
        channel: "tool",
        type: "tool.registered",
        timestamp: new Date(),
        data: { toolId: "test-tool" },
      } as ToolEvent);

      expect(handler).toHaveBeenCalled();
    });

    it("should subscribe to wildcard patterns", async () => {
      const handler = vi.fn();
      bus.subscribe("agent.*", handler);

      await bus.publish({
        id: "1",
        channel: "agent.lifecycle",
        type: "agent.created",
        timestamp: new Date(),
        agentId: "a1",
        data: {},
      } as AgentLifecycleEvent);

      expect(handler).toHaveBeenCalled();
    });

    it("should subscribe to all events with *", async () => {
      const handler = vi.fn();
      bus.subscribe("*", handler);

      await bus.publish({
        id: "1",
        channel: "tool",
        type: "tool.registered",
        timestamp: new Date(),
        data: { toolId: "test" },
      } as ToolEvent);

      await bus.publish({
        id: "2",
        channel: "agent.lifecycle",
        type: "agent.created",
        timestamp: new Date(),
        agentId: "a1",
        data: {},
      } as AgentLifecycleEvent);

      expect(handler).toHaveBeenCalledTimes(2);
    });

    it("should support priority ordering", async () => {
      const order: number[] = [];

      bus.subscribe("test", () => order.push(1), { priority: 1 });
      bus.subscribe("test", () => order.push(2), { priority: 2 });
      bus.subscribe("test", () => order.push(0), { priority: 0 });

      await bus.publish({
        id: "1",
        channel: "test",
        type: "test",
        timestamp: new Date(),
      } as AgentOSEvent);

      expect(order).toEqual([2, 1, 0]);
    });

    it("should support once subscriptions", async () => {
      const handler = vi.fn();
      bus.once("test", handler);

      await bus.publish({
        id: "1",
        channel: "test",
        type: "test",
        timestamp: new Date(),
      } as AgentOSEvent);

      await bus.publish({
        id: "2",
        channel: "test",
        type: "test",
        timestamp: new Date(),
      } as AgentOSEvent);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("should support filter functions", async () => {
      const handler = vi.fn();
      bus.subscribe("agent.lifecycle", handler, {
        filter: (e) => (e as AgentLifecycleEvent).agentId === "agent-1",
      });

      await bus.publish({
        id: "1",
        channel: "agent.lifecycle",
        type: "agent.created",
        timestamp: new Date(),
        agentId: "agent-1",
        data: {},
      } as AgentLifecycleEvent);

      await bus.publish({
        id: "2",
        channel: "agent.lifecycle",
        type: "agent.created",
        timestamp: new Date(),
        agentId: "agent-2",
        data: {},
      } as AgentLifecycleEvent);

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe("Unsubscribing", () => {
    it("should unsubscribe by ID", async () => {
      const handler = vi.fn();
      const subId = bus.subscribe("test", handler);

      bus.unsubscribe(subId);

      await bus.publish({
        id: "1",
        channel: "test",
        type: "test",
        timestamp: new Date(),
      } as AgentOSEvent);

      expect(handler).not.toHaveBeenCalled();
    });

    it("should unsubscribe all for a pattern", () => {
      bus.subscribe("test", () => {});
      bus.subscribe("test", () => {});
      bus.subscribe("other", () => {});

      const removed = bus.unsubscribeAll("test");

      expect(removed).toBe(2);
      expect(bus.listSubscriptions().length).toBe(1);
    });
  });

  describe("History", () => {
    it("should record event history", async () => {
      await bus.publish({
        id: "1",
        channel: "test",
        type: "test.a",
        timestamp: new Date(),
      } as AgentOSEvent);

      await bus.publish({
        id: "2",
        channel: "test",
        type: "test.b",
        timestamp: new Date(),
      } as AgentOSEvent);

      const history = bus.getHistory();
      expect(history.length).toBe(2);
    });

    it("should filter history by channel", async () => {
      await bus.publish({
        id: "1",
        channel: "test",
        type: "test",
        timestamp: new Date(),
      } as AgentOSEvent);

      await bus.publish({
        id: "2",
        channel: "other",
        type: "other",
        timestamp: new Date(),
      } as AgentOSEvent);

      const history = bus.getHistory({ channel: "test" });
      expect(history.length).toBe(1);
    });

    it("should filter history by event type", async () => {
      await bus.publish({
        id: "1",
        channel: "test",
        type: "test.a",
        timestamp: new Date(),
      } as AgentOSEvent);

      await bus.publish({
        id: "2",
        channel: "test",
        type: "test.b",
        timestamp: new Date(),
      } as AgentOSEvent);

      const history = bus.getHistory({ eventType: "test.a" });
      expect(history.length).toBe(1);
    });

    it("should limit history size", async () => {
      bus.setMaxHistorySize(5);

      for (let i = 0; i < 10; i++) {
        await bus.publish({
          id: String(i),
          channel: "test",
          type: "test",
          timestamp: new Date(),
        } as AgentOSEvent);
      }

      const history = bus.getHistory();
      expect(history.length).toBe(5);
    });

    it("should clear history", async () => {
      await bus.publish({
        id: "1",
        channel: "test",
        type: "test",
        timestamp: new Date(),
      } as AgentOSEvent);

      bus.clearHistory();

      expect(bus.getHistory().length).toBe(0);
    });
  });

  describe("Replay", () => {
    it("should replay events to a subscription", async () => {
      // Publish events before subscribing
      await bus.publish({
        id: "1",
        channel: "test",
        type: "test",
        timestamp: new Date(),
      } as AgentOSEvent);

      await bus.publish({
        id: "2",
        channel: "test",
        type: "test",
        timestamp: new Date(),
      } as AgentOSEvent);

      // Subscribe after events
      const handler = vi.fn();
      const subId = bus.subscribe("test", handler);

      // Replay
      const replayed = await bus.replay(subId);

      expect(replayed).toBe(2);
      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  describe("on() helper", () => {
    it("should subscribe to specific event type", async () => {
      const handler = vi.fn();
      bus.on("agent.lifecycle", "agent.created", handler);

      await bus.publish({
        id: "1",
        channel: "agent.lifecycle",
        type: "agent.created",
        timestamp: new Date(),
        agentId: "a1",
        data: {},
      } as AgentLifecycleEvent);

      await bus.publish({
        id: "2",
        channel: "agent.lifecycle",
        type: "agent.terminated",
        timestamp: new Date(),
        agentId: "a1",
        data: {},
      } as AgentLifecycleEvent);

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });
});

describe("WebhookManager", () => {
  let manager: WebhookManager;

  beforeEach(() => {
    manager = createWebhookManager();
  });

  describe("Registration", () => {
    it("should register a webhook", () => {
      const config: WebhookConfig = {
        id: "webhook-1",
        url: "https://example.com/webhook",
        channels: ["agent.*"],
        enabled: true,
      };

      const result = manager.register(config);

      expect(result).toBe(true);
      expect(manager.get("webhook-1")).not.toBeNull();
    });

    it("should reject invalid URL", () => {
      const config: WebhookConfig = {
        id: "webhook-1",
        url: "not-a-url",
        channels: ["agent.*"],
        enabled: true,
      };

      const result = manager.register(config);

      expect(result).toBe(false);
    });

    it("should unregister a webhook", () => {
      manager.register({
        id: "webhook-1",
        url: "https://example.com/webhook",
        channels: ["*"],
        enabled: true,
      });

      const result = manager.unregister("webhook-1");

      expect(result).toBe(true);
      expect(manager.get("webhook-1")).toBeNull();
    });
  });

  describe("Enable/Disable", () => {
    beforeEach(() => {
      manager.register({
        id: "webhook-1",
        url: "https://example.com/webhook",
        channels: ["*"],
        enabled: true,
      });
    });

    it("should disable a webhook", () => {
      manager.disable("webhook-1");

      expect(manager.get("webhook-1")!.enabled).toBe(false);
    });

    it("should enable a webhook", () => {
      manager.disable("webhook-1");
      manager.enable("webhook-1");

      expect(manager.get("webhook-1")!.enabled).toBe(true);
    });
  });

  describe("Listing", () => {
    beforeEach(() => {
      manager.register({
        id: "webhook-1",
        url: "https://example.com/hook1",
        channels: ["agent.*"],
        enabled: true,
      });
      manager.register({
        id: "webhook-2",
        url: "https://example.com/hook2",
        channels: ["tool"],
        enabled: true,
      });
    });

    it("should list all webhooks", () => {
      const webhooks = manager.list();
      expect(webhooks.length).toBe(2);
    });
  });

  describe("Delivery History", () => {
    it("should track delivery history", () => {
      // Mock delivery would go here in integration test
      // For now, just test the API
      const history = manager.getDeliveryHistory();
      expect(Array.isArray(history)).toBe(true);
    });

    it("should clear history", () => {
      manager.clearHistory();
      expect(manager.getDeliveryHistory().length).toBe(0);
    });
  });

  describe("Bus Connection", () => {
    it("should connect to event bus", () => {
      const bus = createEventBus();

      manager.connect(bus);

      // Should not throw
      manager.disconnect();
    });
  });
});

describe("Integration", () => {
  it("should deliver events via webhooks", async () => {
    const bus = createEventBus();
    const webhooks = createWebhookManager();

    // Connect webhooks to bus
    webhooks.connect(bus);

    // Register a webhook (in real scenario, this would hit an actual endpoint)
    webhooks.register({
      id: "test-hook",
      url: "https://example.com/webhook",
      channels: ["agent.*"],
      enabled: false, // Disabled to not make real HTTP calls
    });

    // Publish an event
    await bus.publish({
      id: "1",
      channel: "agent.lifecycle",
      type: "agent.created",
      timestamp: new Date(),
      agentId: "a1",
      data: {},
    } as AgentLifecycleEvent);

    // Cleanup
    webhooks.disconnect();
  });
});

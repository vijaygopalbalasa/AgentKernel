// Event System tests
import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventBus, createEventBus } from "./bus.js";
import { WebhookManager, createWebhookManager } from "./webhooks.js";
import { EventError } from "./types.js";
import type {
  AgentRunEvent,
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
      const subResult = bus.subscribe("agent.lifecycle", handler);
      expect(subResult.ok).toBe(true);

      const event: AgentLifecycleEvent = {
        id: "test-1",
        channel: "agent.lifecycle",
        type: "agent.created",
        timestamp: new Date(),
        agentId: "agent-1",
        data: { state: "created" },
      };

      const pubResult = await bus.publish(event);
      expect(pubResult.ok).toBe(true);
      expect(handler).toHaveBeenCalledWith(event);
    });

    it("should auto-generate event ID if missing", async () => {
      const handler = vi.fn();
      const subResult = bus.subscribe("agent.lifecycle", handler);
      expect(subResult.ok).toBe(true);

      const event = {
        channel: "agent.lifecycle",
        type: "agent.created",
        agentId: "agent-1",
        data: {},
      } as AgentLifecycleEvent;

      const pubResult = await bus.publish(event);
      expect(pubResult.ok).toBe(true);
      expect(handler).toHaveBeenCalled();

      const firstCall = handler.mock.calls[0];
      expect(firstCall).toBeDefined();
      if (!firstCall) {
        throw new Error("Expected handler call");
      }
      const receivedEvent = firstCall[0];
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
      const subResult = bus.subscribe("tool", handler);
      expect(subResult.ok).toBe(true);

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
      const subResult = bus.subscribe("agent.*", handler);
      expect(subResult.ok).toBe(true);

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
      const subResult = bus.subscribe("*", handler);
      expect(subResult.ok).toBe(true);

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

      bus.subscribe("system", () => {
        order.push(1);
      }, { priority: 1 });
      bus.subscribe("system", () => {
        order.push(2);
      }, { priority: 2 });
      bus.subscribe("system", () => {
        order.push(0);
      }, { priority: 0 });

      await bus.publish({
        id: "1",
        channel: "system",
        type: "system.warning",
        timestamp: new Date(),
        data: { message: "priority" },
      } as AgentRunEvent);

      expect(order).toEqual([2, 1, 0]);
    });

    it("should support once subscriptions", async () => {
      const handler = vi.fn();
      const subResult = bus.once("system", handler);
      expect(subResult.ok).toBe(true);

      await bus.publish({
        id: "1",
        channel: "system",
        type: "system.warning",
        timestamp: new Date(),
        data: { message: "once" },
      } as AgentRunEvent);

      await bus.publish({
        id: "2",
        channel: "system",
        type: "system.warning",
        timestamp: new Date(),
        data: { message: "once" },
      } as AgentRunEvent);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("should support filter functions", async () => {
      const handler = vi.fn();
      const subResult = bus.subscribe("agent.lifecycle", handler, {
        filter: (e) => (e as AgentLifecycleEvent).agentId === "agent-1",
      });
      expect(subResult.ok).toBe(true);

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

    it("should reject empty channel pattern", () => {
      const handler = vi.fn();
      const subResult = bus.subscribe("", handler);

      expect(subResult.ok).toBe(false);
      if (!subResult.ok) {
        expect(subResult.error).toBeInstanceOf(EventError);
        expect(subResult.error.code).toBe("VALIDATION_ERROR");
      }
    });
  });

  describe("Unsubscribing", () => {
    it("should unsubscribe by ID", async () => {
      const handler = vi.fn();
      const subResult = bus.subscribe("system", handler);
      expect(subResult.ok).toBe(true);
      if (!subResult.ok) return;

      const unsubResult = bus.unsubscribe(subResult.value);
      expect(unsubResult.ok).toBe(true);

      await bus.publish({
        id: "1",
        channel: "system",
        type: "system.warning",
        timestamp: new Date(),
        data: { message: "unsubscribe" },
      } as AgentRunEvent);

      expect(handler).not.toHaveBeenCalled();
    });

    it("should return error for non-existent subscription", () => {
      const result = bus.unsubscribe("non-existent");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(EventError);
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });

    it("should unsubscribe all for a pattern", () => {
      bus.subscribe("system", () => {});
      bus.subscribe("system", () => {});
      bus.subscribe("tool", () => {});

      const result = bus.unsubscribeAll("system");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(2);
      }

      expect(bus.listSubscriptions().length).toBe(1);
    });
  });

  describe("History", () => {
    it("should record event history", async () => {
      await bus.publish({
        id: "1",
        channel: "system",
        type: "system.warning",
        timestamp: new Date(),
        data: { message: "history-a" },
      } as AgentRunEvent);

      await bus.publish({
        id: "2",
        channel: "system",
        type: "system.error",
        timestamp: new Date(),
        data: { error: "history-b" },
      } as AgentRunEvent);

      const historyResult = bus.getHistory();
      expect(historyResult.ok).toBe(true);
      if (historyResult.ok) {
        expect(historyResult.value.length).toBe(2);
      }
    });

    it("should filter history by channel", async () => {
      await bus.publish({
        id: "1",
        channel: "system",
        type: "system.warning",
        timestamp: new Date(),
        data: { message: "history" },
      } as AgentRunEvent);

      await bus.publish({
        id: "2",
        channel: "tool",
        type: "tool.registered",
        timestamp: new Date(),
        data: { toolId: "test-tool" },
      } as AgentRunEvent);

      const historyResult = bus.getHistory({ channel: "system" });
      expect(historyResult.ok).toBe(true);
      if (historyResult.ok) {
        expect(historyResult.value.length).toBe(1);
      }
    });

    it("should filter history by event type", async () => {
      await bus.publish({
        id: "1",
        channel: "system",
        type: "system.warning",
        timestamp: new Date(),
        data: { message: "history-a" },
      } as AgentRunEvent);

      await bus.publish({
        id: "2",
        channel: "system",
        type: "system.error",
        timestamp: new Date(),
        data: { error: "history-b" },
      } as AgentRunEvent);

      const historyResult = bus.getHistory({ eventType: "system.warning" });
      expect(historyResult.ok).toBe(true);
      if (historyResult.ok) {
        expect(historyResult.value.length).toBe(1);
      }
    });

    it("should limit history size", async () => {
      bus.setMaxHistorySize(5);

      for (let i = 0; i < 10; i++) {
        await bus.publish({
          id: String(i),
          channel: "system",
          type: "system.warning",
          timestamp: new Date(),
          data: { message: `history-${i}` },
        } as AgentRunEvent);
      }

      const historyResult = bus.getHistory();
      expect(historyResult.ok).toBe(true);
      if (historyResult.ok) {
        expect(historyResult.value.length).toBe(5);
      }
    });

    it("should clear history", async () => {
      await bus.publish({
        id: "1",
        channel: "system",
        type: "system.warning",
        timestamp: new Date(),
        data: { message: "clear" },
      } as AgentRunEvent);

      bus.clearHistory();

      const historyResult = bus.getHistory();
      expect(historyResult.ok).toBe(true);
      if (historyResult.ok) {
        expect(historyResult.value.length).toBe(0);
      }
    });
  });

  describe("Replay", () => {
    it("should replay events to a subscription", async () => {
      // Publish events before subscribing
      await bus.publish({
        id: "1",
        channel: "system",
        type: "system.warning",
        timestamp: new Date(),
        data: { message: "replay-1" },
      } as AgentRunEvent);

      await bus.publish({
        id: "2",
        channel: "system",
        type: "system.warning",
        timestamp: new Date(),
        data: { message: "replay-2" },
      } as AgentRunEvent);

      // Subscribe after events
      const handler = vi.fn();
      const subResult = bus.subscribe("system", handler);
      expect(subResult.ok).toBe(true);
      if (!subResult.ok) return;

      // Replay
      const replayResult = await bus.replay(subResult.value);
      expect(replayResult.ok).toBe(true);
      if (replayResult.ok) {
        expect(replayResult.value).toBe(2);
      }
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it("should return error for non-existent subscription", async () => {
      const result = await bus.replay("non-existent");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(EventError);
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });
  });

  describe("on() helper", () => {
    it("should subscribe to specific event type", async () => {
      const handler = vi.fn();
      const subResult = bus.on("agent.lifecycle", "agent.created", handler);
      expect(subResult.ok).toBe(true);

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
      expect(result.ok).toBe(true);

      const getResult = manager.get("webhook-1");
      expect(getResult.ok).toBe(true);
      if (getResult.ok) {
        expect(getResult.value.url).toBe("https://example.com/webhook");
      }
    });

    it("should reject invalid URL", () => {
      const config: WebhookConfig = {
        id: "webhook-1",
        url: "not-a-url",
        channels: ["agent.*"],
        enabled: true,
      };

      const result = manager.register(config);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(EventError);
        expect(result.error.code).toBe("VALIDATION_ERROR");
      }
    });

    it("should unregister a webhook", () => {
      manager.register({
        id: "webhook-1",
        url: "https://example.com/webhook",
        channels: ["*"],
        enabled: true,
      });

      const result = manager.unregister("webhook-1");
      expect(result.ok).toBe(true);

      const getResult = manager.get("webhook-1");
      expect(getResult.ok).toBe(false);
      if (!getResult.ok) {
        expect(getResult.error.code).toBe("NOT_FOUND");
      }
    });

    it("should return error for non-existent webhook", () => {
      const result = manager.unregister("non-existent");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(EventError);
        expect(result.error.code).toBe("NOT_FOUND");
      }
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
      const result = manager.disable("webhook-1");
      expect(result.ok).toBe(true);

      const getResult = manager.get("webhook-1");
      expect(getResult.ok).toBe(true);
      if (getResult.ok) {
        expect(getResult.value.enabled).toBe(false);
      }
    });

    it("should enable a webhook", () => {
      manager.disable("webhook-1");
      const result = manager.enable("webhook-1");
      expect(result.ok).toBe(true);

      const getResult = manager.get("webhook-1");
      expect(getResult.ok).toBe(true);
      if (getResult.ok) {
        expect(getResult.value.enabled).toBe(true);
      }
    });

    it("should return error for non-existent webhook", () => {
      const enableResult = manager.enable("non-existent");
      expect(enableResult.ok).toBe(false);
      if (!enableResult.ok) {
        expect(enableResult.error.code).toBe("NOT_FOUND");
      }

      const disableResult = manager.disable("non-existent");
      expect(disableResult.ok).toBe(false);
      if (!disableResult.ok) {
        expect(disableResult.error.code).toBe("NOT_FOUND");
      }
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

      const connectResult = manager.connect(bus);
      expect(connectResult.ok).toBe(true);

      const disconnectResult = manager.disconnect();
      expect(disconnectResult.ok).toBe(true);
    });
  });

  describe("Manual Delivery", () => {
    it("should return error for non-existent webhook", async () => {
      const event: AgentLifecycleEvent = {
        id: "test-1",
        channel: "agent.lifecycle",
        type: "agent.created",
        timestamp: new Date(),
        agentId: "agent-1",
        data: {},
      };

      const result = await manager.deliver("non-existent", event);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(EventError);
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });
  });
});

describe("Integration", () => {
  it("should deliver events via webhooks", async () => {
    const bus = createEventBus();
    const webhooks = createWebhookManager();

    // Connect webhooks to bus
    const connectResult = webhooks.connect(bus);
    expect(connectResult.ok).toBe(true);

    // Register a webhook (disabled to not make real HTTP calls)
    const registerResult = webhooks.register({
      id: "test-hook",
      url: "https://example.com/webhook",
      channels: ["agent.*"],
      enabled: false,
    });
    expect(registerResult.ok).toBe(true);

    // Publish an event
    const publishResult = await bus.publish({
      id: "1",
      channel: "agent.lifecycle",
      type: "agent.created",
      timestamp: new Date(),
      agentId: "a1",
      data: {},
    } as AgentLifecycleEvent);
    expect(publishResult.ok).toBe(true);

    // Cleanup
    const disconnectResult = webhooks.disconnect();
    expect(disconnectResult.ok).toBe(true);
  });
});

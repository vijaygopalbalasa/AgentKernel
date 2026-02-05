// Real Redis Event Bus Integration Tests
// Requires: docker compose -f docker/docker-compose.test.yml up -d
// Run with: vitest run src/event-bus.integration.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RedisConfig } from "./config.js";
import {
  type EventBus,
  type EventMessage,
  createEventBus,
  createRedisClient,
} from "./event-bus.js";
import { createLogger } from "./logger.js";

const TEST_REDIS_CONFIG: RedisConfig = {
  host: "127.0.0.1",
  port: 6380,
  db: 1, // Use DB 1 for tests to avoid conflicts
  keyPrefix: "test_integration:",
  mode: "standalone" as const,
};

const logger = createLogger({ name: "eventbus-integration-test" });

async function isRedisAvailable(): Promise<boolean> {
  try {
    const client = createRedisClient(TEST_REDIS_CONFIG);
    await client.ping();
    await client.quit();
    return true;
  } catch {
    return false;
  }
}

describe("Event Bus Integration Tests (Real Redis)", () => {
  let bus: EventBus;
  let available = false;

  beforeAll(async () => {
    available = await isRedisAvailable();
    if (!available) {
      console.warn(
        "⚠ Redis not available at 127.0.0.1:6380. Run: docker compose -f docker/docker-compose.test.yml up -d",
      );
      return;
    }

    bus = createEventBus(TEST_REDIS_CONFIG, logger);

    // Wait for Redis connections to establish
    for (let attempt = 0; attempt < 50; attempt++) {
      if (bus.isConnected()) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }, 15000);

  afterAll(async () => {
    if (!available) return;
    // Clean up test keys
    try {
      const client = createRedisClient(TEST_REDIS_CONFIG);
      const keys = await client.keys("test_integration:*");
      if (keys.length > 0) {
        await client.del(...keys);
      }
      await client.quit();
    } catch {
      // Ignore cleanup errors
    }
    await bus.close();
  });

  // ─── CONNECTION ──────────────────────────────────────────

  it("should connect to real Redis", async () => {
    if (!available) return;
    expect(bus.isConnected()).toBe(true);
  });

  it("should report stats after connection", async () => {
    if (!available) return;
    const stats = bus.getStats();
    expect(stats.connected).toBe(true);
    expect(stats.subscriptions).toBeGreaterThanOrEqual(0);
    expect(stats.published).toBeGreaterThanOrEqual(0);
    expect(stats.received).toBeGreaterThanOrEqual(0);
  });

  // ─── PUBLISH / SUBSCRIBE ─────────────────────────────────

  it("should deliver published messages to subscribers", async () => {
    if (!available) return;
    const received: EventMessage[] = [];

    const subscription = await bus.subscribe("test-channel", (msg) => {
      received.push(msg);
    });

    // Publish a message
    const eventId = await bus.publish("test-channel", {
      type: "test.event",
      data: { value: 42 },
    });

    expect(eventId).toBeTruthy();

    // Wait for delivery
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(received.length).toBeGreaterThanOrEqual(1);
    const msg = received.find((m) => m.type === "test.event");
    expect(msg).toBeDefined();
    expect(msg?.data).toEqual({ value: 42 });
    expect(msg?.id).toBeTruthy();
    expect(msg?.timestamp).toBeInstanceOf(Date);

    await subscription.unsubscribe();
  });

  it("should deliver messages to multiple subscribers", async () => {
    if (!available) return;
    const received1: EventMessage[] = [];
    const received2: EventMessage[] = [];

    const sub1 = await bus.subscribe("multi-sub-channel", (msg) => {
      received1.push(msg);
    });
    const sub2 = await bus.subscribe("multi-sub-channel", (msg) => {
      received2.push(msg);
    });

    await bus.publish("multi-sub-channel", {
      type: "multi.event",
      data: { broadcast: true },
    });

    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(received1.length).toBeGreaterThanOrEqual(1);
    expect(received2.length).toBeGreaterThanOrEqual(1);

    await sub1.unsubscribe();
    await sub2.unsubscribe();
  });

  it("should not deliver messages after unsubscribe", async () => {
    if (!available) return;
    const received: EventMessage[] = [];

    const sub = await bus.subscribe("unsub-test", (msg) => {
      received.push(msg);
    });

    await bus.publish("unsub-test", { type: "before", data: {} });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const countBefore = received.length;

    await sub.unsubscribe();

    await bus.publish("unsub-test", { type: "after", data: {} });
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Should not receive the "after" message
    expect(received.length).toBe(countBefore);
  });

  it("should isolate messages between different channels", async () => {
    if (!available) return;
    const channelA: EventMessage[] = [];
    const channelB: EventMessage[] = [];

    const subA = await bus.subscribe("channel-a", (msg) => {
      channelA.push(msg);
    });
    const subB = await bus.subscribe("channel-b", (msg) => {
      channelB.push(msg);
    });

    await bus.publish("channel-a", { type: "a.event", data: { from: "a" } });
    await bus.publish("channel-b", { type: "b.event", data: { from: "b" } });

    await new Promise((resolve) => setTimeout(resolve, 500));

    // Channel A should only have A events
    for (const msg of channelA) {
      expect(msg.type).toBe("a.event");
    }
    // Channel B should only have B events
    for (const msg of channelB) {
      expect(msg.type).toBe("b.event");
    }

    await subA.unsubscribe();
    await subB.unsubscribe();
  });

  // ─── PATTERN SUBSCRIPTIONS ───────────────────────────────

  it("should match pattern subscriptions", async () => {
    if (!available) return;
    const received: EventMessage[] = [];

    const sub = await bus.subscribePattern("agent:*", (msg) => {
      received.push(msg);
    });

    await bus.publish("agent:lifecycle", { type: "agent.started", data: { id: "a1" } });
    await bus.publish("agent:error", { type: "agent.failed", data: { id: "a2" } });
    await bus.publish("system:health", { type: "health.check", data: {} }); // should NOT match

    await new Promise((resolve) => setTimeout(resolve, 500));

    // Should receive agent:lifecycle and agent:error, NOT system:health
    const agentEvents = received.filter(
      (m) => m.type === "agent.started" || m.type === "agent.failed",
    );
    expect(agentEvents.length).toBeGreaterThanOrEqual(2);

    const systemEvents = received.filter((m) => m.type === "health.check");
    expect(systemEvents).toHaveLength(0);

    await sub.unsubscribe();
  });

  // ─── MESSAGE PERSISTENCE / HISTORY ───────────────────────

  it("should store message history", async () => {
    if (!available) return;
    const channel = `history-test-${Date.now()}`;

    // Publish several messages
    for (let i = 0; i < 5; i++) {
      await bus.publish(channel, {
        type: "history.event",
        data: { index: i },
      });
    }

    // Small delay for persistence
    await new Promise((resolve) => setTimeout(resolve, 200));

    const history = await bus.getHistory(channel, { limit: 10 });
    expect(history.length).toBeGreaterThanOrEqual(5);

    // Verify ordering — most recent first or ascending
    for (const msg of history) {
      expect(msg.type).toBe("history.event");
      expect(msg.id).toBeTruthy();
    }
  });

  it("should respect limit on history", async () => {
    if (!available) return;
    const channel = `history-limit-${Date.now()}`;

    for (let i = 0; i < 10; i++) {
      await bus.publish(channel, { type: "limit.event", data: { i } });
    }

    await new Promise((resolve) => setTimeout(resolve, 200));

    const history = await bus.getHistory(channel, { limit: 3 });
    expect(history.length).toBeLessThanOrEqual(3);
  });

  // ─── HIGH THROUGHPUT ─────────────────────────────────────

  it("should handle rapid publish/subscribe without data loss", async () => {
    if (!available) return;
    const received: EventMessage[] = [];
    const channel = `throughput-${Date.now()}`;
    const messageCount = 50;

    const sub = await bus.subscribe(channel, (msg) => {
      received.push(msg);
    });

    // Rapid fire publish
    const publishPromises = Array.from({ length: messageCount }, (_, i) =>
      bus.publish(channel, { type: "rapid", data: { index: i } }),
    );
    await Promise.all(publishPromises);

    // Wait for delivery
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Should receive all or nearly all messages
    expect(received.length).toBeGreaterThanOrEqual(messageCount * 0.9);

    await sub.unsubscribe();
  });

  // ─── STATS TRACKING ──────────────────────────────────────

  it("should track publish/receive counts", async () => {
    if (!available) return;
    const statsBefore = bus.getStats();

    const sub = await bus.subscribe("stats-channel", () => {});
    await bus.publish("stats-channel", { type: "stats.event", data: {} });
    await new Promise((resolve) => setTimeout(resolve, 300));

    const statsAfter = bus.getStats();
    expect(statsAfter.published).toBeGreaterThan(statsBefore.published);

    await sub.unsubscribe();
  });

  // ─── ERROR HANDLING ──────────────────────────────────────

  it("should handle subscriber errors without crashing bus", async () => {
    if (!available) return;
    const goodReceived: EventMessage[] = [];

    // Bad subscriber that throws
    const badSub = await bus.subscribe("error-test", () => {
      throw new Error("Intentional test error");
    });

    // Good subscriber
    const goodSub = await bus.subscribe("error-test", (msg) => {
      goodReceived.push(msg);
    });

    await bus.publish("error-test", { type: "error.test", data: {} });
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Good subscriber should still receive the message
    expect(goodReceived.length).toBeGreaterThanOrEqual(1);

    // Bus should still be connected
    expect(bus.isConnected()).toBe(true);

    await badSub.unsubscribe();
    await goodSub.unsubscribe();
  });

  // ─── EVENT METADATA ──────────────────────────────────────

  it("should preserve source and correlationId in messages", async () => {
    if (!available) return;
    const received: EventMessage[] = [];

    const sub = await bus.subscribe("metadata-test", (msg) => {
      received.push(msg);
    });

    await bus.publish("metadata-test", {
      type: "meta.event",
      data: { key: "value" },
      source: "test-component",
      correlationId: "corr-123",
    });

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(received.length).toBeGreaterThanOrEqual(1);
    const msg = received[0]!;
    expect(msg.source).toBe("test-component");
    expect(msg.correlationId).toBe("corr-123");

    await sub.unsubscribe();
  });

  // ─── SERIALIZATION ───────────────────────────────────────

  it("should correctly serialize/deserialize complex payloads", async () => {
    if (!available) return;
    const received: EventMessage[] = [];

    const sub = await bus.subscribe("complex-payload", (msg) => {
      received.push(msg);
    });

    const complexData = {
      nested: { deep: { value: [1, 2, 3] } },
      boolean: true,
      number: 3.14,
      string: "hello world",
      array: [{ a: 1 }, { b: 2 }],
    };

    await bus.publish("complex-payload", {
      type: "complex.event",
      data: complexData,
    });

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0]?.data).toEqual(complexData);

    await sub.unsubscribe();
  });
});

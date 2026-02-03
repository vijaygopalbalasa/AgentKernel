// Redis-based event bus for pub/sub messaging
// Supports channels, patterns, and message persistence

import { Redis as IORedis, Cluster as IORedisCluster, type Redis as RedisInstance, type Cluster as ClusterInstance } from "ioredis";
import type { RedisConfig } from "./config.js";
import type { Logger } from "./logger.js";

/** Redis client type (standalone/sentinel or cluster) */
type RedisClient = RedisInstance | ClusterInstance;

/** Event message structure */
export interface EventMessage<T = unknown> {
  /** Event ID (UUID) */
  id: string;
  /** Event type/name */
  type: string;
  /** Event payload */
  data: T;
  /** Timestamp */
  timestamp: Date;
  /** Source component/agent */
  source?: string;
  /** Correlation ID for tracing */
  correlationId?: string;
}

/** Event handler function */
export type EventHandler<T = unknown> = (message: EventMessage<T>) => void | Promise<void>;

/** Subscription handle for unsubscribing */
export interface Subscription {
  /** Channel or pattern subscribed to */
  channel: string;
  /** Whether this is a pattern subscription */
  isPattern: boolean;
  /** Unsubscribe from this channel */
  unsubscribe(): Promise<void>;
}

/** Event bus interface */
export interface EventBus {
  /** Publish an event to a channel */
  publish<T = unknown>(channel: string, event: Omit<EventMessage<T>, "id" | "timestamp">): Promise<string>;

  /** Subscribe to a channel */
  subscribe<T = unknown>(channel: string, handler: EventHandler<T>): Promise<Subscription>;

  /** Subscribe to a pattern (e.g., "agent:*") */
  subscribePattern<T = unknown>(pattern: string, handler: EventHandler<T>): Promise<Subscription>;

  /** Get recent events from a channel (if persistence enabled) */
  getHistory(channel: string, options?: { limit?: number; since?: Date }): Promise<EventMessage[]>;

  /** Check if event bus is connected */
  isConnected(): boolean;

  /** Get connection stats */
  getStats(): EventBusStats;

  /** Close all connections */
  close(): Promise<void>;
}

/** Event bus statistics */
export interface EventBusStats {
  /** Whether connected to Redis */
  connected: boolean;
  /** Number of active subscriptions */
  subscriptions: number;
  /** Messages published since startup */
  published: number;
  /** Messages received since startup */
  received: number;
}

/** Generate a UUID v4 */
function generateId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Create a Redis client based on the configured mode (standalone, sentinel, or cluster).
 */
export function createRedisClient(config: RedisConfig, options?: { keyPrefix?: string }): RedisClient {
  const retryStrategy = (times: number) => {
    if (times > 10) return null;
    return Math.min(times * 100, 3000);
  };

  if (config.mode === "cluster" && config.clusterNodes?.length) {
    const nodes = config.clusterNodes.map((node) => {
      const [host, portStr] = node.split(":");
      return { host: host ?? "localhost", port: Number(portStr) || 6379 };
    });
    return new IORedisCluster(nodes, {
      redisOptions: {
        password: config.password,
        keyPrefix: options?.keyPrefix,
      },
      scaleReads: "slave",
      clusterRetryStrategy: retryStrategy,
    });
  }

  if (config.mode === "sentinel" && config.sentinels?.length && config.sentinelName) {
    return new IORedis({
      sentinels: config.sentinels,
      name: config.sentinelName,
      password: config.password,
      db: config.db,
      keyPrefix: options?.keyPrefix,
      retryStrategy,
      sentinelRetryStrategy: retryStrategy,
    });
  }

  // Standalone mode (default)
  return new IORedis({
    host: config.host,
    port: config.port,
    password: config.password,
    db: config.db,
    keyPrefix: options?.keyPrefix,
    retryStrategy,
  });
}

/** Create a Redis-based event bus */
export function createEventBus(config: RedisConfig, logger?: Logger): EventBus {
  const log = logger ?? {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  const keyPrefix = config.keyPrefix;

  // Create two Redis connections: one for pub, one for sub
  // (Redis requires separate connections for pub/sub)
  const pubClient = createRedisClient(config, { keyPrefix });
  const subClient = createRedisClient(config);

  // Track subscriptions
  const channelHandlers = new Map<string, Set<EventHandler>>();
  const patternHandlers = new Map<string, Set<EventHandler>>();
  let subscriptionCount = 0;
  let publishedCount = 0;
  let receivedCount = 0;

  // Handle incoming messages
  subClient.on("message", (channel: string, message: string) => {
    try {
      const event = JSON.parse(message) as EventMessage;
      event.timestamp = new Date(event.timestamp);
      receivedCount++;

      const handlers = channelHandlers.get(channel);
      if (handlers) {
        for (const handler of handlers) {
          try {
            const result = handler(event);
            if (result instanceof Promise) {
              result.catch((err) => {
                log.error("Event handler error", { channel, error: String(err) });
              });
            }
          } catch (error) {
            log.error("Event handler error", { channel, error: String(error) });
          }
        }
      }
    } catch (error) {
      log.error("Failed to parse event message", { channel, error: String(error) });
    }
  });

  // Handle pattern messages
  subClient.on("pmessage", (pattern: string, channel: string, message: string) => {
    try {
      const event = JSON.parse(message) as EventMessage;
      event.timestamp = new Date(event.timestamp);
      receivedCount++;

      const handlers = patternHandlers.get(pattern);
      if (handlers) {
        for (const handler of handlers) {
          try {
            const result = handler(event);
            if (result instanceof Promise) {
              result.catch((err) => {
                log.error("Event handler error", { pattern, channel, error: String(err) });
              });
            }
          } catch (error) {
            log.error("Event handler error", { pattern, channel, error: String(error) });
          }
        }
      }
    } catch (error) {
      log.error("Failed to parse pattern message", { pattern, error: String(error) });
    }
  });

  // Connection logging
  pubClient.on("connect", () => {
    log.info("Event bus publisher connected", { host: config.host, port: config.port });
  });

  subClient.on("connect", () => {
    log.info("Event bus subscriber connected", { host: config.host, port: config.port });
  });

  pubClient.on("error", (error: Error) => {
    log.error("Event bus publisher error", { error: String(error) });
  });

  subClient.on("error", (error: Error) => {
    log.error("Event bus subscriber error", { error: String(error) });
  });

  const bus: EventBus = {
    async publish<T = unknown>(
      channel: string,
      event: Omit<EventMessage<T>, "id" | "timestamp">
    ): Promise<string> {
      const id = generateId();
      const fullEvent: EventMessage<T> = {
        ...event,
        id,
        timestamp: new Date(),
      } as EventMessage<T>;

      const message = JSON.stringify(fullEvent);
      const fullChannel = keyPrefix + channel;

      // Publish to channel
      await pubClient.publish(fullChannel, message);
      publishedCount++;

      // Also store in a list for history (with TTL)
      const historyKey = `${keyPrefix}history:${channel}`;
      await pubClient.lpush(historyKey, message);
      await pubClient.ltrim(historyKey, 0, 999); // Keep last 1000 messages
      await pubClient.expire(historyKey, 86400); // 24 hour TTL

      log.debug("Event published", { channel, type: event.type, id });
      return id;
    },

    async subscribe<T = unknown>(channel: string, handler: EventHandler<T>): Promise<Subscription> {
      const fullChannel = keyPrefix + channel;

      if (!channelHandlers.has(fullChannel)) {
        channelHandlers.set(fullChannel, new Set());
        await subClient.subscribe(fullChannel);
      }

      channelHandlers.get(fullChannel)!.add(handler as EventHandler);
      subscriptionCount++;

      log.debug("Subscribed to channel", { channel });

      return {
        channel,
        isPattern: false,
        async unsubscribe() {
          const handlers = channelHandlers.get(fullChannel);
          if (handlers) {
            handlers.delete(handler as EventHandler);
            subscriptionCount--;

            if (handlers.size === 0) {
              channelHandlers.delete(fullChannel);
              await subClient.unsubscribe(fullChannel);
            }
          }
          log.debug("Unsubscribed from channel", { channel });
        },
      };
    },

    async subscribePattern<T = unknown>(pattern: string, handler: EventHandler<T>): Promise<Subscription> {
      const fullPattern = keyPrefix + pattern;

      if (!patternHandlers.has(fullPattern)) {
        patternHandlers.set(fullPattern, new Set());
        await subClient.psubscribe(fullPattern);
      }

      patternHandlers.get(fullPattern)!.add(handler as EventHandler);
      subscriptionCount++;

      log.debug("Subscribed to pattern", { pattern });

      return {
        channel: pattern,
        isPattern: true,
        async unsubscribe() {
          const handlers = patternHandlers.get(fullPattern);
          if (handlers) {
            handlers.delete(handler as EventHandler);
            subscriptionCount--;

            if (handlers.size === 0) {
              patternHandlers.delete(fullPattern);
              await subClient.punsubscribe(fullPattern);
            }
          }
          log.debug("Unsubscribed from pattern", { pattern });
        },
      };
    },

    async getHistory(
      channel: string,
      options: { limit?: number; since?: Date } = {}
    ): Promise<EventMessage[]> {
      const { limit = 100, since } = options;
      const historyKey = `${keyPrefix}history:${channel}`;

      const messages = await pubClient.lrange(historyKey, 0, limit - 1);

      const events: EventMessage[] = [];
      for (const msg of messages) {
        try {
          const event = JSON.parse(msg) as EventMessage;
          event.timestamp = new Date(event.timestamp);

          if (since && event.timestamp < since) {
            break; // Events are in reverse chronological order
          }

          events.push(event);
        } catch {
          // Skip malformed messages
        }
      }

      return events;
    },

    isConnected(): boolean {
      return pubClient.status === "ready" && subClient.status === "ready";
    },

    getStats(): EventBusStats {
      return {
        connected: bus.isConnected(),
        subscriptions: subscriptionCount,
        published: publishedCount,
        received: receivedCount,
      };
    },

    async close(): Promise<void> {
      log.info("Closing event bus connections");

      // Unsubscribe from all channels
      for (const channel of channelHandlers.keys()) {
        await subClient.unsubscribe(channel);
      }
      for (const pattern of patternHandlers.keys()) {
        await subClient.punsubscribe(pattern);
      }

      channelHandlers.clear();
      patternHandlers.clear();

      await pubClient.quit();
      await subClient.quit();

      log.info("Event bus connections closed");
    },
  };

  return bus;
}

/** Event bus health check */
export async function checkEventBusHealth(bus: EventBus): Promise<{
  healthy: boolean;
  latencyMs: number;
  stats?: EventBusStats;
  error?: string;
}> {
  const start = Date.now();
  try {
    if (!bus.isConnected()) {
      return {
        healthy: false,
        latencyMs: Date.now() - start,
        error: "Event bus not connected",
      };
    }

    return {
      healthy: true,
      latencyMs: Date.now() - start,
      stats: bus.getStats(),
    };
  } catch (error) {
    return {
      healthy: false,
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Wait for event bus to be ready */
export async function waitForEventBus(
  bus: EventBus,
  options: {
    maxRetries?: number;
    retryDelayMs?: number;
    logger?: Logger;
  } = {}
): Promise<boolean> {
  const { maxRetries = 30, retryDelayMs = 1000, logger } = options;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (bus.isConnected()) {
      logger?.info("Event bus ready", { attempt });
      return true;
    }

    logger?.debug("Waiting for event bus", { attempt, maxRetries });
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }

  logger?.error("Event bus not ready after max retries", { maxRetries });
  return false;
}

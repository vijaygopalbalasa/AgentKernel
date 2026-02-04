// Redis-backed Event Bus — uses kernel Redis pub/sub when available
// Falls back to in-memory EventBus for development

import { type Result, ok, err } from "@agentkernel/shared";
import { type Logger, createLogger, createEventBus as createKernelEventBus, type EventBus as KernelEventBus, type RedisConfig } from "@agentkernel/kernel";
import type {
  AgentKernelEvent,
  EventSubscription,
  EventHandler,
  SubscriptionOptions,
  EventBusStats,
  EventHistoryEntry,
  HistoryQueryOptions,
  ReplayOptions,
} from "./types.js";
import { EventError } from "./types.js";
import { EventBus } from "./bus.js";

/** Redis EventBus configuration */
export interface RedisEventBusConfig {
  /** Redis configuration */
  redis: RedisConfig;
  /** Channel prefix for namespacing */
  channelPrefix?: string;
  /** Max history size to keep in memory */
  maxHistorySize?: number;
}

/**
 * RedisEventBus — framework event bus backed by Redis pub/sub.
 * 
 * Uses the kernel's Redis event bus for cross-process event delivery,
 * while maintaining local subscriptions and history for framework events.
 * 
 * Falls back to in-memory EventBus if Redis is unavailable.
 */
export class RedisEventBus {
  private kernelBus: KernelEventBus | null = null;
  private localBus: EventBus;
  private subscriptions: Map<string, { channelPattern: string; kernelSub?: { unsubscribe: () => Promise<void> } }> = new Map();
  private history: EventHistoryEntry[] = [];
  private stats: EventBusStats = {
    totalEventsPublished: 0,
    totalSubscriptions: 0,
    channelCounts: {},
  };
  private maxHistorySize: number;
  private channelPrefix: string;
  private log: Logger;
  private useRedis: boolean = false;

  constructor(config?: RedisEventBusConfig) {
    this.log = createLogger({ name: "redis-event-bus" });
    this.localBus = new EventBus();
    this.maxHistorySize = config?.maxHistorySize ?? 1000;
    this.channelPrefix = config?.channelPrefix ?? "agentkernel:events:";

    if (config?.redis) {
      try {
        this.kernelBus = createKernelEventBus(config.redis, this.log);
        this.useRedis = true;
        this.log.info("Redis EventBus initialized", { host: config.redis.host, port: config.redis.port });
      } catch (error) {
        this.log.warn("Failed to initialize Redis EventBus, falling back to in-memory", {
          error: error instanceof Error ? error.message : String(error),
        });
        this.useRedis = false;
      }
    }
  }

  /**
   * Check if Redis is being used.
   */
  isRedisEnabled(): boolean {
    return this.useRedis && this.kernelBus !== null;
  }

  /**
   * Publish an event to the bus.
   */
  async publish(event: AgentKernelEvent): Promise<Result<void, EventError>> {
    // Ensure event has required fields
    if (!event.id) {
      event.id = this.generateEventId();
    }
    if (!event.timestamp) {
      event.timestamp = new Date();
    }

    // Update stats
    this.stats.totalEventsPublished++;
    this.stats.channelCounts[event.channel] =
      (this.stats.channelCounts[event.channel] ?? 0) + 1;
    this.stats.lastEventAt = event.timestamp;

    // Publish to Redis if available
    if (this.useRedis && this.kernelBus) {
      try {
        const redisChannel = this.channelPrefix + event.channel;
        await this.kernelBus.publish(redisChannel, {
          type: event.type,
          data: event,
          source: event.agentId,
          correlationId: event.correlationId,
        });
        this.log.debug("Event published to Redis", { channel: event.channel, eventId: event.id });
      } catch (error) {
        this.log.error("Failed to publish to Redis, using local delivery", {
          error: error instanceof Error ? error.message : String(error),
        });
        // Fall through to local delivery
      }
    }

    // Also publish locally for subscriptions in this process
    const localResult = await this.localBus.publish(event);

    // Record in local history
    const historyEntry: EventHistoryEntry = {
      event,
      deliveredTo: [],
      timestamp: new Date(),
    };
    this.addToHistory(historyEntry);

    return localResult;
  }

  /**
   * Subscribe to events matching a pattern.
   */
  subscribe(
    channelPattern: string,
    handler: EventHandler,
    options: SubscriptionOptions = {}
  ): Result<string, EventError> {
    // Subscribe locally
    const localResult = this.localBus.subscribe(channelPattern, handler, options);
    if (!localResult.ok) {
      return localResult;
    }

    const subscriptionId = localResult.value;

    // Also subscribe to Redis if available
    if (this.useRedis && this.kernelBus) {
      const redisPattern = this.channelPrefix + channelPattern;
      
      // Use pattern subscription for wildcard patterns
      const subscribePromise = channelPattern.includes("*")
        ? this.kernelBus.subscribePattern(redisPattern, async (message) => {
            try {
              const event = message.data as AgentKernelEvent;
              if (event) {
                await handler(event);
              }
            } catch (error) {
              this.log.error("Redis event handler error", {
                subscriptionId,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          })
        : this.kernelBus.subscribe(redisPattern, async (message) => {
            try {
              const event = message.data as AgentKernelEvent;
              if (event) {
                await handler(event);
              }
            } catch (error) {
              this.log.error("Redis event handler error", {
                subscriptionId,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          });

      subscribePromise.then((sub) => {
        this.subscriptions.set(subscriptionId, { channelPattern, kernelSub: sub });
      }).catch((error) => {
        this.log.warn("Failed to subscribe to Redis", {
          channelPattern,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    this.subscriptions.set(subscriptionId, { channelPattern });
    this.stats.totalSubscriptions = this.subscriptions.size;

    return ok(subscriptionId);
  }

  /**
   * Subscribe to a specific event type.
   */
  on(
    channelPattern: string,
    eventType: string,
    handler: EventHandler,
    options: SubscriptionOptions = {}
  ): Result<string, EventError> {
    const filter = (event: AgentKernelEvent) => {
      if (event.type !== eventType) return false;
      if (options.filter) return options.filter(event);
      return true;
    };

    return this.subscribe(channelPattern, handler, { ...options, filter });
  }

  /**
   * Subscribe for a single event.
   */
  once(
    channelPattern: string,
    handler: EventHandler,
    options: SubscriptionOptions = {}
  ): Result<string, EventError> {
    return this.subscribe(channelPattern, handler, { ...options, once: true });
  }

  /**
   * Unsubscribe by subscription ID.
   */
  async unsubscribe(subscriptionId: string): Promise<Result<void, EventError>> {
    const sub = this.subscriptions.get(subscriptionId);
    if (!sub) {
      return err(
        new EventError(
          `Subscription not found: ${subscriptionId}`,
          "NOT_FOUND"
        )
      );
    }

    // Unsubscribe from Redis
    if (sub.kernelSub) {
      try {
        await sub.kernelSub.unsubscribe();
      } catch (error) {
        this.log.warn("Failed to unsubscribe from Redis", {
          subscriptionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Unsubscribe locally
    this.localBus.unsubscribe(subscriptionId);
    this.subscriptions.delete(subscriptionId);
    this.stats.totalSubscriptions = this.subscriptions.size;

    return ok(undefined);
  }

  /**
   * Get event history.
   */
  getHistory(options: HistoryQueryOptions = {}): Result<EventHistoryEntry[], EventError> {
    let entries = [...this.history];

    if (options.channel) {
      entries = entries.filter((e) => e.event.channel === options.channel);
    }

    if (options.eventType) {
      entries = entries.filter((e) => e.event.type === options.eventType);
    }

    if (options.since) {
      entries = entries.filter((e) => e.timestamp >= options.since!);
    }

    if (options.limit) {
      entries = entries.slice(-options.limit);
    }

    return ok(entries);
  }

  /**
   * Get bus statistics.
   */
  getStats(): EventBusStats & { redisEnabled: boolean } {
    return { ...this.stats, redisEnabled: this.useRedis };
  }

  /**
   * Clear event history.
   */
  clearHistory(): void {
    this.history = [];
    this.localBus.clearHistory();
  }

  /**
   * Close all connections.
   */
  async close(): Promise<void> {
    // Unsubscribe all Redis subscriptions
    for (const [id, sub] of this.subscriptions) {
      if (sub.kernelSub) {
        try {
          await sub.kernelSub.unsubscribe();
        } catch {
          // Ignore errors during shutdown
        }
      }
    }
    this.subscriptions.clear();

    // Close kernel bus
    if (this.kernelBus) {
      await this.kernelBus.close();
      this.kernelBus = null;
    }

    this.log.info("Redis EventBus closed");
  }

  /** Add entry to history, trimming if needed */
  private addToHistory(entry: EventHistoryEntry): void {
    this.history.push(entry);
    if (this.history.length > this.maxHistorySize) {
      this.history = this.history.slice(-this.maxHistorySize);
    }
  }

  /** Generate unique event ID */
  private generateEventId(): string {
    return `evt-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }
}

/**
 * Create a Redis-backed event bus.
 * Falls back to in-memory if Redis config not provided.
 */
export function createRedisEventBus(config?: RedisEventBusConfig): RedisEventBus {
  return new RedisEventBus(config);
}

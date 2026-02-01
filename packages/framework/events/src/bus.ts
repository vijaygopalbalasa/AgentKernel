// Event Bus — pub/sub for Agent OS events
// Central event hub for all system events

import type {
  AgentOSEvent,
  EventSubscription,
  EventHandler,
  SubscriptionOptions,
  EventBusStats,
  EventHistoryEntry,
} from "./types.js";

/**
 * Event Bus — central pub/sub system for Agent OS events.
 *
 * Features:
 * - Publish events to channels
 * - Subscribe to channel patterns (wildcards supported)
 * - Priority-based handler execution
 * - Event history for replay
 * - Async handler support
 */
export class EventBus {
  private subscriptions: Map<string, EventSubscription> = new Map();
  private history: EventHistoryEntry[] = [];
  private stats: EventBusStats = {
    totalEventsPublished: 0,
    totalSubscriptions: 0,
    channelCounts: {},
  };
  private maxHistorySize: number = 1000;

  /**
   * Publish an event to the bus.
   */
  async publish(event: AgentOSEvent): Promise<void> {
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

    // Find matching subscriptions
    const matchingSubscriptions = this.findMatchingSubscriptions(event);

    // Sort by priority (higher first)
    matchingSubscriptions.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

    // Record in history
    const historyEntry: EventHistoryEntry = {
      event,
      deliveredTo: matchingSubscriptions.map((s) => s.id),
      timestamp: new Date(),
    };
    this.addToHistory(historyEntry);

    // Execute handlers
    const subscriptionsToRemove: string[] = [];

    for (const subscription of matchingSubscriptions) {
      try {
        await subscription.handler(event);
      } catch (err) {
        console.error(
          `Event handler error [${subscription.id}]:`,
          err instanceof Error ? err.message : err
        );
      }

      // Mark for removal if once: true
      if (subscription.once) {
        subscriptionsToRemove.push(subscription.id);
      }
    }

    // Remove one-time subscriptions
    for (const id of subscriptionsToRemove) {
      this.subscriptions.delete(id);
    }
  }

  /**
   * Subscribe to events matching a pattern.
   */
  subscribe(
    channelPattern: string,
    handler: EventHandler,
    options: SubscriptionOptions = {}
  ): string {
    const subscriptionId = this.generateSubscriptionId();

    const subscription: EventSubscription = {
      id: subscriptionId,
      channelPattern,
      handler,
      priority: options.priority ?? 0,
      once: options.once ?? false,
      filter: options.filter,
    };

    this.subscriptions.set(subscriptionId, subscription);
    this.stats.totalSubscriptions = this.subscriptions.size;

    return subscriptionId;
  }

  /**
   * Subscribe to a specific event type.
   */
  on(
    channelPattern: string,
    eventType: string,
    handler: EventHandler,
    options: SubscriptionOptions = {}
  ): string {
    const filter = (event: AgentOSEvent) => {
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
  ): string {
    return this.subscribe(channelPattern, handler, { ...options, once: true });
  }

  /**
   * Unsubscribe by subscription ID.
   */
  unsubscribe(subscriptionId: string): boolean {
    const result = this.subscriptions.delete(subscriptionId);
    this.stats.totalSubscriptions = this.subscriptions.size;
    return result;
  }

  /**
   * Unsubscribe all handlers for a channel pattern.
   */
  unsubscribeAll(channelPattern: string): number {
    let removed = 0;
    for (const [id, subscription] of this.subscriptions) {
      if (subscription.channelPattern === channelPattern) {
        this.subscriptions.delete(id);
        removed++;
      }
    }
    this.stats.totalSubscriptions = this.subscriptions.size;
    return removed;
  }

  /**
   * Get event history.
   */
  getHistory(options: {
    channel?: string;
    eventType?: string;
    limit?: number;
    since?: Date;
  } = {}): EventHistoryEntry[] {
    let entries = [...this.history];

    if (options.channel) {
      entries = entries.filter((e) =>
        this.matchPattern(options.channel!, e.event.channel)
      );
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

    return entries;
  }

  /**
   * Replay events from history.
   */
  async replay(
    subscriptionId: string,
    options: { since?: Date; eventTypes?: string[] } = {}
  ): Promise<number> {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return 0;

    let events = this.history.map((h) => h.event);

    if (options.since) {
      events = events.filter((e) => e.timestamp >= options.since!);
    }

    if (options.eventTypes) {
      events = events.filter((e) => options.eventTypes!.includes(e.type));
    }

    let replayed = 0;
    for (const event of events) {
      if (this.matchSubscription(subscription, event)) {
        try {
          await subscription.handler(event);
          replayed++;
        } catch {
          // Ignore errors during replay
        }
      }
    }

    return replayed;
  }

  /**
   * Get bus statistics.
   */
  getStats(): EventBusStats {
    return { ...this.stats };
  }

  /**
   * List all active subscriptions.
   */
  listSubscriptions(): EventSubscription[] {
    return Array.from(this.subscriptions.values());
  }

  /**
   * Clear event history.
   */
  clearHistory(): void {
    this.history = [];
  }

  /**
   * Set maximum history size.
   */
  setMaxHistorySize(size: number): void {
    this.maxHistorySize = size;
    this.trimHistory();
  }

  /**
   * Reset statistics.
   */
  resetStats(): void {
    this.stats = {
      totalEventsPublished: 0,
      totalSubscriptions: this.subscriptions.size,
      channelCounts: {},
    };
  }

  /** Find subscriptions matching an event */
  private findMatchingSubscriptions(event: AgentOSEvent): EventSubscription[] {
    const matching: EventSubscription[] = [];

    for (const subscription of this.subscriptions.values()) {
      if (this.matchSubscription(subscription, event)) {
        matching.push(subscription);
      }
    }

    return matching;
  }

  /** Check if subscription matches event */
  private matchSubscription(
    subscription: EventSubscription,
    event: AgentOSEvent
  ): boolean {
    // Check channel pattern
    if (!this.matchPattern(subscription.channelPattern, event.channel)) {
      return false;
    }

    // Check event type pattern
    if (
      subscription.typePattern &&
      !this.matchPattern(subscription.typePattern, event.type)
    ) {
      return false;
    }

    // Check filter function
    if (subscription.filter && !subscription.filter(event)) {
      return false;
    }

    return true;
  }

  /** Match a pattern with wildcards against a value */
  private matchPattern(pattern: string, value: string): boolean {
    // Exact match
    if (pattern === value) return true;

    // Wildcard patterns
    if (pattern === "*") return true;

    // "foo.*" matches "foo.bar" and "foo.baz"
    if (pattern.endsWith(".*")) {
      const prefix = pattern.slice(0, -2);
      return value.startsWith(prefix + ".");
    }

    // "*.bar" matches "foo.bar" and "baz.bar"
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(2);
      return value.endsWith("." + suffix);
    }

    // "foo.*.baz" matches "foo.bar.baz"
    if (pattern.includes(".*")) {
      const regex = new RegExp(
        "^" + pattern.replace(/\.\*/g, "\\.[^.]+") + "$"
      );
      return regex.test(value);
    }

    return false;
  }

  /** Add entry to history, trimming if needed */
  private addToHistory(entry: EventHistoryEntry): void {
    this.history.push(entry);
    this.trimHistory();
  }

  /** Trim history to max size */
  private trimHistory(): void {
    if (this.history.length > this.maxHistorySize) {
      this.history = this.history.slice(-this.maxHistorySize);
    }
  }

  /** Generate unique event ID */
  private generateEventId(): string {
    return `evt-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  /** Generate unique subscription ID */
  private generateSubscriptionId(): string {
    return `sub-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }
}

/** Create a new event bus */
export function createEventBus(): EventBus {
  return new EventBus();
}

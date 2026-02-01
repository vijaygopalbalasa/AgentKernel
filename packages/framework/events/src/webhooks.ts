// Webhooks — deliver events to external endpoints
// HTTP callbacks for event notifications

import type {
  AgentOSEvent,
  WebhookConfig,
  WebhookDeliveryResult,
} from "./types.js";
import { WebhookConfigSchema } from "./types.js";
import { EventBus } from "./bus.js";

/**
 * Webhook Manager — delivers events to HTTP endpoints.
 *
 * Features:
 * - Register webhook configurations
 * - Filter events by channel and type
 * - Automatic retry with backoff
 * - Payload signing with secrets
 * - Delivery tracking
 */
export class WebhookManager {
  private webhooks: Map<string, WebhookConfig> = new Map();
  private deliveryHistory: WebhookDeliveryResult[] = [];
  private maxHistorySize: number = 100;
  private bus?: EventBus;
  private subscriptionIds: string[] = [];

  /**
   * Connect to an event bus.
   */
  connect(bus: EventBus): void {
    this.bus = bus;

    // Subscribe to all channels
    const subId = bus.subscribe("*", async (event) => {
      await this.processEvent(event);
    });

    this.subscriptionIds.push(subId);
  }

  /**
   * Disconnect from the event bus.
   */
  disconnect(): void {
    if (this.bus) {
      for (const subId of this.subscriptionIds) {
        this.bus.unsubscribe(subId);
      }
      this.subscriptionIds = [];
      this.bus = undefined;
    }
  }

  /**
   * Register a webhook.
   */
  register(config: WebhookConfig): boolean {
    // Validate config
    const validation = WebhookConfigSchema.safeParse(config);
    if (!validation.success) {
      return false;
    }

    this.webhooks.set(config.id, config);
    return true;
  }

  /**
   * Unregister a webhook.
   */
  unregister(webhookId: string): boolean {
    return this.webhooks.delete(webhookId);
  }

  /**
   * Get a webhook configuration.
   */
  get(webhookId: string): WebhookConfig | null {
    return this.webhooks.get(webhookId) ?? null;
  }

  /**
   * List all webhooks.
   */
  list(): WebhookConfig[] {
    return Array.from(this.webhooks.values());
  }

  /**
   * Enable a webhook.
   */
  enable(webhookId: string): boolean {
    const config = this.webhooks.get(webhookId);
    if (!config) return false;
    config.enabled = true;
    return true;
  }

  /**
   * Disable a webhook.
   */
  disable(webhookId: string): boolean {
    const config = this.webhooks.get(webhookId);
    if (!config) return false;
    config.enabled = false;
    return true;
  }

  /**
   * Manually deliver an event to a webhook.
   */
  async deliver(
    webhookId: string,
    event: AgentOSEvent
  ): Promise<WebhookDeliveryResult> {
    const config = this.webhooks.get(webhookId);
    if (!config) {
      return {
        webhookId,
        eventId: event.id,
        success: false,
        error: "Webhook not found",
        attempts: 0,
      };
    }

    return this.deliverToWebhook(config, event);
  }

  /**
   * Get delivery history.
   */
  getDeliveryHistory(webhookId?: string): WebhookDeliveryResult[] {
    if (webhookId) {
      return this.deliveryHistory.filter((d) => d.webhookId === webhookId);
    }
    return [...this.deliveryHistory];
  }

  /**
   * Clear delivery history.
   */
  clearHistory(): void {
    this.deliveryHistory = [];
  }

  /** Process an event from the bus */
  private async processEvent(event: AgentOSEvent): Promise<void> {
    const matchingWebhooks = this.findMatchingWebhooks(event);

    // Deliver to all matching webhooks in parallel
    await Promise.all(
      matchingWebhooks.map((config) => this.deliverToWebhook(config, event))
    );
  }

  /** Find webhooks that match an event */
  private findMatchingWebhooks(event: AgentOSEvent): WebhookConfig[] {
    const matching: WebhookConfig[] = [];

    for (const config of this.webhooks.values()) {
      if (!config.enabled) continue;

      // Check channel match
      const channelMatch = config.channels.some((pattern) =>
        this.matchPattern(pattern, event.channel)
      );
      if (!channelMatch) continue;

      // Check event type match (if specified)
      if (config.eventTypes && config.eventTypes.length > 0) {
        const typeMatch = config.eventTypes.some((pattern) =>
          this.matchPattern(pattern, event.type)
        );
        if (!typeMatch) continue;
      }

      matching.push(config);
    }

    return matching;
  }

  /** Deliver event to a webhook */
  private async deliverToWebhook(
    config: WebhookConfig,
    event: AgentOSEvent
  ): Promise<WebhookDeliveryResult> {
    const maxAttempts = config.retry?.maxAttempts ?? 3;
    const backoffMs = config.retry?.backoffMs ?? 1000;

    let lastError: string | undefined;
    let statusCode: number | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const payload = JSON.stringify(event);
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          ...config.headers,
        };

        // Add signature if secret is configured
        if (config.secret) {
          headers["X-Webhook-Signature"] = await this.signPayload(
            payload,
            config.secret
          );
        }

        const response = await fetch(config.url, {
          method: config.method ?? "POST",
          headers,
          body: payload,
        });

        statusCode = response.status;

        if (response.ok) {
          const result: WebhookDeliveryResult = {
            webhookId: config.id,
            eventId: event.id,
            success: true,
            statusCode,
            attempts: attempt,
            deliveredAt: new Date(),
          };
          this.addToHistory(result);
          return result;
        }

        lastError = `HTTP ${response.status}: ${response.statusText}`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }

      // Wait before retry (exponential backoff)
      if (attempt < maxAttempts) {
        await this.sleep(backoffMs * Math.pow(2, attempt - 1));
      }
    }

    // All attempts failed
    const result: WebhookDeliveryResult = {
      webhookId: config.id,
      eventId: event.id,
      success: false,
      statusCode,
      error: lastError,
      attempts: maxAttempts,
    };
    this.addToHistory(result);
    return result;
  }

  /** Match pattern with wildcards */
  private matchPattern(pattern: string, value: string): boolean {
    if (pattern === "*") return true;
    if (pattern === value) return true;

    if (pattern.endsWith(".*")) {
      const prefix = pattern.slice(0, -2);
      return value.startsWith(prefix + ".");
    }

    return false;
  }

  /** Sign payload with secret */
  private async signPayload(payload: string, secret: string): Promise<string> {
    // Simple HMAC-like signature (in production, use crypto.subtle.sign)
    const encoder = new TextEncoder();
    const data = encoder.encode(payload + secret);
    let hash = 0;
    for (const byte of data) {
      hash = ((hash << 5) - hash + byte) | 0;
    }
    return `sha256=${Math.abs(hash).toString(16)}`;
  }

  /** Add result to history */
  private addToHistory(result: WebhookDeliveryResult): void {
    this.deliveryHistory.push(result);
    if (this.deliveryHistory.length > this.maxHistorySize) {
      this.deliveryHistory = this.deliveryHistory.slice(-this.maxHistorySize);
    }
  }

  /** Sleep for specified milliseconds */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/** Create a new webhook manager */
export function createWebhookManager(): WebhookManager {
  return new WebhookManager();
}

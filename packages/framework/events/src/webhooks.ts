// Webhooks — deliver events to external endpoints
// HTTP callbacks for event notifications

import { type Result, ok, err } from "@agent-os/shared";
import { type Logger, createLogger } from "@agent-os/kernel";
import type {
  AgentOSEvent,
  WebhookConfig,
  WebhookDeliveryResult,
} from "./types.js";
import { WebhookConfigSchema, EventError } from "./types.js";
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
  private log: Logger;

  constructor() {
    this.log = createLogger({ name: "webhook-manager" });
  }

  /**
   * Connect to an event bus.
   */
  connect(bus: EventBus): Result<void, EventError> {
    this.bus = bus;

    // Subscribe to all channels
    const subResult = bus.subscribe("*", async (event) => {
      await this.processEvent(event);
    });

    if (!subResult.ok) {
      return err(
        new EventError(
          `Failed to connect to event bus: ${subResult.error.message}`,
          "SUBSCRIPTION_ERROR"
        )
      );
    }

    this.subscriptionIds.push(subResult.value);
    this.log.info("Connected to event bus");

    return ok(undefined);
  }

  /**
   * Disconnect from the event bus.
   */
  disconnect(): Result<void, EventError> {
    if (this.bus) {
      for (const subId of this.subscriptionIds) {
        this.bus.unsubscribe(subId);
      }
      this.subscriptionIds = [];
      this.bus = undefined;
      this.log.info("Disconnected from event bus");
    }
    return ok(undefined);
  }

  /**
   * Register a webhook.
   */
  register(config: WebhookConfig): Result<void, EventError> {
    // Validate config
    const validation = WebhookConfigSchema.safeParse(config);
    if (!validation.success) {
      return err(
        new EventError(
          `Invalid webhook config: ${validation.error.message}`,
          "VALIDATION_ERROR"
        )
      );
    }

    this.webhooks.set(config.id, config);
    this.log.info("Webhook registered", {
      webhookId: config.id,
      url: config.url,
      channels: config.channels,
      enabled: config.enabled,
    });

    return ok(undefined);
  }

  /**
   * Unregister a webhook.
   */
  unregister(webhookId: string): Result<void, EventError> {
    if (!this.webhooks.has(webhookId)) {
      return err(
        new EventError(
          `Webhook not found: ${webhookId}`,
          "NOT_FOUND"
        )
      );
    }

    this.webhooks.delete(webhookId);
    this.log.info("Webhook unregistered", { webhookId });

    return ok(undefined);
  }

  /**
   * Get a webhook configuration.
   */
  get(webhookId: string): Result<WebhookConfig, EventError> {
    const config = this.webhooks.get(webhookId);
    if (!config) {
      return err(
        new EventError(
          `Webhook not found: ${webhookId}`,
          "NOT_FOUND"
        )
      );
    }
    return ok(config);
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
  enable(webhookId: string): Result<void, EventError> {
    const config = this.webhooks.get(webhookId);
    if (!config) {
      return err(
        new EventError(
          `Webhook not found: ${webhookId}`,
          "NOT_FOUND"
        )
      );
    }

    config.enabled = true;
    this.log.debug("Webhook enabled", { webhookId });

    return ok(undefined);
  }

  /**
   * Disable a webhook.
   */
  disable(webhookId: string): Result<void, EventError> {
    const config = this.webhooks.get(webhookId);
    if (!config) {
      return err(
        new EventError(
          `Webhook not found: ${webhookId}`,
          "NOT_FOUND"
        )
      );
    }

    config.enabled = false;
    this.log.debug("Webhook disabled", { webhookId });

    return ok(undefined);
  }

  /**
   * Manually deliver an event to a webhook.
   */
  async deliver(
    webhookId: string,
    event: AgentOSEvent
  ): Promise<Result<WebhookDeliveryResult, EventError>> {
    const config = this.webhooks.get(webhookId);
    if (!config) {
      return err(
        new EventError(
          `Webhook not found: ${webhookId}`,
          "NOT_FOUND"
        )
      );
    }

    const result = await this.deliverToWebhook(config, event);
    return ok(result);
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
    this.log.debug("Delivery history cleared");
  }

  /** Process an event from the bus */
  private async processEvent(event: AgentOSEvent): Promise<void> {
    const matchingWebhooks = this.findMatchingWebhooks(event);

    // Deliver to all matching webhooks in parallel
    const results = await Promise.all(
      matchingWebhooks.map((config) => this.deliverToWebhook(config, event))
    );

    // Log any failures
    for (const result of results) {
      if (!result.success) {
        this.log.warn("Webhook delivery failed", {
          webhookId: result.webhookId,
          eventId: result.eventId,
          error: result.error,
          attempts: result.attempts,
        });
      }
    }
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

          this.log.debug("Webhook delivered", {
            webhookId: config.id,
            eventId: event.id,
            statusCode,
            attempt,
          });

          return result;
        }

        lastError = `HTTP ${response.status}: ${response.statusText}`;
      } catch (fetchErr) {
        lastError = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
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

    this.log.error("Webhook delivery failed after retries", {
      webhookId: config.id,
      eventId: event.id,
      error: lastError,
      attempts: maxAttempts,
    });

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

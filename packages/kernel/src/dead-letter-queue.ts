// Dead Letter Queue (DLQ) Implementation
// Captures failed events/tasks for later retry or analysis

import { z } from "zod";
import { type Result, ok, err } from "@agentkernel/shared";
import { createLogger } from "./logger.js";

const log = createLogger({ name: "dead-letter-queue" });

// ─── TYPES ──────────────────────────────────────────────────

export type DlqStatus = "pending" | "retrying" | "resolved" | "abandoned";

export const DeadLetterSchema = z.object({
  id: z.string().uuid(),
  originalEvent: z.unknown(),
  errorMessage: z.string(),
  retryCount: z.number().min(0).default(0),
  createdAt: z.date(),
  lastRetryAt: z.date().optional(),
  status: z.enum(["pending", "retrying", "resolved", "abandoned"]).default("pending"),
  metadata: z.record(z.unknown()).optional(),
});

export type DeadLetter = z.infer<typeof DeadLetterSchema>;

export const DlqConfigSchema = z.object({
  maxRetries: z.number().min(1).optional().default(3),
  retryDelay: z.number().min(1000).optional().default(60000), // 1 minute
  backoffMultiplier: z.number().min(1).optional().default(2),
  maxAge: z.number().min(60000).optional().default(7 * 24 * 60 * 60 * 1000), // 7 days
});

export type DlqConfig = z.infer<typeof DlqConfigSchema>;

export interface DlqStorage {
  add(letter: DeadLetter): Promise<void>;
  get(id: string): Promise<DeadLetter | null>;
  update(id: string, updates: Partial<DeadLetter>): Promise<void>;
  list(filter?: { status?: DlqStatus; limit?: number; offset?: number }): Promise<DeadLetter[]>;
  count(status?: DlqStatus): Promise<number>;
  delete(id: string): Promise<void>;
  purge(olderThan?: Date): Promise<number>;
}

// ─── IN-MEMORY STORAGE ──────────────────────────────────────

/**
 * In-memory DLQ storage for development/testing.
 */
export class InMemoryDlqStorage implements DlqStorage {
  private letters: Map<string, DeadLetter> = new Map();

  async add(letter: DeadLetter): Promise<void> {
    this.letters.set(letter.id, letter);
  }

  async get(id: string): Promise<DeadLetter | null> {
    return this.letters.get(id) ?? null;
  }

  async update(id: string, updates: Partial<DeadLetter>): Promise<void> {
    const letter = this.letters.get(id);
    if (letter) {
      this.letters.set(id, { ...letter, ...updates });
    }
  }

  async list(filter?: { status?: DlqStatus; limit?: number; offset?: number }): Promise<DeadLetter[]> {
    let results = Array.from(this.letters.values());

    if (filter?.status) {
      results = results.filter((l) => l.status === filter.status);
    }

    results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? 100;

    return results.slice(offset, offset + limit);
  }

  async count(status?: DlqStatus): Promise<number> {
    if (status) {
      return Array.from(this.letters.values()).filter((l) => l.status === status).length;
    }
    return this.letters.size;
  }

  async delete(id: string): Promise<void> {
    this.letters.delete(id);
  }

  async purge(olderThan?: Date): Promise<number> {
    const cutoff = olderThan ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    let count = 0;

    for (const [id, letter] of this.letters.entries()) {
      if (letter.createdAt < cutoff) {
        this.letters.delete(id);
        count++;
      }
    }

    return count;
  }

  clear(): void {
    this.letters.clear();
  }
}

// ─── DEAD LETTER QUEUE CLASS ────────────────────────────────

/**
 * Dead Letter Queue for handling failed events.
 */
export class DeadLetterQueue {
  private config: DlqConfig;
  private storage: DlqStorage;
  private retryHandlers: Map<string, (letter: DeadLetter) => Promise<boolean>> = new Map();
  private retryTimer?: ReturnType<typeof setInterval>;

  constructor(storage: DlqStorage, config: Partial<DlqConfig> = {}) {
    this.storage = storage;
    this.config = DlqConfigSchema.parse(config);
  }

  /**
   * Add a failed event to the DLQ.
   */
  async add(
    originalEvent: unknown,
    errorMessage: string,
    metadata?: Record<string, unknown>
  ): Promise<Result<string, Error>> {
    try {
      const id = crypto.randomUUID();
      const letter: DeadLetter = {
        id,
        originalEvent,
        errorMessage,
        retryCount: 0,
        createdAt: new Date(),
        status: "pending",
        metadata,
      };

      await this.storage.add(letter);

      log.warn("Event added to dead letter queue", {
        id,
        errorMessage,
        metadata,
      });

      return ok(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err(new Error(`Failed to add to DLQ: ${message}`));
    }
  }

  /**
   * Get a dead letter by ID.
   */
  async get(id: string): Promise<DeadLetter | null> {
    return this.storage.get(id);
  }

  /**
   * List dead letters with optional filtering.
   */
  async list(filter?: {
    status?: DlqStatus;
    limit?: number;
    offset?: number;
  }): Promise<DeadLetter[]> {
    return this.storage.list(filter);
  }

  /**
   * Count dead letters.
   */
  async count(status?: DlqStatus): Promise<number> {
    return this.storage.count(status);
  }

  /**
   * Register a retry handler for a specific event type.
   */
  registerRetryHandler(
    eventType: string,
    handler: (letter: DeadLetter) => Promise<boolean>
  ): void {
    this.retryHandlers.set(eventType, handler);
  }

  /**
   * Retry a specific dead letter.
   */
  async retry(id: string): Promise<Result<boolean, Error>> {
    try {
      const letter = await this.storage.get(id);
      if (!letter) {
        return err(new Error(`Dead letter not found: ${id}`));
      }

      if (letter.status === "resolved" || letter.status === "abandoned") {
        return err(new Error(`Dead letter already ${letter.status}`));
      }

      if (letter.retryCount >= this.config.maxRetries) {
        await this.storage.update(id, { status: "abandoned" });
        log.warn("Dead letter abandoned after max retries", {
          id,
          retryCount: letter.retryCount,
        });
        return ok(false);
      }

      // Update status to retrying
      await this.storage.update(id, {
        status: "retrying",
        retryCount: letter.retryCount + 1,
        lastRetryAt: new Date(),
      });

      // Find appropriate handler
      const eventType = this.getEventType(letter.originalEvent);
      const handler = this.retryHandlers.get(eventType);

      if (!handler) {
        log.warn("No retry handler for event type", { eventType, id });
        await this.storage.update(id, { status: "pending" });
        return ok(false);
      }

      try {
        const success = await handler(letter);

        if (success) {
          await this.storage.update(id, { status: "resolved" });
          log.info("Dead letter successfully retried", { id });
          return ok(true);
        } else {
          await this.storage.update(id, { status: "pending" });
          return ok(false);
        }
      } catch (retryError) {
        const message = retryError instanceof Error ? retryError.message : String(retryError);
        await this.storage.update(id, {
          status: "pending",
          errorMessage: `${letter.errorMessage}; Retry failed: ${message}`,
        });
        log.warn("Dead letter retry failed", { id, error: message });
        return ok(false);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err(new Error(`Retry failed: ${message}`));
    }
  }

  /**
   * Mark a dead letter as resolved.
   */
  async resolve(id: string): Promise<Result<void, Error>> {
    try {
      await this.storage.update(id, { status: "resolved" });
      log.info("Dead letter marked as resolved", { id });
      return ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err(new Error(`Failed to resolve: ${message}`));
    }
  }

  /**
   * Mark a dead letter as abandoned.
   */
  async abandon(id: string): Promise<Result<void, Error>> {
    try {
      await this.storage.update(id, { status: "abandoned" });
      log.info("Dead letter marked as abandoned", { id });
      return ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err(new Error(`Failed to abandon: ${message}`));
    }
  }

  /**
   * Purge old dead letters.
   */
  async purge(olderThan?: Date): Promise<Result<number, Error>> {
    try {
      const count = await this.storage.purge(olderThan);
      log.info("Dead letters purged", { count });
      return ok(count);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err(new Error(`Purge failed: ${message}`));
    }
  }

  /**
   * Start automatic retry processing.
   */
  startAutoRetry(intervalMs?: number): void {
    if (this.retryTimer) return;

    const interval = intervalMs ?? this.config.retryDelay;

    this.retryTimer = setInterval(async () => {
      try {
        await this.processRetries();
      } catch (error) {
        log.error("Auto-retry processing failed", { error });
      }
    }, interval);

    log.info("DLQ auto-retry started", { interval });
  }

  /**
   * Stop automatic retry processing.
   */
  stopAutoRetry(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = undefined;
      log.info("DLQ auto-retry stopped");
    }
  }

  /**
   * Process pending retries.
   */
  private async processRetries(): Promise<void> {
    const pending = await this.storage.list({ status: "pending", limit: 10 });

    for (const letter of pending) {
      // Check if enough time has passed since last retry
      if (letter.lastRetryAt) {
        const delay = this.calculateBackoff(letter.retryCount);
        const elapsed = Date.now() - letter.lastRetryAt.getTime();
        if (elapsed < delay) continue;
      }

      await this.retry(letter.id);
    }
  }

  /**
   * Calculate backoff delay for retry.
   */
  private calculateBackoff(retryCount: number): number {
    return this.config.retryDelay * Math.pow(this.config.backoffMultiplier, retryCount);
  }

  /**
   * Extract event type from original event.
   */
  private getEventType(event: unknown): string {
    if (typeof event === "object" && event !== null && "type" in event) {
      return String((event as { type: unknown }).type);
    }
    return "unknown";
  }

  /**
   * Get DLQ statistics.
   */
  async getStats(): Promise<{
    pending: number;
    retrying: number;
    resolved: number;
    abandoned: number;
    total: number;
  }> {
    const [pending, retrying, resolved, abandoned] = await Promise.all([
      this.storage.count("pending"),
      this.storage.count("retrying"),
      this.storage.count("resolved"),
      this.storage.count("abandoned"),
    ]);

    return {
      pending,
      retrying,
      resolved,
      abandoned,
      total: pending + retrying + resolved + abandoned,
    };
  }
}

// ─── GLOBAL DLQ INSTANCE ────────────────────────────────────

let globalDlq: DeadLetterQueue | undefined;

/**
 * Get or create the global DLQ.
 */
export function getDeadLetterQueue(
  storage?: DlqStorage,
  config?: Partial<DlqConfig>
): DeadLetterQueue {
  if (!globalDlq) {
    globalDlq = new DeadLetterQueue(storage ?? new InMemoryDlqStorage(), config);
  }
  return globalDlq;
}

/**
 * Reset the global DLQ.
 */
export function resetDeadLetterQueue(): void {
  if (globalDlq) {
    globalDlq.stopAutoRetry();
    globalDlq = undefined;
  }
}

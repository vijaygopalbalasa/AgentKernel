// Retry Utility with Exponential Backoff and Jitter
// Provides resilient retry logic for transient failures

import { z } from "zod";
import { type Result, ok, err } from "@agentkernel/shared";
import { createLogger } from "./logger.js";

const log = createLogger({ name: "retry" });

// ─── TYPES ──────────────────────────────────────────────────

export const RetryConfigSchema = z.object({
  maxRetries: z.number().min(0).optional().default(3),
  baseDelay: z.number().min(10).optional().default(1000), // ms
  maxDelay: z.number().min(100).optional().default(30000), // ms
  jitterFactor: z.number().min(0).max(1).optional().default(0.2),
  exponentialBase: z.number().min(1).optional().default(2),
});

export type RetryConfig = z.infer<typeof RetryConfigSchema>;

export interface RetryContext {
  attempt: number;
  maxAttempts: number;
  lastError?: Error;
  totalElapsed: number;
}

export type RetryableErrorFilter = (error: Error) => boolean;

// ─── DEFAULT ERROR FILTERS ──────────────────────────────────

/**
 * Check if error is a connection error (retryable).
 */
export function isConnectionError(error: Error): boolean {
  const message = error.message.toLowerCase();
  const retryablePatterns = [
    "econnrefused",
    "econnreset",
    "etimedout",
    "enotfound",
    "socket hang up",
    "network",
    "connection",
    "timeout",
  ];
  return retryablePatterns.some((p) => message.includes(p));
}

/**
 * Check if error is a rate limit error (retryable).
 */
export function isRateLimitError(error: Error): boolean {
  const httpError = error as Error & { status?: number; statusCode?: number };
  return httpError.status === 429 || httpError.statusCode === 429;
}

/**
 * Check if error is a server error (retryable).
 */
export function isServerError(error: Error): boolean {
  const httpError = error as Error & { status?: number; statusCode?: number };
  const status = httpError.status || httpError.statusCode;
  return status !== undefined && status >= 500 && status < 600;
}

/**
 * Check if error is NOT retryable (auth, validation, etc.).
 */
export function isNonRetryableError(error: Error): boolean {
  const httpError = error as Error & { status?: number; statusCode?: number };
  const status = httpError.status || httpError.statusCode;

  // Auth failures (401, 403)
  if (status === 401 || status === 403) return true;

  // Validation errors (400)
  if (status === 400) return true;

  // Not found (404) - usually not retryable
  if (status === 404) return true;

  // Check for explicit non-retryable markers
  const message = error.message.toLowerCase();
  const nonRetryablePatterns = [
    "authentication",
    "unauthorized",
    "forbidden",
    "invalid",
    "permission denied",
    "not found",
    "bad request",
  ];

  return nonRetryablePatterns.some((p) => message.includes(p));
}

/**
 * Default retryable error filter.
 */
export function isRetryableError(error: Error): boolean {
  // Non-retryable errors take precedence
  if (isNonRetryableError(error)) return false;

  // Check retryable conditions
  return isConnectionError(error) || isRateLimitError(error) || isServerError(error);
}

// ─── BACKOFF CALCULATION ────────────────────────────────────

/**
 * Calculate delay with exponential backoff and jitter.
 */
export function calculateDelay(
  attempt: number,
  config: RetryConfig
): number {
  // Exponential backoff: base * (exponentialBase ^ attempt)
  const exponentialDelay = config.baseDelay * Math.pow(config.exponentialBase, attempt);

  // Cap at maxDelay
  const cappedDelay = Math.min(exponentialDelay, config.maxDelay);

  // Add full jitter: random value between 0 and cappedDelay
  // This prevents thundering herd by spreading retries across the full delay window
  const jitter = cappedDelay * config.jitterFactor * Math.random();

  // Ensure positive delay
  return Math.max(config.baseDelay, Math.floor(cappedDelay + jitter));
}

// ─── RETRY FUNCTION ─────────────────────────────────────────

/**
 * Execute an operation with retry logic.
 */
export async function retry<T>(
  operation: (context: RetryContext) => Promise<T>,
  config: Partial<RetryConfig> = {},
  isRetryable: RetryableErrorFilter = isRetryableError
): Promise<Result<T, Error>> {
  const cfg = RetryConfigSchema.parse(config);
  const maxAttempts = cfg.maxRetries + 1; // +1 for initial attempt
  const startTime = Date.now();

  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const context: RetryContext = {
      attempt,
      maxAttempts,
      lastError,
      totalElapsed: Date.now() - startTime,
    };

    try {
      const result = await operation(context);
      return ok(result);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if we should retry
      if (attempt >= cfg.maxRetries) {
        log.warn("Max retries exceeded", {
          attempts: attempt + 1,
          error: lastError.message,
        });
        break;
      }

      if (!isRetryable(lastError)) {
        log.debug("Error not retryable", {
          attempt,
          error: lastError.message,
        });
        break;
      }

      // Calculate delay and wait
      const delay = calculateDelay(attempt, cfg);
      log.debug("Retrying after delay", {
        attempt,
        delay,
        error: lastError.message,
      });

      await sleep(delay);
    }
  }

  return err(lastError ?? new Error("Retry failed with no error"));
}

/**
 * Retry with a simple async function (no context).
 */
export async function retryAsync<T>(
  operation: () => Promise<T>,
  config: Partial<RetryConfig> = {},
  isRetryable: RetryableErrorFilter = isRetryableError
): Promise<Result<T, Error>> {
  return retry(() => operation(), config, isRetryable);
}

// ─── RETRY DECORATOR ────────────────────────────────────────

/**
 * Create a retryable version of an async function.
 */
export function withRetry<T extends (...args: unknown[]) => Promise<unknown>>(
  fn: T,
  config: Partial<RetryConfig> = {},
  isRetryable: RetryableErrorFilter = isRetryableError
): T {
  return (async (...args: Parameters<T>) => {
    const result = await retry(() => fn(...args), config, isRetryable);
    if (result.ok) {
      return result.value;
    }
    throw result.error;
  }) as T;
}

// ─── SPECIALIZED RETRY CONFIGS ──────────────────────────────

/**
 * Retry config for database operations.
 */
export const dbRetryConfig: Partial<RetryConfig> = {
  maxRetries: 3,
  baseDelay: 500,
  maxDelay: 5000,
  jitterFactor: 0.1,
};

/**
 * Retry config for Redis operations.
 */
export const redisRetryConfig: Partial<RetryConfig> = {
  maxRetries: 3,
  baseDelay: 200,
  maxDelay: 2000,
  jitterFactor: 0.1,
};

/**
 * Retry config for LLM API calls.
 */
export const llmRetryConfig: Partial<RetryConfig> = {
  maxRetries: 2,
  baseDelay: 1000,
  maxDelay: 10000,
  jitterFactor: 0.2,
};

/**
 * Retry config for connection establishment.
 */
export const connectionRetryConfig: Partial<RetryConfig> = {
  maxRetries: 5,
  baseDelay: 1000,
  maxDelay: 30000,
  jitterFactor: 0.3,
  exponentialBase: 2,
};

// ─── HELPER ─────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

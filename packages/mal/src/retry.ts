// Retry logic with exponential backoff and jitter
// Handles transient failures gracefully

import type { Result } from "@agent-os/shared";
import { err } from "@agent-os/shared";
import type { Logger } from "@agent-os/kernel";

/** Retry configuration */
export interface RetryConfig {
  /** Maximum number of retry attempts */
  maxRetries: number;
  /** Initial delay in milliseconds */
  initialDelayMs: number;
  /** Maximum delay in milliseconds */
  maxDelayMs: number;
  /** Backoff multiplier (e.g., 2 for exponential) */
  backoffMultiplier: number;
  /** Jitter factor (0-1, adds randomness to prevent thundering herd) */
  jitterFactor: number;
  /** Errors that should trigger a retry */
  retryableErrors?: string[];
  /** HTTP status codes that should trigger a retry */
  retryableStatusCodes?: number[];
}

/** Retry state for tracking attempts */
export interface RetryState {
  /** Current attempt number (1-indexed) */
  attempt: number;
  /** Total elapsed time across all attempts */
  elapsedMs: number;
  /** Last error encountered */
  lastError?: Error;
  /** Whether retry is exhausted */
  exhausted: boolean;
}

/** Default retry configuration */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  jitterFactor: 0.2,
  retryableErrors: [
    "ECONNRESET",
    "ETIMEDOUT",
    "ECONNREFUSED",
    "ENOTFOUND",
    "EAI_AGAIN",
    "socket hang up",
    "network error",
    "timeout",
    "rate limit",
    "overloaded",
    "temporarily unavailable",
  ],
  retryableStatusCodes: [
    408, // Request Timeout
    429, // Too Many Requests
    500, // Internal Server Error
    502, // Bad Gateway
    503, // Service Unavailable
    504, // Gateway Timeout
  ],
};

/** Check if an error is retryable */
export function isRetryableError(
  error: Error,
  config: RetryConfig = DEFAULT_RETRY_CONFIG
): boolean {
  const errorMessage = error.message.toLowerCase();
  const errorName = error.name.toLowerCase();

  // Check against retryable error patterns
  for (const pattern of config.retryableErrors ?? []) {
    if (
      errorMessage.includes(pattern.toLowerCase()) ||
      errorName.includes(pattern.toLowerCase())
    ) {
      return true;
    }
  }

  // Check for HTTP status codes in error
  const statusMatch = error.message.match(/status[:\s]*(\d{3})/i);
  if (statusMatch && statusMatch[1]) {
    const status = parseInt(statusMatch[1], 10);
    if (config.retryableStatusCodes?.includes(status)) {
      return true;
    }
  }

  // Check for Anthropic/OpenAI specific errors
  if ("status" in error && typeof (error as { status: unknown }).status === "number") {
    const status = (error as { status: number }).status;
    if (config.retryableStatusCodes?.includes(status)) {
      return true;
    }
  }

  return false;
}

/** Calculate delay for a retry attempt */
export function calculateRetryDelay(
  attempt: number,
  config: RetryConfig = DEFAULT_RETRY_CONFIG
): number {
  // Exponential backoff
  const exponentialDelay =
    config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt - 1);

  // Cap at max delay
  const cappedDelay = Math.min(exponentialDelay, config.maxDelayMs);

  // Add jitter
  const jitter = cappedDelay * config.jitterFactor * (Math.random() * 2 - 1);
  const finalDelay = Math.max(0, cappedDelay + jitter);

  return Math.round(finalDelay);
}

/** Retry options for withRetry */
export interface WithRetryOptions<T> {
  /** The operation to retry */
  operation: () => Promise<Result<T>>;
  /** Custom retry configuration */
  config?: Partial<RetryConfig>;
  /** Logger for retry attempts */
  logger?: Logger;
  /** Operation name for logging */
  operationName?: string;
  /** Callback before each retry */
  onRetry?: (state: RetryState) => void | Promise<void>;
  /** Custom error classifier */
  isRetryable?: (error: Error) => boolean;
}

/** Execute an operation with retry logic */
export async function withRetry<T>(
  options: WithRetryOptions<T>
): Promise<Result<T>> {
  const {
    operation,
    config: customConfig,
    logger,
    operationName = "operation",
    onRetry,
    isRetryable = (e) => isRetryableError(e, finalConfig),
  } = options;

  const finalConfig: RetryConfig = {
    ...DEFAULT_RETRY_CONFIG,
    ...customConfig,
  };

  const state: RetryState = {
    attempt: 0,
    elapsedMs: 0,
    exhausted: false,
  };

  const startTime = Date.now();

  while (state.attempt <= finalConfig.maxRetries) {
    state.attempt++;
    state.elapsedMs = Date.now() - startTime;

    try {
      logger?.debug(`Executing ${operationName}`, {
        attempt: state.attempt,
        maxRetries: finalConfig.maxRetries,
      });

      const result = await operation();

      if (result.ok) {
        if (state.attempt > 1) {
          logger?.info(`${operationName} succeeded after retry`, {
            attempt: state.attempt,
            elapsedMs: state.elapsedMs,
          });
        }
        return result;
      }

      // Operation returned an error result
      state.lastError = result.error;

      if (!isRetryable(result.error)) {
        logger?.debug(`${operationName} failed with non-retryable error`, {
          error: result.error.message,
          attempt: state.attempt,
        });
        return result;
      }

      if (state.attempt > finalConfig.maxRetries) {
        state.exhausted = true;
        logger?.warn(`${operationName} exhausted retries`, {
          attempt: state.attempt,
          maxRetries: finalConfig.maxRetries,
          lastError: result.error.message,
          elapsedMs: state.elapsedMs,
        });
        return result;
      }

      // Calculate delay and wait
      const delay = calculateRetryDelay(state.attempt, finalConfig);

      logger?.debug(`${operationName} retrying after error`, {
        error: result.error.message,
        attempt: state.attempt,
        delayMs: delay,
      });

      if (onRetry) {
        await onRetry(state);
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
    } catch (error) {
      // Unexpected throw (should use Result type, but handle anyway)
      const wrappedError =
        error instanceof Error ? error : new Error(String(error));
      state.lastError = wrappedError;

      if (!isRetryable(wrappedError)) {
        logger?.debug(`${operationName} threw non-retryable error`, {
          error: wrappedError.message,
          attempt: state.attempt,
        });
        return err(wrappedError);
      }

      if (state.attempt > finalConfig.maxRetries) {
        state.exhausted = true;
        logger?.warn(`${operationName} exhausted retries (thrown error)`, {
          attempt: state.attempt,
          maxRetries: finalConfig.maxRetries,
          lastError: wrappedError.message,
          elapsedMs: state.elapsedMs,
        });
        return err(wrappedError);
      }

      const delay = calculateRetryDelay(state.attempt, finalConfig);

      logger?.debug(`${operationName} retrying after thrown error`, {
        error: wrappedError.message,
        attempt: state.attempt,
        delayMs: delay,
      });

      if (onRetry) {
        await onRetry(state);
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // Should not reach here, but handle gracefully
  state.exhausted = true;
  return err(
    state.lastError ?? new Error(`${operationName} failed after ${state.attempt} attempts`)
  );
}

/** Create a retry wrapper for a provider */
export function createRetryWrapper(
  config?: Partial<RetryConfig>,
  logger?: Logger
): <T>(
  operation: () => Promise<Result<T>>,
  operationName?: string
) => Promise<Result<T>> {
  return async <T>(
    operation: () => Promise<Result<T>>,
    operationName: string = "operation"
  ): Promise<Result<T>> => {
    return withRetry({
      operation,
      config,
      logger,
      operationName,
    });
  };
}

/** Retry decorator for class methods */
export function retryable(
  config?: Partial<RetryConfig>
): MethodDecorator {
  return function (
    _target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: unknown[]) {
      return withRetry({
        operation: () => originalMethod.apply(this, args),
        config,
        operationName: String(propertyKey),
      });
    };

    return descriptor;
  };
}

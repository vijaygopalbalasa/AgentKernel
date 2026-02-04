// Circuit Breaker Pattern Implementation
// Prevents cascading failures by failing fast when a service is down

import { z } from "zod";
import { type Result, ok, err } from "@agentkernel/shared";
import { createLogger } from "./logger.js";

const log = createLogger({ name: "circuit-breaker" });

// ─── TYPES ──────────────────────────────────────────────────

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export const CircuitBreakerConfigSchema = z.object({
  name: z.string().min(1),
  failureThreshold: z.number().min(1).optional().default(5),
  resetTimeout: z.number().min(1000).optional().default(30000), // ms before trying again
  halfOpenMaxAttempts: z.number().min(1).optional().default(3),
  timeout: z.number().min(100).optional().default(10000), // operation timeout
});

export type CircuitBreakerConfig = z.infer<typeof CircuitBreakerConfigSchema>;

export class CircuitOpenError extends Error {
  constructor(
    public readonly circuitName: string,
    public readonly openedAt: Date,
    public readonly resetAt: Date
  ) {
    super(`Circuit '${circuitName}' is OPEN. Will reset at ${resetAt.toISOString()}`);
    this.name = "CircuitOpenError";
  }
}

export interface CircuitBreakerMetrics {
  name: string;
  state: CircuitState;
  failures: number;
  successes: number;
  rejections: number;
  lastFailure?: Date;
  lastSuccess?: Date;
  openedAt?: Date;
}

// ─── CIRCUIT BREAKER CLASS ──────────────────────────────────

/**
 * Circuit Breaker implementation for resilient external calls.
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Circuit tripped, requests fail fast
 * - HALF_OPEN: Testing if service recovered
 */
export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private failures = 0;
  private successes = 0;
  private rejections = 0;
  private halfOpenAttempts = 0;
  private lastFailure?: Date;
  private lastSuccess?: Date;
  private openedAt?: Date;
  private resetTimer?: ReturnType<typeof setTimeout>;
  private readonly config: CircuitBreakerConfig;

  constructor(config: Partial<CircuitBreakerConfig> & { name: string }) {
    const result = CircuitBreakerConfigSchema.safeParse(config);
    if (!result.success) {
      throw new Error(`Invalid circuit breaker config: ${result.error.message}`);
    }
    this.config = result.data;
    log.debug("Circuit breaker created", { name: this.config.name });
  }

  /**
   * Execute an operation through the circuit breaker.
   */
  async execute<T>(operation: () => Promise<T>): Promise<Result<T, Error>> {
    // Check if circuit is open
    if (this.state === "OPEN") {
      this.rejections++;
      log.debug("Circuit open, rejecting request", { name: this.config.name });
      return err(
        new CircuitOpenError(
          this.config.name,
          this.openedAt!,
          new Date(this.openedAt!.getTime() + this.config.resetTimeout)
        )
      );
    }

    // In HALF_OPEN, limit attempts
    if (this.state === "HALF_OPEN" && this.halfOpenAttempts >= this.config.halfOpenMaxAttempts) {
      this.rejections++;
      return err(new CircuitOpenError(
        this.config.name,
        this.openedAt!,
        new Date(this.openedAt!.getTime() + this.config.resetTimeout)
      ));
    }

    if (this.state === "HALF_OPEN") {
      this.halfOpenAttempts++;
    }

    try {
      // Execute with timeout
      const result = await this.withTimeout(operation(), this.config.timeout);
      this.onSuccess();
      return ok(result);
    } catch (error) {
      this.onFailure(error instanceof Error ? error : new Error(String(error)));
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Execute with timeout wrapper.
   */
  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Operation timed out after ${ms}ms`));
      }, ms);

      promise
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  /**
   * Handle successful operation.
   */
  private onSuccess(): void {
    this.successes++;
    this.lastSuccess = new Date();

    if (this.state === "HALF_OPEN") {
      // Recovery successful
      log.info("Circuit recovered", { name: this.config.name });
      this.close();
    } else {
      // Reset failure count on success
      this.failures = 0;
    }
  }

  /**
   * Handle failed operation.
   */
  private onFailure(error: Error): void {
    this.failures++;
    this.lastFailure = new Date();

    log.debug("Circuit breaker recorded failure", {
      name: this.config.name,
      failures: this.failures,
      threshold: this.config.failureThreshold,
      error: error.message,
    });

    if (this.state === "HALF_OPEN") {
      // Recovery failed
      log.warn("Circuit recovery failed, reopening", { name: this.config.name });
      this.open();
    } else if (this.failures >= this.config.failureThreshold) {
      // Threshold reached
      log.warn("Circuit failure threshold reached, opening", {
        name: this.config.name,
        failures: this.failures,
      });
      this.open();
    }
  }

  /**
   * Open the circuit (stop allowing requests).
   */
  private open(): void {
    this.state = "OPEN";
    this.openedAt = new Date();
    this.halfOpenAttempts = 0;

    // Schedule transition to HALF_OPEN
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
    }

    this.resetTimer = setTimeout(() => {
      this.halfOpen();
    }, this.config.resetTimeout);

    log.info("Circuit opened", {
      name: this.config.name,
      resetTimeout: this.config.resetTimeout,
    });
  }

  /**
   * Transition to half-open state (testing recovery).
   */
  private halfOpen(): void {
    this.state = "HALF_OPEN";
    this.halfOpenAttempts = 0;

    log.info("Circuit half-open, testing recovery", { name: this.config.name });
  }

  /**
   * Close the circuit (resume normal operation).
   */
  private close(): void {
    this.state = "CLOSED";
    this.failures = 0;
    this.halfOpenAttempts = 0;
    this.openedAt = undefined;

    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = undefined;
    }

    log.info("Circuit closed", { name: this.config.name });
  }

  /**
   * Force reset the circuit to closed state.
   */
  reset(): void {
    this.close();
    this.successes = 0;
    this.rejections = 0;
    this.lastFailure = undefined;
    this.lastSuccess = undefined;
  }

  /**
   * Get current circuit state.
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Get circuit metrics.
   */
  getMetrics(): CircuitBreakerMetrics {
    return {
      name: this.config.name,
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      rejections: this.rejections,
      lastFailure: this.lastFailure,
      lastSuccess: this.lastSuccess,
      openedAt: this.openedAt,
    };
  }

  /**
   * Check if circuit allows requests.
   */
  isAllowed(): boolean {
    return this.state !== "OPEN";
  }

  /**
   * Destroy the circuit breaker (cleanup timers).
   */
  destroy(): void {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = undefined;
    }
  }
}

// ─── CIRCUIT BREAKER REGISTRY ───────────────────────────────

const circuits = new Map<string, CircuitBreaker>();

/**
 * Get or create a circuit breaker by name.
 */
export function getCircuitBreaker(
  name: string,
  config?: Partial<Omit<CircuitBreakerConfig, "name">>
): CircuitBreaker {
  let circuit = circuits.get(name);
  if (!circuit) {
    circuit = new CircuitBreaker({ name, ...config });
    circuits.set(name, circuit);
  }
  return circuit;
}

/**
 * Get all circuit breaker metrics.
 */
export function getAllCircuitMetrics(): CircuitBreakerMetrics[] {
  return Array.from(circuits.values()).map((c) => c.getMetrics());
}

/**
 * Reset all circuit breakers.
 */
export function resetAllCircuits(): void {
  circuits.forEach((c) => c.reset());
}

/**
 * Destroy all circuit breakers.
 */
export function destroyAllCircuits(): void {
  circuits.forEach((c) => c.destroy());
  circuits.clear();
}

// ─── DECORATOR HELPER ───────────────────────────────────────

/**
 * Wrap a function with circuit breaker protection.
 */
export function withCircuitBreaker<T extends (...args: unknown[]) => Promise<unknown>>(
  circuitName: string,
  fn: T,
  config?: Partial<Omit<CircuitBreakerConfig, "name">>
): T {
  const circuit = getCircuitBreaker(circuitName, config);

  return (async (...args: Parameters<T>) => {
    const result = await circuit.execute(() => fn(...args));
    if (result.ok) {
      return result.value;
    }
    throw result.error;
  }) as T;
}

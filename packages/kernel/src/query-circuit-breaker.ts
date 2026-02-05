// Query Circuit Breaker — Protects database from cascading failures
// Implements the circuit breaker pattern with three states: closed, open, half-open

// ─── TYPES ────────────────────────────────────────────────────────────────

/** Circuit breaker state */
export type CircuitState = "closed" | "open" | "half-open";

/** Circuit breaker configuration */
export interface CircuitBreakerConfig {
  /** Number of failures before opening the circuit */
  failureThreshold: number;
  /** Time to wait before attempting recovery (ms) */
  resetTimeoutMs: number;
  /** Number of successful calls to close the circuit from half-open */
  successThreshold: number;
  /** Time window for counting failures (ms) */
  failureWindowMs: number;
}

/** Circuit breaker statistics */
export interface CircuitBreakerStats {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailure: Date | null;
  lastSuccess: Date | null;
  totalCalls: number;
  rejectedCalls: number;
}

/** Error thrown when circuit is open */
export class CircuitOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CircuitOpenError";
  }
}

// ─── DEFAULT CONFIG ───────────────────────────────────────────────────────

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeoutMs: 30000,
  successThreshold: 3,
  failureWindowMs: 60000,
};

// ─── CIRCUIT BREAKER ──────────────────────────────────────────────────────

/**
 * Circuit Breaker for protecting database queries.
 *
 * States:
 * - **Closed**: Normal operation, all calls pass through
 * - **Open**: Circuit is broken, all calls are rejected immediately
 * - **Half-Open**: Testing if service has recovered, limited calls allowed
 *
 * Transitions:
 * - Closed → Open: When failure count exceeds threshold
 * - Open → Half-Open: After reset timeout expires
 * - Half-Open → Closed: When success threshold is met
 * - Half-Open → Open: When any call fails
 */
export class QueryCircuitBreaker {
  private state: CircuitState = "closed";
  private failures = 0;
  private successes = 0;
  private lastFailure: Date | null = null;
  private lastSuccess: Date | null = null;
  private failureTimestamps: number[] = [];
  private totalCalls = 0;
  private rejectedCalls = 0;
  private readonly config: CircuitBreakerConfig;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config };
  }

  /**
   * Execute a function with circuit breaker protection.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.totalCalls++;

    // Check if circuit should transition from open to half-open
    if (this.state === "open") {
      if (this.shouldAttemptRecovery()) {
        this.state = "half-open";
        this.successes = 0;
      } else {
        this.rejectedCalls++;
        throw new CircuitOpenError(
          `Circuit breaker is open. Retry after ${this.getTimeUntilRecovery()}ms`,
        );
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /**
   * Check if the circuit allows a call without executing.
   */
  canExecute(): boolean {
    if (this.state === "closed") {
      return true;
    }
    if (this.state === "open") {
      return this.shouldAttemptRecovery();
    }
    // half-open
    return true;
  }

  /**
   * Get current circuit state.
   */
  getState(): CircuitState {
    // Check for automatic transition to half-open
    if (this.state === "open" && this.shouldAttemptRecovery()) {
      this.state = "half-open";
      this.successes = 0;
    }
    return this.state;
  }

  /**
   * Get circuit breaker statistics.
   */
  getStats(): CircuitBreakerStats {
    return {
      state: this.getState(),
      failures: this.failures,
      successes: this.successes,
      lastFailure: this.lastFailure,
      lastSuccess: this.lastSuccess,
      totalCalls: this.totalCalls,
      rejectedCalls: this.rejectedCalls,
    };
  }

  /**
   * Reset the circuit breaker to closed state.
   */
  reset(): void {
    this.state = "closed";
    this.failures = 0;
    this.successes = 0;
    this.failureTimestamps = [];
  }

  /**
   * Force the circuit to open (for testing or manual intervention).
   */
  forceOpen(): void {
    this.state = "open";
    this.lastFailure = new Date();
  }

  /**
   * Get time until recovery attempt is allowed.
   */
  getTimeUntilRecovery(): number {
    if (this.state !== "open" || !this.lastFailure) {
      return 0;
    }
    const elapsed = Date.now() - this.lastFailure.getTime();
    return Math.max(0, this.config.resetTimeoutMs - elapsed);
  }

  /** Handle successful call */
  private onSuccess(): void {
    this.lastSuccess = new Date();

    if (this.state === "half-open") {
      this.successes++;
      if (this.successes >= this.config.successThreshold) {
        // Recovery successful, close the circuit
        this.state = "closed";
        this.failures = 0;
        this.failureTimestamps = [];
      }
    } else if (this.state === "closed") {
      // Clear old failures outside the window
      this.cleanupFailures();
    }
  }

  /** Handle failed call */
  private onFailure(): void {
    this.lastFailure = new Date();
    this.failures++;
    this.failureTimestamps.push(Date.now());

    if (this.state === "half-open") {
      // Any failure in half-open state reopens the circuit
      this.state = "open";
      return;
    }

    if (this.state === "closed") {
      // Clean up old failures and check threshold
      this.cleanupFailures();
      const recentFailures = this.failureTimestamps.length;

      if (recentFailures >= this.config.failureThreshold) {
        this.state = "open";
      }
    }
  }

  /** Check if we should attempt recovery */
  private shouldAttemptRecovery(): boolean {
    if (!this.lastFailure) {
      return true;
    }
    return Date.now() - this.lastFailure.getTime() >= this.config.resetTimeoutMs;
  }

  /** Remove failures outside the time window */
  private cleanupFailures(): void {
    const cutoff = Date.now() - this.config.failureWindowMs;
    this.failureTimestamps = this.failureTimestamps.filter((ts) => ts > cutoff);
  }
}

// ─── FACTORY FUNCTION ─────────────────────────────────────────────────────

/**
 * Create a query circuit breaker with default configuration.
 */
export function createQueryCircuitBreaker(
  config?: Partial<CircuitBreakerConfig>,
): QueryCircuitBreaker {
  return new QueryCircuitBreaker(config);
}

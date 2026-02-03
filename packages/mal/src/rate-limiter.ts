// Rate limiter using token bucket algorithm
// Controls request rate per provider to prevent API throttling

import type { Logger } from "@agent-os/kernel";

/** Rate limit configuration */
export interface RateLimitConfig {
  /** Requests per minute */
  requestsPerMinute: number;
  /** Tokens per minute (for LLM providers) */
  tokensPerMinute: number;
  /** Max burst size for requests */
  maxBurstRequests?: number;
  /** Max burst size for tokens */
  maxBurstTokens?: number;
}

/** Rate limiter state */
export interface RateLimiterState {
  /** Available request tokens */
  requestTokens: number;
  /** Available token tokens (for LLM usage) */
  tokenBudget: number;
  /** Last refill timestamp */
  lastRefillTime: number;
  /** Pending requests waiting */
  pendingRequests: number;
}

/** Rate limiter interface */
export interface RateLimiter {
  /** Check if a request can proceed (non-blocking) */
  canProceed(estimatedTokens?: number): boolean;

  /** Wait until request can proceed (blocking) */
  waitForCapacity(estimatedTokens?: number): Promise<void>;

  /** Acquire capacity for a request */
  acquire(estimatedTokens?: number): Promise<boolean>;

  /** Report actual token usage after request completes */
  reportUsage(actualTokens: number): void;

  /** Get current state */
  getState(): RateLimiterState;

  /** Reset the rate limiter */
  reset(): void;
}

/** Default rate limits for common providers */
export const DEFAULT_RATE_LIMITS: Record<string, RateLimitConfig> = {
  anthropic: {
    requestsPerMinute: 60,
    tokensPerMinute: 100000,
    maxBurstRequests: 10,
    maxBurstTokens: 20000,
  },
  openai: {
    requestsPerMinute: 60,
    tokensPerMinute: 150000,
    maxBurstRequests: 10,
    maxBurstTokens: 30000,
  },
  google: {
    requestsPerMinute: 60,
    tokensPerMinute: 120000,
    maxBurstRequests: 10,
    maxBurstTokens: 25000,
  },
  ollama: {
    requestsPerMinute: 1000, // Local, much higher
    tokensPerMinute: 1000000,
    maxBurstRequests: 100,
    maxBurstTokens: 100000,
  },
};

/** Create a rate limiter for a provider */
export function createRateLimiter(
  providerId: string,
  config?: Partial<RateLimitConfig>,
  logger?: Logger
): RateLimiter {
  const defaults = DEFAULT_RATE_LIMITS[providerId] ?? {
    requestsPerMinute: 60,
    tokensPerMinute: 100000,
    maxBurstRequests: 10,
    maxBurstTokens: 20000,
  };

  const finalConfig: Required<RateLimitConfig> = {
    requestsPerMinute: config?.requestsPerMinute ?? defaults.requestsPerMinute,
    tokensPerMinute: config?.tokensPerMinute ?? defaults.tokensPerMinute,
    maxBurstRequests: config?.maxBurstRequests ?? defaults.maxBurstRequests ?? 10,
    maxBurstTokens: config?.maxBurstTokens ?? defaults.maxBurstTokens ?? 20000,
  };

  // Token bucket state
  let requestTokens = finalConfig.maxBurstRequests;
  let tokenBudget = finalConfig.maxBurstTokens;
  let lastRefillTime = Date.now();
  let pendingRequests = 0;

  // Refill rates (per millisecond)
  const requestRefillRate = finalConfig.requestsPerMinute / 60000;
  const tokenRefillRate = finalConfig.tokensPerMinute / 60000;

  /** Refill tokens based on elapsed time */
  function refill(): void {
    const now = Date.now();
    const elapsed = now - lastRefillTime;

    if (elapsed > 0) {
      const requestRefill = elapsed * requestRefillRate;
      const tokenRefill = elapsed * tokenRefillRate;

      requestTokens = Math.min(
        finalConfig.maxBurstRequests,
        requestTokens + requestRefill
      );
      tokenBudget = Math.min(
        finalConfig.maxBurstTokens,
        tokenBudget + tokenRefill
      );

      lastRefillTime = now;
    }
  }

  /** Calculate wait time for capacity */
  function calculateWaitTime(estimatedTokens: number): number {
    refill();

    const requestWait = requestTokens < 1
      ? (1 - requestTokens) / requestRefillRate
      : 0;

    const tokenWait = tokenBudget < estimatedTokens
      ? (estimatedTokens - tokenBudget) / tokenRefillRate
      : 0;

    return Math.max(requestWait, tokenWait);
  }

  return {
    canProceed(estimatedTokens: number = 1000): boolean {
      refill();
      return requestTokens >= 1 && tokenBudget >= estimatedTokens;
    },

    async waitForCapacity(estimatedTokens: number = 1000): Promise<void> {
      const waitTime = calculateWaitTime(estimatedTokens);

      if (waitTime > 0) {
        logger?.debug("Rate limiter waiting for capacity", {
          providerId,
          waitMs: Math.ceil(waitTime),
          estimatedTokens,
        });

        await new Promise((resolve) => setTimeout(resolve, Math.ceil(waitTime)));
        refill();
      }
    },

    async acquire(estimatedTokens: number = 1000): Promise<boolean> {
      pendingRequests++;

      try {
        // Wait up to 30 seconds for capacity
        const maxWait = 30000;
        const startTime = Date.now();

        while (Date.now() - startTime < maxWait) {
          refill();

          if (requestTokens >= 1 && tokenBudget >= estimatedTokens) {
            requestTokens -= 1;
            tokenBudget -= estimatedTokens;

            logger?.debug("Rate limiter acquired capacity", {
              providerId,
              estimatedTokens,
              remainingRequests: requestTokens,
              remainingTokens: tokenBudget,
            });

            return true;
          }

          // Wait a bit before retry
          const waitTime = Math.min(calculateWaitTime(estimatedTokens), 1000);
          await new Promise((resolve) => setTimeout(resolve, Math.max(10, waitTime)));
        }

        logger?.warn("Rate limiter timeout waiting for capacity", {
          providerId,
          estimatedTokens,
        });

        return false;
      } finally {
        pendingRequests--;
      }
    },

    reportUsage(actualTokens: number): void {
      // Adjust token budget based on actual vs estimated usage
      // If we used less than estimated, we can give some back
      // This is tracked but doesn't affect the bucket directly
      // since we're being conservative
      logger?.debug("Rate limiter usage reported", {
        providerId,
        actualTokens,
      });
    },

    getState(): RateLimiterState {
      refill();
      return {
        requestTokens,
        tokenBudget,
        lastRefillTime,
        pendingRequests,
      };
    },

    reset(): void {
      requestTokens = finalConfig.maxBurstRequests;
      tokenBudget = finalConfig.maxBurstTokens;
      lastRefillTime = Date.now();
      pendingRequests = 0;

      logger?.debug("Rate limiter reset", { providerId });
    },
  };
}

/** Rate limiter registry for managing multiple providers */
export interface RateLimiterRegistry {
  /** Get or create rate limiter for a provider */
  get(providerId: string): RateLimiter;

  /** Configure rate limits for a provider */
  configure(providerId: string, config: Partial<RateLimitConfig>): void;

  /** Get all rate limiter states */
  getAllStates(): Record<string, RateLimiterState>;

  /** Reset all rate limiters */
  resetAll(): void;
}

/** Create a rate limiter registry */
export function createRateLimiterRegistry(logger?: Logger): RateLimiterRegistry {
  const limiters = new Map<string, RateLimiter>();
  const configs = new Map<string, Partial<RateLimitConfig>>();

  return {
    get(providerId: string): RateLimiter {
      let limiter = limiters.get(providerId);

      if (!limiter) {
        const config = configs.get(providerId);
        limiter = createRateLimiter(providerId, config, logger);
        limiters.set(providerId, limiter);
      }

      return limiter;
    },

    configure(providerId: string, config: Partial<RateLimitConfig>): void {
      configs.set(providerId, config);
      // Remove existing limiter so it gets recreated with new config
      limiters.delete(providerId);
    },

    getAllStates(): Record<string, RateLimiterState> {
      const states: Record<string, RateLimiterState> = {};
      for (const [id, limiter] of limiters) {
        states[id] = limiter.getState();
      }
      return states;
    },

    resetAll(): void {
      for (const limiter of limiters.values()) {
        limiter.reset();
      }
    },
  };
}

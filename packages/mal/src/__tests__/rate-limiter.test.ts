import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createRateLimiter,
  createRateLimiterRegistry,
  DEFAULT_RATE_LIMITS,
  type RateLimiter,
  type RateLimiterRegistry,
} from "../rate-limiter.js";

describe("Rate Limiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("createRateLimiter", () => {
    it("should create a rate limiter with default config", () => {
      const limiter = createRateLimiter("test");

      expect(limiter).toHaveProperty("canProceed");
      expect(limiter).toHaveProperty("waitForCapacity");
      expect(limiter).toHaveProperty("acquire");
      expect(limiter).toHaveProperty("reportUsage");
      expect(limiter).toHaveProperty("getState");
      expect(limiter).toHaveProperty("reset");
    });

    it("should use provider-specific defaults", () => {
      const anthropicLimiter = createRateLimiter("anthropic");
      const state = anthropicLimiter.getState();

      // Should have Anthropic defaults
      expect(state.requestTokens).toBe(DEFAULT_RATE_LIMITS.anthropic!.maxBurstRequests);
    });

    it("should accept custom configuration", () => {
      const limiter = createRateLimiter("custom", {
        requestsPerMinute: 100,
        tokensPerMinute: 50000,
        maxBurstRequests: 20,
        maxBurstTokens: 10000,
      });

      const state = limiter.getState();
      expect(state.requestTokens).toBe(20);
      expect(state.tokenBudget).toBe(10000);
    });
  });

  describe("canProceed", () => {
    it("should return true when capacity is available", () => {
      const limiter = createRateLimiter("test", {
        maxBurstRequests: 10,
        maxBurstTokens: 20000,
      });

      expect(limiter.canProceed(1000)).toBe(true);
    });

    it("should return false when request capacity exhausted", () => {
      const limiter = createRateLimiter("test", {
        maxBurstRequests: 0,
        maxBurstTokens: 20000,
        requestsPerMinute: 60,
        tokensPerMinute: 100000,
      });

      expect(limiter.canProceed(1000)).toBe(false);
    });

    it("should return false when token capacity exhausted", () => {
      const limiter = createRateLimiter("test", {
        maxBurstRequests: 10,
        maxBurstTokens: 100,
        requestsPerMinute: 60,
        tokensPerMinute: 100000,
      });

      expect(limiter.canProceed(200)).toBe(false);
    });
  });

  describe("acquire", () => {
    it("should acquire capacity and reduce tokens", async () => {
      const limiter = createRateLimiter("test", {
        maxBurstRequests: 10,
        maxBurstTokens: 20000,
        requestsPerMinute: 60,
        tokensPerMinute: 100000,
      });

      const stateBefore = limiter.getState();
      const acquired = await limiter.acquire(5000);

      expect(acquired).toBe(true);

      const stateAfter = limiter.getState();
      expect(stateAfter.requestTokens).toBeLessThan(stateBefore.requestTokens);
      expect(stateAfter.tokenBudget).toBeLessThan(stateBefore.tokenBudget);
    });

    it("should return true when capacity becomes available", async () => {
      const limiter = createRateLimiter("test", {
        maxBurstRequests: 1,
        maxBurstTokens: 1000,
        requestsPerMinute: 600, // 10 per second
        tokensPerMinute: 60000,
      });

      // Exhaust capacity
      await limiter.acquire(500);
      expect(limiter.canProceed(500)).toBe(false);

      // Start acquiring (will wait)
      const acquirePromise = limiter.acquire(500);

      // Advance time
      await vi.advanceTimersByTimeAsync(200);

      const result = await acquirePromise;
      expect(result).toBe(true);
    });
  });

  describe("reset", () => {
    it("should reset all tokens to max burst", async () => {
      const limiter = createRateLimiter("test", {
        maxBurstRequests: 10,
        maxBurstTokens: 20000,
        requestsPerMinute: 60,
        tokensPerMinute: 100000,
      });

      // Exhaust some capacity
      await limiter.acquire(10000);
      await limiter.acquire(5000);

      limiter.reset();

      const state = limiter.getState();
      expect(state.requestTokens).toBe(10);
      expect(state.tokenBudget).toBe(20000);
    });
  });

  describe("refill", () => {
    it("should refill tokens over time", async () => {
      const limiter = createRateLimiter("test", {
        maxBurstRequests: 10,
        maxBurstTokens: 20000,
        requestsPerMinute: 600, // 10 per second
        tokensPerMinute: 120000, // 2000 per second
      });

      // Exhaust all capacity
      await limiter.acquire(20000);

      // Advance time by 1 second
      await vi.advanceTimersByTimeAsync(1000);

      const state = limiter.getState();
      expect(state.requestTokens).toBeGreaterThan(0);
      expect(state.tokenBudget).toBeGreaterThan(0);
    });
  });
});

describe("Rate Limiter Registry", () => {
  describe("createRateLimiterRegistry", () => {
    it("should create a registry", () => {
      const registry = createRateLimiterRegistry();

      expect(registry).toHaveProperty("get");
      expect(registry).toHaveProperty("configure");
      expect(registry).toHaveProperty("getAllStates");
      expect(registry).toHaveProperty("resetAll");
    });
  });

  describe("get", () => {
    it("should create and return rate limiter for provider", () => {
      const registry = createRateLimiterRegistry();
      const limiter = registry.get("anthropic");

      expect(limiter).toBeDefined();
      expect(limiter.canProceed).toBeDefined();
    });

    it("should return same limiter for same provider", () => {
      const registry = createRateLimiterRegistry();
      const limiter1 = registry.get("anthropic");
      const limiter2 = registry.get("anthropic");

      expect(limiter1).toBe(limiter2);
    });

    it("should return different limiters for different providers", () => {
      const registry = createRateLimiterRegistry();
      const anthropic = registry.get("anthropic");
      const openai = registry.get("openai");

      expect(anthropic).not.toBe(openai);
    });
  });

  describe("configure", () => {
    it("should apply custom config to new limiters", () => {
      const registry = createRateLimiterRegistry();

      registry.configure("custom", {
        maxBurstRequests: 100,
        maxBurstTokens: 50000,
      });

      const limiter = registry.get("custom");
      const state = limiter.getState();

      expect(state.requestTokens).toBe(100);
      expect(state.tokenBudget).toBe(50000);
    });
  });

  describe("getAllStates", () => {
    it("should return states for all created limiters", async () => {
      const registry = createRateLimiterRegistry();

      registry.get("anthropic");
      registry.get("openai");

      const states = registry.getAllStates();

      expect(Object.keys(states)).toContain("anthropic");
      expect(Object.keys(states)).toContain("openai");
    });
  });

  describe("resetAll", () => {
    it("should reset all limiters", async () => {
      vi.useFakeTimers();

      const registry = createRateLimiterRegistry();
      const limiter = registry.get("test");

      // Exhaust some capacity
      await limiter.acquire(5000);

      registry.resetAll();

      const states = registry.getAllStates();
      const testState = states.test;
      expect(testState).toBeDefined();
      if (!testState) return;
      expect(testState.pendingRequests).toBe(0);

      vi.useRealTimers();
    });
  });
});

describe("DEFAULT_RATE_LIMITS", () => {
  it("should have limits for common providers", () => {
    expect(DEFAULT_RATE_LIMITS).toHaveProperty("anthropic");
    expect(DEFAULT_RATE_LIMITS).toHaveProperty("openai");
    expect(DEFAULT_RATE_LIMITS).toHaveProperty("google");
    expect(DEFAULT_RATE_LIMITS).toHaveProperty("ollama");
  });

  it("should have all required fields for each provider", () => {
    for (const [_, config] of Object.entries(DEFAULT_RATE_LIMITS)) {
      expect(config).toHaveProperty("requestsPerMinute");
      expect(config).toHaveProperty("tokensPerMinute");
      expect(typeof config.requestsPerMinute).toBe("number");
      expect(typeof config.tokensPerMinute).toBe("number");
    }
  });
});

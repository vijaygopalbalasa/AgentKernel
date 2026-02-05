// Rate Limiter Tests
// Tests for the token bucket rate limiter implementation

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentRateLimiter,
  type BucketType,
  DEFAULT_RATE_LIMIT_CONFIG,
  TokenBucket,
  createAgentRateLimiter,
} from "../rate-limiter.js";

describe("TokenBucket", () => {
  describe("constructor", () => {
    it("should initialize with full capacity", () => {
      const bucket = new TokenBucket(100, 10);
      expect(bucket.tokens).toBe(100);
      expect(bucket.capacity).toBe(100);
      expect(bucket.refillRate).toBe(10);
    });

    it("should initialize with custom initial tokens", () => {
      const bucket = new TokenBucket(100, 10, 50);
      expect(bucket.tokens).toBe(50);
    });

    it("should initialize with custom last refill time", () => {
      const pastTime = new Date(Date.now() - 5000);
      const bucket = new TokenBucket(100, 10, 50, pastTime);
      // Tokens should refill based on elapsed time
      expect(bucket.tokens).toBeGreaterThan(50);
    });
  });

  describe("tryConsume", () => {
    it("should consume tokens when available", () => {
      const bucket = new TokenBucket(100, 10);
      expect(bucket.tryConsume(10)).toBe(true);
      expect(bucket.tokens).toBe(90);
    });

    it("should fail when not enough tokens", () => {
      const bucket = new TokenBucket(10, 1, 5);
      expect(bucket.tryConsume(10)).toBe(false);
      expect(bucket.tokens).toBeCloseTo(5, 1); // Unchanged (allow tiny refill drift)
    });

    it("should consume exact capacity", () => {
      const bucket = new TokenBucket(100, 10);
      expect(bucket.tryConsume(100)).toBe(true);
      expect(bucket.tokens).toBeLessThan(0.1);
    });

    it("should fail when consuming more than capacity", () => {
      const bucket = new TokenBucket(100, 10);
      expect(bucket.tryConsume(101)).toBe(false);
    });
  });

  describe("refill", () => {
    it("should refill tokens over time", async () => {
      const bucket = new TokenBucket(100, 100, 0); // 100 tokens/second

      // Wait 50ms
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should have refilled ~5 tokens
      expect(bucket.tokens).toBeGreaterThan(0);
      expect(bucket.tokens).toBeLessThan(20);
    });

    it("should not exceed capacity", async () => {
      const bucket = new TokenBucket(100, 1000, 90); // Very fast refill

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(bucket.tokens).toBeLessThanOrEqual(100);
    });
  });

  describe("getTimeToRefill", () => {
    it("should return 0 when enough tokens available", () => {
      const bucket = new TokenBucket(100, 10);
      expect(bucket.getTimeToRefill(50)).toBe(0);
    });

    it("should calculate time to refill", () => {
      const bucket = new TokenBucket(100, 10, 0); // Empty, 10 tokens/sec
      const timeMs = bucket.getTimeToRefill(50);
      // Need 50 tokens at 10/sec = 5 seconds = 5000ms
      expect(timeMs).toBeGreaterThanOrEqual(4900);
      expect(timeMs).toBeLessThanOrEqual(5100);
    });
  });

  describe("shouldPersist", () => {
    it("should return false immediately after creation", () => {
      const bucket = new TokenBucket(100, 10, undefined, undefined, 10000);
      expect(bucket.shouldPersist()).toBe(false);
    });

    it("should return true after persistence interval", async () => {
      const bucket = new TokenBucket(100, 10, undefined, undefined, 10);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(bucket.shouldPersist()).toBe(true);
    });

    it("should reset after markPersisted", async () => {
      const bucket = new TokenBucket(100, 10, undefined, undefined, 10);
      await new Promise((resolve) => setTimeout(resolve, 20));
      bucket.markPersisted();
      expect(bucket.shouldPersist()).toBe(false);
    });
  });

  describe("getState", () => {
    it("should return current state", () => {
      const bucket = new TokenBucket(100, 10, 75);
      const state = bucket.getState();
      expect(state.capacity).toBe(100);
      expect(state.refillRate).toBe(10);
      expect(state.tokens).toBeCloseTo(75, 0);
      expect(state.lastRefill).toBeInstanceOf(Date);
    });
  });

  describe("fromState", () => {
    it("should restore bucket from state", () => {
      const original = new TokenBucket(100, 10, 75);
      const state = original.getState();
      const restored = TokenBucket.fromState(state);

      expect(restored.capacity).toBe(original.capacity);
      expect(restored.refillRate).toBe(original.refillRate);
      expect(restored.tokens).toBeCloseTo(original.tokens, 0);
    });
  });
});

describe("AgentRateLimiter", () => {
  let limiter: AgentRateLimiter;

  beforeEach(() => {
    limiter = new AgentRateLimiter();
  });

  describe("constructor", () => {
    it("should use default config when none provided", () => {
      const l = new AgentRateLimiter();
      expect(l).toBeDefined();
    });

    it("should merge partial config with defaults", () => {
      const l = new AgentRateLimiter({ toolCallsPerMinute: 120 });
      expect(l).toBeDefined();
    });
  });

  describe("checkLimit", () => {
    it("should allow operations within limits", async () => {
      const result = await limiter.checkLimit("agent-1", "tool");
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBeDefined();
    });

    it("should track usage across calls", async () => {
      const r1 = await limiter.checkLimit("agent-1", "tool");
      const r2 = await limiter.checkLimit("agent-1", "tool");
      expect(r2.remaining).toBeLessThan(r1.remaining!);
    });

    it("should isolate limits between agents", async () => {
      const r1 = await limiter.checkLimit("agent-1", "tool");
      const r2 = await limiter.checkLimit("agent-2", "tool");
      expect(r1.remaining).toEqual(r2.remaining);
    });

    it("should handle different bucket types", async () => {
      const types: BucketType[] = ["tool", "token", "message"];
      for (const type of types) {
        const result = await limiter.checkLimit("agent-1", type);
        expect(result.allowed).toBe(true);
      }
    });

    it("should reject when limit exceeded", async () => {
      // Create limiter with very low limit
      const strictLimiter = new AgentRateLimiter({
        toolCallsPerMinute: 1,
        burstMultiplier: 1,
      });

      // First call should succeed
      await strictLimiter.checkLimit("agent-1", "tool");

      // Second call should fail
      const result = await strictLimiter.checkLimit("agent-1", "tool");
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBeGreaterThan(0);
    });

    it("should include bucket state in result", async () => {
      const result = await limiter.checkLimit("agent-1", "tool");
      expect(result.bucket).toBeDefined();
      expect(result.bucket?.tokens).toBeDefined();
      expect(result.bucket?.capacity).toBeDefined();
    });
  });

  describe("peekLimit", () => {
    it("should check limit without consuming", async () => {
      const r1 = await limiter.peekLimit("agent-1", "tool");
      const r2 = await limiter.peekLimit("agent-1", "tool");
      expect(r1.remaining).toEqual(r2.remaining);
    });

    it("should show current state", async () => {
      const result = await limiter.peekLimit("agent-1", "tool", 1);
      expect(result.allowed).toBe(true);
      expect(result.bucket).toBeDefined();
    });
  });

  describe("resetLimits", () => {
    it("should reset limits for an agent", async () => {
      // Use some tokens
      await limiter.checkLimit("agent-1", "tool", 10);

      // Reset
      await limiter.resetLimits("agent-1");

      // Check that limit is full again
      const result = await limiter.peekLimit("agent-1", "tool");
      expect(result.bucket?.tokens).toBeCloseTo(result.bucket?.capacity, 0);
    });
  });

  describe("getStatus", () => {
    it("should return status for all bucket types", async () => {
      const status = await limiter.getStatus("agent-1");
      expect(status.tool).toBeDefined();
      expect(status.token).toBeDefined();
      expect(status.message).toBeDefined();
    });
  });

  describe("burst handling", () => {
    it("should allow burst above per-minute limit", async () => {
      // With burstMultiplier of 2, capacity should be 2x the per-minute rate
      const customLimiter = new AgentRateLimiter({
        toolCallsPerMinute: 60,
        burstMultiplier: 2,
      });

      // Should be able to do 120 calls in burst
      let successCount = 0;
      for (let i = 0; i < 130; i++) {
        const result = await customLimiter.checkLimit("agent-1", "tool");
        if (result.allowed) successCount++;
      }

      // Should have succeeded 120 times (60 * 2)
      expect(successCount).toBe(120);
    });
  });
});

describe("createAgentRateLimiter", () => {
  it("should create limiter with default config", () => {
    const limiter = createAgentRateLimiter();
    expect(limiter).toBeInstanceOf(AgentRateLimiter);
  });

  it("should create limiter with custom config", () => {
    const limiter = createAgentRateLimiter({ toolCallsPerMinute: 100 });
    expect(limiter).toBeInstanceOf(AgentRateLimiter);
  });
});

describe("DEFAULT_RATE_LIMIT_CONFIG", () => {
  it("should have reasonable defaults", () => {
    expect(DEFAULT_RATE_LIMIT_CONFIG.toolCallsPerMinute).toBe(60);
    expect(DEFAULT_RATE_LIMIT_CONFIG.tokensPerMinute).toBe(100000);
    expect(DEFAULT_RATE_LIMIT_CONFIG.messagesPerMinute).toBe(30);
    expect(DEFAULT_RATE_LIMIT_CONFIG.burstMultiplier).toBe(2);
    expect(DEFAULT_RATE_LIMIT_CONFIG.persistenceIntervalMs).toBe(10000);
  });
});

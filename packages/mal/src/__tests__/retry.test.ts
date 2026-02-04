import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  withRetry,
  isRetryableError,
  calculateRetryDelay,
  createRetryWrapper,
  DEFAULT_RETRY_CONFIG,
  type RetryConfig,
} from "../retry.js";
import { ok, err } from "@agentrun/shared";

describe("Retry Module", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("isRetryableError", () => {
    it("should identify connection errors as retryable", () => {
      expect(isRetryableError(new Error("ECONNRESET"))).toBe(true);
      expect(isRetryableError(new Error("ETIMEDOUT"))).toBe(true);
      expect(isRetryableError(new Error("ECONNREFUSED"))).toBe(true);
      expect(isRetryableError(new Error("socket hang up"))).toBe(true);
    });

    it("should identify rate limit errors as retryable", () => {
      expect(isRetryableError(new Error("rate limit exceeded"))).toBe(true);
      // "Too many requests" matches via HTTP 429 status, not error message pattern
      expect(isRetryableError(new Error("status: 429 Too many requests"))).toBe(true);
    });

    it("should identify server errors as retryable", () => {
      expect(isRetryableError(new Error("Service temporarily unavailable"))).toBe(true);
      expect(isRetryableError(new Error("Server overloaded"))).toBe(true);
    });

    it("should identify HTTP status codes as retryable", () => {
      expect(isRetryableError(new Error("status: 429"))).toBe(true);
      expect(isRetryableError(new Error("status: 503"))).toBe(true);
      expect(isRetryableError(new Error("status: 500"))).toBe(true);
    });

    it("should not identify client errors as retryable", () => {
      expect(isRetryableError(new Error("Invalid API key"))).toBe(false);
      expect(isRetryableError(new Error("status: 400"))).toBe(false);
      expect(isRetryableError(new Error("status: 401"))).toBe(false);
      expect(isRetryableError(new Error("status: 404"))).toBe(false);
    });

    it("should respect custom config", () => {
      const config: RetryConfig = {
        ...DEFAULT_RETRY_CONFIG,
        retryableErrors: ["custom_error"],
        retryableStatusCodes: [418],
      };

      expect(isRetryableError(new Error("custom_error occurred"), config)).toBe(true);
      expect(isRetryableError(new Error("status: 418"), config)).toBe(true);
      expect(isRetryableError(new Error("ECONNRESET"), config)).toBe(false);
    });
  });

  describe("calculateRetryDelay", () => {
    it("should return initial delay for first attempt", () => {
      const delay = calculateRetryDelay(1, {
        ...DEFAULT_RETRY_CONFIG,
        jitterFactor: 0,
      });

      expect(delay).toBe(DEFAULT_RETRY_CONFIG.initialDelayMs);
    });

    it("should apply exponential backoff", () => {
      const config = {
        ...DEFAULT_RETRY_CONFIG,
        initialDelayMs: 1000,
        backoffMultiplier: 2,
        jitterFactor: 0,
        maxDelayMs: 100000,
      };

      expect(calculateRetryDelay(1, config)).toBe(1000);
      expect(calculateRetryDelay(2, config)).toBe(2000);
      expect(calculateRetryDelay(3, config)).toBe(4000);
      expect(calculateRetryDelay(4, config)).toBe(8000);
    });

    it("should cap delay at maxDelayMs", () => {
      const config = {
        ...DEFAULT_RETRY_CONFIG,
        initialDelayMs: 1000,
        backoffMultiplier: 2,
        maxDelayMs: 5000,
        jitterFactor: 0,
      };

      expect(calculateRetryDelay(10, config)).toBe(5000);
    });

    it("should add jitter within bounds", () => {
      const config = {
        ...DEFAULT_RETRY_CONFIG,
        initialDelayMs: 1000,
        jitterFactor: 0.5,
        maxDelayMs: 100000,
      };

      // Run multiple times to test randomness
      const delays = Array.from({ length: 100 }, () => calculateRetryDelay(1, config));

      // All delays should be within jitter range (500-1500 for 1000 base with 0.5 factor)
      for (const delay of delays) {
        expect(delay).toBeGreaterThanOrEqual(500);
        expect(delay).toBeLessThanOrEqual(1500);
      }
    });
  });

  describe("withRetry", () => {
    it("should return result on first success", async () => {
      const operation = vi.fn().mockResolvedValue(ok("success"));

      const resultPromise = withRetry({
        operation,
        config: { maxRetries: 3, initialDelayMs: 100, maxDelayMs: 1000, backoffMultiplier: 2, jitterFactor: 0 },
      });

      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("success");
      }
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it("should retry on retryable error", async () => {
      const operation = vi
        .fn()
        .mockResolvedValueOnce(err(new Error("ECONNRESET")))
        .mockResolvedValueOnce(err(new Error("ECONNRESET")))
        .mockResolvedValueOnce(ok("success"));

      const resultPromise = withRetry({
        operation,
        config: { maxRetries: 3, initialDelayMs: 100, maxDelayMs: 1000, backoffMultiplier: 2, jitterFactor: 0 },
      });

      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.ok).toBe(true);
      expect(operation).toHaveBeenCalledTimes(3);
    });

    it("should not retry on non-retryable error", async () => {
      const operation = vi.fn().mockResolvedValue(err(new Error("Invalid API key")));

      const resultPromise = withRetry({
        operation,
        config: { maxRetries: 3, initialDelayMs: 100, maxDelayMs: 1000, backoffMultiplier: 2, jitterFactor: 0 },
      });

      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.ok).toBe(false);
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it("should exhaust retries and return last error", async () => {
      const operation = vi.fn().mockResolvedValue(err(new Error("ECONNRESET")));

      const resultPromise = withRetry({
        operation,
        config: { maxRetries: 2, initialDelayMs: 100, maxDelayMs: 1000, backoffMultiplier: 2, jitterFactor: 0 },
      });

      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.ok).toBe(false);
      expect(operation).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
    });

    it("should call onRetry callback", async () => {
      const onRetry = vi.fn();
      const operation = vi
        .fn()
        .mockResolvedValueOnce(err(new Error("ECONNRESET")))
        .mockResolvedValueOnce(ok("success"));

      const resultPromise = withRetry({
        operation,
        config: { maxRetries: 3, initialDelayMs: 100, maxDelayMs: 1000, backoffMultiplier: 2, jitterFactor: 0 },
        onRetry,
      });

      await vi.runAllTimersAsync();
      await resultPromise;

      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onRetry).toHaveBeenCalledWith(
        expect.objectContaining({
          attempt: 2, // Called after the attempt counter is incremented (first attempt failed, now attempting retry #2)
          lastError: expect.any(Error),
        })
      );
    });

    it("should handle thrown errors", async () => {
      const operation = vi
        .fn()
        .mockRejectedValueOnce(new Error("ECONNRESET"))
        .mockResolvedValueOnce(ok("success"));

      const resultPromise = withRetry({
        operation,
        config: { maxRetries: 3, initialDelayMs: 100, maxDelayMs: 1000, backoffMultiplier: 2, jitterFactor: 0 },
      });

      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.ok).toBe(true);
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it("should use custom isRetryable function", async () => {
      const isRetryable = vi.fn().mockReturnValue(true);
      const operation = vi
        .fn()
        .mockResolvedValueOnce(err(new Error("custom error")))
        .mockResolvedValueOnce(ok("success"));

      const resultPromise = withRetry({
        operation,
        config: { maxRetries: 3, initialDelayMs: 100, maxDelayMs: 1000, backoffMultiplier: 2, jitterFactor: 0 },
        isRetryable,
      });

      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.ok).toBe(true);
      expect(isRetryable).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe("createRetryWrapper", () => {
    it("should create a reusable retry wrapper", async () => {
      const wrapper = createRetryWrapper({
        maxRetries: 2,
        initialDelayMs: 100,
        maxDelayMs: 1000,
        backoffMultiplier: 2,
        jitterFactor: 0,
      });

      const operation = vi
        .fn()
        .mockResolvedValueOnce(err(new Error("ECONNRESET")))
        .mockResolvedValueOnce(ok("success"));

      const resultPromise = wrapper(operation, "test");

      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.ok).toBe(true);
    });
  });

  describe("DEFAULT_RETRY_CONFIG", () => {
    it("should have sensible defaults", () => {
      expect(DEFAULT_RETRY_CONFIG.maxRetries).toBeGreaterThan(0);
      expect(DEFAULT_RETRY_CONFIG.initialDelayMs).toBeGreaterThan(0);
      expect(DEFAULT_RETRY_CONFIG.maxDelayMs).toBeGreaterThan(DEFAULT_RETRY_CONFIG.initialDelayMs);
      expect(DEFAULT_RETRY_CONFIG.backoffMultiplier).toBeGreaterThan(1);
      expect(DEFAULT_RETRY_CONFIG.jitterFactor).toBeGreaterThanOrEqual(0);
      expect(DEFAULT_RETRY_CONFIG.jitterFactor).toBeLessThanOrEqual(1);
    });

    it("should include common retryable errors", () => {
      expect(DEFAULT_RETRY_CONFIG.retryableErrors).toContain("ECONNRESET");
      expect(DEFAULT_RETRY_CONFIG.retryableErrors).toContain("ETIMEDOUT");
      expect(DEFAULT_RETRY_CONFIG.retryableErrors).toContain("rate limit");
    });

    it("should include common retryable status codes", () => {
      expect(DEFAULT_RETRY_CONFIG.retryableStatusCodes).toContain(429);
      expect(DEFAULT_RETRY_CONFIG.retryableStatusCodes).toContain(500);
      expect(DEFAULT_RETRY_CONFIG.retryableStatusCodes).toContain(503);
    });
  });
});

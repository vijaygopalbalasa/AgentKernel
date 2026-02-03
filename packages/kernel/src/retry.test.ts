// Retry Utility Tests
import { describe, it, expect, vi } from "vitest";
import {
  retry,
  retryAsync,
  withRetry,
  calculateDelay,
  isConnectionError,
  isRateLimitError,
  isServerError,
  isNonRetryableError,
  isRetryableError,
  type RetryConfig,
} from "./retry.js";

describe("Retry", () => {
  describe("calculateDelay", () => {
    const config: RetryConfig = {
      maxRetries: 3,
      baseDelay: 1000,
      maxDelay: 30000,
      jitterFactor: 0,
      exponentialBase: 2,
    };

    it("should calculate exponential backoff", () => {
      expect(calculateDelay(0, config)).toBe(1000); // 1000 * 2^0 = 1000
      expect(calculateDelay(1, config)).toBe(2000); // 1000 * 2^1 = 2000
      expect(calculateDelay(2, config)).toBe(4000); // 1000 * 2^2 = 4000
    });

    it("should cap at maxDelay", () => {
      expect(calculateDelay(10, config)).toBe(30000);
    });

    it("should add jitter when configured", () => {
      const jitterConfig = { ...config, jitterFactor: 0.5 };
      const delays = Array.from({ length: 100 }, () => calculateDelay(1, jitterConfig));

      // With 0.5 jitter, delay should vary
      const min = Math.min(...delays);
      const max = Math.max(...delays);
      expect(max - min).toBeGreaterThan(0);
    });
  });

  describe("Error Classification", () => {
    describe("isConnectionError", () => {
      it("should identify connection errors", () => {
        expect(isConnectionError(new Error("ECONNREFUSED"))).toBe(true);
        expect(isConnectionError(new Error("ECONNRESET"))).toBe(true);
        expect(isConnectionError(new Error("ETIMEDOUT"))).toBe(true);
        expect(isConnectionError(new Error("socket hang up"))).toBe(true);
        expect(isConnectionError(new Error("network error"))).toBe(true);
      });

      it("should not match non-connection errors", () => {
        expect(isConnectionError(new Error("Invalid input"))).toBe(false);
      });
    });

    describe("isRateLimitError", () => {
      it("should identify rate limit errors", () => {
        const error = Object.assign(new Error("Rate limited"), { status: 429 });
        expect(isRateLimitError(error)).toBe(true);
      });

      it("should not match other errors", () => {
        const error = Object.assign(new Error("Server error"), { status: 500 });
        expect(isRateLimitError(error)).toBe(false);
      });
    });

    describe("isServerError", () => {
      it("should identify 5xx errors", () => {
        expect(isServerError(Object.assign(new Error(), { status: 500 }))).toBe(true);
        expect(isServerError(Object.assign(new Error(), { status: 502 }))).toBe(true);
        expect(isServerError(Object.assign(new Error(), { status: 503 }))).toBe(true);
      });

      it("should not match 4xx errors", () => {
        expect(isServerError(Object.assign(new Error(), { status: 400 }))).toBe(false);
        expect(isServerError(Object.assign(new Error(), { status: 404 }))).toBe(false);
      });
    });

    describe("isNonRetryableError", () => {
      it("should identify auth errors", () => {
        expect(isNonRetryableError(Object.assign(new Error(), { status: 401 }))).toBe(true);
        expect(isNonRetryableError(Object.assign(new Error(), { status: 403 }))).toBe(true);
      });

      it("should identify validation errors", () => {
        expect(isNonRetryableError(Object.assign(new Error(), { status: 400 }))).toBe(true);
        expect(isNonRetryableError(new Error("Invalid input"))).toBe(true);
      });
    });

    describe("isRetryableError", () => {
      it("should return true for retryable errors", () => {
        expect(isRetryableError(new Error("ECONNREFUSED"))).toBe(true);
        expect(isRetryableError(Object.assign(new Error(), { status: 429 }))).toBe(true);
        expect(isRetryableError(Object.assign(new Error(), { status: 500 }))).toBe(true);
      });

      it("should return false for non-retryable errors", () => {
        expect(isRetryableError(Object.assign(new Error(), { status: 401 }))).toBe(false);
        expect(isRetryableError(Object.assign(new Error(), { status: 400 }))).toBe(false);
      });
    });
  });

  describe("retry function", () => {
    it("should succeed on first attempt", async () => {
      const fn = vi.fn().mockResolvedValue("success");

      const result = await retry(() => fn());

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe("success");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should retry on retryable error", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockResolvedValue("success");

      const result = await retry(() => fn(), { baseDelay: 10, maxRetries: 3 });

      expect(result.ok).toBe(true);
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("should not retry on non-retryable error", async () => {
      const fn = vi.fn().mockRejectedValue(Object.assign(new Error("Unauthorized"), { status: 401 }));

      const result = await retry(() => fn(), { baseDelay: 10, maxRetries: 3 });

      expect(result.ok).toBe(false);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should respect max retries", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

      const result = await retry(() => fn(), { baseDelay: 10, maxRetries: 2 });

      expect(result.ok).toBe(false);
      expect(fn).toHaveBeenCalledTimes(3); // Initial + 2 retries
    });

    it("should provide context to operation", async () => {
      const contexts: Array<{ attempt: number }> = [];

      await retry(
        (ctx) => {
          contexts.push({ attempt: ctx.attempt });
          if (ctx.attempt < 2) throw new Error("ECONNREFUSED");
          return Promise.resolve("success");
        },
        { baseDelay: 10, maxRetries: 3 }
      );

      expect(contexts).toEqual([{ attempt: 0 }, { attempt: 1 }, { attempt: 2 }]);
    });
  });

  describe("retryAsync function", () => {
    it("should work with simple async functions", async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        if (attempts < 2) throw new Error("ECONNREFUSED");
        return "success";
      };

      const result = await retryAsync(fn, { baseDelay: 10 });

      expect(result.ok).toBe(true);
      expect(attempts).toBe(2);
    });
  });

  describe("withRetry decorator", () => {
    it("should create retryable function", async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        if (attempts < 2) throw new Error("ECONNREFUSED");
        return "success";
      };

      const retryableFn = withRetry(fn, { baseDelay: 10, maxRetries: 3 });
      const result = await retryableFn();

      expect(result).toBe("success");
      expect(attempts).toBe(2);
    });

    it("should throw after max retries", async () => {
      const fn = async () => {
        throw new Error("ECONNREFUSED");
      };

      const retryableFn = withRetry(fn, { baseDelay: 10, maxRetries: 2 });

      await expect(retryableFn()).rejects.toThrow("ECONNREFUSED");
    });
  });
});

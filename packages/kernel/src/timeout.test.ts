// Timeout Utilities Tests
import { describe, it, expect, beforeEach } from "vitest";
import {
  TimeoutError,
  defaultTimeouts,
  configureTimeouts,
  getTimeouts,
  withTimeout,
  createTimeoutController,
  withDbTimeout,
  withLlmTimeout,
  withMcpTimeout,
  withA2aTimeout,
  withAgentTaskTimeout,
  withHttpTimeout,
  Deadline,
} from "./timeout.js";

describe("Timeout Utilities", () => {
  beforeEach(() => {
    // Reset to default timeouts
    configureTimeouts(defaultTimeouts);
  });

  describe("TimeoutError", () => {
    it("should create error with correct properties", () => {
      const error = new TimeoutError("database query", "users", 5000);

      expect(error.name).toBe("TimeoutError");
      expect(error.operation).toBe("database query");
      expect(error.target).toBe("users");
      expect(error.durationMs).toBe(5000);
      expect(error.message).toContain("5000ms");
      expect(error.message).toContain("database query");
      expect(error.message).toContain("users");
    });

    it("should be instance of Error", () => {
      const error = new TimeoutError("test", "target", 1000);
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe("configureTimeouts", () => {
    it("should update specific timeouts", () => {
      configureTimeouts({ dbQuery: 5000 });

      const timeouts = getTimeouts();
      expect(timeouts.dbQuery).toBe(5000);
      expect(timeouts.llmApi).toBe(defaultTimeouts.llmApi);
    });

    it("should update multiple timeouts", () => {
      configureTimeouts({ dbQuery: 5000, llmApi: 60000 });

      const timeouts = getTimeouts();
      expect(timeouts.dbQuery).toBe(5000);
      expect(timeouts.llmApi).toBe(60000);
    });

    it("should preserve existing values", () => {
      configureTimeouts({ dbQuery: 5000 });
      configureTimeouts({ llmApi: 60000 });

      const timeouts = getTimeouts();
      expect(timeouts.dbQuery).toBe(5000);
      expect(timeouts.llmApi).toBe(60000);
    });
  });

  describe("getTimeouts", () => {
    it("should return current configuration", () => {
      const timeouts = getTimeouts();

      expect(timeouts.dbQuery).toBe(defaultTimeouts.dbQuery);
      expect(timeouts.llmApi).toBe(defaultTimeouts.llmApi);
      expect(timeouts.mcpTool).toBe(defaultTimeouts.mcpTool);
    });

    it("should return a copy not reference", () => {
      const timeouts = getTimeouts();
      timeouts.dbQuery = 1;

      expect(getTimeouts().dbQuery).toBe(defaultTimeouts.dbQuery);
    });
  });

  describe("withTimeout", () => {
    it("should resolve if promise completes in time", async () => {
      const promise = new Promise<string>((resolve) => {
        setTimeout(() => resolve("success"), 10);
      });

      const result = await withTimeout(promise, 100, "test", "target");
      expect(result).toBe("success");
    });

    it("should reject with TimeoutError if promise exceeds timeout", async () => {
      const promise = new Promise<string>((resolve) => {
        setTimeout(() => resolve("success"), 200);
      });

      await expect(withTimeout(promise, 50, "slow op", "target")).rejects.toThrow(TimeoutError);
    });

    it("should pass through original error if promise rejects", async () => {
      const promise = new Promise<string>((_, reject) => {
        setTimeout(() => reject(new Error("original error")), 10);
      });

      await expect(withTimeout(promise, 100, "test", "target")).rejects.toThrow("original error");
    });

    it("should clear timeout on success", async () => {
      const promise = Promise.resolve("fast");

      const result = await withTimeout(promise, 1000, "test", "target");
      expect(result).toBe("fast");
    });
  });

  describe("createTimeoutController", () => {
    it("should create controller with signal", () => {
      const { controller, signal, cleanup } = createTimeoutController(1000);

      expect(controller).toBeInstanceOf(AbortController);
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(false);

      cleanup();
    });

    it("should abort after timeout", async () => {
      const { signal, cleanup } = createTimeoutController(50);

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(signal.aborted).toBe(true);
      cleanup();
    });

    it("should not abort if cleaned up early", async () => {
      const { signal, cleanup } = createTimeoutController(100);

      cleanup();
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(signal.aborted).toBe(false);
    });
  });

  describe("typed timeout wrappers", () => {
    describe("withDbTimeout", () => {
      it("should use default db timeout", async () => {
        configureTimeouts({ dbQuery: 50 });

        const promise = new Promise<string>((resolve) => {
          setTimeout(() => resolve("data"), 100);
        });

        await expect(withDbTimeout(promise, "users")).rejects.toThrow(TimeoutError);
      });

      it("should accept custom timeout", async () => {
        const promise = new Promise<string>((resolve) => {
          setTimeout(() => resolve("data"), 50);
        });

        const result = await withDbTimeout(promise, "users", 100);
        expect(result).toBe("data");
      });
    });

    describe("withLlmTimeout", () => {
      it("should use streaming timeout when streaming", async () => {
        configureTimeouts({ llmStreaming: 50, llmApi: 200 });

        const promise = new Promise<string>((resolve) => {
          setTimeout(() => resolve("response"), 100);
        });

        await expect(withLlmTimeout(promise, "claude", true)).rejects.toThrow(TimeoutError);
      });

      it("should use api timeout when not streaming", async () => {
        configureTimeouts({ llmApi: 50, llmStreaming: 200 });

        const promise = new Promise<string>((resolve) => {
          setTimeout(() => resolve("response"), 100);
        });

        await expect(withLlmTimeout(promise, "claude", false)).rejects.toThrow(TimeoutError);
      });
    });

    describe("withMcpTimeout", () => {
      it("should use mcp tool timeout", async () => {
        configureTimeouts({ mcpTool: 50 });

        const promise = new Promise<string>((resolve) => {
          setTimeout(() => resolve("result"), 100);
        });

        await expect(withMcpTimeout(promise, "file_read")).rejects.toThrow(TimeoutError);
      });
    });

    describe("withA2aTimeout", () => {
      it("should use a2a task timeout", async () => {
        configureTimeouts({ a2aTask: 50 });

        const promise = new Promise<string>((resolve) => {
          setTimeout(() => resolve("result"), 100);
        });

        await expect(withA2aTimeout(promise, "agent-123")).rejects.toThrow(TimeoutError);
      });
    });

    describe("withAgentTaskTimeout", () => {
      it("should use agent task timeout", async () => {
        configureTimeouts({ agentTask: 50 });

        const promise = new Promise<string>((resolve) => {
          setTimeout(() => resolve("result"), 100);
        });

        await expect(withAgentTaskTimeout(promise, "agent-456")).rejects.toThrow(TimeoutError);
      });
    });

    describe("withHttpTimeout", () => {
      it("should use http request timeout", async () => {
        configureTimeouts({ httpRequest: 50 });

        const promise = new Promise<string>((resolve) => {
          setTimeout(() => resolve("result"), 100);
        });

        await expect(withHttpTimeout(promise, "https://example.com")).rejects.toThrow(TimeoutError);
      });
    });
  });

  describe("Deadline", () => {
    it("should track expiration", async () => {
      const deadline = new Deadline(50, "test operation");

      expect(deadline.isExpired()).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(deadline.isExpired()).toBe(true);
    });

    it("should track remaining time", async () => {
      const deadline = new Deadline(100, "test operation");

      const initial = deadline.remaining();
      expect(initial).toBeGreaterThan(0);
      expect(initial).toBeLessThanOrEqual(100);

      await new Promise((resolve) => setTimeout(resolve, 50));

      const later = deadline.remaining();
      expect(later).toBeLessThan(initial);
    });

    it("should return 0 when expired", async () => {
      const deadline = new Deadline(10, "test operation");

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(deadline.remaining()).toBe(0);
    });

    it("should throw on check when expired", async () => {
      const deadline = new Deadline(10, "test operation");

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(() => deadline.check()).toThrow(TimeoutError);
    });

    it("should not throw on check when not expired", () => {
      const deadline = new Deadline(1000, "test operation");

      expect(() => deadline.check()).not.toThrow();
    });

    it("should run promise with remaining time", async () => {
      const deadline = new Deadline(200, "test operation");

      const promise = new Promise<string>((resolve) => {
        setTimeout(() => resolve("success"), 10);
      });

      const result = await deadline.run(promise, "step1");
      expect(result).toBe("success");
    });

    it("should timeout if deadline exceeded during run", async () => {
      const deadline = new Deadline(50, "test operation");

      const promise = new Promise<string>((resolve) => {
        setTimeout(() => resolve("success"), 100);
      });

      await expect(deadline.run(promise, "slow step")).rejects.toThrow(TimeoutError);
    });

    it("should throw immediately if already expired", async () => {
      const deadline = new Deadline(10, "test operation");

      await new Promise((resolve) => setTimeout(resolve, 50));

      const promise = Promise.resolve("instant");

      await expect(deadline.run(promise, "step")).rejects.toThrow(TimeoutError);
    });
  });
});

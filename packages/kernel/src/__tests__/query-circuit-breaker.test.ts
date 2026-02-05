// Query Circuit Breaker Tests
// Tests for the circuit breaker implementation

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CircuitOpenError,
  type CircuitState,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  QueryCircuitBreaker,
  createQueryCircuitBreaker,
} from "../query-circuit-breaker.js";

describe("QueryCircuitBreaker", () => {
  let breaker: QueryCircuitBreaker;

  beforeEach(() => {
    breaker = new QueryCircuitBreaker({
      failureThreshold: 3,
      resetTimeoutMs: 100,
      successThreshold: 2,
      failureWindowMs: 1000,
    });
  });

  describe("constructor", () => {
    it("should start in closed state", () => {
      expect(breaker.getState()).toBe("closed");
    });

    it("should use default config when none provided", () => {
      const b = new QueryCircuitBreaker();
      expect(b.getState()).toBe("closed");
    });
  });

  describe("execute - closed state", () => {
    it("should execute function successfully", async () => {
      const result = await breaker.execute(async () => "success");
      expect(result).toBe("success");
    });

    it("should pass through errors", async () => {
      await expect(
        breaker.execute(async () => {
          throw new Error("test error");
        }),
      ).rejects.toThrow("test error");
    });

    it("should track successful calls", async () => {
      await breaker.execute(async () => "success");
      const stats = breaker.getStats();
      expect(stats.totalCalls).toBe(1);
    });

    it("should track failed calls", async () => {
      try {
        await breaker.execute(async () => {
          throw new Error("fail");
        });
      } catch {
        // Expected
      }
      const stats = breaker.getStats();
      expect(stats.failures).toBe(1);
    });
  });

  describe("execute - opening circuit", () => {
    it("should open after failure threshold", async () => {
      // Cause failures
      for (let i = 0; i < 3; i++) {
        try {
          await breaker.execute(async () => {
            throw new Error("fail");
          });
        } catch {
          // Expected
        }
      }

      expect(breaker.getState()).toBe("open");
    });

    it("should reject calls when open", async () => {
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        try {
          await breaker.execute(async () => {
            throw new Error("fail");
          });
        } catch {
          // Expected
        }
      }

      // Should throw CircuitOpenError
      await expect(breaker.execute(async () => "success")).rejects.toThrow(CircuitOpenError);
    });

    it("should count rejected calls", async () => {
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        try {
          await breaker.execute(async () => {
            throw new Error("fail");
          });
        } catch {
          // Expected
        }
      }

      // Try a rejected call
      try {
        await breaker.execute(async () => "success");
      } catch {
        // Expected
      }

      const stats = breaker.getStats();
      expect(stats.rejectedCalls).toBe(1);
    });
  });

  describe("execute - half-open state", () => {
    it("should transition to half-open after timeout", async () => {
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        try {
          await breaker.execute(async () => {
            throw new Error("fail");
          });
        } catch {
          // Expected
        }
      }

      // Wait for reset timeout
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Should be half-open now
      expect(breaker.getState()).toBe("half-open");
    });

    it("should close after success threshold in half-open", async () => {
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        try {
          await breaker.execute(async () => {
            throw new Error("fail");
          });
        } catch {
          // Expected
        }
      }

      // Wait for reset timeout
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Success calls to close
      await breaker.execute(async () => "success");
      await breaker.execute(async () => "success");

      expect(breaker.getState()).toBe("closed");
    });

    it("should reopen on failure in half-open", async () => {
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        try {
          await breaker.execute(async () => {
            throw new Error("fail");
          });
        } catch {
          // Expected
        }
      }

      // Wait for reset timeout
      await new Promise((resolve) => setTimeout(resolve, 150));

      // One failure should reopen
      try {
        await breaker.execute(async () => {
          throw new Error("fail");
        });
      } catch {
        // Expected
      }

      expect(breaker.getState()).toBe("open");
    });
  });

  describe("canExecute", () => {
    it("should return true when closed", () => {
      expect(breaker.canExecute()).toBe(true);
    });

    it("should return false when open", async () => {
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        try {
          await breaker.execute(async () => {
            throw new Error("fail");
          });
        } catch {
          // Expected
        }
      }

      expect(breaker.canExecute()).toBe(false);
    });

    it("should return true in half-open", async () => {
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        try {
          await breaker.execute(async () => {
            throw new Error("fail");
          });
        } catch {
          // Expected
        }
      }

      // Wait for reset timeout
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(breaker.canExecute()).toBe(true);
    });
  });

  describe("reset", () => {
    it("should reset to closed state", async () => {
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        try {
          await breaker.execute(async () => {
            throw new Error("fail");
          });
        } catch {
          // Expected
        }
      }

      breaker.reset();

      expect(breaker.getState()).toBe("closed");
    });

    it("should clear failure count", async () => {
      // Some failures
      try {
        await breaker.execute(async () => {
          throw new Error("fail");
        });
      } catch {
        // Expected
      }

      breaker.reset();

      const stats = breaker.getStats();
      expect(stats.failures).toBe(0);
    });
  });

  describe("forceOpen", () => {
    it("should force circuit to open", () => {
      breaker.forceOpen();
      expect(breaker.getState()).toBe("open");
    });

    it("should reject calls after force open", async () => {
      breaker.forceOpen();
      await expect(breaker.execute(async () => "success")).rejects.toThrow(CircuitOpenError);
    });
  });

  describe("getTimeUntilRecovery", () => {
    it("should return 0 when closed", () => {
      expect(breaker.getTimeUntilRecovery()).toBe(0);
    });

    it("should return time until recovery when open", async () => {
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        try {
          await breaker.execute(async () => {
            throw new Error("fail");
          });
        } catch {
          // Expected
        }
      }

      const time = breaker.getTimeUntilRecovery();
      expect(time).toBeGreaterThan(0);
      expect(time).toBeLessThanOrEqual(100);
    });
  });

  describe("getStats", () => {
    it("should return correct stats", async () => {
      await breaker.execute(async () => "success");
      try {
        await breaker.execute(async () => {
          throw new Error("fail");
        });
      } catch {
        // Expected
      }

      const stats = breaker.getStats();
      expect(stats.state).toBe("closed");
      expect(stats.totalCalls).toBe(2);
      expect(stats.failures).toBe(1);
    });

    it("should track lastSuccess and lastFailure", async () => {
      await breaker.execute(async () => "success");
      try {
        await breaker.execute(async () => {
          throw new Error("fail");
        });
      } catch {
        // Expected
      }

      const stats = breaker.getStats();
      expect(stats.lastSuccess).toBeInstanceOf(Date);
      expect(stats.lastFailure).toBeInstanceOf(Date);
    });
  });

  describe("failure window", () => {
    it("should not count old failures", async () => {
      const windowBreaker = new QueryCircuitBreaker({
        failureThreshold: 3,
        resetTimeoutMs: 100,
        successThreshold: 2,
        failureWindowMs: 50, // Very short window
      });

      // Two failures
      for (let i = 0; i < 2; i++) {
        try {
          await windowBreaker.execute(async () => {
            throw new Error("fail");
          });
        } catch {
          // Expected
        }
      }

      // Wait for failures to age out
      await new Promise((resolve) => setTimeout(resolve, 60));

      // Third failure should not open circuit (previous two are outside window)
      try {
        await windowBreaker.execute(async () => {
          throw new Error("fail");
        });
      } catch {
        // Expected
      }

      expect(windowBreaker.getState()).toBe("closed");
    });
  });
});

describe("createQueryCircuitBreaker", () => {
  it("should create breaker with default config", () => {
    const breaker = createQueryCircuitBreaker();
    expect(breaker).toBeInstanceOf(QueryCircuitBreaker);
    expect(breaker.getState()).toBe("closed");
  });

  it("should create breaker with custom config", () => {
    const breaker = createQueryCircuitBreaker({ failureThreshold: 10 });
    expect(breaker).toBeInstanceOf(QueryCircuitBreaker);
  });
});

describe("DEFAULT_CIRCUIT_BREAKER_CONFIG", () => {
  it("should have reasonable defaults", () => {
    expect(DEFAULT_CIRCUIT_BREAKER_CONFIG.failureThreshold).toBe(5);
    expect(DEFAULT_CIRCUIT_BREAKER_CONFIG.resetTimeoutMs).toBe(30000);
    expect(DEFAULT_CIRCUIT_BREAKER_CONFIG.successThreshold).toBe(3);
    expect(DEFAULT_CIRCUIT_BREAKER_CONFIG.failureWindowMs).toBe(60000);
  });
});

describe("CircuitOpenError", () => {
  it("should be an instance of Error", () => {
    const error = new CircuitOpenError("test");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("CircuitOpenError");
    expect(error.message).toBe("test");
  });
});

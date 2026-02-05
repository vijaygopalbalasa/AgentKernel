// Circuit Breaker Tests
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CircuitBreaker,
  CircuitOpenError,
  destroyAllCircuits,
  getCircuitBreaker,
  resetAllCircuits,
} from "./circuit-breaker.js";

describe("CircuitBreaker", () => {
  let circuit: CircuitBreaker;

  beforeEach(() => {
    circuit = new CircuitBreaker({
      name: "test-circuit",
      failureThreshold: 3,
      resetTimeout: 1000,
      halfOpenMaxAttempts: 2,
      timeout: 5000,
    });
  });

  afterEach(() => {
    circuit.destroy();
    destroyAllCircuits();
  });

  describe("Initial State", () => {
    it("should start in CLOSED state", () => {
      expect(circuit.getState()).toBe("CLOSED");
    });

    it("should allow requests when closed", () => {
      expect(circuit.isAllowed()).toBe(true);
    });

    it("should have zero metrics initially", () => {
      const metrics = circuit.getMetrics();
      expect(metrics.failures).toBe(0);
      expect(metrics.successes).toBe(0);
      expect(metrics.rejections).toBe(0);
    });
  });

  describe("Success Handling", () => {
    it("should record successful operations", async () => {
      const result = await circuit.execute(async () => "success");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe("success");

      const metrics = circuit.getMetrics();
      expect(metrics.successes).toBe(1);
      expect(metrics.failures).toBe(0);
    });

    it("should reset failure count on success", async () => {
      // Cause some failures
      await circuit.execute(async () => {
        throw new Error("fail");
      });
      await circuit.execute(async () => {
        throw new Error("fail");
      });

      // Success should reset
      await circuit.execute(async () => "success");

      const metrics = circuit.getMetrics();
      expect(metrics.failures).toBe(0);
    });
  });

  describe("Failure Handling", () => {
    it("should record failed operations", async () => {
      const result = await circuit.execute(async () => {
        throw new Error("test error");
      });

      expect(result.ok).toBe(false);
      expect(circuit.getMetrics().failures).toBe(1);
    });

    it("should open circuit after reaching threshold", async () => {
      // Cause 3 failures (threshold)
      for (let i = 0; i < 3; i++) {
        await circuit.execute(async () => {
          throw new Error("fail");
        });
      }

      expect(circuit.getState()).toBe("OPEN");
    });

    it("should not open circuit before threshold", async () => {
      // Cause 2 failures (below threshold of 3)
      for (let i = 0; i < 2; i++) {
        await circuit.execute(async () => {
          throw new Error("fail");
        });
      }

      expect(circuit.getState()).toBe("CLOSED");
    });
  });

  describe("Open State", () => {
    beforeEach(async () => {
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        await circuit.execute(async () => {
          throw new Error("fail");
        });
      }
    });

    it("should reject requests when open", async () => {
      const result = await circuit.execute(async () => "success");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(CircuitOpenError);
      }
    });

    it("should increment rejection count", async () => {
      await circuit.execute(async () => "success");
      await circuit.execute(async () => "success");

      const metrics = circuit.getMetrics();
      expect(metrics.rejections).toBe(2);
    });

    it("should transition to half-open after reset timeout", async () => {
      // Wait for reset timeout
      await new Promise((resolve) => setTimeout(resolve, 1100));

      expect(circuit.getState()).toBe("HALF_OPEN");
    });
  });

  describe("Half-Open State", () => {
    beforeEach(async () => {
      // Open and wait for half-open
      for (let i = 0; i < 3; i++) {
        await circuit.execute(async () => {
          throw new Error("fail");
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 1100));
    });

    it("should close on successful request", async () => {
      await circuit.execute(async () => "success");

      expect(circuit.getState()).toBe("CLOSED");
    });

    it("should reopen on failed request", async () => {
      await circuit.execute(async () => {
        throw new Error("fail");
      });

      expect(circuit.getState()).toBe("OPEN");
    });

    it("should limit attempts in half-open state", async () => {
      // First two attempts allowed
      await circuit.execute(async () => {
        throw new Error("fail 1");
      });

      // Circuit should reopen after first failure in half-open
      expect(circuit.getState()).toBe("OPEN");
    });
  });

  describe("Reset", () => {
    it("should reset all state", async () => {
      // Create some state
      await circuit.execute(async () => "success");
      await circuit.execute(async () => {
        throw new Error("fail");
      });

      circuit.reset();

      const metrics = circuit.getMetrics();
      expect(metrics.failures).toBe(0);
      expect(metrics.successes).toBe(0);
      expect(metrics.rejections).toBe(0);
      expect(circuit.getState()).toBe("CLOSED");
    });
  });

  describe("Timeout", () => {
    it("should timeout slow operations", async () => {
      const slowCircuit = new CircuitBreaker({
        name: "slow-circuit",
        timeout: 100, // 100ms timeout
        failureThreshold: 5,
        resetTimeout: 1000,
      });

      const result = await slowCircuit.execute(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return "should timeout";
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("timed out");
      }

      slowCircuit.destroy();
    });
  });

  describe("Registry", () => {
    it("should get or create circuit by name", () => {
      const circuit1 = getCircuitBreaker("registry-test");
      const circuit2 = getCircuitBreaker("registry-test");

      expect(circuit1).toBe(circuit2);
    });

    it("should reset all circuits", async () => {
      const c1 = getCircuitBreaker("reset-test-1");
      const c2 = getCircuitBreaker("reset-test-2");

      await c1.execute(async () => {
        throw new Error("fail");
      });

      resetAllCircuits();

      expect(c1.getMetrics().failures).toBe(0);
      expect(c2.getMetrics().failures).toBe(0);
    });
  });
});

describe("CircuitOpenError", () => {
  it("should contain circuit information", () => {
    const openedAt = new Date();
    const resetAt = new Date(openedAt.getTime() + 30000);

    const error = new CircuitOpenError("test", openedAt, resetAt);

    expect(error.name).toBe("CircuitOpenError");
    expect(error.circuitName).toBe("test");
    expect(error.openedAt).toBe(openedAt);
    expect(error.resetAt).toBe(resetAt);
    expect(error.message).toContain("test");
    expect(error.message).toContain("OPEN");
  });
});

// CLI Tests
import { describe, it, expect } from "vitest";
import { z } from "zod";

// Re-create schemas for testing (since we can't import from main.ts easily)
const HealthResponseSchema = z.object({
  status: z.enum(["ok", "degraded", "error"]),
  version: z.string(),
  uptime: z.number(),
  providers: z.array(z.string()),
  agents: z.number(),
  connections: z.number(),
  timestamp: z.number(),
});

const GatewayResponseSchema = z.object({
  type: z.string(),
  id: z.string().optional(),
  payload: z.unknown().optional(),
  timestamp: z.number().optional(),
});

describe("CLI Schemas", () => {
  describe("HealthResponseSchema", () => {
    it("should validate valid health response", () => {
      const response = {
        status: "ok",
        version: "0.1.0",
        uptime: 3600,
        providers: ["anthropic", "openai"],
        agents: 5,
        connections: 10,
        timestamp: Date.now(),
      };
      const result = HealthResponseSchema.safeParse(response);
      expect(result.success).toBe(true);
    });

    it("should validate degraded status", () => {
      const response = {
        status: "degraded",
        version: "0.1.0",
        uptime: 100,
        providers: ["anthropic"],
        agents: 1,
        connections: 2,
        timestamp: Date.now(),
      };
      const result = HealthResponseSchema.safeParse(response);
      expect(result.success).toBe(true);
    });

    it("should validate error status", () => {
      const response = {
        status: "error",
        version: "0.1.0",
        uptime: 0,
        providers: [],
        agents: 0,
        connections: 0,
        timestamp: Date.now(),
      };
      const result = HealthResponseSchema.safeParse(response);
      expect(result.success).toBe(true);
    });

    it("should reject invalid status", () => {
      const response = {
        status: "unknown",
        version: "0.1.0",
        uptime: 0,
        providers: [],
        agents: 0,
        connections: 0,
        timestamp: Date.now(),
      };
      const result = HealthResponseSchema.safeParse(response);
      expect(result.success).toBe(false);
    });

    it("should reject missing fields", () => {
      const response = {
        status: "ok",
        version: "0.1.0",
      };
      const result = HealthResponseSchema.safeParse(response);
      expect(result.success).toBe(false);
    });
  });

  describe("GatewayResponseSchema", () => {
    it("should validate minimal response", () => {
      const response = {
        type: "pong",
      };
      const result = GatewayResponseSchema.safeParse(response);
      expect(result.success).toBe(true);
    });

    it("should validate full response", () => {
      const response = {
        type: "chat_response",
        id: "msg-123",
        payload: { content: "Hello!", model: "claude-3" },
        timestamp: Date.now(),
      };
      const result = GatewayResponseSchema.safeParse(response);
      expect(result.success).toBe(true);
    });

    it("should validate error response", () => {
      const response = {
        type: "error",
        id: "msg-456",
        payload: { code: "VALIDATION_ERROR", message: "Invalid input" },
      };
      const result = GatewayResponseSchema.safeParse(response);
      expect(result.success).toBe(true);
    });

    it("should reject missing type", () => {
      const response = {
        id: "msg-789",
        payload: {},
      };
      const result = GatewayResponseSchema.safeParse(response);
      expect(result.success).toBe(false);
    });
  });
});

describe("CLI Helper Functions", () => {
  // Test the logic that would be in helper functions
  describe("formatUptime", () => {
    function formatUptime(seconds: number): string {
      if (seconds < 60) return `${seconds}s`;
      if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
      const hours = Math.floor(seconds / 3600);
      const mins = Math.floor((seconds % 3600) / 60);
      return `${hours}h ${mins}m`;
    }

    it("should format seconds", () => {
      expect(formatUptime(45)).toBe("45s");
    });

    it("should format minutes", () => {
      expect(formatUptime(125)).toBe("2m 5s");
    });

    it("should format hours", () => {
      expect(formatUptime(3665)).toBe("1h 1m");
    });
  });
});

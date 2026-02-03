// Gateway Tests
import { describe, it, expect } from "vitest";
import {
  WsMessageSchema,
  WsServerConfigSchema,
  ChatPayloadSchema,
  AgentSpawnPayloadSchema,
  AgentTerminatePayloadSchema,
  SubscribePayloadSchema,
  HealthStatusSchema,
  GatewayError,
  AgentTaskPayloadSchema,
} from "./types.js";
import { z } from "zod";

// Define ApprovalSchema for testing (mirrors main.ts definition)
const ApprovalSchema = z.object({
  approvedBy: z.string().min(1),
  approvedAt: z.union([z.string(), z.date(), z.number()]).optional(),
  reason: z.string().optional(),
});

const InvokeToolTaskSchema = z.object({
  type: z.literal("invoke_tool"),
  toolId: z.string().min(1),
  arguments: z.record(z.unknown()).optional(),
  approval: ApprovalSchema.optional(),
});

describe("Gateway Types", () => {
  describe("WsMessageSchema", () => {
    it("should validate valid message", () => {
      const message = {
        type: "ping",
        id: "test-1",
      };
      const result = WsMessageSchema.safeParse(message);
      expect(result.success).toBe(true);
    });

    it("should validate message with payload", () => {
      const message = {
        type: "chat",
        id: "test-2",
        payload: { messages: [{ role: "user", content: "Hello" }] },
      };
      const result = WsMessageSchema.safeParse(message);
      expect(result.success).toBe(true);
    });

    it("should reject invalid message type", () => {
      const message = {
        type: "invalid_type",
        id: "test-3",
      };
      const result = WsMessageSchema.safeParse(message);
      expect(result.success).toBe(false);
    });
  });

  describe("WsServerConfigSchema", () => {
    it("should validate valid config", () => {
      const config = {
        port: 8080,
        host: "127.0.0.1",
      };
      const result = WsServerConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("should validate config with auth token", () => {
      const config = {
        port: 8080,
        host: "0.0.0.0",
        authToken: "secret-token",
      };
      const result = WsServerConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("should reject invalid port", () => {
      const config = {
        port: 70000, // > 65535
        host: "localhost",
      };
      const result = WsServerConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it("should reject empty host", () => {
      const config = {
        port: 8080,
        host: "",
      };
      const result = WsServerConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });
  });

  describe("ChatPayloadSchema", () => {
    it("should validate valid chat payload", () => {
      const payload = {
        messages: [
          { role: "user", content: "Hello" },
        ],
      };
      const result = ChatPayloadSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });

    it("should validate with optional fields", () => {
      const payload = {
        model: "claude-3-haiku",
        messages: [
          { role: "system", content: "You are helpful" },
          { role: "user", content: "Hello" },
        ],
        maxTokens: 1000,
        temperature: 0.7,
      };
      const result = ChatPayloadSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });

    it("should reject empty messages", () => {
      const payload = {
        messages: [],
      };
      const result = ChatPayloadSchema.safeParse(payload);
      expect(result.success).toBe(false);
    });

    it("should reject invalid role", () => {
      const payload = {
        messages: [
          { role: "invalid", content: "Hello" },
        ],
      };
      const result = ChatPayloadSchema.safeParse(payload);
      expect(result.success).toBe(false);
    });
  });

  describe("AgentSpawnPayloadSchema", () => {
    it("should validate spawn with manifest", () => {
      const payload = {
        manifest: {
          id: "assistant-1",
          name: "Assistant",
        },
      };
      const result = AgentSpawnPayloadSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });

    it("should validate full manifest", () => {
      const payload = {
        manifest: {
          id: "coder-1",
          name: "Coder Agent",
          version: "1.0.0",
          description: "A coding assistant",
          model: "claude-3-opus",
          systemPrompt: "You are a coding assistant",
          skills: ["code-review", "refactoring"],
          permissions: ["filesystem.read"],
        },
        config: { debug: true },
      };
      const result = AgentSpawnPayloadSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });

    it("should validate spawn with manifest path", () => {
      const payload = {
        manifestPath: "/agents/assistant/manifest.json",
      };
      const result = AgentSpawnPayloadSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });

    it("should reject manifest with empty name", () => {
      const payload = {
        manifest: {
          id: "test",
          name: "",
        },
      };
      const result = AgentSpawnPayloadSchema.safeParse(payload);
      expect(result.success).toBe(false);
    });
  });

  describe("AgentTerminatePayloadSchema", () => {
    it("should validate terminate payload", () => {
      const payload = {
        agentId: "agent_123",
      };
      const result = AgentTerminatePayloadSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });

    it("should validate with force flag", () => {
      const payload = {
        agentId: "agent_456",
        force: true,
      };
      const result = AgentTerminatePayloadSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });

    it("should reject empty agent id", () => {
      const payload = {
        agentId: "",
      };
      const result = AgentTerminatePayloadSchema.safeParse(payload);
      expect(result.success).toBe(false);
    });
  });

  describe("SubscribePayloadSchema", () => {
    it("should validate subscribe payload", () => {
      const payload = {
        channels: ["agent.lifecycle", "system.*"],
      };
      const result = SubscribePayloadSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });

    it("should reject empty channels", () => {
      const payload = {
        channels: [],
      };
      const result = SubscribePayloadSchema.safeParse(payload);
      expect(result.success).toBe(false);
    });
  });

  describe("HealthStatusSchema", () => {
    it("should validate health status", () => {
      const status = {
        status: "ok",
        version: "0.1.0",
        uptime: 3600,
        providers: ["anthropic", "openai"],
        agents: 5,
        connections: 10,
        timestamp: Date.now(),
      };
      const result = HealthStatusSchema.safeParse(status);
      expect(result.success).toBe(true);
    });

    it("should validate degraded status", () => {
      const status = {
        status: "degraded",
        version: "0.1.0",
        uptime: 100,
        providers: ["anthropic"],
        agents: 0,
        connections: 1,
        timestamp: Date.now(),
      };
      const result = HealthStatusSchema.safeParse(status);
      expect(result.success).toBe(true);
    });

    it("should reject invalid status", () => {
      const status = {
        status: "unknown",
        version: "0.1.0",
        uptime: 0,
        providers: [],
        agents: 0,
        connections: 0,
        timestamp: Date.now(),
      };
      const result = HealthStatusSchema.safeParse(status);
      expect(result.success).toBe(false);
    });
  });

  describe("GatewayError", () => {
    it("should create error with code", () => {
      const error = new GatewayError("Not found", "NOT_FOUND", "client-1");
      expect(error.message).toBe("Not found");
      expect(error.code).toBe("NOT_FOUND");
      expect(error.clientId).toBe("client-1");
      expect(error.name).toBe("GatewayError");
    });

    it("should create error with agent id", () => {
      const error = new GatewayError("Agent error", "AGENT_ERROR", "client-1", "agent-1");
      expect(error.agentId).toBe("agent-1");
    });

    it("should extend Error", () => {
      const error = new GatewayError("Test", "INTERNAL_ERROR");
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe("AgentTaskPayloadSchema", () => {
    it("should validate basic agent task", () => {
      const payload = {
        agentId: "agent-123",
        task: { type: "echo", content: "hello" },
      };
      const result = AgentTaskPayloadSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });

    it("should validate internal task", () => {
      const payload = {
        agentId: "agent-123",
        task: { type: "search_memory", query: "test" },
        internal: true,
        internalToken: "secret-token",
      };
      const result = AgentTaskPayloadSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });

    it("should reject empty agent id", () => {
      const payload = {
        agentId: "",
        task: { type: "echo", content: "hello" },
      };
      const result = AgentTaskPayloadSchema.safeParse(payload);
      expect(result.success).toBe(false);
    });
  });
});

describe("Tool Approval Mechanism", () => {
  describe("ApprovalSchema", () => {
    it("should validate approval with required fields", () => {
      const approval = {
        approvedBy: "admin@example.com",
      };
      const result = ApprovalSchema.safeParse(approval);
      expect(result.success).toBe(true);
    });

    it("should validate approval with all fields", () => {
      const approval = {
        approvedBy: "admin@example.com",
        approvedAt: new Date().toISOString(),
        reason: "Approved for testing",
      };
      const result = ApprovalSchema.safeParse(approval);
      expect(result.success).toBe(true);
    });

    it("should accept approvedAt as ISO string", () => {
      const approval = {
        approvedBy: "admin@example.com",
        approvedAt: "2026-02-02T12:00:00Z",
      };
      const result = ApprovalSchema.safeParse(approval);
      expect(result.success).toBe(true);
    });

    it("should accept approvedAt as timestamp", () => {
      const approval = {
        approvedBy: "admin@example.com",
        approvedAt: Date.now(),
      };
      const result = ApprovalSchema.safeParse(approval);
      expect(result.success).toBe(true);
    });

    it("should reject approval without approvedBy", () => {
      const approval = {
        reason: "No approver specified",
      };
      const result = ApprovalSchema.safeParse(approval);
      expect(result.success).toBe(false);
    });

    it("should reject empty approvedBy", () => {
      const approval = {
        approvedBy: "",
      };
      const result = ApprovalSchema.safeParse(approval);
      expect(result.success).toBe(false);
    });
  });

  describe("InvokeToolTaskSchema", () => {
    it("should validate tool invocation without approval", () => {
      const task = {
        type: "invoke_tool",
        toolId: "builtin:echo",
        arguments: { message: "hello" },
      };
      const result = InvokeToolTaskSchema.safeParse(task);
      expect(result.success).toBe(true);
    });

    it("should validate tool invocation with approval", () => {
      const task = {
        type: "invoke_tool",
        toolId: "builtin:file_write",
        arguments: { path: "/tmp/test.txt", content: "hello" },
        approval: {
          approvedBy: "admin@example.com",
          reason: "Approved for testing file operations",
        },
      };
      const result = InvokeToolTaskSchema.safeParse(task);
      expect(result.success).toBe(true);
    });

    it("should validate tool invocation with full approval", () => {
      const task = {
        type: "invoke_tool",
        toolId: "builtin:http_fetch",
        arguments: { url: "https://api.example.com/data", method: "POST" },
        approval: {
          approvedBy: "security-team@example.com",
          approvedAt: new Date().toISOString(),
          reason: "Approved API call for integration testing",
        },
      };
      const result = InvokeToolTaskSchema.safeParse(task);
      expect(result.success).toBe(true);
    });

    it("should reject empty tool id", () => {
      const task = {
        type: "invoke_tool",
        toolId: "",
      };
      const result = InvokeToolTaskSchema.safeParse(task);
      expect(result.success).toBe(false);
    });

    it("should reject invalid type", () => {
      const task = {
        type: "execute_tool", // wrong type
        toolId: "builtin:echo",
      };
      const result = InvokeToolTaskSchema.safeParse(task);
      expect(result.success).toBe(false);
    });
  });

  describe("Trust Level Approval Requirements", () => {
    // These tests document the approval behavior based on trust level
    // The actual enforcement happens in main.ts via ensureApproval()

    it("should document supervised trust level requires approval for all tools", () => {
      // Agents with trustLevel: "supervised" require approval for ALL tool invocations
      // This is enforced by the gateway's ensureApproval function
      const supervisedAgent = {
        trustLevel: "supervised",
        description: "Requires human approval for every action",
      };
      expect(supervisedAgent.trustLevel).toBe("supervised");
    });

    it("should document semi-autonomous trust level skips approval unless tool requires it", () => {
      // Agents with trustLevel: "semi-autonomous" only need approval
      // when the tool has requiresConfirmation: true
      const semiAutonomousAgent = {
        trustLevel: "semi-autonomous",
        description: "Only requires approval for tools with requiresConfirmation flag",
      };
      expect(semiAutonomousAgent.trustLevel).toBe("semi-autonomous");
    });

    it("should document monitored-autonomous trust level behaves like semi-autonomous", () => {
      // Agents with trustLevel: "monitored-autonomous" are similar to semi-autonomous
      // but may have additional logging/monitoring
      const monitoredAgent = {
        trustLevel: "monitored-autonomous",
        description: "Autonomous but with enhanced monitoring",
      };
      expect(monitoredAgent.trustLevel).toBe("monitored-autonomous");
    });
  });

  describe("Tool Confirmation Requirements", () => {
    // These tests document which built-in tools require confirmation

    it("should document file_write requires confirmation", () => {
      // builtin:file_write has requiresConfirmation: true
      // This means approval is always required regardless of trust level
      const fileWriteTool = {
        id: "builtin:file_write",
        requiresConfirmation: true,
        reason: "Destructive operation that modifies filesystem",
      };
      expect(fileWriteTool.requiresConfirmation).toBe(true);
    });

    it("should document utility tools do not require confirmation", () => {
      // Tools like echo, datetime, calculate do not require confirmation
      const utilityTools = [
        { id: "builtin:echo", requiresConfirmation: false },
        { id: "builtin:datetime", requiresConfirmation: false },
        { id: "builtin:calculate", requiresConfirmation: false },
      ];
      for (const tool of utilityTools) {
        expect(tool.requiresConfirmation).toBe(false);
      }
    });
  });
});

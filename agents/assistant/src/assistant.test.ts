// Assistant Agent Tests
import { describe, it, expect, beforeEach } from "vitest";
import {
  AssistantAgent,
  createAssistantAgent,
  AssistantManifestSchema,
  AssistantError,
  DEFAULT_MANIFEST,
} from "./index.js";

describe("AssistantAgent", () => {
  let agent: AssistantAgent;

  beforeEach(() => {
    agent = createAssistantAgent();
  });

  describe("Manifest Validation", () => {
    it("should use default manifest", () => {
      const status = agent.getStatus();
      expect(status.id).toBe("assistant");
      expect(status.name).toBe("Assistant Agent");
    });

    it("should accept custom manifest", () => {
      const customAgent = createAssistantAgent({
        id: "custom-assistant",
        name: "Custom Assistant",
        version: "1.0.0",
      });
      const status = customAgent.getStatus();
      expect(status.id).toBe("custom-assistant");
      expect(status.name).toBe("Custom Assistant");
    });

    it("should validate manifest schema", () => {
      const valid = AssistantManifestSchema.safeParse({
        id: "test",
        name: "Test Agent",
      });
      expect(valid.success).toBe(true);
    });

    it("should reject invalid manifest", () => {
      const invalid = AssistantManifestSchema.safeParse({
        id: "", // Empty ID
        name: "Test",
      });
      expect(invalid.success).toBe(false);
    });

    it("should throw on invalid manifest in constructor", () => {
      expect(() => createAssistantAgent({ id: "" })).toThrow(AssistantError);
    });
  });

  describe("Lifecycle", () => {
    it("should start in idle state", () => {
      const status = agent.getStatus();
      expect(status.state).toBe("idle");
    });

    it("should initialize successfully", async () => {
      const result = await agent.initialize();
      expect(result.ok).toBe(true);
      expect(agent.getStatus().state).toBe("ready");
    });

    it("should reject double initialization", async () => {
      await agent.initialize();
      const result = await agent.initialize();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("ALREADY_RUNNING");
      }
    });

    it("should terminate successfully", async () => {
      await agent.initialize();
      const result = await agent.terminate();
      expect(result.ok).toBe(true);
      expect(agent.getStatus().state).toBe("terminated");
    });

    it("should track uptime after initialization", async () => {
      await agent.initialize();
      const status = agent.getStatus();
      expect(status.uptime).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Message Processing", () => {
    beforeEach(async () => {
      await agent.initialize();
    });

    it("should process simple message", async () => {
      const result = await agent.processMessage("Hello!");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toContain("Hello");
      }
    });

    it("should respond to help request", async () => {
      const result = await agent.processMessage("help");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toContain("help");
      }
    });

    it("should handle who are you question", async () => {
      const result = await agent.processMessage("Who are you?");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toContain("Assistant Agent");
      }
    });

    it("should reject processing when not ready", async () => {
      const unreadyAgent = createAssistantAgent();
      const result = await unreadyAgent.processMessage("Hello");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_INITIALIZED");
      }
    });

    it("should track message count", async () => {
      await agent.processMessage("Message 1");
      await agent.processMessage("Message 2");
      const status = agent.getStatus();
      expect(status.messageCount).toBe(2);
    });
  });

  describe("Tool Invocation", () => {
    beforeEach(async () => {
      await agent.initialize();
    });

    it("should handle calculate request", async () => {
      const result = await agent.processMessage("calculate: 2 + 2");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toContain("4");
      }
    });

    it("should handle time request", async () => {
      const result = await agent.processMessage("What time is it?");
      expect(result.ok).toBe(true);
    });

    it("should handle date request", async () => {
      const result = await agent.processMessage("What is today's date?");
      expect(result.ok).toBe(true);
    });
  });

  describe("Conversation History", () => {
    beforeEach(async () => {
      await agent.initialize();
    });

    it("should maintain conversation history", async () => {
      await agent.processMessage("Hello");
      await agent.processMessage("How are you?");
      const history = agent.getHistory();
      // System prompt + 2 user messages + 2 assistant responses
      expect(history.length).toBeGreaterThanOrEqual(4);
    });

    it("should include system prompt in history", () => {
      const history = agent.getHistory();
      const systemMessage = history.find((m) => m.role === "system");
      expect(systemMessage).toBeDefined();
    });

    it("should clear history", async () => {
      await agent.processMessage("Hello");
      agent.clearHistory();
      const history = agent.getHistory();
      // Should only have system prompt
      expect(history.length).toBe(1);
      expect(history[0]?.role).toBe("system");
    });
  });

  describe("Status", () => {
    it("should return complete status", async () => {
      await agent.initialize();
      const status = agent.getStatus();
      expect(status).toHaveProperty("id");
      expect(status).toHaveProperty("name");
      expect(status).toHaveProperty("state");
      expect(status).toHaveProperty("uptime");
      expect(status).toHaveProperty("messageCount");
      expect(status).toHaveProperty("capabilities");
    });

    it("should include capabilities", async () => {
      await agent.initialize();
      const status = agent.getStatus();
      expect(status.capabilities).toContain("chat");
      expect(status.capabilities).toContain("memory");
      expect(status.capabilities).toContain("tools");
    });
  });

  describe("AssistantError", () => {
    it("should create error with code", () => {
      const error = new AssistantError("Test error", "VALIDATION_ERROR");
      expect(error.message).toBe("Test error");
      expect(error.code).toBe("VALIDATION_ERROR");
      expect(error.name).toBe("AssistantError");
    });

    it("should extend Error", () => {
      const error = new AssistantError("Test", "TOOL_ERROR");
      expect(error).toBeInstanceOf(Error);
    });
  });
});

describe("DEFAULT_MANIFEST", () => {
  it("should have required fields", () => {
    expect(DEFAULT_MANIFEST.id).toBe("assistant");
    expect(DEFAULT_MANIFEST.name).toBe("Assistant Agent");
    expect(DEFAULT_MANIFEST.version).toBe("0.1.0");
  });

  it("should have system prompt", () => {
    expect(DEFAULT_MANIFEST.systemPrompt).toBeDefined();
    expect(DEFAULT_MANIFEST.systemPrompt?.length).toBeGreaterThan(0);
  });

  it("should have capabilities", () => {
    expect(DEFAULT_MANIFEST.capabilities).toContain("chat");
  });
});

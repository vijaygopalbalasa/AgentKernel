import { describe, it, expect, beforeEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AutoGenAdapter, createAutoGenAdapter } from "./index.js";
import { AgentSandbox } from "@agentkernel/runtime";

const TEST_DIR = join(tmpdir(), "agentkernel-autogen-test");

function writeTestConfig(filename: string, content: string): string {
  mkdirSync(TEST_DIR, { recursive: true });
  const path = join(TEST_DIR, filename);
  writeFileSync(path, content);
  return path;
}

function createCodingPair(): string {
  return writeTestConfig("autogen.json", JSON.stringify({
    name: "coding-pair",
    initiator: "user_proxy",
    responder: "assistant",
    agents: {
      assistant: {
        name: "AI Assistant",
        type: "AssistantAgent",
        system_message: "You are a helpful AI assistant that writes Python code.",
        model: "gpt-4o",
        functions: {
          search_web: { description: "Search the web", capability: "network:http" },
          read_file: { description: "Read a file" },
        },
      },
      user_proxy: {
        name: "User Proxy",
        type: "UserProxyAgent",
        human_input_mode: "NEVER",
        max_consecutive_auto_reply: 5,
        is_termination_msg: "TERMINATE",
        code_execution_config: {
          enabled: true,
          work_dir: "/tmp/code",
          use_docker: false,
          timeout: 30,
        },
      },
    },
  }));
}

describe("AutoGenAdapter", () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("creates via factory function", () => {
    const adapter = createAutoGenAdapter();
    expect(adapter.name).toBe("autogen");
    expect(adapter.version).toBe("0.1.0");
    expect(adapter.state).toBe("idle");
  });

  it("loads a two-agent config", async () => {
    const configPath = createCodingPair();
    const adapter = new AutoGenAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    expect(adapter.state).toBe("loaded");
    const config = adapter.getConfig();
    expect(config?.name).toBe("coding-pair");
    expect(config?.agents.size).toBe(2);
    expect(config?.initiator).toBe("user_proxy");
    expect(config?.responder).toBe("assistant");
    expect(config?.agents.get("assistant")?.type).toBe("AssistantAgent");
    expect(config?.agents.get("user_proxy")?.type).toBe("UserProxyAgent");
  });

  it("resolves capabilities from code execution and functions", async () => {
    const configPath = createCodingPair();
    const adapter = new AutoGenAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const caps = adapter.getRequiredCapabilities();
    expect(caps).toContain("llm:chat");
    expect(caps).toContain("llm:stream");
    expect(caps).toContain("shell:execute");
    expect(caps).toContain("network:http");
    expect(caps).toContain("file:read");
  });

  it("starts and sets initial speaker", async () => {
    const configPath = createCodingPair();
    const adapter = new AutoGenAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const sandbox = new AgentSandbox("test-autogen", { enforcePermissions: false });
    await adapter.start(sandbox);

    expect(adapter.state).toBe("running");
    expect(adapter.getCurrentSpeaker()).toBe("user_proxy");
  });

  it("denies start with missing capabilities", async () => {
    const configPath = createCodingPair();
    const adapter = new AutoGenAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const sandbox = new AgentSandbox("test-autogen", {
      enforcePermissions: true,
      defaultCapabilities: ["llm:chat"],
    });

    await expect(adapter.start(sandbox)).rejects.toThrow("shell:execute");
  });

  it("initiates a two-agent conversation", async () => {
    const configPath = createCodingPair();
    const adapter = new AutoGenAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const sandbox = new AgentSandbox("test-autogen", { enforcePermissions: false });
    await adapter.start(sandbox);

    const response = await adapter.handleMessage({
      type: "initiate",
      payload: { content: "Write a Python function to sort a list" },
    });

    expect(response.type).toBe("conversation_started");
    expect(response.payload.mode).toBe("two_agent");
    expect(response.payload.initiator).toBe("user_proxy");
    expect(response.payload.responder).toBe("assistant");
    expect(response.payload.message).toContain("sort");
  });

  it("initiates a group chat conversation", async () => {
    const configPath = writeTestConfig("group.json", JSON.stringify({
      name: "dev-team",
      initiator: "pm",
      agents: {
        pm: { name: "PM", type: "AssistantAgent", system_message: "You are a PM" },
        dev: { name: "Developer", type: "AssistantAgent", system_message: "You code" },
        qa: { name: "QA", type: "AssistantAgent", system_message: "You test" },
      },
      group_chat: {
        agents: ["pm", "dev", "qa"],
        max_round: 5,
        speaker_selection_method: "round_robin",
      },
    }));

    const adapter = new AutoGenAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const sandbox = new AgentSandbox("test-autogen", { enforcePermissions: false });
    await adapter.start(sandbox);

    const response = await adapter.handleMessage({
      type: "initiate",
      payload: { content: "Build a feature" },
    });

    expect(response.type).toBe("conversation_started");
    expect(response.payload.mode).toBe("group_chat");
    expect(response.payload.maxRound).toBe(5);
    const participants = response.payload.participants as Array<{ name: string }>;
    expect(participants).toHaveLength(3);
  });

  it("handles chat turns with system messages", async () => {
    const configPath = createCodingPair();
    const adapter = new AutoGenAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const sandbox = new AgentSandbox("test-autogen", { enforcePermissions: false });
    await adapter.start(sandbox);

    const response = await adapter.handleMessage({
      type: "chat",
      payload: { content: "Hello from user proxy", agent: "user_proxy" },
    });

    expect(response.type).toBe("chat_request");
    // Should advance to the responder (assistant)
    expect(response.payload.agent).toBe("assistant");
    const messages = response.payload.messages as Array<{ role: string; content: string }>;
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("Python code");
  });

  it("detects termination message", async () => {
    const configPath = createCodingPair();
    const adapter = new AutoGenAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const sandbox = new AgentSandbox("test-autogen", { enforcePermissions: false });
    await adapter.start(sandbox);

    const response = await adapter.handleMessage({
      type: "chat",
      payload: { content: "The task is done. TERMINATE", agent: "user_proxy" },
    });

    expect(response.type).toBe("conversation_complete");
    expect(response.payload.reason).toBe("termination_message");
  });

  it("handles code execution with sandbox check", async () => {
    const configPath = createCodingPair();
    const adapter = new AutoGenAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const sandbox = new AgentSandbox("test-autogen", { enforcePermissions: false });
    await adapter.start(sandbox);

    const response = await adapter.handleMessage({
      type: "execute_code",
      payload: { agent: "user_proxy", code: "print('hello')", language: "python" },
    });

    expect(response.type).toBe("code_execution");
    expect(response.payload.code).toBe("print('hello')");
    expect(response.payload.workDir).toBe("/tmp/code");
    expect(response.payload.timeout).toBe(30);
  });

  it("denies code execution for agents without it enabled", async () => {
    const configPath = createCodingPair();
    const adapter = new AutoGenAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const sandbox = new AgentSandbox("test-autogen", { enforcePermissions: false });
    await adapter.start(sandbox);

    const response = await adapter.handleMessage({
      type: "execute_code",
      payload: { agent: "assistant", code: "print('hello')" },
    });

    expect(response.type).toBe("error");
    expect(String(response.payload.message)).toContain("not enabled");
  });

  it("approves registered function calls", async () => {
    const configPath = createCodingPair();
    const adapter = new AutoGenAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const sandbox = new AgentSandbox("test-autogen", { enforcePermissions: false });
    await adapter.start(sandbox);

    const response = await adapter.handleMessage({
      type: "function_call",
      payload: { function: "search_web", agent: "assistant", args: { query: "test" } },
    });

    expect(response.type).toBe("function_approved");
    expect(response.payload.function).toBe("search_web");
  });

  it("denies unregistered function calls", async () => {
    const configPath = createCodingPair();
    const adapter = new AutoGenAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const sandbox = new AgentSandbox("test-autogen", { enforcePermissions: false });
    await adapter.start(sandbox);

    const response = await adapter.handleMessage({
      type: "function_call",
      payload: { function: "delete_database", agent: "assistant" },
    });

    expect(response.type).toBe("error");
    expect(String(response.payload.message)).toContain("not registered");
  });

  it("denies function calls when sandbox denies capability", async () => {
    const configPath = writeTestConfig("fn-deny.json", JSON.stringify({
      name: "fn-deny-test",
      initiator: "user",
      responder: "bot",
      agents: {
        user: { name: "User", type: "UserProxyAgent", human_input_mode: "NEVER" },
        bot: {
          name: "Bot",
          type: "AssistantAgent",
          functions: {
            dangerous_fn: { description: "Needs admin", capability: "admin:dangerous" },
          },
        },
      },
    }));

    const adapter = new AutoGenAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    // Sandbox does not grant admin:dangerous — start() should reject
    const sandbox = new AgentSandbox("test-deny", {
      enforcePermissions: true,
      defaultCapabilities: ["llm:chat", "llm:stream"],
    });
    await expect(adapter.start(sandbox)).rejects.toThrow("admin:dangerous");
  });

  it("returns status with conversation details", async () => {
    const configPath = createCodingPair();
    const adapter = new AutoGenAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const sandbox = new AgentSandbox("test-autogen", { enforcePermissions: false });
    await adapter.start(sandbox);

    const response = await adapter.handleMessage({
      type: "status",
      payload: {},
    });

    expect(response.type).toBe("status");
    expect(response.payload.adapter).toBe("autogen");
    expect(response.payload.state).toBe("running");
    expect(response.payload.currentSpeaker).toBe("user_proxy");
    const config = response.payload.config as Record<string, unknown>;
    expect(config.name).toBe("coding-pair");
  });

  it("stops cleanly and clears history", async () => {
    const configPath = createCodingPair();
    const adapter = new AutoGenAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const sandbox = new AgentSandbox("test-autogen", { enforcePermissions: false });
    await adapter.start(sandbox);

    await adapter.handleMessage({
      type: "chat",
      payload: { content: "Hello", agent: "user_proxy" },
    });
    expect(adapter.getConversationHistory()).toHaveLength(1);

    await adapter.stop();
    expect(adapter.state).toBe("stopped");
    expect(adapter.getConversationHistory()).toHaveLength(0);
    expect(adapter.getCurrentSpeaker()).toBeNull();
  });

  it("errors on missing config file", async () => {
    const adapter = new AutoGenAdapter();
    await expect(
      adapter.load({
        configPath: "/nonexistent/autogen.json",
        workingDirectory: TEST_DIR,
        env: {},
        options: {},
      })
    ).rejects.toThrow("not found");
  });

  it("errors on unsupported config format", async () => {
    const configPath = writeTestConfig("autogen.toml", "name = 'test'");
    const adapter = new AutoGenAdapter();
    await expect(
      adapter.load({
        configPath,
        workingDirectory: TEST_DIR,
        env: {},
        options: {},
      })
    ).rejects.toThrow("Unsupported config format");
  });
});

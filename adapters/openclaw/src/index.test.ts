import { describe, it, expect, beforeEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OpenClawAdapter, createOpenClawAdapter } from "./index.js";
import { AgentSandbox } from "@agentkernel/runtime";

const TEST_DIR = join(tmpdir(), "agentkernel-openclaw-test");

function writeTestConfig(filename: string, content: string): string {
  mkdirSync(TEST_DIR, { recursive: true });
  const path = join(TEST_DIR, filename);
  writeFileSync(path, content);
  return path;
}

describe("OpenClawAdapter", () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("creates an adapter via factory", () => {
    const adapter = createOpenClawAdapter();
    expect(adapter.name).toBe("openclaw");
    expect(adapter.version).toBe("0.1.0");
    expect(adapter.state).toBe("idle");
  });

  it("loads a JSON config", async () => {
    const configPath = writeTestConfig("config.json", JSON.stringify({
      name: "test-agent",
      skills: ["web-browse", "memory"],
      model: "claude-3-haiku",
    }));

    const adapter = new OpenClawAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    expect(adapter.state).toBe("loaded");
    const config = adapter.getConfig();
    expect(config?.name).toBe("test-agent");
    expect(config?.skills).toHaveLength(2);
    expect(config?.model).toBe("claude-3-haiku");
  });

  it("loads a YAML config", async () => {
    const configPath = writeTestConfig("config.yaml", [
      "name: my-openclaw",
      "personality: You are helpful",
      "model: gpt-4o",
      "skills:",
      "  - file-system",
      "  - shell-exec",
    ].join("\n"));

    const adapter = new OpenClawAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    expect(adapter.state).toBe("loaded");
    const config = adapter.getConfig();
    expect(config?.name).toBe("my-openclaw");
    expect(config?.personality).toBe("You are helpful");
    expect(config?.skills).toHaveLength(2);
  });

  it("resolves capabilities from skills", async () => {
    const configPath = writeTestConfig("config.json", JSON.stringify({
      skills: ["file-system", "shell-exec", "web-browse"],
    }));

    const adapter = new OpenClawAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const caps = adapter.getRequiredCapabilities();
    expect(caps).toContain("llm:chat");
    expect(caps).toContain("llm:stream");
    expect(caps).toContain("file:read");
    expect(caps).toContain("file:write");
    expect(caps).toContain("shell:execute");
    expect(caps).toContain("network:http");
  });

  it("starts with sandbox and checks capabilities", async () => {
    const configPath = writeTestConfig("config.json", JSON.stringify({
      skills: ["memory"],
    }));

    const adapter = new OpenClawAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const sandbox = new AgentSandbox("test-agent", {
      enforcePermissions: false,
    });

    await adapter.start(sandbox);
    expect(adapter.state).toBe("running");
  });

  it("denies capabilities not granted in strict mode", async () => {
    const configPath = writeTestConfig("config.json", JSON.stringify({
      skills: ["shell-exec"],
    }));

    const adapter = new OpenClawAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const sandbox = new AgentSandbox("test-agent", {
      enforcePermissions: true,
      defaultCapabilities: ["llm:chat", "llm:stream"],
    });

    await expect(adapter.start(sandbox)).rejects.toThrow("shell:execute");
  });

  it("handles chat messages", async () => {
    const configPath = writeTestConfig("config.json", JSON.stringify({
      personality: "You are a test bot",
      skills: [],
    }));

    const adapter = new OpenClawAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const sandbox = new AgentSandbox("test-agent", {
      enforcePermissions: false,
    });
    await adapter.start(sandbox);

    const response = await adapter.handleMessage({
      type: "chat",
      payload: { content: "Hello" },
    });

    expect(response.type).toBe("chat_request");
    const messages = response.payload.messages as Array<{ role: string; content: string }>;
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toBe("You are a test bot");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toBe("Hello");
  });

  it("enforces skill permissions via sandbox", async () => {
    const configPath = writeTestConfig("config.json", JSON.stringify({
      skills: ["file-system"],
    }));

    const adapter = new OpenClawAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const sandbox = new AgentSandbox("test-agent", {
      enforcePermissions: true,
      defaultCapabilities: ["llm:chat", "llm:stream"],
    });
    sandbox.grant("file:read", "system");
    sandbox.grant("file:write", "system");
    await adapter.start(sandbox);

    const response = await adapter.handleMessage({
      type: "skill_invoke",
      payload: { skill: "file-system", args: { path: "/tmp/test" } },
    });
    expect(response.type).toBe("skill_approved");
  });

  it("denies unenabled skills", async () => {
    const configPath = writeTestConfig("config.json", JSON.stringify({
      skills: [{ name: "shell-exec", enabled: false }],
    }));

    const adapter = new OpenClawAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const sandbox = new AgentSandbox("test-agent", {
      enforcePermissions: false,
    });
    await adapter.start(sandbox);

    const response = await adapter.handleMessage({
      type: "skill_invoke",
      payload: { skill: "shell-exec" },
    });
    expect(response.type).toBe("error");
  });

  it("handles tool_call with capability check", async () => {
    const configPath = writeTestConfig("config.json", JSON.stringify({
      skills: [],
    }));

    const adapter = new OpenClawAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const sandbox = new AgentSandbox("test-agent", {
      enforcePermissions: true,
      defaultCapabilities: ["llm:chat", "llm:stream"],
    });
    await adapter.start(sandbox);

    const response = await adapter.handleMessage({
      type: "tool_call",
      payload: { tool: "read_file", args: { path: "/etc/passwd" } },
    });
    expect(response.type).toBe("error");
    expect(String(response.payload.message)).toContain("denied");
  });

  it("returns status", async () => {
    const configPath = writeTestConfig("config.json", JSON.stringify({
      name: "status-test",
      skills: ["web-browse"],
      model: "gpt-4o",
    }));

    const adapter = new OpenClawAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const sandbox = new AgentSandbox("test-agent", {
      enforcePermissions: false,
    });
    await adapter.start(sandbox);

    const response = await adapter.handleMessage({
      type: "status",
      payload: {},
    });

    expect(response.type).toBe("status");
    expect(response.payload.adapter).toBe("openclaw");
    expect(response.payload.state).toBe("running");
  });

  it("stops cleanly", async () => {
    const configPath = writeTestConfig("config.json", JSON.stringify({
      skills: [],
    }));

    const adapter = new OpenClawAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const sandbox = new AgentSandbox("test-agent", {
      enforcePermissions: false,
    });
    await adapter.start(sandbox);
    await adapter.stop();

    expect(adapter.state).toBe("stopped");
  });

  it("errors on missing config file", async () => {
    const adapter = new OpenClawAdapter();
    await expect(
      adapter.load({
        configPath: "/nonexistent/config.json",
        workingDirectory: TEST_DIR,
        env: {},
        options: {},
      })
    ).rejects.toThrow("not found");
  });

  it("errors on unsupported config format", async () => {
    const configPath = writeTestConfig("config.toml", "name = 'test'");
    const adapter = new OpenClawAdapter();
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

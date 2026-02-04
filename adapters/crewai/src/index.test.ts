import { describe, it, expect, beforeEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CrewAIAdapter, createCrewAIAdapter } from "./index.js";
import { AgentSandbox } from "@agentrun/runtime";

const TEST_DIR = join(tmpdir(), "agentrun-crewai-test");

function writeTestConfig(filename: string, content: string): string {
  mkdirSync(TEST_DIR, { recursive: true });
  const path = join(TEST_DIR, filename);
  writeFileSync(path, content);
  return path;
}

function createResearchCrew(): string {
  return writeTestConfig("crew.json", JSON.stringify({
    name: "research-crew",
    process: "sequential",
    memory: true,
    agents: {
      researcher: {
        role: "Senior Researcher",
        goal: "Find comprehensive information on the given topic",
        backstory: "You are an expert researcher with decades of experience",
        tools: ["SerperDevTool", "ScrapeWebsiteTool"],
        llm: "claude-3-haiku",
        allow_delegation: true,
      },
      writer: {
        role: "Content Writer",
        goal: "Write engaging content based on research findings",
        backstory: "You are a skilled content writer",
        tools: ["FileWriteTool"],
        llm: "gpt-4o",
        allow_delegation: false,
      },
    },
    tasks: [
      {
        description: "Research the latest AI agent frameworks",
        expected_output: "A comprehensive summary with key findings",
        agent: "researcher",
      },
      {
        description: "Write a blog post based on the research",
        expected_output: "A 1000-word blog post",
        agent: "writer",
        context: ["research"],
      },
    ],
  }));
}

describe("CrewAIAdapter", () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("creates via factory function", () => {
    const adapter = createCrewAIAdapter();
    expect(adapter.name).toBe("crewai");
    expect(adapter.version).toBe("0.1.0");
    expect(adapter.state).toBe("idle");
  });

  it("loads a crew config with agents and tasks", async () => {
    const configPath = createResearchCrew();
    const adapter = new CrewAIAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    expect(adapter.state).toBe("loaded");
    const config = adapter.getConfig();
    expect(config?.name).toBe("research-crew");
    expect(config?.process).toBe("sequential");
    expect(config?.agents.size).toBe(2);
    expect(config?.tasks).toHaveLength(2);
    expect(config?.agents.get("researcher")?.role).toBe("Senior Researcher");
    expect(config?.agents.get("writer")?.tools).toContain("FileWriteTool");
  });

  it("resolves capabilities from agent tools", async () => {
    const configPath = createResearchCrew();
    const adapter = new CrewAIAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const caps = adapter.getRequiredCapabilities();
    expect(caps).toContain("llm:chat");
    expect(caps).toContain("llm:stream");
    expect(caps).toContain("network:http");
    expect(caps).toContain("file:read");
    expect(caps).toContain("file:write");
    expect(caps).toContain("agent:communicate");
    expect(caps).toContain("memory:read");
    expect(caps).toContain("memory:write");
  });

  it("starts with permissive sandbox", async () => {
    const configPath = createResearchCrew();
    const adapter = new CrewAIAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const sandbox = new AgentSandbox("test-crew", { enforcePermissions: false });
    await adapter.start(sandbox);
    expect(adapter.state).toBe("running");
  });

  it("denies start when missing required capabilities", async () => {
    const configPath = createResearchCrew();
    const adapter = new CrewAIAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const sandbox = new AgentSandbox("test-crew", {
      enforcePermissions: true,
      defaultCapabilities: ["llm:chat"],
    });

    await expect(adapter.start(sandbox)).rejects.toThrow("network:http");
  });

  it("handles sequential kickoff with execution plan", async () => {
    const configPath = createResearchCrew();
    const adapter = new CrewAIAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const sandbox = new AgentSandbox("test-crew", { enforcePermissions: false });
    await adapter.start(sandbox);

    const response = await adapter.handleMessage({
      type: "kickoff",
      payload: { inputs: { topic: "AI agents" } },
    });

    expect(response.type).toBe("execution_plan");
    expect(response.payload.process).toBe("sequential");
    expect(response.payload.totalTasks).toBe(2);
    const steps = response.payload.steps as Array<{ step: number; agent: string }>;
    expect(steps[0].step).toBe(1);
    expect(steps[0].agent).toBe("researcher");
    expect(steps[1].step).toBe(2);
    expect(steps[1].agent).toBe("writer");
  });

  it("handles hierarchical kickoff with manager", async () => {
    const configPath = writeTestConfig("hier-crew.json", JSON.stringify({
      name: "managed-crew",
      process: "hierarchical",
      manager_llm: "claude-3-opus",
      agents: {
        analyst: {
          role: "Data Analyst",
          goal: "Analyze data",
          backstory: "Expert analyst",
          tools: ["CSVSearchTool"],
        },
      },
      tasks: [{
        description: "Analyze Q4 data",
        expected_output: "Charts and insights",
        agent: "analyst",
      }],
    }));

    const adapter = new CrewAIAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const sandbox = new AgentSandbox("test-crew", { enforcePermissions: false });
    await adapter.start(sandbox);

    const response = await adapter.handleMessage({
      type: "kickoff",
      payload: { inputs: {} },
    });

    expect(response.type).toBe("execution_plan");
    expect(response.payload.process).toBe("hierarchical");
    expect(response.payload.managerLlm).toBe("claude-3-opus");
  });

  it("handles chat messages with agent role/goal system prompt", async () => {
    const configPath = createResearchCrew();
    const adapter = new CrewAIAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const sandbox = new AgentSandbox("test-crew", { enforcePermissions: false });
    await adapter.start(sandbox);

    const response = await adapter.handleMessage({
      type: "chat",
      payload: { content: "What are the trends?", agent: "researcher" },
    });

    expect(response.type).toBe("chat_request");
    const messages = response.payload.messages as Array<{ role: string; content: string }>;
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("Senior Researcher");
    expect(messages[0].content).toContain("Find comprehensive information");
    expect(messages[1].content).toBe("What are the trends?");
  });

  it("handles delegation between agents", async () => {
    const configPath = createResearchCrew();
    const adapter = new CrewAIAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const sandbox = new AgentSandbox("test-crew", { enforcePermissions: false });
    await adapter.start(sandbox);

    const response = await adapter.handleMessage({
      type: "delegate",
      payload: { from: "researcher", to: "writer", task: "Write a summary" },
    });

    expect(response.type).toBe("delegation");
    expect((response.payload.from as Record<string, unknown>).role).toBe("Senior Researcher");
    expect((response.payload.to as Record<string, unknown>).role).toBe("Content Writer");
  });

  it("blocks delegation when agent has allowDelegation=false", async () => {
    const configPath = createResearchCrew();
    const adapter = new CrewAIAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const sandbox = new AgentSandbox("test-crew", { enforcePermissions: false });
    await adapter.start(sandbox);

    const response = await adapter.handleMessage({
      type: "delegate",
      payload: { from: "writer", to: "researcher", task: "Do more research" },
    });

    expect(response.type).toBe("error");
    expect(String(response.payload.message)).toContain("does not allow delegation");
  });

  it("approves tool calls for assigned tools", async () => {
    const configPath = createResearchCrew();
    const adapter = new CrewAIAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const sandbox = new AgentSandbox("test-crew", { enforcePermissions: false });
    await adapter.start(sandbox);

    const response = await adapter.handleMessage({
      type: "tool_call",
      payload: { tool: "SerperDevTool", agent: "researcher", args: { query: "AI" } },
    });

    expect(response.type).toBe("tool_approved");
    expect(response.payload.tool).toBe("SerperDevTool");
  });

  it("denies tool calls for unassigned tools", async () => {
    const configPath = createResearchCrew();
    const adapter = new CrewAIAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const sandbox = new AgentSandbox("test-crew", { enforcePermissions: false });
    await adapter.start(sandbox);

    const response = await adapter.handleMessage({
      type: "tool_call",
      payload: { tool: "ShellTool", agent: "researcher" },
    });

    expect(response.type).toBe("error");
    expect(String(response.payload.message)).toContain("not assigned");
  });

  it("denies tool calls when sandbox denies capability", async () => {
    const configPath = writeTestConfig("shell-crew.json", JSON.stringify({
      agents: {
        devops: {
          role: "DevOps",
          goal: "Manage servers",
          backstory: "Expert",
          tools: ["ShellTool"],
        },
      },
      tasks: [],
    }));

    const adapter = new CrewAIAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const sandbox = new AgentSandbox("test-crew", {
      enforcePermissions: true,
      defaultCapabilities: ["llm:chat", "llm:stream", "agent:communicate"],
    });

    await expect(adapter.start(sandbox)).rejects.toThrow("shell:execute");
  });

  it("returns status with crew details", async () => {
    const configPath = createResearchCrew();
    const adapter = new CrewAIAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const sandbox = new AgentSandbox("test-crew", { enforcePermissions: false });
    await adapter.start(sandbox);

    const response = await adapter.handleMessage({
      type: "status",
      payload: {},
    });

    expect(response.type).toBe("status");
    expect(response.payload.adapter).toBe("crewai");
    expect(response.payload.state).toBe("running");
    const config = response.payload.config as Record<string, unknown>;
    expect(config.process).toBe("sequential");
    expect(config.tasks).toBe(2);
  });

  it("stops cleanly", async () => {
    const configPath = createResearchCrew();
    const adapter = new CrewAIAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const sandbox = new AgentSandbox("test-crew", { enforcePermissions: false });
    await adapter.start(sandbox);
    await adapter.stop();
    expect(adapter.state).toBe("stopped");
  });

  it("errors on missing config file", async () => {
    const adapter = new CrewAIAdapter();
    await expect(
      adapter.load({
        configPath: "/nonexistent/crew.json",
        workingDirectory: TEST_DIR,
        env: {},
        options: {},
      })
    ).rejects.toThrow("not found");
  });

  it("errors on unsupported config format", async () => {
    const configPath = writeTestConfig("crew.toml", "name = 'test'");
    const adapter = new CrewAIAdapter();
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

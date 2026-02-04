import { describe, it, expect, beforeEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LangGraphAdapter, createLangGraphAdapter } from "./index.js";
import { AgentSandbox } from "@agentkernel/runtime";

const TEST_DIR = join(tmpdir(), "agentkernel-langgraph-test");

function writeTestConfig(filename: string, content: string): string {
  mkdirSync(TEST_DIR, { recursive: true });
  const path = join(TEST_DIR, filename);
  writeFileSync(path, content);
  return path;
}

function createReActGraph(): string {
  return writeTestConfig("graph.json", JSON.stringify({
    name: "react-agent",
    entry_point: "agent",
    recursion_limit: 10,
    nodes: {
      agent: {
        type: "agent",
        name: "ReAct Agent",
        model: "claude-3-haiku",
        prompt: "You are a helpful assistant with access to tools.",
        tools: ["TavilySearchResults", "ReadFileTool"],
      },
      tools: {
        type: "tool",
        name: "Tool Executor",
        tools: ["TavilySearchResults", "ReadFileTool"],
      },
    },
    edges: [
      { from: "agent", to: "tools", condition: "has_tool_calls" },
      { from: "agent", to: "__end__" },
      { from: "tools", to: "agent" },
    ],
    state_schema: {
      messages: { type: "list", default: [], reducer: "append" },
      next_step: { type: "string", default: "" },
    },
    checkpoint: { enabled: true, store: "memory" },
  }));
}

describe("LangGraphAdapter", () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("creates via factory function", () => {
    const adapter = createLangGraphAdapter();
    expect(adapter.name).toBe("langgraph");
    expect(adapter.version).toBe("0.1.0");
    expect(adapter.state).toBe("idle");
  });

  it("loads a graph config with nodes and edges", async () => {
    const configPath = createReActGraph();
    const adapter = new LangGraphAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    expect(adapter.state).toBe("loaded");
    const config = adapter.getConfig();
    expect(config?.name).toBe("react-agent");
    expect(config?.entryPoint).toBe("agent");
    expect(config?.nodes.size).toBe(3); // agent, tools, __end__
    expect(config?.edges).toHaveLength(3);
    expect(config?.recursionLimit).toBe(10);
    expect(config?.checkpoint.enabled).toBe(true);
  });

  it("resolves capabilities from tool nodes", async () => {
    const configPath = createReActGraph();
    const adapter = new LangGraphAdapter();
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
  });

  it("initializes state with defaults on start", async () => {
    const configPath = createReActGraph();
    const adapter = new LangGraphAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const sandbox = new AgentSandbox("test-graph", { enforcePermissions: false });
    await adapter.start(sandbox);

    expect(adapter.state).toBe("running");
    const state = adapter.getGraphState();
    expect(state.messages).toEqual([]);
    expect(state.next_step).toBe("");
    expect(adapter.getCurrentNode()).toBe("agent");
  });

  it("denies start when capabilities missing", async () => {
    const configPath = createReActGraph();
    const adapter = new LangGraphAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const sandbox = new AgentSandbox("test-graph", {
      enforcePermissions: true,
      defaultCapabilities: ["llm:chat"],
    });

    await expect(adapter.start(sandbox)).rejects.toThrow("network:http");
  });

  it("handles graph invocation with initial state", async () => {
    const configPath = createReActGraph();
    const adapter = new LangGraphAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const sandbox = new AgentSandbox("test-graph", { enforcePermissions: false });
    await adapter.start(sandbox);

    const response = await adapter.handleMessage({
      type: "invoke",
      payload: { inputs: { query: "What is AgentKernel?" } },
    });

    expect(response.type).toBe("graph_step");
    expect(response.payload.currentNode).toBe("agent");
    expect(response.payload.nodeType).toBe("agent");
    expect(response.payload.model).toBe("claude-3-haiku");
    const state = response.payload.state as Record<string, unknown>;
    expect(state.query).toBe("What is AgentKernel?");
  });

  it("advances through graph with step messages", async () => {
    const configPath = writeTestConfig("linear.json", JSON.stringify({
      name: "linear-graph",
      entry_point: "step1",
      nodes: {
        step1: { type: "agent", name: "Step 1", prompt: "First step" },
        step2: { type: "agent", name: "Step 2", prompt: "Second step" },
      },
      edges: [
        { from: "step1", to: "step2" },
        { from: "step2", to: "__end__" },
      ],
    }));

    const adapter = new LangGraphAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const sandbox = new AgentSandbox("test-graph", { enforcePermissions: false });
    await adapter.start(sandbox);

    // First step advances to step2
    const step1 = await adapter.handleMessage({ type: "step", payload: {} });
    expect(step1.type).toBe("graph_step");
    expect(step1.payload.currentNode).toBe("step2");

    // Second step completes the graph
    const step2 = await adapter.handleMessage({ type: "step", payload: {} });
    expect(step2.type).toBe("graph_complete");
  });

  it("completes graph when no outgoing edges", async () => {
    const configPath = writeTestConfig("terminal.json", JSON.stringify({
      name: "terminal-graph",
      entry_point: "only_node",
      nodes: {
        only_node: { type: "agent", name: "Only Node" },
      },
      edges: [],
    }));

    const adapter = new LangGraphAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const sandbox = new AgentSandbox("test-graph", { enforcePermissions: false });
    await adapter.start(sandbox);

    const response = await adapter.handleMessage({ type: "step", payload: {} });
    expect(response.type).toBe("graph_complete");
  });

  it("handles chat messages on agent nodes", async () => {
    const configPath = createReActGraph();
    const adapter = new LangGraphAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const sandbox = new AgentSandbox("test-graph", { enforcePermissions: false });
    await adapter.start(sandbox);

    const response = await adapter.handleMessage({
      type: "chat",
      payload: { content: "Search for something", node: "agent" },
    });

    expect(response.type).toBe("chat_request");
    const messages = response.payload.messages as Array<{ role: string; content: string }>;
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("helpful assistant");
    expect(messages[1].content).toBe("Search for something");
  });

  it("rejects chat on non-agent nodes", async () => {
    const configPath = createReActGraph();
    const adapter = new LangGraphAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const sandbox = new AgentSandbox("test-graph", { enforcePermissions: false });
    await adapter.start(sandbox);

    const response = await adapter.handleMessage({
      type: "chat",
      payload: { content: "Hello", node: "tools" },
    });

    expect(response.type).toBe("error");
    expect(String(response.payload.message)).toContain("tool node");
  });

  it("handles state updates with reducers", async () => {
    const configPath = createReActGraph();
    const adapter = new LangGraphAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const sandbox = new AgentSandbox("test-graph", { enforcePermissions: false });
    await adapter.start(sandbox);

    // messages field uses "append" reducer
    await adapter.handleMessage({
      type: "update_state",
      payload: { updates: { messages: "hello" } },
    });

    const state1 = adapter.getGraphState();
    expect(state1.messages).toEqual(["hello"]); // default [] gets "hello" appended

    // next_step uses default replace
    await adapter.handleMessage({
      type: "update_state",
      payload: { updates: { next_step: "tools" } },
    });

    const state2 = adapter.getGraphState();
    expect(state2.next_step).toBe("tools");
  });

  it("approves tool calls on nodes with matching tools", async () => {
    const configPath = createReActGraph();
    const adapter = new LangGraphAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const sandbox = new AgentSandbox("test-graph", { enforcePermissions: false });
    await adapter.start(sandbox);

    const response = await adapter.handleMessage({
      type: "tool_call",
      payload: { tool: "TavilySearchResults", node: "agent", args: { query: "test" } },
    });

    expect(response.type).toBe("tool_approved");
  });

  it("denies tool calls for tools not on the node", async () => {
    const configPath = createReActGraph();
    const adapter = new LangGraphAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const sandbox = new AgentSandbox("test-graph", { enforcePermissions: false });
    await adapter.start(sandbox);

    const response = await adapter.handleMessage({
      type: "tool_call",
      payload: { tool: "ShellTool", node: "agent" },
    });

    expect(response.type).toBe("error");
    expect(String(response.payload.message)).toContain("not available");
  });

  it("validates graph structure on load", async () => {
    const configPath = writeTestConfig("bad-graph.json", JSON.stringify({
      entry_point: "nonexistent",
      nodes: {
        start: { type: "agent", name: "Start" },
      },
      edges: [],
    }));

    const adapter = new LangGraphAdapter();
    await expect(
      adapter.load({
        configPath,
        workingDirectory: TEST_DIR,
        env: {},
        options: {},
      })
    ).rejects.toThrow("not found in graph nodes");
  });

  it("validates edge references on load", async () => {
    const configPath = writeTestConfig("bad-edges.json", JSON.stringify({
      entry_point: "start",
      nodes: {
        start: { type: "agent", name: "Start" },
      },
      edges: [{ from: "start", to: "missing_node" }],
    }));

    const adapter = new LangGraphAdapter();
    await expect(
      adapter.load({
        configPath,
        workingDirectory: TEST_DIR,
        env: {},
        options: {},
      })
    ).rejects.toThrow("unknown target node");
  });

  it("returns status with graph details", async () => {
    const configPath = createReActGraph();
    const adapter = new LangGraphAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const sandbox = new AgentSandbox("test-graph", { enforcePermissions: false });
    await adapter.start(sandbox);

    const response = await adapter.handleMessage({
      type: "status",
      payload: {},
    });

    expect(response.type).toBe("status");
    expect(response.payload.adapter).toBe("langgraph");
    expect(response.payload.currentNode).toBe("agent");
    const config = response.payload.config as Record<string, unknown>;
    expect(config.entryPoint).toBe("agent");
    expect(config.recursionLimit).toBe(10);
    expect(config.checkpoint).toBe(true);
  });

  it("stops cleanly and clears state", async () => {
    const configPath = createReActGraph();
    const adapter = new LangGraphAdapter();
    await adapter.load({
      configPath,
      workingDirectory: TEST_DIR,
      env: {},
      options: {},
    });

    const sandbox = new AgentSandbox("test-graph", { enforcePermissions: false });
    await adapter.start(sandbox);
    await adapter.stop();

    expect(adapter.state).toBe("stopped");
    expect(adapter.getCurrentNode()).toBeNull();
    expect(adapter.getGraphState()).toEqual({});
  });

  it("errors on missing config file", async () => {
    const adapter = new LangGraphAdapter();
    await expect(
      adapter.load({
        configPath: "/nonexistent/graph.json",
        workingDirectory: TEST_DIR,
        env: {},
        options: {},
      })
    ).rejects.toThrow("not found");
  });
});

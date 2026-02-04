// @agentrun/adapter-langgraph — Run LangGraph state machines inside AgentRun's sandboxed runtime
// Models LangGraph's directed graph with nodes, edges, state, and checkpoints.

import { readFileSync, existsSync } from "node:fs";
import { resolve, extname } from "node:path";
import type {
  AgentAdapter,
  AdapterConfig,
  AdapterMessage,
  AdapterResponse,
  AdapterState,
} from "@agentrun/runtime";
import type { Capability, AgentSandbox } from "@agentrun/runtime";

// ─── LangGraph Configuration Types ──────────────────────────

/** Node types in a LangGraph graph. */
type NodeType = "agent" | "tool" | "router" | "human" | "subgraph";

/** A node in the graph. */
interface GraphNode {
  id: string;
  type: NodeType;
  name: string;
  tools?: string[];
  model?: string;
  prompt?: string;
  routingFunction?: string;
  subgraph?: string;
}

/** An edge connecting two nodes. */
interface GraphEdge {
  from: string;
  to: string;
  condition?: string;
}

/** State field in the graph's state schema. */
interface StateField {
  name: string;
  type: string;
  default?: unknown;
  reducer?: "append" | "replace" | "last";
}

/** Checkpoint configuration for persistence. */
interface CheckpointConfig {
  enabled: boolean;
  store?: "memory" | "postgres" | "redis";
  ttlSeconds?: number;
}

/** Parsed LangGraph configuration. */
interface LangGraphConfig {
  name?: string;
  version?: string;
  entryPoint: string;
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
  stateSchema: StateField[];
  checkpoint: CheckpointConfig;
  recursionLimit: number;
  raw: Record<string, unknown>;
}

/** Maps LangGraph tool names to AgentRun capabilities. */
const TOOL_CAPABILITY_MAP: Record<string, Capability[]> = {
  // LangChain built-in tools
  "TavilySearchResults": ["network:http"],
  "WikipediaQueryRun": ["network:http"],
  "ArxivQueryRun": ["network:http"],
  "PubmedQueryRun": ["network:http"],
  "DuckDuckGoSearch": ["network:http"],
  "GoogleSearch": ["network:http"],
  "BingSearch": ["network:http"],
  // File tools
  "ReadFileTool": ["file:read"],
  "WriteFileTool": ["file:read", "file:write"],
  "ListDirectoryTool": ["file:read"],
  "CopyFileTool": ["file:read", "file:write"],
  "DeleteFileTool": ["file:delete"],
  "MoveFileTool": ["file:read", "file:write", "file:delete"],
  "FileSearchTool": ["file:read"],
  // Shell tools
  "ShellTool": ["shell:execute"],
  "BashProcess": ["shell:execute"],
  "PythonREPL": ["shell:execute"],
  // Web tools
  "RequestsGetTool": ["network:http"],
  "RequestsPostTool": ["network:http"],
  "WebBrowser": ["network:http"],
  // Database tools
  "SQLDatabaseTool": ["network:http"],
  "VectorStoreTool": ["memory:read"],
  // Memory tools
  "MemorySearchTool": ["memory:read"],
  "MemoryWriteTool": ["memory:read", "memory:write"],
  // MCP tools
  "MCPTool": ["tool:mcp"],
  // Agent communication
  "HumanInputRun": ["agent:communicate"],
};

/** Base capabilities every LangGraph graph needs. */
const BASE_CAPABILITIES: Capability[] = ["llm:chat", "llm:stream"];

/**
 * Adapter that wraps LangGraph state machines inside AgentRun's sandboxed runtime.
 *
 * Reads a LangGraph graph definition (nodes, edges, state schema), maps tool nodes
 * to AgentRun capabilities, and enforces sandbox permissions during graph traversal.
 */
export class LangGraphAdapter implements AgentAdapter {
  readonly name = "langgraph";
  readonly version = "0.1.0";

  private _state: AdapterState = "idle";
  private config: LangGraphConfig | null = null;
  private sandbox: AgentSandbox | null = null;
  private workingDirectory: string = process.cwd();
  private requiredCapabilities: Capability[] = [];
  private currentNode: string | null = null;
  private graphState: Map<string, unknown> = new Map();

  get state(): AdapterState {
    return this._state;
  }

  /** Load and validate a LangGraph configuration file. */
  async load(adapterConfig: AdapterConfig): Promise<void> {
    const configPath = resolve(adapterConfig.workingDirectory, adapterConfig.configPath);

    if (!existsSync(configPath)) {
      throw new Error(`LangGraph config not found: ${configPath}`);
    }

    this.workingDirectory = adapterConfig.workingDirectory;
    const raw = parseConfigFile(configPath);
    this.config = normalizeGraphConfig(raw);

    // Validate graph structure
    validateGraph(this.config);

    this.requiredCapabilities = resolveCapabilities(this.config);
    this._state = "loaded";
  }

  /** Start the graph with sandbox enforcement. */
  async start(sandbox: AgentSandbox): Promise<void> {
    if (this._state !== "loaded") {
      throw new Error(`Cannot start adapter in state "${this._state}" (must be "loaded")`);
    }

    if (!this.config) {
      throw new Error("No configuration loaded");
    }

    this.sandbox = sandbox;

    const denied = this.requiredCapabilities.filter((cap) => !sandbox.check(cap).allowed);
    if (denied.length > 0) {
      this._state = "error";
      throw new Error(
        `LangGraph requires capabilities not granted by sandbox: ${denied.join(", ")}. ` +
        `Grant them explicitly or use --policy permissive.`
      );
    }

    // Initialize graph state with defaults
    this.graphState = new Map();
    for (const field of this.config.stateSchema) {
      if (field.default !== undefined) {
        this.graphState.set(field.name, field.default);
      }
    }

    this.currentNode = this.config.entryPoint;
    this._state = "running";
  }

  /** Gracefully stop the graph. */
  async stop(): Promise<void> {
    this.sandbox = null;
    this.currentNode = null;
    this.graphState.clear();
    this._state = "stopped";
  }

  /** Handle messages routed to the graph. */
  async handleMessage(message: AdapterMessage): Promise<AdapterResponse> {
    if (this._state !== "running" || !this.sandbox || !this.config) {
      return {
        type: "error",
        payload: { message: `Adapter is not running (state: ${this._state})` },
      };
    }

    switch (message.type) {
      case "invoke":
        return this.handleInvoke(message);
      case "step":
        return this.handleStep();
      case "chat":
        return this.handleChat(message);
      case "tool_call":
        return this.handleToolCall(message);
      case "update_state":
        return this.handleUpdateState(message);
      case "status":
        return this.handleStatus();
      default:
        return {
          type: "error",
          payload: { message: `Unknown message type: ${message.type}` },
        };
    }
  }

  /** Return required capabilities. */
  getRequiredCapabilities(): Capability[] {
    return [...this.requiredCapabilities];
  }

  /** Get the parsed graph configuration. */
  getConfig(): LangGraphConfig | null {
    return this.config;
  }

  /** Get the current node in the graph traversal. */
  getCurrentNode(): string | null {
    return this.currentNode;
  }

  /** Get the current graph state. */
  getGraphState(): Record<string, unknown> {
    return Object.fromEntries(this.graphState);
  }

  // ─── Message Handlers ─────────────────────────────────────

  /** Handle graph invocation — set initial state and return first node to execute. */
  private handleInvoke(message: AdapterMessage): AdapterResponse {
    const config = this.config!;
    const inputs = (message.payload.inputs ?? {}) as Record<string, unknown>;

    // Apply inputs to graph state
    for (const [key, value] of Object.entries(inputs)) {
      this.graphState.set(key, value);
    }

    this.currentNode = config.entryPoint;
    const entryNode = config.nodes.get(config.entryPoint);

    if (!entryNode) {
      return {
        type: "error",
        payload: { message: `Entry point "${config.entryPoint}" not found in graph` },
      };
    }

    return {
      type: "graph_step",
      payload: {
        graph: config.name ?? "unnamed-graph",
        currentNode: entryNode.id,
        nodeType: entryNode.type,
        nodeName: entryNode.name,
        tools: entryNode.tools ?? [],
        model: entryNode.model,
        prompt: entryNode.prompt,
        state: Object.fromEntries(this.graphState),
        outgoingEdges: config.edges
          .filter((e) => e.from === entryNode.id)
          .map((e) => ({ to: e.to, condition: e.condition })),
      },
    };
  }

  /** Handle a step — advance to the next node in the graph. */
  private handleStep(): AdapterResponse {
    const config = this.config!;

    if (!this.currentNode) {
      return {
        type: "graph_complete",
        payload: { state: Object.fromEntries(this.graphState) },
      };
    }

    const outgoingEdges = config.edges.filter((e) => e.from === this.currentNode);

    if (outgoingEdges.length === 0) {
      const finalState = Object.fromEntries(this.graphState);
      this.currentNode = null;
      return {
        type: "graph_complete",
        payload: { state: finalState },
      };
    }

    // Take the first edge (or the first unconditional edge)
    const edge = outgoingEdges.find((e) => !e.condition) ?? outgoingEdges[0];
    if (!edge) {
      const finalState = Object.fromEntries(this.graphState);
      this.currentNode = null;
      return {
        type: "graph_complete",
        payload: { state: finalState },
      };
    }
    const nextNode = config.nodes.get(edge.to);

    if (!nextNode) {
      return {
        type: "error",
        payload: { message: `Next node "${edge.to}" not found in graph` },
      };
    }

    // Check if next node is END
    if (nextNode.id === "__end__" || (nextNode.type === "router" && edge.to === "__end__")) {
      const finalState = Object.fromEntries(this.graphState);
      this.currentNode = null;
      return {
        type: "graph_complete",
        payload: { state: finalState },
      };
    }

    this.currentNode = nextNode.id;

    return {
      type: "graph_step",
      payload: {
        graph: config.name ?? "unnamed-graph",
        currentNode: nextNode.id,
        nodeType: nextNode.type,
        nodeName: nextNode.name,
        tools: nextNode.tools ?? [],
        model: nextNode.model,
        prompt: nextNode.prompt,
        state: Object.fromEntries(this.graphState),
        outgoingEdges: config.edges
          .filter((e) => e.from === nextNode.id)
          .map((e) => ({ to: e.to, condition: e.condition })),
      },
    };
  }

  /** Handle a chat message — route to the current agent node. */
  private handleChat(message: AdapterMessage): AdapterResponse {
    const sandbox = this.sandbox!;
    const check = sandbox.check("llm:chat");
    if (!check.allowed) {
      return {
        type: "error",
        payload: { message: `Permission denied: llm:chat — ${check.reason ?? ""}` },
      };
    }

    const content = message.payload.content as string | undefined;
    const nodeId = (message.payload.node as string | undefined) ?? this.currentNode;
    const node = nodeId ? this.config!.nodes.get(nodeId) : undefined;

    if (!node) {
      return {
        type: "error",
        payload: { message: `Node "${nodeId}" not found in graph` },
      };
    }

    if (node.type !== "agent") {
      return {
        type: "error",
        payload: { message: `Node "${nodeId}" is a ${node.type} node, not an agent node` },
      };
    }

    return {
      type: "chat_request",
      payload: {
        messages: [
          ...(node.prompt ? [{ role: "system", content: node.prompt }] : []),
          { role: "user", content: content ?? "" },
        ],
        model: node.model,
        node: nodeId,
        state: Object.fromEntries(this.graphState),
      },
    };
  }

  /** Handle a tool call with sandbox capability checking. */
  private handleToolCall(message: AdapterMessage): AdapterResponse {
    const sandbox = this.sandbox!;
    const toolName = message.payload.tool as string | undefined;
    const nodeId = message.payload.node as string | undefined;

    if (!toolName) {
      return { type: "error", payload: { message: "Missing tool name" } };
    }

    // Check the node has this tool
    if (nodeId) {
      const node = this.config!.nodes.get(nodeId);
      if (node?.tools && !node.tools.includes(toolName)) {
        return {
          type: "error",
          payload: { message: `Tool "${toolName}" not available on node "${nodeId}"` },
        };
      }
    }

    const requiredCaps = TOOL_CAPABILITY_MAP[toolName] ?? [];
    for (const cap of requiredCaps) {
      const check = sandbox.check(cap, { tool: toolName, node: nodeId });
      if (!check.allowed) {
        return {
          type: "error",
          payload: {
            message: `Tool "${toolName}" denied: capability "${cap}" — ${check.reason ?? "not granted"}`,
          },
        };
      }
    }

    return {
      type: "tool_approved",
      payload: {
        tool: toolName,
        node: nodeId,
        args: message.payload.args ?? {},
        workingDirectory: this.workingDirectory,
      },
    };
  }

  /** Handle state update — apply a state mutation. */
  private handleUpdateState(message: AdapterMessage): AdapterResponse {
    const updates = (message.payload.updates ?? {}) as Record<string, unknown>;

    for (const [key, value] of Object.entries(updates)) {
      const field = this.config!.stateSchema.find((f) => f.name === key);
      if (field?.reducer === "append") {
        const current = this.graphState.get(key);
        if (Array.isArray(current)) {
          this.graphState.set(key, [...current, value]);
        } else {
          this.graphState.set(key, [value]);
        }
      } else {
        this.graphState.set(key, value);
      }
    }

    return {
      type: "state_updated",
      payload: { state: Object.fromEntries(this.graphState) },
    };
  }

  /** Return graph status. */
  private handleStatus(): AdapterResponse {
    return {
      type: "status",
      payload: {
        adapter: this.name,
        version: this.version,
        state: this._state,
        currentNode: this.currentNode,
        graphState: Object.fromEntries(this.graphState),
        config: this.config
          ? {
              name: this.config.name,
              entryPoint: this.config.entryPoint,
              nodes: Array.from(this.config.nodes.values()).map((n) => ({
                id: n.id,
                type: n.type,
                name: n.name,
              })),
              edges: this.config.edges.length,
              recursionLimit: this.config.recursionLimit,
              checkpoint: this.config.checkpoint.enabled,
            }
          : null,
        capabilities: this.requiredCapabilities,
      },
    };
  }
}

// ─── Config Parsing ───────────────────────────────────────────

function parseConfigFile(configPath: string): Record<string, unknown> {
  const ext = extname(configPath).toLowerCase();
  const content = readFileSync(configPath, "utf-8");

  if (ext === ".json") {
    return JSON.parse(content) as Record<string, unknown>;
  }

  if (ext === ".yaml" || ext === ".yml") {
    return parseSimpleYaml(content);
  }

  throw new Error(`Unsupported config format: ${ext} (expected .json, .yaml, or .yml)`);
}

function parseSimpleYaml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split(/\r?\n/);
  let currentKey = "";
  let currentList: unknown[] | null = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, "  ");
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const listMatch = line.match(/^\s+- (.+)$/);
    if (listMatch && currentKey) {
      if (!currentList) {
        currentList = [];
        result[currentKey] = currentList;
      }
      currentList.push(parseYamlValue((listMatch[1] ?? "").trim()));
      continue;
    }

    const kvMatch = line.match(/^([a-zA-Z_][\w.-]*):\s*(.*)$/);
    if (kvMatch) {
      currentKey = kvMatch[1] ?? "";
      const value = (kvMatch[2] ?? "").trim();
      currentList = null;
      if (value) {
        result[currentKey] = parseYamlValue(value);
      }
    }
  }

  return result;
}

function parseYamlValue(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (/^-?\d+$/.test(value)) return parseInt(value, 10);
  if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    return value.slice(1, -1);
  }
  return value;
}

// ─── Config Normalization ────────────────────────────────────

function normalizeGraphConfig(raw: Record<string, unknown>): LangGraphConfig {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const stateSchema: StateField[] = [];

  // Parse nodes
  const rawNodes = raw.nodes;
  if (typeof rawNodes === "object" && rawNodes !== null && !Array.isArray(rawNodes)) {
    for (const [id, value] of Object.entries(rawNodes as Record<string, unknown>)) {
      if (typeof value === "object" && value !== null) {
        const nodeDef = value as Record<string, unknown>;
        nodes.set(id, {
          id,
          type: normalizeNodeType(nodeDef.type),
          name: String(nodeDef.name ?? id),
          tools: Array.isArray(nodeDef.tools)
            ? nodeDef.tools.filter((t): t is string => typeof t === "string")
            : undefined,
          model: typeof nodeDef.model === "string" ? nodeDef.model : undefined,
          prompt: typeof nodeDef.prompt === "string" ? nodeDef.prompt : undefined,
          routingFunction: typeof nodeDef.routing_function === "string"
            ? nodeDef.routing_function
            : typeof nodeDef.routingFunction === "string"
              ? nodeDef.routingFunction
              : undefined,
          subgraph: typeof nodeDef.subgraph === "string" ? nodeDef.subgraph : undefined,
        });
      }
    }
  }

  if (Array.isArray(rawNodes)) {
    for (const entry of rawNodes) {
      if (typeof entry === "object" && entry !== null) {
        const nodeDef = entry as Record<string, unknown>;
        const id = String(nodeDef.id ?? nodeDef.name ?? `node-${nodes.size}`);
        nodes.set(id, {
          id,
          type: normalizeNodeType(nodeDef.type),
          name: String(nodeDef.name ?? id),
          tools: Array.isArray(nodeDef.tools)
            ? nodeDef.tools.filter((t): t is string => typeof t === "string")
            : undefined,
          model: typeof nodeDef.model === "string" ? nodeDef.model : undefined,
          prompt: typeof nodeDef.prompt === "string" ? nodeDef.prompt : undefined,
          routingFunction: typeof nodeDef.routing_function === "string"
            ? nodeDef.routing_function
            : undefined,
          subgraph: typeof nodeDef.subgraph === "string" ? nodeDef.subgraph : undefined,
        });
      }
    }
  }

  // Always add __end__ sentinel node
  if (!nodes.has("__end__")) {
    nodes.set("__end__", {
      id: "__end__",
      type: "router",
      name: "END",
    });
  }

  // Parse edges
  const rawEdges = raw.edges;
  if (Array.isArray(rawEdges)) {
    for (const entry of rawEdges) {
      if (typeof entry === "object" && entry !== null) {
        const edgeDef = entry as Record<string, unknown>;
        edges.push({
          from: String(edgeDef.from ?? ""),
          to: String(edgeDef.to ?? ""),
          condition: typeof edgeDef.condition === "string" ? edgeDef.condition : undefined,
        });
      }
    }
  }

  // Parse state schema
  const rawState = raw.state_schema ?? raw.stateSchema ?? raw.state;
  if (typeof rawState === "object" && rawState !== null && !Array.isArray(rawState)) {
    for (const [name, value] of Object.entries(rawState as Record<string, unknown>)) {
      if (typeof value === "string") {
        stateSchema.push({ name, type: value });
      } else if (typeof value === "object" && value !== null) {
        const fieldDef = value as Record<string, unknown>;
        stateSchema.push({
          name,
          type: String(fieldDef.type ?? "string"),
          default: fieldDef.default,
          reducer: normalizeReducer(fieldDef.reducer),
        });
      }
    }
  }

  if (Array.isArray(rawState)) {
    for (const entry of rawState) {
      if (typeof entry === "object" && entry !== null) {
        const fieldDef = entry as Record<string, unknown>;
        stateSchema.push({
          name: String(fieldDef.name ?? ""),
          type: String(fieldDef.type ?? "string"),
          default: fieldDef.default,
          reducer: normalizeReducer(fieldDef.reducer),
        });
      }
    }
  }

  // Parse checkpoint config
  const rawCheckpoint = raw.checkpoint ?? raw.checkpointer;
  let checkpoint: CheckpointConfig = { enabled: false };
  if (typeof rawCheckpoint === "boolean") {
    checkpoint = { enabled: rawCheckpoint };
  } else if (typeof rawCheckpoint === "object" && rawCheckpoint !== null) {
    const cpDef = rawCheckpoint as Record<string, unknown>;
    checkpoint = {
      enabled: cpDef.enabled !== false,
      store: normalizeStore(cpDef.store),
      ttlSeconds: typeof cpDef.ttl_seconds === "number"
        ? cpDef.ttl_seconds
        : typeof cpDef.ttlSeconds === "number"
          ? cpDef.ttlSeconds
          : undefined,
    };
  }

  const entryPoint = typeof raw.entry_point === "string"
    ? raw.entry_point
    : typeof raw.entryPoint === "string"
      ? raw.entryPoint
      : Array.from(nodes.keys()).find((k) => k !== "__end__") ?? "";

  return {
    name: typeof raw.name === "string" ? raw.name : undefined,
    version: typeof raw.version === "string" ? raw.version : undefined,
    entryPoint,
    nodes,
    edges,
    stateSchema,
    checkpoint,
    recursionLimit: typeof raw.recursion_limit === "number"
      ? raw.recursion_limit
      : typeof raw.recursionLimit === "number"
        ? raw.recursionLimit
        : 25,
    raw,
  };
}

function normalizeNodeType(value: unknown): NodeType {
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (lower === "agent" || lower === "llm") return "agent";
    if (lower === "tool" || lower === "tools") return "tool";
    if (lower === "router" || lower === "conditional" || lower === "branch") return "router";
    if (lower === "human" || lower === "human_in_the_loop") return "human";
    if (lower === "subgraph") return "subgraph";
  }
  return "agent";
}

function normalizeReducer(value: unknown): "append" | "replace" | "last" | undefined {
  if (value === "append" || value === "add_messages") return "append";
  if (value === "replace") return "replace";
  if (value === "last") return "last";
  return undefined;
}

function normalizeStore(value: unknown): "memory" | "postgres" | "redis" | undefined {
  if (value === "memory" || value === "MemorySaver") return "memory";
  if (value === "postgres" || value === "PostgresSaver") return "postgres";
  if (value === "redis" || value === "RedisSaver") return "redis";
  return undefined;
}

// ─── Graph Validation ────────────────────────────────────────

function validateGraph(config: LangGraphConfig): void {
  if (!config.entryPoint) {
    throw new Error("Graph must have an entry_point");
  }

  if (!config.nodes.has(config.entryPoint)) {
    throw new Error(`Entry point "${config.entryPoint}" not found in graph nodes`);
  }

  // Validate edges reference existing nodes
  for (const edge of config.edges) {
    if (!config.nodes.has(edge.from)) {
      throw new Error(`Edge references unknown source node: "${edge.from}"`);
    }
    if (!config.nodes.has(edge.to)) {
      throw new Error(`Edge references unknown target node: "${edge.to}"`);
    }
  }
}

// ─── Capability Resolution ───────────────────────────────────

function resolveCapabilities(config: LangGraphConfig): Capability[] {
  const caps = new Set<Capability>(BASE_CAPABILITIES);

  for (const node of config.nodes.values()) {
    if (node.tools) {
      for (const tool of node.tools) {
        const mapped = TOOL_CAPABILITY_MAP[tool];
        if (mapped) {
          for (const cap of mapped) caps.add(cap);
        }
      }
    }
    if (node.type === "human") {
      caps.add("agent:communicate");
    }
    if (node.type === "tool") {
      // Tool nodes might need generic tool access
      if (node.tools && node.tools.length > 0) {
        for (const tool of node.tools) {
          const mapped = TOOL_CAPABILITY_MAP[tool];
          if (mapped) {
            for (const cap of mapped) caps.add(cap);
          }
        }
      }
    }
  }

  if (config.checkpoint.enabled && config.checkpoint.store === "postgres") {
    caps.add("memory:read");
    caps.add("memory:write");
  }

  return Array.from(caps);
}

/** Create a LangGraph adapter instance. */
export function createLangGraphAdapter(): LangGraphAdapter {
  return new LangGraphAdapter();
}

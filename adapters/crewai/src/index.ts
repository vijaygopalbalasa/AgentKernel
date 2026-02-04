// @agentkernel/adapter-crewai — Run CrewAI crews inside AgentKernel's sandboxed runtime
// Models CrewAI's role-based delegation pattern with agents, tasks, and process types.

import { readFileSync, existsSync } from "node:fs";
import { resolve, extname } from "node:path";
import type {
  AgentAdapter,
  AdapterConfig,
  AdapterMessage,
  AdapterResponse,
  AdapterState,
} from "@agentkernel/runtime";
import type { Capability, AgentSandbox } from "@agentkernel/runtime";

// ─── CrewAI Configuration Types ──────────────────────────────

/** A CrewAI agent definition with role, goal, and backstory. */
interface CrewAgent {
  role: string;
  goal: string;
  backstory: string;
  tools: string[];
  llm?: string;
  allowDelegation?: boolean;
  verbose?: boolean;
  maxIterations?: number;
}

/** A CrewAI task assigned to an agent. */
interface CrewTask {
  description: string;
  expectedOutput: string;
  agent: string;
  tools?: string[];
  context?: string[];
  asyncExecution?: boolean;
}

/** Parsed CrewAI crew configuration. */
interface CrewConfig {
  name?: string;
  version?: string;
  process: "sequential" | "hierarchical";
  agents: Map<string, CrewAgent>;
  tasks: CrewTask[];
  managerLlm?: string;
  verbose?: boolean;
  memory?: boolean;
  raw: Record<string, unknown>;
}

/** Maps CrewAI tool names to AgentKernel capabilities. */
const TOOL_CAPABILITY_MAP: Record<string, Capability[]> = {
  // Search tools
  "SerperDevTool": ["network:http"],
  "GoogleSearchTool": ["network:http"],
  "DuckDuckGoSearchTool": ["network:http"],
  // Web tools
  "ScrapeWebsiteTool": ["network:http"],
  "WebsiteSearchTool": ["network:http"],
  "BrowserbaseTool": ["network:http"],
  // File tools
  "FileReadTool": ["file:read"],
  "FileWriteTool": ["file:read", "file:write"],
  "DirectoryReadTool": ["file:read"],
  "DirectorySearchTool": ["file:read"],
  "CSVSearchTool": ["file:read"],
  "JSONSearchTool": ["file:read"],
  "TXTSearchTool": ["file:read"],
  "PDFSearchTool": ["file:read"],
  "DOCXSearchTool": ["file:read"],
  "MDXSearchTool": ["file:read"],
  "XMLSearchTool": ["file:read"],
  // Code tools
  "CodeDocsSearchTool": ["file:read", "network:http"],
  "CodeInterpreterTool": ["shell:execute"],
  "GithubSearchTool": ["network:http"],
  // Memory / RAG tools
  "RagTool": ["memory:read"],
  "EXASearchTool": ["network:http"],
  // Shell tools
  "ShellTool": ["shell:execute"],
  // MCP tools
  "MCPTool": ["tool:mcp"],
  // Delegation
  "DelegateWorkTool": ["agent:communicate"],
  "AskQuestionTool": ["agent:communicate"],
};

/** Base capabilities every CrewAI crew needs. */
const BASE_CAPABILITIES: Capability[] = ["llm:chat", "llm:stream"];

/**
 * Adapter that wraps CrewAI crews inside AgentKernel's sandboxed runtime.
 *
 * Reads a CrewAI crew configuration (agents with roles/goals, tasks, process type),
 * maps tools to AgentKernel capabilities, and enforces sandbox permissions before
 * allowing tool execution and agent delegation.
 */
export class CrewAIAdapter implements AgentAdapter {
  readonly name = "crewai";
  readonly version = "0.1.0";

  private _state: AdapterState = "idle";
  private config: CrewConfig | null = null;
  private sandbox: AgentSandbox | null = null;
  private workingDirectory: string = process.cwd();
  private requiredCapabilities: Capability[] = [];

  get state(): AdapterState {
    return this._state;
  }

  /** Load and validate a CrewAI crew configuration file. */
  async load(adapterConfig: AdapterConfig): Promise<void> {
    const configPath = resolve(adapterConfig.workingDirectory, adapterConfig.configPath);

    if (!existsSync(configPath)) {
      throw new Error(`CrewAI config not found: ${configPath}`);
    }

    this.workingDirectory = adapterConfig.workingDirectory;
    const raw = parseConfigFile(configPath);
    this.config = normalizeCrewConfig(raw);
    this.requiredCapabilities = resolveCapabilities(this.config);
    this._state = "loaded";
  }

  /** Start the adapted CrewAI crew with sandbox enforcement. */
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
        `CrewAI crew requires capabilities not granted by sandbox: ${denied.join(", ")}. ` +
        `Grant them explicitly or use --policy permissive.`
      );
    }

    this._state = "running";
  }

  /** Gracefully stop the crew. */
  async stop(): Promise<void> {
    this.sandbox = null;
    this._state = "stopped";
  }

  /** Handle messages routed to the crew. */
  async handleMessage(message: AdapterMessage): Promise<AdapterResponse> {
    if (this._state !== "running" || !this.sandbox || !this.config) {
      return {
        type: "error",
        payload: { message: `Adapter is not running (state: ${this._state})` },
      };
    }

    switch (message.type) {
      case "kickoff":
        return this.handleKickoff(message);
      case "chat":
        return this.handleChat(message);
      case "delegate":
        return this.handleDelegate(message);
      case "tool_call":
        return this.handleToolCall(message);
      case "status":
        return this.handleStatus();
      default:
        return {
          type: "error",
          payload: { message: `Unknown message type: ${message.type}` },
        };
    }
  }

  /** Return the capabilities this crew requires. */
  getRequiredCapabilities(): Capability[] {
    return [...this.requiredCapabilities];
  }

  /** Get the parsed crew configuration. */
  getConfig(): CrewConfig | null {
    return this.config;
  }

  // ─── Message Handlers ─────────────────────────────────────

  /** Handle crew kickoff — build the execution plan based on process type. */
  private handleKickoff(message: AdapterMessage): AdapterResponse {
    const config = this.config!;
    const inputs = (message.payload.inputs ?? {}) as Record<string, unknown>;

    if (config.process === "sequential") {
      const plan = config.tasks.map((task, index) => ({
        step: index + 1,
        description: task.description,
        agent: task.agent,
        expectedOutput: task.expectedOutput,
        tools: task.tools ?? config.agents.get(task.agent)?.tools ?? [],
        asyncExecution: task.asyncExecution ?? false,
      }));

      return {
        type: "execution_plan",
        payload: {
          process: "sequential",
          crew: config.name ?? "unnamed-crew",
          steps: plan,
          inputs,
          totalTasks: config.tasks.length,
          agents: Array.from(config.agents.keys()),
        },
      };
    }

    // Hierarchical process — manager coordinates agents
    const agents = Array.from(config.agents.entries()).map(([id, agent]) => ({
      id,
      role: agent.role,
      goal: agent.goal,
      tools: agent.tools,
      allowDelegation: agent.allowDelegation ?? true,
    }));

    return {
      type: "execution_plan",
      payload: {
        process: "hierarchical",
        crew: config.name ?? "unnamed-crew",
        managerLlm: config.managerLlm ?? "default",
        agents,
        tasks: config.tasks.map((t) => ({
          description: t.description,
          agent: t.agent,
          expectedOutput: t.expectedOutput,
        })),
        inputs,
      },
    };
  }

  /** Handle a chat message — route to the first agent with LLM access. */
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
    const targetAgent = message.payload.agent as string | undefined;

    const agent = targetAgent
      ? this.config!.agents.get(targetAgent)
      : this.config!.agents.values().next().value;

    if (!agent) {
      return {
        type: "error",
        payload: { message: `Agent "${targetAgent}" not found in crew` },
      };
    }

    return {
      type: "chat_request",
      payload: {
        messages: [
          {
            role: "system",
            content: `You are ${agent.role}.\n\nGoal: ${agent.goal}\n\nBackstory: ${agent.backstory}`,
          },
          { role: "user", content: content ?? "" },
        ],
        model: agent.llm ?? this.config!.managerLlm,
        agent: targetAgent ?? Array.from(this.config!.agents.keys())[0],
      },
    };
  }

  /** Handle task delegation between crew agents. */
  private handleDelegate(message: AdapterMessage): AdapterResponse {
    const sandbox = this.sandbox!;
    const check = sandbox.check("agent:communicate");
    if (!check.allowed) {
      return {
        type: "error",
        payload: { message: `Delegation denied: agent:communicate — ${check.reason ?? ""}` },
      };
    }

    const fromAgent = message.payload.from as string | undefined;
    const toAgent = message.payload.to as string | undefined;
    const task = message.payload.task as string | undefined;

    if (!fromAgent || !toAgent) {
      return {
        type: "error",
        payload: { message: "Delegation requires 'from' and 'to' agent IDs" },
      };
    }

    const source = this.config!.agents.get(fromAgent);
    const target = this.config!.agents.get(toAgent);

    if (!source) {
      return { type: "error", payload: { message: `Source agent "${fromAgent}" not found` } };
    }
    if (!target) {
      return { type: "error", payload: { message: `Target agent "${toAgent}" not found` } };
    }
    if (source.allowDelegation === false) {
      return {
        type: "error",
        payload: { message: `Agent "${fromAgent}" does not allow delegation` },
      };
    }

    return {
      type: "delegation",
      payload: {
        from: { id: fromAgent, role: source.role },
        to: { id: toAgent, role: target.role, goal: target.goal },
        task: task ?? "",
        targetTools: target.tools,
      },
    };
  }

  /** Handle a tool call with sandbox capability checking. */
  private handleToolCall(message: AdapterMessage): AdapterResponse {
    const sandbox = this.sandbox!;
    const toolName = message.payload.tool as string | undefined;
    const agentId = message.payload.agent as string | undefined;

    if (!toolName) {
      return { type: "error", payload: { message: "Missing tool name" } };
    }

    // Check the agent has this tool assigned
    if (agentId) {
      const agent = this.config!.agents.get(agentId);
      if (agent && !agent.tools.includes(toolName)) {
        return {
          type: "error",
          payload: { message: `Tool "${toolName}" not assigned to agent "${agentId}"` },
        };
      }
    }

    const requiredCaps = TOOL_CAPABILITY_MAP[toolName] ?? [];
    for (const cap of requiredCaps) {
      const check = sandbox.check(cap, { tool: toolName, agent: agentId });
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
        agent: agentId,
        args: message.payload.args ?? {},
        workingDirectory: this.workingDirectory,
      },
    };
  }

  /** Return crew status. */
  private handleStatus(): AdapterResponse {
    return {
      type: "status",
      payload: {
        adapter: this.name,
        version: this.version,
        state: this._state,
        config: this.config
          ? {
              name: this.config.name,
              process: this.config.process,
              agents: Array.from(this.config.agents.entries()).map(([id, a]) => ({
                id,
                role: a.role,
                tools: a.tools,
              })),
              tasks: this.config.tasks.length,
              memory: this.config.memory ?? false,
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

function normalizeCrewConfig(raw: Record<string, unknown>): CrewConfig {
  const agents = new Map<string, CrewAgent>();
  const tasks: CrewTask[] = [];

  // Parse agents
  const rawAgents = raw.agents;
  if (typeof rawAgents === "object" && rawAgents !== null && !Array.isArray(rawAgents)) {
    for (const [id, value] of Object.entries(rawAgents as Record<string, unknown>)) {
      if (typeof value === "object" && value !== null) {
        const agentDef = value as Record<string, unknown>;
        agents.set(id, {
          role: String(agentDef.role ?? id),
          goal: String(agentDef.goal ?? ""),
          backstory: String(agentDef.backstory ?? ""),
          tools: normalizeStringArray(agentDef.tools),
          llm: typeof agentDef.llm === "string" ? agentDef.llm : undefined,
          allowDelegation: typeof agentDef.allow_delegation === "boolean"
            ? agentDef.allow_delegation
            : typeof agentDef.allowDelegation === "boolean"
              ? agentDef.allowDelegation
              : true,
          verbose: typeof agentDef.verbose === "boolean" ? agentDef.verbose : undefined,
          maxIterations: typeof agentDef.max_iter === "number"
            ? agentDef.max_iter
            : typeof agentDef.maxIterations === "number"
              ? agentDef.maxIterations
              : undefined,
        });
      }
    }
  }

  // Parse agents from array format
  if (Array.isArray(rawAgents)) {
    for (const entry of rawAgents) {
      if (typeof entry === "object" && entry !== null) {
        const agentDef = entry as Record<string, unknown>;
        const id = String(agentDef.id ?? agentDef.name ?? agentDef.role ?? `agent-${agents.size}`);
        agents.set(id, {
          role: String(agentDef.role ?? id),
          goal: String(agentDef.goal ?? ""),
          backstory: String(agentDef.backstory ?? ""),
          tools: normalizeStringArray(agentDef.tools),
          llm: typeof agentDef.llm === "string" ? agentDef.llm : undefined,
          allowDelegation: agentDef.allow_delegation !== false && agentDef.allowDelegation !== false,
          verbose: typeof agentDef.verbose === "boolean" ? agentDef.verbose : undefined,
          maxIterations: typeof agentDef.max_iter === "number"
            ? agentDef.max_iter
            : typeof agentDef.maxIterations === "number"
              ? agentDef.maxIterations
              : undefined,
        });
      }
    }
  }

  // Parse tasks
  const rawTasks = raw.tasks;
  if (Array.isArray(rawTasks)) {
    for (const entry of rawTasks) {
      if (typeof entry === "object" && entry !== null) {
        const taskDef = entry as Record<string, unknown>;
        tasks.push({
          description: String(taskDef.description ?? ""),
          expectedOutput: String(taskDef.expected_output ?? taskDef.expectedOutput ?? ""),
          agent: String(taskDef.agent ?? ""),
          tools: taskDef.tools ? normalizeStringArray(taskDef.tools) : undefined,
          context: taskDef.context ? normalizeStringArray(taskDef.context) : undefined,
          asyncExecution: typeof taskDef.async_execution === "boolean"
            ? taskDef.async_execution
            : typeof taskDef.asyncExecution === "boolean"
              ? taskDef.asyncExecution
              : false,
        });
      }
    }
  }

  return {
    name: typeof raw.name === "string" ? raw.name : undefined,
    version: typeof raw.version === "string" ? raw.version : undefined,
    process: raw.process === "hierarchical" ? "hierarchical" : "sequential",
    agents,
    tasks,
    managerLlm: typeof raw.manager_llm === "string"
      ? raw.manager_llm
      : typeof raw.managerLlm === "string"
        ? raw.managerLlm
        : undefined,
    verbose: typeof raw.verbose === "boolean" ? raw.verbose : undefined,
    memory: typeof raw.memory === "boolean" ? raw.memory : undefined,
    raw,
  };
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  return [];
}

// ─── Capability Resolution ───────────────────────────────────

function resolveCapabilities(config: CrewConfig): Capability[] {
  const caps = new Set<Capability>(BASE_CAPABILITIES);

  for (const agent of config.agents.values()) {
    for (const tool of agent.tools) {
      const mapped = TOOL_CAPABILITY_MAP[tool];
      if (mapped) {
        for (const cap of mapped) caps.add(cap);
      }
    }
    if (agent.allowDelegation) {
      caps.add("agent:communicate");
    }
  }

  if (config.memory) {
    caps.add("memory:read");
    caps.add("memory:write");
  }

  return Array.from(caps);
}

/** Create a CrewAI adapter instance. */
export function createCrewAIAdapter(): CrewAIAdapter {
  return new CrewAIAdapter();
}

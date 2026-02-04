// @agentrun/adapter-autogen — Run Microsoft AutoGen conversations inside AgentRun's sandboxed runtime
// Models AutoGen's conversational agents: AssistantAgent, UserProxyAgent, GroupChatManager.

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

// ─── AutoGen Configuration Types ─────────────────────────────

/** AutoGen agent types. */
type AutoGenAgentType =
  | "AssistantAgent"
  | "UserProxyAgent"
  | "GroupChatManager"
  | "ConversableAgent"
  | "RetrieveAssistantAgent"
  | "RetrieveUserProxyAgent";

/** Code execution configuration for UserProxyAgent. */
interface CodeExecutionConfig {
  enabled: boolean;
  workDir?: string;
  useDocker?: boolean;
  timeout?: number;
  lastNMessages?: number;
}

/** A function registered in an agent's function map. */
interface FunctionDef {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  capability?: Capability;
}

/** An AutoGen agent definition. */
interface AutoGenAgent {
  name: string;
  type: AutoGenAgentType;
  systemMessage?: string;
  model?: string;
  codeExecutionConfig: CodeExecutionConfig;
  functions: FunctionDef[];
  humanInputMode?: "ALWAYS" | "TERMINATE" | "NEVER";
  maxConsecutiveAutoReply?: number;
  isTerminationMsg?: string;
}

/** Group chat configuration (when using GroupChatManager). */
interface GroupChatConfig {
  agents: string[];
  maxRound: number;
  speakerSelectionMethod: "auto" | "round_robin" | "random" | "manual";
  allowRepeatSpeaker: boolean;
}

/** Parsed AutoGen configuration. */
interface AutoGenConfig {
  name?: string;
  version?: string;
  agents: Map<string, AutoGenAgent>;
  initiator?: string;
  responder?: string;
  groupChat?: GroupChatConfig;
  raw: Record<string, unknown>;
}

/** Maps AutoGen function/capability patterns to AgentRun capabilities. */
const FUNCTION_CAPABILITY_MAP: Record<string, Capability> = {
  "read_file": "file:read",
  "write_file": "file:write",
  "list_directory": "file:read",
  "delete_file": "file:delete",
  "execute_code": "shell:execute",
  "run_shell": "shell:execute",
  "bash": "shell:execute",
  "python": "shell:execute",
  "search_web": "network:http",
  "http_get": "network:http",
  "http_post": "network:http",
  "fetch_url": "network:http",
  "browse_web": "network:http",
  "retrieve_docs": "memory:read",
  "store_memory": "memory:write",
  "search_memory": "memory:read",
  "call_agent": "agent:communicate",
  "mcp_tool": "tool:mcp",
};

/** Base capabilities every AutoGen conversation needs. */
const BASE_CAPABILITIES: Capability[] = ["llm:chat", "llm:stream"];

/**
 * Adapter that wraps AutoGen conversations inside AgentRun's sandboxed runtime.
 *
 * Reads an AutoGen configuration (agents, group chat, function maps),
 * maps code execution and functions to AgentRun capabilities, and enforces
 * sandbox permissions before allowing execution.
 */
export class AutoGenAdapter implements AgentAdapter {
  readonly name = "autogen";
  readonly version = "0.1.0";

  private _state: AdapterState = "idle";
  private config: AutoGenConfig | null = null;
  private sandbox: AgentSandbox | null = null;
  private workingDirectory: string = process.cwd();
  private requiredCapabilities: Capability[] = [];
  private conversationHistory: Array<{ agent: string; content: string; role: string }> = [];
  private currentSpeaker: string | null = null;
  private roundCount = 0;

  get state(): AdapterState {
    return this._state;
  }

  /** Load and validate an AutoGen configuration file. */
  async load(adapterConfig: AdapterConfig): Promise<void> {
    const configPath = resolve(adapterConfig.workingDirectory, adapterConfig.configPath);

    if (!existsSync(configPath)) {
      throw new Error(`AutoGen config not found: ${configPath}`);
    }

    this.workingDirectory = adapterConfig.workingDirectory;
    const raw = parseConfigFile(configPath);
    this.config = normalizeAutoGenConfig(raw);
    this.requiredCapabilities = resolveCapabilities(this.config);
    this._state = "loaded";
  }

  /** Start the conversation with sandbox enforcement. */
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
        `AutoGen conversation requires capabilities not granted by sandbox: ${denied.join(", ")}. ` +
        `Grant them explicitly or use --policy permissive.`
      );
    }

    this.conversationHistory = [];
    this.roundCount = 0;
    this.currentSpeaker = this.config.initiator ?? null;
    this._state = "running";
  }

  /** Gracefully stop the conversation. */
  async stop(): Promise<void> {
    this.sandbox = null;
    this.conversationHistory = [];
    this.currentSpeaker = null;
    this.roundCount = 0;
    this._state = "stopped";
  }

  /** Handle messages routed to the conversation. */
  async handleMessage(message: AdapterMessage): Promise<AdapterResponse> {
    if (this._state !== "running" || !this.sandbox || !this.config) {
      return {
        type: "error",
        payload: { message: `Adapter is not running (state: ${this._state})` },
      };
    }

    switch (message.type) {
      case "initiate":
        return this.handleInitiate(message);
      case "chat":
        return this.handleChat(message);
      case "execute_code":
        return this.handleExecuteCode(message);
      case "function_call":
        return this.handleFunctionCall(message);
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

  /** Get the parsed AutoGen configuration. */
  getConfig(): AutoGenConfig | null {
    return this.config;
  }

  /** Get the conversation history. */
  getConversationHistory(): Array<{ agent: string; content: string; role: string }> {
    return [...this.conversationHistory];
  }

  /** Get the current speaker. */
  getCurrentSpeaker(): string | null {
    return this.currentSpeaker;
  }

  // ─── Message Handlers ─────────────────────────────────────

  /** Initiate a conversation between agents. */
  private handleInitiate(message: AdapterMessage): AdapterResponse {
    const config = this.config!;
    const content = message.payload.content as string | undefined;
    const initiatorId = (message.payload.initiator as string | undefined) ?? config.initiator;
    const responderId = (message.payload.responder as string | undefined) ?? config.responder;

    if (!initiatorId) {
      return { type: "error", payload: { message: "No initiator agent specified" } };
    }

    const initiator = config.agents.get(initiatorId);
    if (!initiator) {
      return { type: "error", payload: { message: `Initiator "${initiatorId}" not found` } };
    }

    this.currentSpeaker = initiatorId;
    this.roundCount = 1;

    // Add the initial message to history
    if (content) {
      this.conversationHistory.push({
        agent: initiatorId,
        content,
        role: "user",
      });
    }

    // If group chat, return group setup
    if (config.groupChat) {
      const participants = config.groupChat.agents
        .map((id) => config.agents.get(id))
        .filter((a): a is AutoGenAgent => a !== undefined);

      return {
        type: "conversation_started",
        payload: {
          mode: "group_chat",
          initiator: initiatorId,
          participants: participants.map((a) => ({
            name: a.name,
            type: a.type,
            systemMessage: a.systemMessage,
          })),
          maxRound: config.groupChat.maxRound,
          selectionMethod: config.groupChat.speakerSelectionMethod,
          message: content ?? "",
        },
      };
    }

    // Two-agent conversation
    const responder = responderId ? config.agents.get(responderId) : undefined;

    return {
      type: "conversation_started",
      payload: {
        mode: "two_agent",
        initiator: initiatorId,
        responder: responderId,
        initiatorSystem: initiator.systemMessage,
        responderSystem: responder?.systemMessage,
        message: content ?? "",
        history: this.conversationHistory,
      },
    };
  }

  /** Handle a chat turn in the conversation. */
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
    const agentId = (message.payload.agent as string | undefined) ?? this.currentSpeaker;

    if (!agentId) {
      return { type: "error", payload: { message: "No agent specified for chat turn" } };
    }

    const agent = this.config!.agents.get(agentId);
    if (!agent) {
      return { type: "error", payload: { message: `Agent "${agentId}" not found` } };
    }

    // Check max rounds for group chat
    if (this.config!.groupChat) {
      if (this.roundCount >= this.config!.groupChat.maxRound) {
        return {
          type: "conversation_complete",
          payload: {
            reason: "max_rounds",
            rounds: this.roundCount,
            history: this.conversationHistory,
          },
        };
      }
    }

    // Check max consecutive auto-reply
    if (agent.humanInputMode === "NEVER" && agent.maxConsecutiveAutoReply !== undefined) {
      const consecutiveReplies = countConsecutiveReplies(this.conversationHistory, agentId);
      if (consecutiveReplies >= agent.maxConsecutiveAutoReply) {
        return {
          type: "conversation_complete",
          payload: {
            reason: "max_auto_reply",
            agent: agentId,
            rounds: this.roundCount,
            history: this.conversationHistory,
          },
        };
      }
    }

    // Record the message
    if (content) {
      this.conversationHistory.push({ agent: agentId, content, role: "assistant" });
    }

    // Check termination
    if (content && agent.isTerminationMsg) {
      if (content.includes(agent.isTerminationMsg)) {
        return {
          type: "conversation_complete",
          payload: {
            reason: "termination_message",
            agent: agentId,
            rounds: this.roundCount,
            history: this.conversationHistory,
          },
        };
      }
    }

    // Advance to next speaker
    this.roundCount++;
    const nextSpeaker = this.getNextSpeaker(agentId);
    this.currentSpeaker = nextSpeaker;

    const nextAgent = nextSpeaker ? this.config!.agents.get(nextSpeaker) : undefined;

    return {
      type: "chat_request",
      payload: {
        messages: [
          ...(nextAgent?.systemMessage
            ? [{ role: "system", content: nextAgent.systemMessage }]
            : []),
          ...this.conversationHistory.map((h) => ({
            role: h.agent === nextSpeaker ? "assistant" : "user",
            content: h.content,
          })),
        ],
        model: nextAgent?.model,
        agent: nextSpeaker,
        round: this.roundCount,
        availableFunctions: nextAgent?.functions.map((f) => f.name) ?? [],
      },
    };
  }

  /** Handle code execution request from a UserProxyAgent. */
  private handleExecuteCode(message: AdapterMessage): AdapterResponse {
    const sandbox = this.sandbox!;
    const agentId = message.payload.agent as string | undefined;
    const code = message.payload.code as string | undefined;
    const language = message.payload.language as string | undefined;

    if (!agentId) {
      return { type: "error", payload: { message: "No agent specified for code execution" } };
    }

    const agent = this.config!.agents.get(agentId);
    if (!agent) {
      return { type: "error", payload: { message: `Agent "${agentId}" not found` } };
    }

    if (!agent.codeExecutionConfig.enabled) {
      return {
        type: "error",
        payload: { message: `Code execution not enabled for agent "${agentId}"` },
      };
    }

    const check = sandbox.check("shell:execute", { agent: agentId, language });
    if (!check.allowed) {
      return {
        type: "error",
        payload: { message: `Code execution denied: ${check.reason ?? "not granted"}` },
      };
    }

    return {
      type: "code_execution",
      payload: {
        agent: agentId,
        code: code ?? "",
        language: language ?? "python",
        workDir: agent.codeExecutionConfig.workDir ?? this.workingDirectory,
        useDocker: agent.codeExecutionConfig.useDocker ?? false,
        timeout: agent.codeExecutionConfig.timeout ?? 60,
      },
    };
  }

  /** Handle a function call with capability checking. */
  private handleFunctionCall(message: AdapterMessage): AdapterResponse {
    const sandbox = this.sandbox!;
    const functionName = message.payload.function as string | undefined;
    const agentId = message.payload.agent as string | undefined;

    if (!functionName) {
      return { type: "error", payload: { message: "Missing function name" } };
    }

    if (!agentId) {
      return { type: "error", payload: { message: "Missing agent ID" } };
    }

    const agent = this.config!.agents.get(agentId);
    if (!agent) {
      return { type: "error", payload: { message: `Agent "${agentId}" not found` } };
    }

    // Check agent has this function registered
    const funcDef = agent.functions.find((f) => f.name === functionName);
    if (!funcDef) {
      return {
        type: "error",
        payload: { message: `Function "${functionName}" not registered for agent "${agentId}"` },
      };
    }

    // Check capability
    const capability = funcDef.capability ?? inferCapability(functionName);
    if (capability) {
      const check = sandbox.check(capability, { function: functionName, agent: agentId });
      if (!check.allowed) {
        return {
          type: "error",
          payload: {
            message: `Function "${functionName}" denied: capability "${capability}" — ${check.reason ?? "not granted"}`,
          },
        };
      }
    }

    return {
      type: "function_approved",
      payload: {
        function: functionName,
        agent: agentId,
        args: message.payload.args ?? {},
        description: funcDef.description,
        workingDirectory: this.workingDirectory,
      },
    };
  }

  /** Return conversation status. */
  private handleStatus(): AdapterResponse {
    return {
      type: "status",
      payload: {
        adapter: this.name,
        version: this.version,
        state: this._state,
        currentSpeaker: this.currentSpeaker,
        round: this.roundCount,
        historyLength: this.conversationHistory.length,
        config: this.config
          ? {
              name: this.config.name,
              agents: Array.from(this.config.agents.entries()).map(([id, a]) => ({
                id,
                name: a.name,
                type: a.type,
                codeExecution: a.codeExecutionConfig.enabled,
                functions: a.functions.length,
              })),
              groupChat: this.config.groupChat
                ? {
                    maxRound: this.config.groupChat.maxRound,
                    method: this.config.groupChat.speakerSelectionMethod,
                  }
                : null,
            }
          : null,
        capabilities: this.requiredCapabilities,
      },
    };
  }

  // ─── Helpers ───────────────────────────────────────────────

  /** Determine the next speaker based on conversation mode. */
  private getNextSpeaker(currentAgentId: string): string | null {
    const config = this.config!;

    if (config.groupChat) {
      const agents = config.groupChat.agents;
      const currentIndex = agents.indexOf(currentAgentId);

      switch (config.groupChat.speakerSelectionMethod) {
        case "round_robin": {
          const nextIndex = (currentIndex + 1) % agents.length;
          return agents[nextIndex] ?? null;
        }
        case "random": {
          const filtered = agents.filter((a) => a !== currentAgentId || config.groupChat!.allowRepeatSpeaker);
          return filtered[Math.floor(Math.random() * filtered.length)] ?? null;
        }
        default:
          // "auto" — return null to let the LLM decide
          return null;
      }
    }

    // Two-agent: alternate between initiator and responder
    if (currentAgentId === config.initiator && config.responder) {
      return config.responder;
    }
    if (currentAgentId === config.responder && config.initiator) {
      return config.initiator;
    }

    return null;
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

function normalizeAutoGenConfig(raw: Record<string, unknown>): AutoGenConfig {
  const agents = new Map<string, AutoGenAgent>();

  // Parse agents
  const rawAgents = raw.agents;
  if (typeof rawAgents === "object" && rawAgents !== null && !Array.isArray(rawAgents)) {
    for (const [id, value] of Object.entries(rawAgents as Record<string, unknown>)) {
      if (typeof value === "object" && value !== null) {
        agents.set(id, normalizeAgent(id, value as Record<string, unknown>));
      }
    }
  }

  if (Array.isArray(rawAgents)) {
    for (const entry of rawAgents) {
      if (typeof entry === "object" && entry !== null) {
        const agentDef = entry as Record<string, unknown>;
        const id = String(agentDef.id ?? agentDef.name ?? `agent-${agents.size}`);
        agents.set(id, normalizeAgent(id, agentDef));
      }
    }
  }

  // Parse group chat
  let groupChat: GroupChatConfig | undefined;
  const rawGroupChat = raw.group_chat ?? raw.groupChat;
  if (typeof rawGroupChat === "object" && rawGroupChat !== null) {
    const gcDef = rawGroupChat as Record<string, unknown>;
    groupChat = {
      agents: Array.isArray(gcDef.agents)
        ? gcDef.agents.filter((a): a is string => typeof a === "string")
        : Array.from(agents.keys()),
      maxRound: typeof gcDef.max_round === "number"
        ? gcDef.max_round
        : typeof gcDef.maxRound === "number"
          ? gcDef.maxRound
          : 10,
      speakerSelectionMethod: normalizeSpeakerMethod(gcDef.speaker_selection_method ?? gcDef.speakerSelectionMethod),
      allowRepeatSpeaker: gcDef.allow_repeat_speaker !== false && gcDef.allowRepeatSpeaker !== false,
    };
  }

  return {
    name: typeof raw.name === "string" ? raw.name : undefined,
    version: typeof raw.version === "string" ? raw.version : undefined,
    agents,
    initiator: typeof raw.initiator === "string" ? raw.initiator : undefined,
    responder: typeof raw.responder === "string" ? raw.responder : undefined,
    groupChat,
    raw,
  };
}

function normalizeAgent(id: string, raw: Record<string, unknown>): AutoGenAgent {
  const rawCodeExec = raw.code_execution_config ?? raw.codeExecutionConfig;
  let codeExecutionConfig: CodeExecutionConfig = { enabled: false };

  if (typeof rawCodeExec === "boolean") {
    codeExecutionConfig = { enabled: rawCodeExec };
  } else if (typeof rawCodeExec === "object" && rawCodeExec !== null) {
    const ceDef = rawCodeExec as Record<string, unknown>;
    codeExecutionConfig = {
      enabled: ceDef.enabled !== false,
      workDir: typeof ceDef.work_dir === "string"
        ? ceDef.work_dir
        : typeof ceDef.workDir === "string"
          ? ceDef.workDir
          : undefined,
      useDocker: typeof ceDef.use_docker === "boolean"
        ? ceDef.use_docker
        : typeof ceDef.useDocker === "boolean"
          ? ceDef.useDocker
          : undefined,
      timeout: typeof ceDef.timeout === "number" ? ceDef.timeout : undefined,
      lastNMessages: typeof ceDef.last_n_messages === "number"
        ? ceDef.last_n_messages
        : typeof ceDef.lastNMessages === "number"
          ? ceDef.lastNMessages
          : undefined,
    };
  }

  // Disable code execution for AssistantAgent by default (it's for UserProxy)
  const agentType = normalizeAgentType(raw.type);
  if (agentType === "AssistantAgent" && typeof rawCodeExec === "undefined") {
    codeExecutionConfig = { enabled: false };
  }

  const functions: FunctionDef[] = [];
  const rawFunctions = raw.functions ?? raw.function_map ?? raw.functionMap;
  if (typeof rawFunctions === "object" && rawFunctions !== null && !Array.isArray(rawFunctions)) {
    for (const [name, value] of Object.entries(rawFunctions as Record<string, unknown>)) {
      if (typeof value === "string") {
        functions.push({ name, description: value });
      } else if (typeof value === "object" && value !== null) {
        const fDef = value as Record<string, unknown>;
        functions.push({
          name,
          description: String(fDef.description ?? ""),
          parameters: typeof fDef.parameters === "object" ? fDef.parameters as Record<string, unknown> : undefined,
          capability: typeof fDef.capability === "string" ? fDef.capability as Capability : undefined,
        });
      }
    }
  }

  if (Array.isArray(rawFunctions)) {
    for (const entry of rawFunctions) {
      if (typeof entry === "string") {
        functions.push({ name: entry, description: "" });
      } else if (typeof entry === "object" && entry !== null) {
        const fDef = entry as Record<string, unknown>;
        functions.push({
          name: String(fDef.name ?? ""),
          description: String(fDef.description ?? ""),
          parameters: typeof fDef.parameters === "object" ? fDef.parameters as Record<string, unknown> : undefined,
          capability: typeof fDef.capability === "string" ? fDef.capability as Capability : undefined,
        });
      }
    }
  }

  return {
    name: String(raw.name ?? id),
    type: agentType,
    systemMessage: typeof raw.system_message === "string"
      ? raw.system_message
      : typeof raw.systemMessage === "string"
        ? raw.systemMessage
        : undefined,
    model: typeof raw.model === "string" ? raw.model : undefined,
    codeExecutionConfig,
    functions,
    humanInputMode: normalizeInputMode(raw.human_input_mode ?? raw.humanInputMode),
    maxConsecutiveAutoReply: typeof raw.max_consecutive_auto_reply === "number"
      ? raw.max_consecutive_auto_reply
      : typeof raw.maxConsecutiveAutoReply === "number"
        ? raw.maxConsecutiveAutoReply
        : undefined,
    isTerminationMsg: typeof raw.is_termination_msg === "string"
      ? raw.is_termination_msg
      : typeof raw.isTerminationMsg === "string"
        ? raw.isTerminationMsg
        : undefined,
  };
}

function normalizeAgentType(value: unknown): AutoGenAgentType {
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (lower.includes("userproxy") || lower === "user_proxy") return "UserProxyAgent";
    if (lower.includes("groupchat") || lower === "group_chat_manager") return "GroupChatManager";
    if (lower.includes("retrieveassistant")) return "RetrieveAssistantAgent";
    if (lower.includes("retrieveuser")) return "RetrieveUserProxyAgent";
    if (lower.includes("conversable")) return "ConversableAgent";
  }
  return "AssistantAgent";
}

function normalizeInputMode(value: unknown): "ALWAYS" | "TERMINATE" | "NEVER" | undefined {
  if (value === "ALWAYS" || value === "always") return "ALWAYS";
  if (value === "TERMINATE" || value === "terminate") return "TERMINATE";
  if (value === "NEVER" || value === "never") return "NEVER";
  return undefined;
}

function normalizeSpeakerMethod(value: unknown): "auto" | "round_robin" | "random" | "manual" {
  if (value === "round_robin" || value === "roundRobin") return "round_robin";
  if (value === "random") return "random";
  if (value === "manual") return "manual";
  return "auto";
}

// ─── Capability Resolution ───────────────────────────────────

function resolveCapabilities(config: AutoGenConfig): Capability[] {
  const caps = new Set<Capability>(BASE_CAPABILITIES);

  for (const agent of config.agents.values()) {
    if (agent.codeExecutionConfig.enabled) {
      caps.add("shell:execute");
    }

    for (const func of agent.functions) {
      const cap = func.capability ?? inferCapability(func.name);
      if (cap) caps.add(cap);
    }

    if (agent.humanInputMode === "ALWAYS") {
      caps.add("agent:communicate");
    }

    if (agent.type === "RetrieveAssistantAgent" || agent.type === "RetrieveUserProxyAgent") {
      caps.add("memory:read");
    }
  }

  return Array.from(caps);
}

function inferCapability(functionName: string): Capability | null {
  const lower = functionName.toLowerCase();
  for (const [pattern, cap] of Object.entries(FUNCTION_CAPABILITY_MAP)) {
    if (lower.includes(pattern)) return cap;
  }
  return null;
}

function countConsecutiveReplies(
  history: Array<{ agent: string }>,
  agentId: string
): number {
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry && entry.agent === agentId) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

/** Create an AutoGen adapter instance. */
export function createAutoGenAdapter(): AutoGenAdapter {
  return new AutoGenAdapter();
}

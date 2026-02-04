// @agentrun/sdk — AgentClient
// High-level API for agents to interact with the AgentRun gateway.
// Wraps the low-level sendGatewayTask() WebSocket RPC with typed methods.

import { sendGatewayTask, type GatewayClientOptions } from "./gateway-client.js";
import type {
  ChatMessage,
  ChatOptions,
  ChatResponse,
  StoreFact,
  SearchMemoryOptions,
  MemoryResult,
  RecordEpisode,
  ToolResult,
  ToolInfo,
  AgentInfo,
} from "./types.js";

/** Options for creating an AgentClient. */
export interface AgentClientOptions {
  /** The agent's unique ID (used for all gateway requests). */
  agentId: string;
  /** Gateway WebSocket URL. Defaults to ws://127.0.0.1:18800 or env vars. */
  gatewayUrl?: string;
  /** Auth token for gateway connection. Defaults to GATEWAY_AUTH_TOKEN env var. */
  authToken?: string;
  /** Internal token for agent-to-gateway trust. Defaults to INTERNAL_AUTH_TOKEN env var. */
  internalToken?: string;
  /** Request timeout in milliseconds. Defaults to 30000. */
  timeoutMs?: number;
}

/**
 * AgentClient — The primary API for agents to interact with AgentRun.
 *
 * Provides typed methods for:
 * - LLM chat (context.client.chat)
 * - Memory operations (storeFact, searchMemory, recordEpisode)
 * - Tool invocation (invokeTool, listTools)
 * - Agent-to-agent communication (callAgent, discoverAgents)
 * - Event emission (emit)
 *
 * @example
 * ```typescript
 * const client = new AgentClient({ agentId: "my-agent" });
 * const response = await client.chat([
 *   { role: "user", content: "Hello!" }
 * ]);
 * console.log(response.content);
 * ```
 */
export class AgentClient {
  private readonly options: Required<Pick<AgentClientOptions, "agentId" | "timeoutMs">> &
    Pick<AgentClientOptions, "gatewayUrl" | "authToken" | "internalToken">;

  constructor(options: AgentClientOptions) {
    this.options = {
      agentId: options.agentId,
      gatewayUrl: options.gatewayUrl,
      authToken: options.authToken ?? process.env.GATEWAY_AUTH_TOKEN,
      internalToken: options.internalToken ?? process.env.INTERNAL_AUTH_TOKEN,
      timeoutMs: options.timeoutMs ?? 30000,
    };
  }

  // ─── LLM ───────────────────────────────────────────────

  /**
   * Send a chat request to an LLM through the gateway.
   *
   * @example
   * ```typescript
   * const response = await client.chat([
   *   { role: "system", content: "You are a helpful assistant." },
   *   { role: "user", content: "What is MCP?" }
   * ], { maxTokens: 500, temperature: 0.3 });
   * ```
   */
  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    const result = await this.sendTask<{
      content?: string;
      model?: string;
      finishReason?: string;
      usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
    }>({
      type: "chat",
      messages,
      model: options?.model,
      maxTokens: options?.maxTokens,
      temperature: options?.temperature,
      systemPrompt: options?.systemPrompt,
    });

    return {
      content: typeof result.content === "string" ? result.content : "",
      model: result.model,
      finishReason: result.finishReason,
      usage: result.usage,
    };
  }

  // ─── MEMORY ────────────────────────────────────────────

  /**
   * Store a fact in the agent's semantic memory.
   *
   * @example
   * ```typescript
   * await client.storeFact({
   *   category: "user-preferences",
   *   fact: "User prefers TypeScript over JavaScript",
   *   tags: ["preferences", "language"],
   *   importance: 0.8,
   * });
   * ```
   */
  async storeFact(fact: StoreFact): Promise<void> {
    await this.sendTask({
      type: "store_fact",
      category: fact.category,
      fact: fact.fact,
      tags: fact.tags,
      importance: fact.importance,
    });
  }

  /**
   * Search across the agent's memory (semantic, episodic, procedural).
   *
   * @example
   * ```typescript
   * const results = await client.searchMemory("code review patterns", {
   *   types: ["semantic", "episodic"],
   *   limit: 5,
   * });
   * ```
   */
  async searchMemory(query: string, options?: SearchMemoryOptions): Promise<MemoryResult[]> {
    const result = await this.sendTask<{
      memories?: Array<Record<string, unknown>>;
      total?: number;
    }>({
      type: "search_memory",
      query,
      types: options?.types,
      limit: options?.limit,
    });

    const memories = Array.isArray(result.memories) ? result.memories : [];
    return memories.map((m) => ({
      type: typeof m.type === "string" ? m.type : "unknown",
      content: typeof m.content === "string" ? m.content : JSON.stringify(m),
      score: typeof m.score === "number" ? m.score : undefined,
      metadata: typeof m.metadata === "object" && m.metadata !== null
        ? m.metadata as Record<string, unknown>
        : undefined,
    }));
  }

  /**
   * Record an episode in the agent's episodic memory.
   *
   * @example
   * ```typescript
   * await client.recordEpisode({
   *   event: "code.reviewed",
   *   context: JSON.stringify({ file: "app.ts", issues: 3 }),
   *   tags: ["review"],
   *   success: true,
   * });
   * ```
   */
  async recordEpisode(episode: RecordEpisode): Promise<void> {
    await this.sendTask({
      type: "record_episode",
      event: episode.event,
      context: episode.context,
      tags: episode.tags,
      success: episode.success,
    });
  }

  // ─── TOOLS ─────────────────────────────────────────────

  /**
   * Invoke a tool registered with the gateway.
   *
   * @example
   * ```typescript
   * const result = await client.invokeTool("builtin:http_fetch", {
   *   url: "https://example.com",
   *   timeoutMs: 10000,
   * });
   * ```
   */
  async invokeTool<T = unknown>(
    toolId: string,
    args: Record<string, unknown>
  ): Promise<ToolResult<T>> {
    const result = await this.sendTask<{
      success?: boolean;
      content?: T;
      error?: string;
    }>({
      type: "invoke_tool",
      toolId,
      arguments: args,
    });

    return {
      success: result.success ?? true,
      content: result.content,
      error: result.error,
    };
  }

  /**
   * List all tools available to this agent.
   *
   * @example
   * ```typescript
   * const tools = await client.listTools();
   * for (const tool of tools) {
   *   console.log(`${tool.id}: ${tool.description}`);
   * }
   * ```
   */
  async listTools(): Promise<ToolInfo[]> {
    const result = await this.sendTask<{
      tools?: Array<Record<string, unknown>>;
    }>({
      type: "list_tools",
    });

    const tools = Array.isArray(result.tools) ? result.tools : [];
    return tools.map((t) => ({
      id: typeof t.id === "string" ? t.id : "",
      name: typeof t.name === "string" ? t.name : "",
      description: typeof t.description === "string" ? t.description : undefined,
      inputSchema: typeof t.inputSchema === "object" && t.inputSchema !== null
        ? t.inputSchema as Record<string, unknown>
        : undefined,
    }));
  }

  // ─── A2A (Agent-to-Agent) ──────────────────────────────

  /**
   * Send a task to another agent via A2A protocol.
   *
   * @example
   * ```typescript
   * const result = await client.callAgent("researcher", {
   *   type: "research_query",
   *   question: "What is the MCP protocol?",
   * });
   * ```
   */
  async callAgent<T = unknown>(
    agentId: string,
    task: Record<string, unknown>
  ): Promise<T> {
    const result = await this.sendTask<{
      result?: T;
      status?: string;
      error?: string;
    }>({
      type: "a2a_delegate",
      targetAgentId: agentId,
      task,
    });

    if (result.status === "error" || result.error) {
      throw new Error(result.error ?? `A2A call to ${agentId} failed`);
    }

    return (result.result ?? result) as T;
  }

  /**
   * Discover agents registered with the gateway.
   *
   * @example
   * ```typescript
   * const agents = await client.discoverAgents();
   * for (const agent of agents) {
   *   console.log(`${agent.name} (${agent.id}): ${agent.description}`);
   * }
   * ```
   */
  async discoverAgents(query?: string): Promise<AgentInfo[]> {
    const result = await this.sendTask<{
      agents?: Array<Record<string, unknown>>;
    }>({
      type: "agent_directory",
      query,
    });

    const agents = Array.isArray(result.agents) ? result.agents : [];
    return agents.map((a) => ({
      id: typeof a.id === "string" ? a.id : "",
      name: typeof a.name === "string" ? a.name : "",
      description: typeof a.description === "string" ? a.description : undefined,
      state: typeof a.state === "string" ? a.state : undefined,
      skills: Array.isArray(a.skills) ? a.skills as AgentInfo["skills"] : undefined,
    }));
  }

  // ─── PROCEDURAL MEMORY ────────────────────────────────

  /**
   * Store a procedure (skill/workflow) in the agent's procedural memory.
   *
   * @example
   * ```typescript
   * await client.storeProcedure({
   *   name: "Code Review",
   *   description: "Review pull request changes for bugs and style",
   *   trigger: "When a pull request is opened",
   *   steps: [
   *     { action: "fetch_diff", description: "Get the PR diff" },
   *     { action: "analyze_changes", description: "Check for bugs and style issues" },
   *     { action: "post_review", description: "Post review comments" },
   *   ],
   * });
   * ```
   */
  async storeProcedure(procedure: {
    name: string;
    description: string;
    trigger: string;
    steps: Array<{ action: string; description?: string; parameters?: Record<string, unknown> }>;
    inputs?: string[];
    outputs?: string[];
    tags?: string[];
    scope?: "private" | "shared" | "public";
    importance?: number;
  }): Promise<string> {
    const result = await this.sendTask<{ procedureId?: string }>({
      type: "store_procedure",
      ...procedure,
    });
    return result.procedureId ?? "";
  }

  /**
   * Get a procedure by name from the agent's procedural memory.
   *
   * @example
   * ```typescript
   * const proc = await client.getProcedure("Code Review");
   * if (proc) console.log(`Steps: ${proc.steps.length}, Success rate: ${proc.successRate}`);
   * ```
   */
  async getProcedure(name: string): Promise<{
    id: string;
    name: string;
    description: string;
    trigger: string;
    steps: Array<{ action: string; description?: string }>;
    version: number;
    successRate: number;
    executionCount: number;
    active: boolean;
  } | null> {
    const result = await this.sendTask<{
      found?: boolean;
      procedure?: Record<string, unknown>;
    }>({
      type: "get_procedure",
      name,
    });
    if (!result.found || !result.procedure) return null;
    return result.procedure as ReturnType<AgentClient["getProcedure"]> extends Promise<infer T> ? NonNullable<T> : never;
  }

  /**
   * Find procedures matching a situation/trigger.
   *
   * @example
   * ```typescript
   * const procs = await client.findProcedures("error in production");
   * for (const p of procs) {
   *   console.log(`${p.name}: ${p.description}`);
   * }
   * ```
   */
  async findProcedures(
    situation: string,
    options?: { limit?: number; minSuccessRate?: number }
  ): Promise<Array<{
    id: string;
    name: string;
    description: string;
    trigger: string;
    steps: Array<{ action: string; description?: string }>;
    successRate: number;
    executionCount: number;
  }>> {
    const result = await this.sendTask<{
      procedures?: Array<Record<string, unknown>>;
    }>({
      type: "find_procedures",
      situation,
      ...options,
    });
    return (result.procedures ?? []) as Awaited<ReturnType<AgentClient["findProcedures"]>>;
  }

  /**
   * Record the outcome of a procedure execution (for learning).
   *
   * @example
   * ```typescript
   * await client.recordProcedureExecution("proc-uuid", true);
   * ```
   */
  async recordProcedureExecution(procedureId: string, success: boolean): Promise<void> {
    await this.sendTask({
      type: "record_procedure_execution",
      procedureId,
      success,
    });
  }

  // ─── SKILLS ──────────────────────────────────────────

  /**
   * List all skills available across running agents.
   *
   * @example
   * ```typescript
   * const skills = await client.listSkills();
   * for (const skill of skills) {
   *   console.log(`${skill.name} (by ${skill.agentName}): ${skill.description}`);
   * }
   * ```
   */
  async listSkills(filter?: {
    capability?: string;
    agentId?: string;
  }): Promise<Array<{
    id: string;
    name: string;
    description?: string;
    providedBy: string;
    agentName: string;
  }>> {
    const result = await this.sendTask<{
      skills?: Array<Record<string, unknown>>;
    }>({
      type: "list_skills",
      filter,
    });
    return (result.skills ?? []) as Awaited<ReturnType<AgentClient["listSkills"]>>;
  }

  /**
   * Invoke a skill by ID. The gateway routes the request to the agent providing the skill.
   *
   * @example
   * ```typescript
   * const result = await client.invokeSkill("summarize-text", {
   *   text: "Long article here...",
   *   maxLength: 200,
   * });
   * ```
   */
  async invokeSkill<T = unknown>(
    skillId: string,
    input?: Record<string, unknown>
  ): Promise<T> {
    const result = await this.sendTask<{ result?: T }>({
      type: "invoke_skill",
      skillId,
      input,
    });
    return (result.result ?? result) as T;
  }

  // ─── EVENTS ────────────────────────────────────────────

  /**
   * Emit an event on the gateway event bus.
   *
   * @example
   * ```typescript
   * await client.emit("agent.lifecycle", "agent.task.completed", {
   *   taskId: "123",
   *   duration: 450,
   * });
   * ```
   */
  async emit(
    channel: string,
    type: string,
    data?: Record<string, unknown>
  ): Promise<void> {
    await this.sendTask({
      type: "emit_event",
      channel,
      eventType: type,
      data,
    });
  }

  // ─── INTERNAL ──────────────────────────────────────────

  /**
   * Low-level method to send a raw task to the gateway.
   * Prefer the typed methods (chat, storeFact, etc.) when possible.
   */
  async sendTask<T = unknown>(task: Record<string, unknown>): Promise<T> {
    const gatewayOptions: GatewayClientOptions = {
      url: this.resolveGatewayUrl(),
      agentId: this.options.agentId,
      authToken: this.options.authToken,
      internalToken: this.options.internalToken,
      timeoutMs: this.options.timeoutMs,
    };

    const result = await sendGatewayTask<T>(gatewayOptions, task, true);

    if (!result.ok) {
      throw new Error(result.error ?? "Gateway task failed");
    }

    return result.result as T;
  }

  private resolveGatewayUrl(): string {
    if (this.options.gatewayUrl) return this.options.gatewayUrl;
    const host = process.env.GATEWAY_HOST ?? "127.0.0.1";
    const port = process.env.GATEWAY_PORT ?? "18800";
    return process.env.GATEWAY_URL ?? `ws://${host}:${port}`;
  }
}

/**
 * Create an AgentClient instance.
 *
 * @example
 * ```typescript
 * const client = createAgentClient({ agentId: "my-agent" });
 * const response = await client.chat([{ role: "user", content: "Hello!" }]);
 * ```
 */
export function createAgentClient(options: AgentClientOptions): AgentClient {
  return new AgentClient(options);
}

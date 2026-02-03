// @agent-os/shared — Shared types, utils, and constants

// ─── Result Type (no try/catch for business logic) ───
export interface Ok<T> { readonly ok: true; readonly value: T }
export interface Err<E> { readonly ok: false; readonly error: E }
export type Result<T, E = Error> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> { return { ok: true, value }; }
export function err<E>(error: E): Err<E> { return { ok: false, error }; }

// ─── Agent Identity ───
export interface AgentId {
  /** Unique identifier for this agent instance */
  readonly id: string;
  /** Human-readable name */
  readonly name: string;
  /** Version of the agent */
  readonly version: string;
}

// ─── Agent Manifest (like Android's AndroidManifest.xml) ───
export interface AgentManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly author: string;
  /** Which LLM model this agent prefers */
  readonly preferredModel?: string;
  /** Optional manifest signature metadata */
  readonly signedAt?: string;
  readonly signedBy?: string;
  readonly signature?: string;
  /** Optional entry point for isolated agent runtime */
  readonly entryPoint?: string;
  /** Skills this agent requires */
  readonly requiredSkills: string[];
  /** Permissions this agent needs */
  readonly permissions: string[];
  /** Structured permission grants */
  readonly permissionGrants?: Array<{
    category: string;
    actions: string[];
    resource?: string;
    constraints?: Record<string, unknown>;
  }>;
  /** Trust level for tool autonomy */
  readonly trustLevel?: "supervised" | "semi-autonomous" | "monitored-autonomous";
  /** A2A skills with optional input/output schemas */
  readonly a2aSkills?: Array<{
    id: string;
    name?: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
  }>;
  /** Resource and budget limits */
  readonly limits?: {
    maxTokensPerRequest?: number;
    tokensPerMinute?: number;
    requestsPerMinute?: number;
    toolCallsPerMinute?: number;
    costBudgetUSD?: number;
    maxMemoryMB?: number;
    cpuCores?: number;
    diskQuotaMB?: number;
  };
  /** MCP servers this agent connects to */
  readonly mcpServers?: McpServerConfig[];
  /** Optional tool allowlist */
  readonly tools?: Array<{
    id: string;
    enabled?: boolean;
  }>;
}

export interface McpServerConfig {
  readonly name: string;
  readonly transport: "stdio" | "sse" | "streamable-http";
  readonly command?: string;
  readonly args?: string[];
  readonly url?: string;
}

// ─── Agent Lifecycle States ───
export type AgentState =
  | "initializing"
  | "ready"
  | "running"
  | "paused"
  | "error"
  | "terminated";

// ─── Provider Types ───
export interface LlmProvider {
  readonly id: string;
  readonly name: string;
  readonly models: string[];
}

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface ChatRequest {
  readonly model: string;
  readonly messages: ChatMessage[];
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly stream?: boolean;
}

export interface ChatResponse {
  readonly content: string;
  readonly model: string;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
  /** Router-generated request ID */
  readonly requestId?: string;
  /** Provider that served the request */
  readonly providerId?: string;
  /** Total latency in ms */
  readonly latencyMs?: number;
  /** Number of retry attempts */
  readonly retryCount?: number;
  /** Number of failover attempts */
  readonly failoverCount?: number;
  /** Fallback model used (if any) */
  readonly fallbackModel?: string;
}

// ─── Events ───
export interface AgentEvent {
  readonly type: string;
  readonly agentId: string;
  readonly timestamp: number;
  readonly payload: unknown;
}

// ─── Logger Interface ───
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

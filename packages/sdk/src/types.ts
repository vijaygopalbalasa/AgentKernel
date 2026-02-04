// @agentrun/sdk — Core types for the AgentClient API
// These types provide a clean, typed interface for agent developers.

// ─── LLM ───────────────────────────────────────────────────

/** A chat message sent to or received from an LLM. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Options for an LLM chat request. */
export interface ChatOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
}

/** Response from an LLM chat request. */
export interface ChatResponse {
  content: string;
  model?: string;
  finishReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

// ─── MEMORY ────────────────────────────────────────────────

/** A fact to store in semantic memory. */
export interface StoreFact {
  category: string;
  fact: string;
  tags?: string[];
  importance?: number;
}

/** Options for searching agent memory. */
export interface SearchMemoryOptions {
  types?: Array<"semantic" | "episodic" | "procedural">;
  limit?: number;
}

/** A single memory search result. */
export interface MemoryResult {
  type: string;
  content: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

/** An episode to record in episodic memory. */
export interface RecordEpisode {
  event: string;
  context?: string;
  tags?: string[];
  success?: boolean;
}

// ─── TOOLS ─────────────────────────────────────────────────

/** Result of invoking a tool. */
export interface ToolResult<T = unknown> {
  success: boolean;
  content?: T;
  error?: string;
}

/** Information about an available tool. */
export interface ToolInfo {
  id: string;
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

// ─── A2A (Agent-to-Agent) ──────────────────────────────────

/** Information about a registered agent. */
export interface AgentInfo {
  id: string;
  name: string;
  description?: string;
  state?: string;
  skills?: Array<{
    id: string;
    name?: string;
    description?: string;
  }>;
}

// ─── PROCEDURAL MEMORY ────────────────────────────────────

/** A procedure step definition. */
export interface ProcedureStep {
  action: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

/** A procedure to store in procedural memory. */
export interface StoreProcedure {
  name: string;
  description: string;
  trigger: string;
  steps: ProcedureStep[];
  inputs?: string[];
  outputs?: string[];
  tags?: string[];
  scope?: "private" | "shared" | "public";
  importance?: number;
}

/** A procedure retrieved from memory. */
export interface ProcedureInfo {
  id: string;
  name: string;
  description: string;
  trigger: string;
  steps: ProcedureStep[];
  version: number;
  successRate: number;
  executionCount: number;
  active: boolean;
}

// ─── SKILLS ───────────────────────────────────────────────

/** Information about a skill provided by an agent. */
export interface SkillInfo {
  id: string;
  name: string;
  description?: string;
  providedBy: string;
  agentName: string;
}

// ─── EVENTS ────────────────────────────────────────────────

/** An event to emit on the event bus. */
export interface EmitEvent {
  channel: string;
  type: string;
  data?: Record<string, unknown>;
}

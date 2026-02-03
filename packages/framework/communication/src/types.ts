// A2A Types — Agent-to-Agent Protocol types
// Based on Google's A2A Protocol specification v0.3

import { z } from "zod";

// ─── ERROR CLASS ────────────────────────────────────────────

/** Communication error codes */
export type CommunicationErrorCode =
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "NETWORK_ERROR"
  | "TIMEOUT_ERROR"
  | "PROTOCOL_ERROR"
  | "AUTH_ERROR"
  | "TASK_ERROR"
  | "REGISTRY_ERROR"
  | "REPLAY_ERROR";

/**
 * Error class for communication operations.
 */
export class CommunicationError extends Error {
  constructor(
    message: string,
    public readonly code: CommunicationErrorCode,
    public readonly agentUrl?: string,
    public readonly taskId?: string
  ) {
    super(message);
    this.name = "CommunicationError";
  }
}

// ─── INPUT/OUTPUT MODES ─────────────────────────────────────

/** Input modes schema */
export const A2AInputModeSchema = z.enum(["text", "audio", "video", "file"]);

/** Input modes */
export type A2AInputMode = z.infer<typeof A2AInputModeSchema>;

/** Output modes schema */
export const A2AOutputModeSchema = z.enum(["text", "audio", "video", "file"]);

/** Output modes */
export type A2AOutputMode = z.infer<typeof A2AOutputModeSchema>;

// ─── CAPABILITIES ────────────────────────────────────────────

/** Agent capabilities schema */
export const A2ACapabilitiesSchema = z.object({
  /** Supports streaming responses */
  streaming: z.boolean().optional(),
  /** Supports push notifications */
  pushNotifications: z.boolean().optional(),
  /** Supports state/context between requests */
  stateTransitionHistory: z.boolean().optional(),
});

/** Agent capabilities */
export interface A2ACapabilities {
  /** Supports streaming responses */
  streaming?: boolean;
  /** Supports push notifications */
  pushNotifications?: boolean;
  /** Supports state/context between requests */
  stateTransitionHistory?: boolean;
}

// ─── AUTHENTICATION ──────────────────────────────────────────

/** Authentication scheme schema */
export const A2AAuthSchemeSchema = z.enum(["bearer", "apiKey", "oauth2", "none"]);

/** OAuth2 configuration schema */
export const A2AOAuth2ConfigSchema = z.object({
  authorizationUrl: z.string().url(),
  tokenUrl: z.string().url(),
  scopes: z.record(z.string()).optional(),
});

/** Authentication configuration schema */
export const A2AAuthenticationSchema = z.object({
  /** Authentication schemes supported */
  schemes: z.array(A2AAuthSchemeSchema),
  /** OAuth2 configuration if applicable */
  oauth2: A2AOAuth2ConfigSchema.optional(),
});

/** Authentication configuration */
export interface A2AAuthentication {
  /** Authentication schemes supported */
  schemes: Array<"bearer" | "apiKey" | "oauth2" | "none">;
  /** OAuth2 configuration if applicable */
  oauth2?: {
    authorizationUrl: string;
    tokenUrl: string;
    scopes?: Record<string, string>;
  };
}

// ─── SKILLS ──────────────────────────────────────────────────

/** Skill definition schema */
export const A2ASkillSchema = z.object({
  /** Skill identifier */
  id: z.string().min(1),
  /** Human-readable name */
  name: z.string().min(1),
  /** Description */
  description: z.string().optional(),
  /** Tags for categorization */
  tags: z.array(z.string()).optional(),
  /** Example prompts */
  examples: z.array(z.string()).optional(),
  /** Input schema (JSON Schema) */
  inputSchema: z.record(z.unknown()).optional(),
  /** Output schema (JSON Schema) */
  outputSchema: z.record(z.unknown()).optional(),
});

/** Skill definition */
export interface A2ASkill {
  /** Skill identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description */
  description?: string;
  /** Tags for categorization */
  tags?: string[];
  /** Example prompts */
  examples?: string[];
  /** Input schema (JSON Schema) */
  inputSchema?: Record<string, unknown>;
  /** Output schema (JSON Schema) */
  outputSchema?: Record<string, unknown>;
}

// ─── PROVIDER ────────────────────────────────────────────────

/** Provider information schema */
export const A2AProviderSchema = z.object({
  organization: z.string().min(1),
  url: z.string().url().optional(),
});

// ─── AGENT CARD ──────────────────────────────────────────────

/** Agent Card schema — published at /.well-known/agent.json */
export const A2AAgentCardSchema = z.object({
  /** Agent name */
  name: z.string().min(1),
  /** Agent description */
  description: z.string().optional(),
  /** Agent URL (base endpoint) */
  url: z.string().url(),
  /** Provider information */
  provider: A2AProviderSchema.optional(),
  /** Agent version */
  version: z.string().optional(),
  /** Documentation URL */
  documentationUrl: z.string().url().optional(),
  /** Capabilities this agent offers */
  capabilities: A2ACapabilitiesSchema.optional(),
  /** Authentication requirements */
  authentication: A2AAuthenticationSchema.optional(),
  /** Default input modes */
  defaultInputModes: z.array(A2AInputModeSchema).optional(),
  /** Default output modes */
  defaultOutputModes: z.array(A2AOutputModeSchema).optional(),
  /** Skills this agent can perform */
  skills: z.array(A2ASkillSchema).optional(),
});

/** Agent Card — published at /.well-known/agent.json */
export interface A2AAgentCard {
  /** Agent name */
  name: string;
  /** Agent description */
  description?: string;
  /** Agent URL (base endpoint) */
  url: string;
  /** Provider information */
  provider?: {
    organization: string;
    url?: string;
  };
  /** Agent version */
  version?: string;
  /** Documentation URL */
  documentationUrl?: string;
  /** Capabilities this agent offers */
  capabilities?: A2ACapabilities;
  /** Authentication requirements */
  authentication?: A2AAuthentication;
  /** Default input modes */
  defaultInputModes?: A2AInputMode[];
  /** Default output modes */
  defaultOutputModes?: A2AOutputMode[];
  /** Skills this agent can perform */
  skills?: A2ASkill[];
}

// ─── TASK STATE ──────────────────────────────────────────────

/** Task states schema */
export const A2ATaskStateSchema = z.enum([
  "submitted",      // Task received
  "working",        // Agent is processing
  "input-required", // Agent needs more input
  "completed",      // Task finished successfully
  "failed",         // Task failed
  "canceled",       // Task was canceled
]);

/** Task states */
export type A2ATaskState = z.infer<typeof A2ATaskStateSchema>;

/** Task status schema */
export const A2ATaskStatusSchema = z.object({
  /** Current state */
  state: A2ATaskStateSchema,
  /** Progress message */
  message: z.string().optional(),
  /** Timestamp of status update */
  timestamp: z.date(),
});

/** Task status */
export interface A2ATaskStatus {
  /** Current state */
  state: A2ATaskState;
  /** Progress message */
  message?: string;
  /** Timestamp of status update */
  timestamp: Date;
}

// ─── MESSAGE PARTS ───────────────────────────────────────────

/** Text message part schema */
export const A2ATextPartSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

/** Text message part */
export interface A2ATextPart {
  type: "text";
  text: string;
}

/** File message part schema */
export const A2AFilePartSchema = z.object({
  type: z.literal("file"),
  file: z.object({
    name: z.string().min(1),
    mimeType: z.string().min(1),
    content: z.string().optional(),
    url: z.string().url().optional(),
  }),
});

/** File message part */
export interface A2AFilePart {
  type: "file";
  file: {
    name: string;
    mimeType: string;
    /** Base64 encoded content or URL */
    content?: string;
    url?: string;
  };
}

/** Data message part schema */
export const A2ADataPartSchema = z.object({
  type: z.literal("data"),
  data: z.record(z.unknown()),
});

/** Data message part */
export interface A2ADataPart {
  type: "data";
  data: Record<string, unknown>;
}

/** Message part schema */
export const A2AMessagePartSchema = z.discriminatedUnion("type", [
  A2ATextPartSchema,
  A2AFilePartSchema,
  A2ADataPartSchema,
]);

/** Message part */
export type A2AMessagePart =
  | A2ATextPart
  | A2AFilePart
  | A2ADataPart;

// ─── MESSAGE ─────────────────────────────────────────────────

/** Message role schema */
export const A2AMessageRoleSchema = z.enum(["user", "agent"]);

/** Message in a task schema */
export const A2AMessageSchema = z.object({
  /** Message role */
  role: A2AMessageRoleSchema,
  /** Message parts */
  parts: z.array(A2AMessagePartSchema),
  /** Timestamp */
  timestamp: z.date().optional(),
});

/** Message in a task */
export interface A2AMessage {
  /** Message role */
  role: "user" | "agent";
  /** Message parts */
  parts: A2AMessagePart[];
  /** Timestamp */
  timestamp?: Date;
}

// ─── ARTIFACT ────────────────────────────────────────────────

/** Artifact produced by a task schema */
export const A2AArtifactSchema = z.object({
  /** Artifact ID */
  id: z.string().min(1),
  /** Artifact name */
  name: z.string().min(1),
  /** MIME type */
  mimeType: z.string().min(1),
  /** Content or URL */
  content: z.string().optional(),
  url: z.string().url().optional(),
  /** Metadata */
  metadata: z.record(z.unknown()).optional(),
});

/** Artifact produced by a task */
export interface A2AArtifact {
  /** Artifact ID */
  id: string;
  /** Artifact name */
  name: string;
  /** MIME type */
  mimeType: string;
  /** Content or URL */
  content?: string;
  url?: string;
  /** Metadata */
  metadata?: Record<string, unknown>;
}

// ─── TASK ────────────────────────────────────────────────────

/** Task schema — a unit of work delegated to an agent */
export const A2ATaskSchema = z.object({
  /** Task ID */
  id: z.string().min(1),
  /** Session ID for multi-turn conversations */
  sessionId: z.string().optional(),
  /** Current task status */
  status: A2ATaskStatusSchema,
  /** Input message */
  message: A2AMessageSchema,
  /** Task artifacts (files, data) */
  artifacts: z.array(A2AArtifactSchema).optional(),
  /** Task history */
  history: z.array(A2AMessageSchema).optional(),
  /** Task metadata */
  metadata: z.record(z.unknown()).optional(),
  /** When the task was created */
  createdAt: z.date(),
  /** When the task was last updated */
  updatedAt: z.date(),
});

/** Task — a unit of work delegated to an agent */
export interface A2ATask {
  /** Task ID */
  id: string;
  /** Session ID for multi-turn conversations */
  sessionId?: string;
  /** Current task status */
  status: A2ATaskStatus;
  /** Input message */
  message: A2AMessage;
  /** Task artifacts (files, data) */
  artifacts?: A2AArtifact[];
  /** Task history */
  history?: A2AMessage[];
  /** Task metadata */
  metadata?: Record<string, unknown>;
  /** When the task was created */
  createdAt: Date;
  /** When the task was last updated */
  updatedAt: Date;
}

// ─── JSON-RPC ────────────────────────────────────────────────

/** A2A Methods schema */
export const A2AMethodSchema = z.enum([
  "tasks/send",         // Send a new task
  "tasks/sendSubscribe", // Send task with streaming
  "tasks/get",          // Get task status
  "tasks/cancel",       // Cancel a task
  "tasks/list",         // List tasks
]);

/** A2A Methods */
export type A2AMethod = z.infer<typeof A2AMethodSchema>;

/** A2A Error schema */
export const A2AErrorSchema = z.object({
  /** Error code */
  code: z.number(),
  /** Error message */
  message: z.string(),
  /** Additional data */
  data: z.unknown().optional(),
});

/** A2A Error */
export interface A2AError {
  /** Error code */
  code: number;
  /** Error message */
  message: string;
  /** Additional data */
  data?: unknown;
}

/** A2A Request schema — sent to an agent (lenient for unknown methods) */
export const A2ARequestSchema = z.object({
  /** JSON-RPC version */
  jsonrpc: z.literal("2.0"),
  /** Request ID */
  id: z.union([z.string(), z.number()]),
  /** Method name — accepts any string, unknown methods return -32601 */
  method: z.string().min(1),
  /** Method parameters */
  params: z.unknown().optional(),
});

/** A2A Request — sent to an agent */
export interface A2ARequest {
  /** JSON-RPC version */
  jsonrpc: "2.0";
  /** Request ID */
  id: string | number;
  /** Method name — accepts any string, unknown methods return -32601 */
  method: string;
  /** Method parameters */
  params?: unknown;
}

/** A2A Response schema — returned from an agent */
export const A2AResponseSchema = z.object({
  /** JSON-RPC version */
  jsonrpc: z.literal("2.0"),
  /** Request ID (matches request) */
  id: z.union([z.string(), z.number()]),
  /** Result (if success) */
  result: z.unknown().optional(),
  /** Error (if failed) */
  error: A2AErrorSchema.optional(),
});

/** A2A Response — returned from an agent */
export interface A2AResponse {
  /** JSON-RPC version */
  jsonrpc: "2.0";
  /** Request ID (matches request) */
  id: string | number;
  /** Result (if success) */
  result?: unknown;
  /** Error (if failed) */
  error?: A2AError;
}

// ─── SSE EVENT ───────────────────────────────────────────────

/** SSE Event type schema */
export const A2ASSEEventTypeSchema = z.enum(["status", "artifact", "message", "error"]);

/** SSE Event schema — Server-Sent Events for streaming */
export const A2ASSEEventSchema = z.object({
  /** Event type */
  event: A2ASSEEventTypeSchema,
  /** Event data */
  data: z.unknown(),
});

/** SSE Event — Server-Sent Events for streaming */
export interface A2ASSEEvent {
  /** Event type */
  event: "status" | "artifact" | "message" | "error";
  /** Event data */
  data: unknown;
}

// ─── REGISTRY ENTRY ──────────────────────────────────────────

/** Agent Registry Entry schema */
export const AgentRegistryEntrySchema = z.object({
  /** Agent Card */
  card: A2AAgentCardSchema,
  /** When the agent was registered */
  registeredAt: z.date(),
  /** When the card was last fetched */
  lastFetchedAt: z.date(),
  /** Whether the agent is currently reachable */
  isOnline: z.boolean(),
  /** Local agent ID (for local agents) */
  localAgentId: z.string().optional(),
});

/** Agent Registry Entry */
export interface AgentRegistryEntry {
  /** Agent Card */
  card: A2AAgentCard;
  /** When the agent was registered */
  registeredAt: Date;
  /** When the card was last fetched */
  lastFetchedAt: Date;
  /** Whether the agent is currently reachable */
  isOnline: boolean;
  /** Local agent ID (for local agents) */
  localAgentId?: string;
}

// ─── TASK DELEGATION ─────────────────────────────────────────

/** Task delegation request schema */
export const TaskDelegationRequestSchema = z.object({
  /** Target agent URL or ID */
  agentUrl: z.string().url(),
  /** Task message */
  message: A2AMessageSchema,
  /** Session ID for multi-turn */
  sessionId: z.string().optional(),
  /** Whether to use streaming */
  streaming: z.boolean().optional(),
  /** Timeout in milliseconds */
  timeout: z.number().int().min(0).optional(),
});

/** Task delegation request */
export interface TaskDelegationRequest {
  /** Target agent URL or ID */
  agentUrl: string;
  /** Task message */
  message: A2AMessage;
  /** Session ID for multi-turn */
  sessionId?: string;
  /** Whether to use streaming */
  streaming?: boolean;
  /** Timeout in milliseconds */
  timeout?: number;
}

/** Task delegation result schema */
export const TaskDelegationResultSchema = z.object({
  /** Whether delegation succeeded */
  success: z.boolean(),
  /** The task (if created) */
  task: A2ATaskSchema.optional(),
  /** Error message (if failed) */
  error: z.string().optional(),
});

/** Task delegation result */
export interface TaskDelegationResult {
  /** Whether delegation succeeded */
  success: boolean;
  /** The task (if created) */
  task?: A2ATask;
  /** Error message (if failed) */
  error?: string;
}

// ─── COMMUNICATION EVENT ─────────────────────────────────────

/** Communication event type schema */
export const CommunicationEventTypeSchema = z.enum([
  "agent_registered",
  "agent_discovered",
  "agent_offline",
  "task_sent",
  "task_received",
  "task_completed",
  "task_failed",
  "message_received",
]);

/** Communication event schema */
export const CommunicationEventSchema = z.object({
  type: CommunicationEventTypeSchema,
  agentId: z.string().optional(),
  agentUrl: z.string().optional(),
  taskId: z.string().optional(),
  timestamp: z.date(),
  data: z.unknown().optional(),
});

/** Communication event */
export interface CommunicationEvent {
  type:
    | "agent_registered"
    | "agent_discovered"
    | "agent_offline"
    | "task_sent"
    | "task_received"
    | "task_completed"
    | "task_failed"
    | "message_received";
  agentId?: string;
  agentUrl?: string;
  taskId?: string;
  timestamp: Date;
  data?: unknown;
}

// ─── INPUT SCHEMAS (for validation) ──────────────────────────

/** Task send params schema (with optional replay protection fields) */
export const TaskSendParamsSchema = z.object({
  message: A2AMessageSchema,
  sessionId: z.string().optional(),
  /** Unique nonce for replay protection (UUID recommended) */
  nonce: z.string().min(1).optional(),
  /** Unix timestamp in milliseconds when the request was created */
  timestamp: z.number().int().positive().optional(),
});

/** Task send params with required replay protection fields */
export const TaskSendParamsWithReplayProtectionSchema = z.object({
  message: A2AMessageSchema,
  sessionId: z.string().optional(),
  /** Unique nonce for replay protection (UUID recommended) */
  nonce: z.string().min(1),
  /** Unix timestamp in milliseconds when the request was created */
  timestamp: z.number().int().positive(),
});

/** Register local agent input schema */
export const RegisterLocalInputSchema = z.object({
  agentId: z.string().min(1),
  card: A2AAgentCardSchema,
});

/** Discover agent input schema */
export const DiscoverAgentInputSchema = z.object({
  agentUrl: z.string().url(),
});

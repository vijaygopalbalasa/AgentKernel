// A2A Types — Agent-to-Agent Protocol types
// Based on Google's A2A Protocol specification v0.3

import { z } from "zod";

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

/** Agent capabilities */
export interface A2ACapabilities {
  /** Supports streaming responses */
  streaming?: boolean;
  /** Supports push notifications */
  pushNotifications?: boolean;
  /** Supports state/context between requests */
  stateTransitionHistory?: boolean;
}

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

/** Input modes */
export type A2AInputMode = "text" | "audio" | "video" | "file";

/** Output modes */
export type A2AOutputMode = "text" | "audio" | "video" | "file";

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

/** Task status */
export interface A2ATaskStatus {
  /** Current state */
  state: A2ATaskState;
  /** Progress message */
  message?: string;
  /** Timestamp of status update */
  timestamp: Date;
}

/** Task states */
export type A2ATaskState =
  | "submitted"    // Task received
  | "working"      // Agent is processing
  | "input-required" // Agent needs more input
  | "completed"    // Task finished successfully
  | "failed"       // Task failed
  | "canceled";    // Task was canceled

/** Message in a task */
export interface A2AMessage {
  /** Message role */
  role: "user" | "agent";
  /** Message parts */
  parts: A2AMessagePart[];
  /** Timestamp */
  timestamp?: Date;
}

/** Message part */
export type A2AMessagePart =
  | A2ATextPart
  | A2AFilePart
  | A2ADataPart;

/** Text message part */
export interface A2ATextPart {
  type: "text";
  text: string;
}

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

/** Data message part */
export interface A2ADataPart {
  type: "data";
  data: Record<string, unknown>;
}

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

/** A2A Request — sent to an agent */
export interface A2ARequest {
  /** JSON-RPC version */
  jsonrpc: "2.0";
  /** Request ID */
  id: string | number;
  /** Method name */
  method: A2AMethod;
  /** Method parameters */
  params?: unknown;
}

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

/** A2A Error */
export interface A2AError {
  /** Error code */
  code: number;
  /** Error message */
  message: string;
  /** Additional data */
  data?: unknown;
}

/** A2A Methods */
export type A2AMethod =
  | "tasks/send"      // Send a new task
  | "tasks/sendSubscribe" // Send task with streaming
  | "tasks/get"       // Get task status
  | "tasks/cancel"    // Cancel a task
  | "tasks/list";     // List tasks

/** SSE Event — Server-Sent Events for streaming */
export interface A2ASSEEvent {
  /** Event type */
  event: "status" | "artifact" | "message" | "error";
  /** Event data */
  data: unknown;
}

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

/** Task delegation result */
export interface TaskDelegationResult {
  /** Whether delegation succeeded */
  success: boolean;
  /** The task (if created) */
  task?: A2ATask;
  /** Error message (if failed) */
  error?: string;
}

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

// Zod schemas for validation

export const A2ATextPartSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export const A2AFilePartSchema = z.object({
  type: z.literal("file"),
  file: z.object({
    name: z.string(),
    mimeType: z.string(),
    content: z.string().optional(),
    url: z.string().optional(),
  }),
});

export const A2ADataPartSchema = z.object({
  type: z.literal("data"),
  data: z.record(z.unknown()),
});

export const A2AMessagePartSchema = z.discriminatedUnion("type", [
  A2ATextPartSchema,
  A2AFilePartSchema,
  A2ADataPartSchema,
]);

export const A2AMessageSchema = z.object({
  role: z.enum(["user", "agent"]),
  parts: z.array(A2AMessagePartSchema),
  timestamp: z.date().optional(),
});

export const TaskSendParamsSchema = z.object({
  message: A2AMessageSchema,
  sessionId: z.string().optional(),
});

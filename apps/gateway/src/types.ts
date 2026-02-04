// Gateway Types — Zod schemas and types for WebSocket communication
// Production quality with runtime validation

import { z } from "zod";
import { A2ASkillSchema } from "@agentrun/communication";

// ─── ERROR CLASS ────────────────────────────────────────────

/** Gateway error codes */
export type GatewayErrorCode =
  | "VALIDATION_ERROR"
  | "AUTH_ERROR"
  | "NOT_FOUND"
  | "AGENT_ERROR"
  | "PROVIDER_ERROR"
  | "CONNECTION_ERROR"
  | "RATE_LIMIT"
  | "PERMISSION_DENIED"
  | "APPROVAL_REQUIRED"
  | "POLICY_ERROR"
  | "CLUSTER_FORWARD_FAILED"
  | "INTERNAL_ERROR";

/**
 * Error class for gateway operations.
 */
export class GatewayError extends Error {
  constructor(
    message: string,
    public readonly code: GatewayErrorCode,
    public readonly clientId?: string,
    public readonly agentId?: string
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

// ─── MESSAGE TYPES ──────────────────────────────────────────

/** WebSocket message type schema */
export const MessageTypeSchema = z.enum([
  // Connection
  "ping",
  "pong",
  "auth",
  "auth_required",
  "auth_success",
  "auth_failed",
  // Chat
  "chat",
  "chat_response",
  "chat_stream",
  "chat_stream_end",
  // Agent lifecycle
  "agent_spawn",
  "agent_spawn_result",
  "agent_terminate",
  "agent_terminate_result",
  "agent_status",
  "agent_list",
  // Agent tasks
  "agent_task",
  "agent_task_result",
  // Events
  "event",
  "subscribe",
  "unsubscribe",
  // Errors
  "error",
]);

export type MessageType = z.infer<typeof MessageTypeSchema>;

// ─── BASE MESSAGE ───────────────────────────────────────────

/** Base WebSocket message schema */
export const WsMessageSchema = z.object({
  type: MessageTypeSchema,
  id: z.string().optional(),
  payload: z.unknown().optional(),
  timestamp: z.number().optional(),
});

export type WsMessage = z.infer<typeof WsMessageSchema>;

// ─── AUTH PAYLOADS ──────────────────────────────────────────

export const AuthPayloadSchema = z.object({
  token: z.string().min(1),
});

export const AuthSuccessPayloadSchema = z.object({
  clientId: z.string(),
  message: z.string().optional(),
});

export const AuthFailedPayloadSchema = z.object({
  message: z.string(),
});

// ─── CHAT PAYLOADS ──────────────────────────────────────────

export const ChatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});

export const ChatPayloadSchema = z.object({
  model: z.string().optional(),
  messages: z.array(ChatMessageSchema).min(1),
  maxTokens: z.number().int().min(1).max(100000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  stream: z.boolean().optional(),
});

export const ChatResponsePayloadSchema = z.object({
  content: z.string(),
  model: z.string(),
  usage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
  }).optional(),
  finishReason: z.string().optional(),
});

export const ChatStreamPayloadSchema = z.object({
  delta: z.string(),
  index: z.number(),
});

export const ChatStreamEndPayloadSchema = ChatResponsePayloadSchema;

// ─── AGENT PAYLOADS ─────────────────────────────────────────

export const TrustLevelSchema = z.enum([
  "supervised",
  "semi-autonomous",
  "monitored-autonomous",
]);

export const PermissionGrantSchema = z.object({
  category: z.enum([
    "memory",
    "tools",
    "network",
    "filesystem",
    "agents",
    "llm",
    "secrets",
    "admin",
    "system",
    "shell",
    "skill",
    "social",
  ]),
  actions: z.array(z.enum(["read", "write", "execute", "delete", "admin"])).min(1),
  resource: z.string().optional(),
  constraints: z.record(z.unknown()).optional(),
});

export const AgentSpawnPayloadSchema = z.object({
  manifestPath: z.string().optional(),
  manifest: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    version: z.string().optional(),
    description: z.string().optional(),
    model: z.string().optional(),
    preferredModel: z.string().optional(),
    systemPrompt: z.string().optional(),
    skills: z.array(z.string()).optional(),
    a2aSkills: z.array(A2ASkillSchema).optional(),
    entryPoint: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    permissions: z.array(z.string()).optional(),
    permissionGrants: z.array(PermissionGrantSchema).optional(),
    trustLevel: TrustLevelSchema.optional(),
    signedAt: z.string().optional(),
    signedBy: z.string().optional(),
    signature: z.string().optional(),
    limits: z.object({
      maxTokensPerRequest: z.number().int().min(1).optional(),
      tokensPerMinute: z.number().int().min(1).optional(),
      requestsPerMinute: z.number().int().min(1).optional(),
      toolCallsPerMinute: z.number().int().min(1).optional(),
      costBudgetUSD: z.number().min(0).optional(),
      maxMemoryMB: z.number().int().min(1).optional(),
      cpuCores: z.number().min(0.1).optional(),
      diskQuotaMB: z.number().int().min(16).optional(),
    }).optional(),
    mcpServers: z
      .array(
        z.union([
          z.string().min(1),
          z.object({ name: z.string().min(1) }).passthrough(),
        ])
      )
      .optional(),
    tools: z.array(z.object({
      id: z.string().min(1),
      enabled: z.boolean().optional(),
    })).optional(),
  }).optional(),
  config: z.record(z.unknown()).optional(),
});

export const AgentSpawnResultPayloadSchema = z.object({
  agentId: z.string(),
  externalId: z.string().optional(),
  status: z.enum(["spawning", "ready", "error"]),
  error: z.string().optional(),
});

export const AgentTerminatePayloadSchema = z.object({
  agentId: z.string().min(1),
  force: z.boolean().optional(),
});

export const AgentTerminateResultPayloadSchema = z.object({
  agentId: z.string(),
  success: z.boolean(),
  error: z.string().optional(),
});

export const AgentStatusPayloadSchema = z.object({
  agentId: z.string().optional(),
});

export const AgentInfoSchema = z.object({
  id: z.string(),
  externalId: z.string().optional(),
  name: z.string(),
  state: z.enum(["initializing", "ready", "running", "paused", "error", "terminated"]),
  uptime: z.number(),
  model: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  permissions: z.array(z.string()).optional(),
  trustLevel: TrustLevelSchema.optional(),
  limits: z.object({
    maxTokensPerRequest: z.number().int().min(1).optional(),
    tokensPerMinute: z.number().int().min(1).optional(),
    requestsPerMinute: z.number().int().min(1).optional(),
    toolCallsPerMinute: z.number().int().min(1).optional(),
    costBudgetUSD: z.number().min(0).optional(),
    maxMemoryMB: z.number().int().min(1).optional(),
    cpuCores: z.number().min(0.1).optional(),
    diskQuotaMB: z.number().int().min(16).optional(),
  }).optional(),
  tokenUsage: z.object({
    input: z.number(),
    output: z.number(),
  }).optional(),
});

export const AgentListPayloadSchema = z.object({
  agents: z.array(AgentInfoSchema),
  count: z.number(),
});

export const AgentTaskPayloadSchema = z.object({
  agentId: z.string().min(1),
  task: z.record(z.unknown()),
  internal: z.boolean().optional(),
  internalToken: z.string().optional(),
});

export const AgentTaskResultPayloadSchema = z.object({
  agentId: z.string(),
  status: z.enum(["ok", "error"]),
  result: z.unknown().optional(),
  error: z.string().optional(),
});

// ─── EVENT PAYLOADS ─────────────────────────────────────────

export const SubscribePayloadSchema = z.object({
  channels: z.array(z.string()).min(1),
});

export const UnsubscribePayloadSchema = z.object({
  channels: z.array(z.string()).optional(),
  subscriptionId: z.string().optional(),
});

export const EventPayloadSchema = z.object({
  channel: z.string(),
  type: z.string(),
  data: z.unknown(),
  timestamp: z.number(),
});

// ─── ERROR PAYLOAD ──────────────────────────────────────────

export const ErrorPayloadSchema = z.object({
  code: z.string().optional(),
  message: z.string(),
  details: z.unknown().optional(),
});

// ─── CLIENT CONNECTION ──────────────────────────────────────

export const ClientConnectionSchema = z.object({
  id: z.string(),
  authenticated: z.boolean(),
  agentId: z.string().optional(),
  connectedAt: z.number(),
  subscriptions: z.array(z.string()).optional(),
});

export type ClientConnection = z.infer<typeof ClientConnectionSchema> & {
  ws: unknown; // WebSocket instance (can't be serialized)
};

// ─── SERVER CONFIG ──────────────────────────────────────────

export const WsServerConfigSchema = z.object({
  port: z.number().int().min(1).max(65535),
  host: z.string().min(1),
  authToken: z.string().optional(),
  maxConnections: z.number().int().min(1).optional(),
  heartbeatInterval: z.number().int().min(1000).optional(),
  messageRateLimit: z.number().int().min(1).optional(),
  maxPayloadSize: z.number().int().min(1024).optional(),
});

export type WsServerConfig = z.infer<typeof WsServerConfigSchema>;

// ─── HEALTH STATUS ──────────────────────────────────────────

export const HealthStatusSchema = z.object({
  status: z.enum(["ok", "degraded", "error"]),
  version: z.string(),
  uptime: z.number(),
  providers: z.array(z.string()),
  agents: z.number(),
  connections: z.number(),
  timestamp: z.number(),
});

export type HealthStatus = z.infer<typeof HealthStatusSchema>;

// ─── TYPE EXPORTS ───────────────────────────────────────────

export type AuthPayload = z.infer<typeof AuthPayloadSchema>;
export type AuthSuccessPayload = z.infer<typeof AuthSuccessPayloadSchema>;
export type AuthFailedPayload = z.infer<typeof AuthFailedPayloadSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type ChatPayload = z.infer<typeof ChatPayloadSchema>;
export type ChatResponsePayload = z.infer<typeof ChatResponsePayloadSchema>;
export type ChatStreamPayload = z.infer<typeof ChatStreamPayloadSchema>;
export type AgentSpawnPayload = z.infer<typeof AgentSpawnPayloadSchema>;
export type AgentSpawnResultPayload = z.infer<typeof AgentSpawnResultPayloadSchema>;
export type AgentTerminatePayload = z.infer<typeof AgentTerminatePayloadSchema>;
export type AgentTerminateResultPayload = z.infer<typeof AgentTerminateResultPayloadSchema>;
export type AgentStatusPayload = z.infer<typeof AgentStatusPayloadSchema>;
export type AgentInfo = z.infer<typeof AgentInfoSchema>;
export type AgentListPayload = z.infer<typeof AgentListPayloadSchema>;
export type SubscribePayload = z.infer<typeof SubscribePayloadSchema>;
export type UnsubscribePayload = z.infer<typeof UnsubscribePayloadSchema>;
export type EventPayload = z.infer<typeof EventPayloadSchema>;
export type ErrorPayload = z.infer<typeof ErrorPayloadSchema>;

// Event Types — definitions for the AgentRun event system
// Pub/sub for agent lifecycle, tools, skills, and system events

import { z } from "zod";

// ─── ERROR CLASS ──────────────────────────────────────────────

/** Event error codes */
export type EventErrorCode =
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "PUBLISH_ERROR"
  | "SUBSCRIPTION_ERROR"
  | "WEBHOOK_ERROR"
  | "DELIVERY_ERROR";

/**
 * Error class for event operations.
 */
export class EventError extends Error {
  constructor(
    message: string,
    public readonly code: EventErrorCode,
    public readonly eventId?: string
  ) {
    super(message);
    this.name = "EventError";
  }
}

// ─── BASIC TYPES ──────────────────────────────────────────────

/** Event channel/topic */
export type EventChannel = string;

// ─── ZOD SCHEMAS ──────────────────────────────────────────────

/** Base event schema */
export const BaseEventSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  timestamp: z.date(),
  agentId: z.string().optional(),
  correlationId: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

/** Base event structure */
export interface BaseEvent {
  /** Event ID */
  id: string;
  /** Event type */
  type: string;
  /** Event timestamp */
  timestamp: Date;
  /** Source agent ID (if from an agent) */
  agentId?: string;
  /** Correlation ID for tracing */
  correlationId?: string;
  /** Event metadata */
  metadata?: Record<string, unknown>;
}

// ─── LIFECYCLE EVENTS ──────────────────────────────────────

/** Agent lifecycle event type values */
export const AgentLifecycleTypeSchema = z.enum([
  "agent.created",
  "agent.initializing",
  "agent.ready",
  "agent.running",
  "agent.paused",
  "agent.stopping",
  "agent.terminated",
  "agent.error",
]);

/** Agent lifecycle event data schema */
export const AgentLifecycleDataSchema = z.object({
  state: z.string().optional(),
  previousState: z.string().optional(),
  error: z.string().optional(),
  manifest: z.record(z.unknown()).optional(),
});

/** Agent lifecycle event schema */
export const AgentLifecycleEventSchema = BaseEventSchema.extend({
  channel: z.literal("agent.lifecycle"),
  type: AgentLifecycleTypeSchema,
  agentId: z.string().min(1),
  data: AgentLifecycleDataSchema,
});

/** Agent lifecycle event */
export interface AgentLifecycleEvent extends BaseEvent {
  channel: "agent.lifecycle";
  type:
    | "agent.created"
    | "agent.initializing"
    | "agent.ready"
    | "agent.running"
    | "agent.paused"
    | "agent.stopping"
    | "agent.terminated"
    | "agent.error";
  agentId: string;
  data: {
    state?: string;
    previousState?: string;
    error?: string;
    manifest?: Record<string, unknown>;
  };
}

// ─── TOOL EVENTS ───────────────────────────────────────────

/** Tool event type values */
export const ToolEventTypeSchema = z.enum([
  "tool.registered",
  "tool.unregistered",
  "tool.invocation.start",
  "tool.invocation.complete",
  "tool.invocation.error",
]);

/** Tool event data schema */
export const ToolEventDataSchema = z.object({
  toolId: z.string().min(1),
  arguments: z.record(z.unknown()).optional(),
  result: z.unknown().optional(),
  error: z.string().optional(),
  duration: z.number().optional(),
});

/** Tool event schema */
export const ToolEventSchema = BaseEventSchema.extend({
  channel: z.literal("tool"),
  type: ToolEventTypeSchema,
  data: ToolEventDataSchema,
});

/** Tool execution event */
export interface ToolEvent extends BaseEvent {
  channel: "tool";
  type:
    | "tool.registered"
    | "tool.unregistered"
    | "tool.invocation.start"
    | "tool.invocation.complete"
    | "tool.invocation.error";
  data: {
    toolId: string;
    arguments?: Record<string, unknown>;
    result?: unknown;
    error?: string;
    duration?: number;
  };
}

// ─── SKILL EVENTS ──────────────────────────────────────────

/** Skill event type values */
export const SkillEventTypeSchema = z.enum([
  "skill.installed",
  "skill.activated",
  "skill.deactivated",
  "skill.uninstalled",
  "skill.error",
]);

/** Skill event data schema */
export const SkillEventDataSchema = z.object({
  skillId: z.string().min(1),
  skillName: z.string().optional(),
  version: z.string().optional(),
  error: z.string().optional(),
});

/** Skill event schema */
export const SkillEventSchema = BaseEventSchema.extend({
  channel: z.literal("skill"),
  type: SkillEventTypeSchema,
  data: SkillEventDataSchema,
});

/** Skill lifecycle event */
export interface SkillEvent extends BaseEvent {
  channel: "skill";
  type:
    | "skill.installed"
    | "skill.activated"
    | "skill.deactivated"
    | "skill.uninstalled"
    | "skill.error";
  data: {
    skillId: string;
    skillName?: string;
    version?: string;
    error?: string;
  };
}

// ─── MEMORY EVENTS ─────────────────────────────────────────

/** Memory event type values */
export const MemoryEventTypeSchema = z.enum([
  "memory.episode.stored",
  "memory.episode.retrieved",
  "memory.fact.stored",
  "memory.fact.retrieved",
  "memory.procedure.stored",
  "memory.procedure.executed",
]);

/** Memory event data schema */
export const MemoryEventDataSchema = z.object({
  memoryType: z.enum(["episodic", "semantic", "procedural"]),
  id: z.string().optional(),
  count: z.number().optional(),
});

/** Memory event schema */
export const MemoryEventSchema = BaseEventSchema.extend({
  channel: z.literal("memory"),
  type: MemoryEventTypeSchema,
  data: MemoryEventDataSchema,
});

/** Memory operation event */
export interface MemoryEvent extends BaseEvent {
  channel: "memory";
  type:
    | "memory.episode.stored"
    | "memory.episode.retrieved"
    | "memory.fact.stored"
    | "memory.fact.retrieved"
    | "memory.procedure.stored"
    | "memory.procedure.executed";
  data: {
    memoryType: "episodic" | "semantic" | "procedural";
    id?: string;
    count?: number;
  };
}

// ─── COMMUNICATION EVENTS ──────────────────────────────────

/** Communication event type values */
export const CommunicationEventTypeSchema = z.enum([
  "comm.agent.discovered",
  "comm.agent.connected",
  "comm.agent.disconnected",
  "comm.task.sent",
  "comm.task.received",
  "comm.task.completed",
  "comm.message.received",
]);

/** Communication event data schema */
export const CommunicationEventDataSchema = z.object({
  remoteAgentUrl: z.string().optional(),
  remoteAgentName: z.string().optional(),
  taskId: z.string().optional(),
  messageType: z.string().optional(),
});

/** Communication event schema */
export const CommunicationEventSchema = BaseEventSchema.extend({
  channel: z.literal("communication"),
  type: CommunicationEventTypeSchema,
  data: CommunicationEventDataSchema,
});

/** Agent communication event */
export interface CommunicationEvent extends BaseEvent {
  channel: "communication";
  type:
    | "comm.agent.discovered"
    | "comm.agent.connected"
    | "comm.agent.disconnected"
    | "comm.task.sent"
    | "comm.task.received"
    | "comm.task.completed"
    | "comm.message.received";
  data: {
    remoteAgentUrl?: string;
    remoteAgentName?: string;
    taskId?: string;
    messageType?: string;
  };
}

// ─── SYSTEM EVENTS ─────────────────────────────────────────

/** System event type values */
export const SystemEventTypeSchema = z.enum([
  "system.startup",
  "system.shutdown",
  "system.health.check",
  "system.config.changed",
  "system.error",
  "system.warning",
]);

/** Health status schema */
export const HealthStatusSchema = z.object({
  status: z.enum(["healthy", "degraded", "unhealthy"]),
  components: z.record(z.boolean()),
});

/** System event data schema */
export const SystemEventDataSchema = z.object({
  message: z.string().optional(),
  error: z.string().optional(),
  config: z.record(z.unknown()).optional(),
  health: HealthStatusSchema.optional(),
});

/** System event schema */
export const SystemEventSchema = BaseEventSchema.extend({
  channel: z.literal("system"),
  type: SystemEventTypeSchema,
  data: SystemEventDataSchema,
});

/** System-level event */
export interface SystemEvent extends BaseEvent {
  channel: "system";
  type:
    | "system.startup"
    | "system.shutdown"
    | "system.health.check"
    | "system.config.changed"
    | "system.error"
    | "system.warning";
  data: {
    message?: string;
    error?: string;
    config?: Record<string, unknown>;
    health?: {
      status: "healthy" | "degraded" | "unhealthy";
      components: Record<string, boolean>;
    };
  };
}

// ─── ALERT EVENTS ─────────────────────────────────────────

/** Alert event type values */
export const AlertEventTypeSchema = z.enum([
  "agent.error.threshold",
  "rate_limit.exceeded",
  "budget.exceeded",
  "budget.reached",
]);

/** Alert event data schema */
export const AlertEventDataSchema = z.object({
  message: z.string().optional(),
  error: z.string().optional(),
  limit: z.number().optional(),
  current: z.number().optional(),
  kind: z.string().optional(),
  action: z.string().optional(),
  budget: z.number().optional(),
  spent: z.number().optional(),
  errorCount: z.number().optional(),
  maxErrors: z.number().optional(),
});

/** Alert event schema */
export const AlertEventSchema = BaseEventSchema.extend({
  channel: z.literal("alerts"),
  type: AlertEventTypeSchema,
  data: AlertEventDataSchema,
});

/** Alert event (rate limits, budgets, error thresholds) */
export interface AlertEvent extends BaseEvent {
  channel: "alerts";
  type:
    | "agent.error.threshold"
    | "rate_limit.exceeded"
    | "budget.exceeded"
    | "budget.reached";
  data: {
    message?: string;
    error?: string;
    limit?: number;
    current?: number;
    kind?: string;
    action?: string;
    budget?: number;
    spent?: number;
    errorCount?: number;
    maxErrors?: number;
  };
}

// ─── UNION TYPE ────────────────────────────────────────────

/** All event types */
export type AgentRunEvent =
  | AgentLifecycleEvent
  | ToolEvent
  | SkillEvent
  | MemoryEvent
  | CommunicationEvent
  | SystemEvent
  | AlertEvent;

/** Union schema for all event types (for validation) */
export const AgentRunEventSchema = z.union([
  AgentLifecycleEventSchema,
  ToolEventSchema,
  SkillEventSchema,
  MemoryEventSchema,
  CommunicationEventSchema,
  SystemEventSchema,
  AlertEventSchema,
]);

// ─── SUBSCRIPTION TYPES ────────────────────────────────────

/** Subscription options schema */
export const SubscriptionOptionsSchema = z.object({
  priority: z.number().int().optional(),
  once: z.boolean().optional(),
});

/** Subscription options */
export interface SubscriptionOptions {
  /** Priority (higher runs first) */
  priority?: number;
  /** Unsubscribe after first event */
  once?: boolean;
  /** Filter function */
  filter?: (event: AgentRunEvent) => boolean;
}

/** Event handler function */
export type EventHandler = (event: AgentRunEvent) => void | Promise<void>;

/** Event subscription */
export interface EventSubscription {
  /** Subscription ID */
  id: string;
  /** Channel pattern (supports wildcards: "agent.*", "tool.invocation.*") */
  channelPattern: string;
  /** Event type pattern (optional) */
  typePattern?: string;
  /** Filter function */
  filter?: (event: AgentRunEvent) => boolean;
  /** Handler function */
  handler: EventHandler;
  /** Priority (higher runs first) */
  priority?: number;
  /** Whether to unsubscribe after first event */
  once?: boolean;
}

// ─── WEBHOOK TYPES ─────────────────────────────────────────

/** Retry configuration schema */
export const WebhookRetrySchema = z.object({
  maxAttempts: z.number().int().min(1).max(10),
  backoffMs: z.number().int().min(100),
});

/** Webhook configuration schema */
export const WebhookConfigSchema = z.object({
  id: z.string().min(1),
  url: z.string().url(),
  channels: z.array(z.string()).min(1),
  eventTypes: z.array(z.string()).optional(),
  method: z.enum(["POST", "PUT"]).optional(),
  headers: z.record(z.string()).optional(),
  secret: z.string().optional(),
  enabled: z.boolean(),
  retry: WebhookRetrySchema.optional(),
});

/** Webhook configuration */
export interface WebhookConfig {
  /** Webhook ID */
  id: string;
  /** Destination URL */
  url: string;
  /** Channel patterns to send */
  channels: string[];
  /** Event type patterns to send */
  eventTypes?: string[];
  /** HTTP method */
  method?: "POST" | "PUT";
  /** Custom headers */
  headers?: Record<string, string>;
  /** Secret for signing payloads */
  secret?: string;
  /** Whether webhook is active */
  enabled: boolean;
  /** Retry configuration */
  retry?: {
    maxAttempts: number;
    backoffMs: number;
  };
}

/** Webhook delivery result schema */
export const WebhookDeliveryResultSchema = z.object({
  webhookId: z.string(),
  eventId: z.string(),
  success: z.boolean(),
  statusCode: z.number().optional(),
  error: z.string().optional(),
  attempts: z.number().int().min(0),
  deliveredAt: z.date().optional(),
});

/** Webhook delivery result */
export interface WebhookDeliveryResult {
  webhookId: string;
  eventId: string;
  success: boolean;
  statusCode?: number;
  error?: string;
  attempts: number;
  deliveredAt?: Date;
}

// ─── EVENT BUS TYPES ───────────────────────────────────────

/** Event bus statistics schema */
export const EventBusStatsSchema = z.object({
  totalEventsPublished: z.number().int().min(0),
  totalSubscriptions: z.number().int().min(0),
  channelCounts: z.record(z.number().int().min(0)),
  lastEventAt: z.date().optional(),
});

/** Event bus statistics */
export interface EventBusStats {
  totalEventsPublished: number;
  totalSubscriptions: number;
  channelCounts: Record<string, number>;
  lastEventAt?: Date;
}

/** Event history entry schema */
export const EventHistoryEntrySchema = z.object({
  event: AgentRunEventSchema,
  deliveredTo: z.array(z.string()),
  timestamp: z.date(),
});

/** Event history entry */
export interface EventHistoryEntry {
  event: AgentRunEvent;
  deliveredTo: string[];
  timestamp: Date;
}

// ─── HISTORY QUERY OPTIONS ─────────────────────────────────

/** History query options schema */
export const HistoryQueryOptionsSchema = z.object({
  channel: z.string().optional(),
  eventType: z.string().optional(),
  limit: z.number().int().min(1).optional(),
  since: z.date().optional(),
});

/** History query options */
export interface HistoryQueryOptions {
  channel?: string;
  eventType?: string;
  limit?: number;
  since?: Date;
}

/** Replay options schema */
export const ReplayOptionsSchema = z.object({
  since: z.date().optional(),
  eventTypes: z.array(z.string()).optional(),
});

/** Replay options */
export interface ReplayOptions {
  since?: Date;
  eventTypes?: string[];
}

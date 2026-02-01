// Event Types — definitions for the Agent OS event system
// Pub/sub for agent lifecycle, tools, skills, and system events

import { z } from "zod";

/** Event channel/topic */
export type EventChannel = string;

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

// ─── UNION TYPE ────────────────────────────────────────────

/** All event types */
export type AgentOSEvent =
  | AgentLifecycleEvent
  | ToolEvent
  | SkillEvent
  | MemoryEvent
  | CommunicationEvent
  | SystemEvent;

// ─── SUBSCRIPTION TYPES ────────────────────────────────────

/** Event subscription */
export interface EventSubscription {
  /** Subscription ID */
  id: string;
  /** Channel pattern (supports wildcards: "agent.*", "tool.invocation.*") */
  channelPattern: string;
  /** Event type pattern (optional) */
  typePattern?: string;
  /** Filter function */
  filter?: (event: AgentOSEvent) => boolean;
  /** Handler function */
  handler: EventHandler;
  /** Priority (higher runs first) */
  priority?: number;
  /** Whether to unsubscribe after first event */
  once?: boolean;
}

/** Event handler function */
export type EventHandler = (event: AgentOSEvent) => void | Promise<void>;

/** Subscription options */
export interface SubscriptionOptions {
  /** Priority (higher runs first) */
  priority?: number;
  /** Unsubscribe after first event */
  once?: boolean;
  /** Filter function */
  filter?: (event: AgentOSEvent) => boolean;
}

// ─── WEBHOOK TYPES ─────────────────────────────────────────

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

/** Event bus statistics */
export interface EventBusStats {
  totalEventsPublished: number;
  totalSubscriptions: number;
  channelCounts: Record<string, number>;
  lastEventAt?: Date;
}

/** Event history entry */
export interface EventHistoryEntry {
  event: AgentOSEvent;
  deliveredTo: string[];
  timestamp: Date;
}

// ─── ZOD SCHEMAS ───────────────────────────────────────────

export const BaseEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  timestamp: z.date(),
  agentId: z.string().optional(),
  correlationId: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const WebhookConfigSchema = z.object({
  id: z.string(),
  url: z.string().url(),
  channels: z.array(z.string()),
  eventTypes: z.array(z.string()).optional(),
  method: z.enum(["POST", "PUT"]).optional(),
  headers: z.record(z.string()).optional(),
  secret: z.string().optional(),
  enabled: z.boolean(),
  retry: z
    .object({
      maxAttempts: z.number().min(1).max(10),
      backoffMs: z.number().min(100),
    })
    .optional(),
});

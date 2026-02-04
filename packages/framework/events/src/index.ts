// @agentrun/events — Event System (Layer 4: Framework)
// Pub/sub for agent lifecycle, tools, skills, and system events

// Error class
export { EventError } from "./types.js";
export type { EventErrorCode } from "./types.js";

// Types
export type {
  EventChannel,
  BaseEvent,
  AgentLifecycleEvent,
  ToolEvent,
  SkillEvent,
  MemoryEvent,
  CommunicationEvent,
  SystemEvent,
  AlertEvent,
  AgentRunEvent,
  EventSubscription,
  EventHandler,
  SubscriptionOptions,
  WebhookConfig,
  WebhookDeliveryResult,
  EventBusStats,
  EventHistoryEntry,
  HistoryQueryOptions,
  ReplayOptions,
} from "./types.js";

// Zod Schemas
export {
  // Base
  BaseEventSchema,
  // Lifecycle events
  AgentLifecycleTypeSchema,
  AgentLifecycleDataSchema,
  AgentLifecycleEventSchema,
  // Tool events
  ToolEventTypeSchema,
  ToolEventDataSchema,
  ToolEventSchema,
  // Skill events
  SkillEventTypeSchema,
  SkillEventDataSchema,
  SkillEventSchema,
  // Memory events
  MemoryEventTypeSchema,
  MemoryEventDataSchema,
  MemoryEventSchema,
  // Communication events
  CommunicationEventTypeSchema,
  CommunicationEventDataSchema,
  CommunicationEventSchema,
  // System events
  SystemEventTypeSchema,
  HealthStatusSchema,
  SystemEventDataSchema,
  SystemEventSchema,
  // Alert events
  AlertEventTypeSchema,
  AlertEventDataSchema,
  AlertEventSchema,
  // Union schema
  AgentRunEventSchema,
  // Subscription schemas
  SubscriptionOptionsSchema,
  // Webhook schemas
  WebhookRetrySchema,
  WebhookConfigSchema,
  WebhookDeliveryResultSchema,
  // Stats schemas
  EventBusStatsSchema,
  EventHistoryEntrySchema,
  // Query schemas
  HistoryQueryOptionsSchema,
  ReplayOptionsSchema,
} from "./types.js";

// Event Bus
export { EventBus, createEventBus } from "./bus.js";

// Webhooks
export { WebhookManager, createWebhookManager } from "./webhooks.js";

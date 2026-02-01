// @agent-os/events — Event System (Layer 4: Framework)
// Pub/sub for agent lifecycle, tools, skills, and system events

console.log("✅ @agent-os/events loaded");

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
  AgentOSEvent,
  EventSubscription,
  EventHandler,
  SubscriptionOptions,
  WebhookConfig,
  WebhookDeliveryResult,
  EventBusStats,
  EventHistoryEntry,
} from "./types.js";

export { BaseEventSchema, WebhookConfigSchema } from "./types.js";

// Event Bus
export { EventBus, createEventBus } from "./bus.js";

// Webhooks
export { WebhookManager, createWebhookManager } from "./webhooks.js";

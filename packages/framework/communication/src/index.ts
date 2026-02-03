// @agent-os/communication — Agent-to-Agent Communication (Layer 4: Framework)
// Enables agents to discover and communicate with each other via A2A protocol

// ─── Types ──────────────────────────────────────────────────
export type {
  A2AAgentCard,
  A2ACapabilities,
  A2AAuthentication,
  A2AInputMode,
  A2AOutputMode,
  A2ASkill,
  A2ATask,
  A2ATaskStatus,
  A2ATaskState,
  A2AMessage,
  A2AMessagePart,
  A2ATextPart,
  A2AFilePart,
  A2ADataPart,
  A2AArtifact,
  A2ARequest,
  A2AResponse,
  A2AError,
  A2AMethod,
  A2ASSEEvent,
  AgentRegistryEntry,
  TaskDelegationRequest,
  TaskDelegationResult,
  CommunicationEvent,
  CommunicationErrorCode,
} from "./types.js";

// ─── Error Class ─────────────────────────────────────────────
export { CommunicationError } from "./types.js";

// ─── Zod Schemas ─────────────────────────────────────────────
export {
  // Input/Output modes
  A2AInputModeSchema,
  A2AOutputModeSchema,
  // Capabilities
  A2ACapabilitiesSchema,
  // Authentication
  A2AAuthSchemeSchema,
  A2AOAuth2ConfigSchema,
  A2AAuthenticationSchema,
  // Skills
  A2ASkillSchema,
  // Provider
  A2AProviderSchema,
  // Agent Card
  A2AAgentCardSchema,
  // Task state/status
  A2ATaskStateSchema,
  A2ATaskStatusSchema,
  // Message parts
  A2ATextPartSchema,
  A2AFilePartSchema,
  A2ADataPartSchema,
  A2AMessagePartSchema,
  A2AMessageRoleSchema,
  A2AMessageSchema,
  // Artifact
  A2AArtifactSchema,
  // Task
  A2ATaskSchema,
  // JSON-RPC
  A2AMethodSchema,
  A2AErrorSchema,
  A2ARequestSchema,
  A2AResponseSchema,
  // SSE
  A2ASSEEventTypeSchema,
  A2ASSEEventSchema,
  // Registry entry
  AgentRegistryEntrySchema,
  // Task delegation
  TaskDelegationRequestSchema,
  TaskDelegationResultSchema,
  // Communication event
  CommunicationEventTypeSchema,
  CommunicationEventSchema,
  // Input validation
  TaskSendParamsSchema,
  TaskSendParamsWithReplayProtectionSchema,
  RegisterLocalInputSchema,
  DiscoverAgentInputSchema,
} from "./types.js";

// ─── Agent Registry ──────────────────────────────────────────
export { AgentRegistry, createAgentRegistry } from "./agent-registry.js";

// ─── A2A Client ──────────────────────────────────────────────
export {
  A2AClient,
  createA2AClient,
  type A2AClientConfig,
} from "./a2a-client.js";

// ─── A2A Server ──────────────────────────────────────────────
export {
  A2AServer,
  createA2AServer,
  type TaskHandler,
  type TaskHandlerResult,
  type A2AServerConfig,
  type ReplayProtectionConfig,
} from "./a2a-server.js";

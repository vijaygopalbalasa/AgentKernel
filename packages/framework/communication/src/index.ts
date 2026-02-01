// @agent-os/communication — Agent-to-Agent Communication (Layer 4: Framework)
// Enables agents to discover and communicate with each other via A2A protocol

console.log("✅ @agent-os/communication loaded");

// Types
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
} from "./types.js";

export {
  A2ATextPartSchema,
  A2AFilePartSchema,
  A2ADataPartSchema,
  A2AMessagePartSchema,
  A2AMessageSchema,
  TaskSendParamsSchema,
} from "./types.js";

// Agent Registry
export { AgentRegistry, createAgentRegistry } from "./agent-registry.js";

// A2A Client
export { A2AClient, createA2AClient } from "./a2a-client.js";

// A2A Server
export {
  A2AServer,
  createA2AServer,
  type TaskHandler,
  type TaskHandlerResult,
  type A2AServerConfig,
} from "./a2a-server.js";

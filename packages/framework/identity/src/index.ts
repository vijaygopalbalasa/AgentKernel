// @agent-os/identity — Agent Identity System (Layer 4: Framework)
// DIDs, Agent Cards (A2A Protocol), registration

console.log("✅ @agent-os/identity loaded");

// Agent Card (A2A Protocol)
export {
  type AgentCard,
  type AgentCardInput,
  type AgentSkill,
  type AgentEndpoint,
  type AuthConfig,
  type AuthScheme,
  type Modality,
  A2A_PROTOCOL_VERSION,
  createAgentCard,
  validateAgentCard,
  serializeAgentCard,
  parseAgentCard,
  getWellKnownPath,
} from "./agent-card.js";

// Identity Manager
export {
  IdentityManager,
  type AgentIdentity,
  type IdentityManagerOptions,
  type RegistrationResult,
} from "./identity-manager.js";

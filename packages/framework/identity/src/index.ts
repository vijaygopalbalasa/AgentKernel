// @agent-os/identity — Agent Identity System (Layer 4: Framework)
// DIDs, Agent Cards (A2A Protocol), registration

// ─── Agent Card (A2A Protocol) ───────────────────────────────

export {
  // Types
  type AgentCard,
  type AgentCardInput,
  type AgentSkill,
  type AgentEndpoint,
  type AuthConfig,
  type AuthScheme,
  type Modality,
  type ProviderInfo,
  // Zod Schemas
  AgentCardSchema,
  AgentCardInputSchema,
  AgentSkillSchema,
  AgentEndpointSchema,
  AuthConfigSchema,
  AuthSchemeSchema,
  ModalitySchema,
  ProviderInfoSchema,
  // Constants
  A2A_PROTOCOL_VERSION,
  // Functions
  createAgentCard,
  validateAgentCard,
  serializeAgentCard,
  parseAgentCard,
  getWellKnownPath,
  // Error class
  AgentCardError,
} from "./agent-card.js";

// ─── Identity Manager ────────────────────────────────────────

export {
  // Main class
  IdentityManager,
  createIdentityManager,
  // Types
  type AgentIdentity,
  type IdentityManagerOptions,
  type RegistrationResult,
  type DIDMethod,
  // Zod Schemas
  AgentIdentitySchema,
  IdentityManagerOptionsSchema,
  DIDMethodSchema,
  // Error class
  IdentityError,
  // Storage interface
  type IdentityStorage,
  InMemoryIdentityStorage,
} from "./identity-manager.js";

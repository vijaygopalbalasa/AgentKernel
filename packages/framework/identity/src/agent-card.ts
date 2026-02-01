// Agent Card — A2A Protocol compliant agent metadata
// Published at /.well-known/agent.json for discovery
// Based on: https://a2a-protocol.org/latest/specification/

/** Supported authentication schemes */
export type AuthScheme = "none" | "api_key" | "oauth2" | "jwt" | "mtls";

/** Supported input/output modalities */
export type Modality = "text" | "image" | "audio" | "video" | "file";

/** Agent skill definition */
export interface AgentSkill {
  /** Unique skill identifier */
  id: string;
  /** Human-readable skill name */
  name: string;
  /** Description of what this skill does */
  description: string;
  /** Input modalities this skill accepts */
  inputModes?: Modality[];
  /** Output modalities this skill produces */
  outputModes?: Modality[];
  /** Example prompts that trigger this skill */
  examples?: string[];
  /** Tags for categorization */
  tags?: string[];
}

/** Authentication configuration */
export interface AuthConfig {
  /** Authentication scheme */
  scheme: AuthScheme;
  /** OAuth2 configuration (if scheme is oauth2) */
  oauth2?: {
    authorizationUrl: string;
    tokenUrl: string;
    scopes: string[];
  };
  /** API key header name (if scheme is api_key) */
  apiKeyHeader?: string;
}

/** Agent service endpoint */
export interface AgentEndpoint {
  /** Base URL for the agent's A2A server */
  url: string;
  /** Supported protocols */
  protocols: Array<"http" | "https" | "grpc" | "websocket">;
  /** Whether streaming (SSE) is supported */
  streaming?: boolean;
}

/**
 * Agent Card — A2A Protocol compliant metadata document.
 *
 * Every agent publishes this at `/.well-known/agent.json`
 * for discovery by other agents and systems.
 */
export interface AgentCard {
  /** A2A protocol version */
  protocolVersion: string;

  /** Unique agent identifier (DID or URI) */
  id: string;

  /** Human-readable agent name */
  name: string;

  /** Agent description */
  description: string;

  /** Agent version */
  version: string;

  /** Service endpoint configuration */
  endpoint: AgentEndpoint;

  /** Authentication requirements */
  auth: AuthConfig;

  /** Skills/capabilities this agent provides */
  skills: AgentSkill[];

  /** Supported input modalities */
  inputModes: Modality[];

  /** Supported output modalities */
  outputModes: Modality[];

  /** Agent owner/organization */
  provider?: {
    name: string;
    url?: string;
    contact?: string;
  };

  /** Tags for discovery */
  tags?: string[];

  /** When this card was last updated */
  updatedAt: string;

  /** Optional digital signature (JWS) */
  signature?: string;

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/** Minimal Agent Card for registration */
export interface AgentCardInput {
  name: string;
  description: string;
  version?: string;
  endpoint?: Partial<AgentEndpoint>;
  auth?: Partial<AuthConfig>;
  skills?: AgentSkill[];
  inputModes?: Modality[];
  outputModes?: Modality[];
  provider?: AgentCard["provider"];
  tags?: string[];
}

/** Current A2A protocol version we support */
export const A2A_PROTOCOL_VERSION = "0.3";

/**
 * Create a complete Agent Card from minimal input.
 */
export function createAgentCard(
  id: string,
  input: AgentCardInput,
  baseUrl: string = "http://localhost:18800"
): AgentCard {
  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    id,
    name: input.name,
    description: input.description,
    version: input.version ?? "1.0.0",
    endpoint: {
      url: input.endpoint?.url ?? `${baseUrl}/a2a/${id}`,
      protocols: input.endpoint?.protocols ?? ["https"],
      streaming: input.endpoint?.streaming ?? true,
    },
    auth: {
      scheme: input.auth?.scheme ?? "none",
      ...input.auth,
    },
    skills: input.skills ?? [],
    inputModes: input.inputModes ?? ["text"],
    outputModes: input.outputModes ?? ["text"],
    provider: input.provider,
    tags: input.tags,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Validate an Agent Card structure.
 */
export function validateAgentCard(card: unknown): card is AgentCard {
  if (!card || typeof card !== "object") return false;

  const c = card as Record<string, unknown>;

  // Required fields
  if (typeof c.id !== "string" || !c.id) return false;
  if (typeof c.name !== "string" || !c.name) return false;
  if (typeof c.description !== "string") return false;
  if (typeof c.protocolVersion !== "string") return false;
  if (!c.endpoint || typeof c.endpoint !== "object") return false;
  if (!c.auth || typeof c.auth !== "object") return false;
  if (!Array.isArray(c.skills)) return false;
  if (!Array.isArray(c.inputModes)) return false;
  if (!Array.isArray(c.outputModes)) return false;

  return true;
}

/**
 * Generate the well-known path for an agent card.
 */
export function getWellKnownPath(agentId?: string): string {
  if (agentId) {
    return `/.well-known/agents/${agentId}.json`;
  }
  return "/.well-known/agent.json";
}

/**
 * Serialize Agent Card to JSON for publishing.
 */
export function serializeAgentCard(card: AgentCard): string {
  return JSON.stringify(card, null, 2);
}

/**
 * Parse Agent Card from JSON.
 */
export function parseAgentCard(json: string): AgentCard | null {
  try {
    const parsed = JSON.parse(json);
    if (validateAgentCard(parsed)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

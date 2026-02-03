// Agent Card — A2A Protocol compliant agent metadata
// Published at /.well-known/agent.json for discovery
// Based on: https://a2a-protocol.org/latest/specification/

import { z } from "zod";
import { type Result, ok, err } from "@agent-os/shared";

/** Supported authentication schemes */
export const AuthSchemeSchema = z.enum(["none", "api_key", "oauth2", "jwt", "mtls"]);
export type AuthScheme = z.infer<typeof AuthSchemeSchema>;

/** Supported input/output modalities */
export const ModalitySchema = z.enum(["text", "image", "audio", "video", "file"]);
export type Modality = z.infer<typeof ModalitySchema>;

/** Agent skill definition */
export const AgentSkillSchema = z.object({
  /** Unique skill identifier */
  id: z.string().min(1),
  /** Human-readable skill name */
  name: z.string().min(1),
  /** Description of what this skill does */
  description: z.string(),
  /** Input modalities this skill accepts */
  inputModes: z.array(ModalitySchema).optional(),
  /** Output modalities this skill produces */
  outputModes: z.array(ModalitySchema).optional(),
  /** Example prompts that trigger this skill */
  examples: z.array(z.string()).optional(),
  /** Tags for categorization */
  tags: z.array(z.string()).optional(),
});
export type AgentSkill = z.infer<typeof AgentSkillSchema>;

/** Authentication configuration */
export const AuthConfigSchema = z.object({
  /** Authentication scheme */
  scheme: AuthSchemeSchema,
  /** OAuth2 configuration (if scheme is oauth2) */
  oauth2: z
    .object({
      authorizationUrl: z.string().url(),
      tokenUrl: z.string().url(),
      scopes: z.array(z.string()),
    })
    .optional(),
  /** API key header name (if scheme is api_key) */
  apiKeyHeader: z.string().optional(),
});
export type AuthConfig = z.infer<typeof AuthConfigSchema>;

/** Agent service endpoint */
export const AgentEndpointSchema = z.object({
  /** Base URL for the agent's A2A server */
  url: z.string().url(),
  /** Supported protocols */
  protocols: z.array(z.enum(["http", "https", "grpc", "websocket"])),
  /** Whether streaming (SSE) is supported */
  streaming: z.boolean().optional(),
});
export type AgentEndpoint = z.infer<typeof AgentEndpointSchema>;

/** Provider info */
export const ProviderInfoSchema = z.object({
  name: z.string().min(1),
  url: z.string().url().optional(),
  contact: z.string().optional(),
});
export type ProviderInfo = z.infer<typeof ProviderInfoSchema>;

/**
 * Agent Card — A2A Protocol compliant metadata document.
 *
 * Every agent publishes this at `/.well-known/agent.json`
 * for discovery by other agents and systems.
 */
export const AgentCardSchema = z.object({
  /** A2A protocol version */
  protocolVersion: z.string(),
  /** Unique agent identifier (DID or URI) */
  id: z.string().min(1),
  /** Human-readable agent name */
  name: z.string().min(1),
  /** Agent description */
  description: z.string(),
  /** Agent version */
  version: z.string(),
  /** Service endpoint configuration */
  endpoint: AgentEndpointSchema,
  /** Authentication requirements */
  auth: AuthConfigSchema,
  /** Skills/capabilities this agent provides */
  skills: z.array(AgentSkillSchema),
  /** Supported input modalities */
  inputModes: z.array(ModalitySchema),
  /** Supported output modalities */
  outputModes: z.array(ModalitySchema),
  /** Agent owner/organization */
  provider: ProviderInfoSchema.optional(),
  /** Tags for discovery */
  tags: z.array(z.string()).optional(),
  /** When this card was last updated */
  updatedAt: z.string().datetime(),
  /** Optional digital signature (JWS) */
  signature: z.string().optional(),
  /** Additional metadata */
  metadata: z.record(z.unknown()).optional(),
});
export type AgentCard = z.infer<typeof AgentCardSchema>;

/** Minimal Agent Card input for registration */
export const AgentCardInputSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  version: z.string().optional(),
  endpoint: AgentEndpointSchema.partial().optional(),
  auth: AuthConfigSchema.partial().optional(),
  skills: z.array(AgentSkillSchema).optional(),
  inputModes: z.array(ModalitySchema).optional(),
  outputModes: z.array(ModalitySchema).optional(),
  provider: ProviderInfoSchema.optional(),
  tags: z.array(z.string()).optional(),
});
export type AgentCardInput = z.infer<typeof AgentCardInputSchema>;

/** Current A2A protocol version we support */
export const A2A_PROTOCOL_VERSION = "0.3";

/** Error types for agent card operations */
export class AgentCardError extends Error {
  constructor(
    message: string,
    public readonly code: "VALIDATION_ERROR" | "PARSE_ERROR" | "NOT_FOUND"
  ) {
    super(message);
    this.name = "AgentCardError";
  }
}

/**
 * Create a complete Agent Card from minimal input.
 */
export function createAgentCard(
  id: string,
  input: AgentCardInput,
  baseUrl: string = "http://localhost:18800"
): Result<AgentCard, AgentCardError> {
  // Validate input
  const inputResult = AgentCardInputSchema.safeParse(input);
  if (!inputResult.success) {
    return err(
      new AgentCardError(
        `Invalid input: ${inputResult.error.message}`,
        "VALIDATION_ERROR"
      )
    );
  }

  const validInput = inputResult.data;

  // Construct the full card
  const card: AgentCard = {
    protocolVersion: A2A_PROTOCOL_VERSION,
    id,
    name: validInput.name,
    description: validInput.description,
    version: validInput.version ?? "1.0.0",
    endpoint: {
      url: validInput.endpoint?.url ?? `${baseUrl}/a2a/${id}`,
      protocols: validInput.endpoint?.protocols ?? ["https"],
      streaming: validInput.endpoint?.streaming ?? true,
    },
    auth: {
      scheme: validInput.auth?.scheme ?? "none",
      oauth2: validInput.auth?.oauth2,
      apiKeyHeader: validInput.auth?.apiKeyHeader,
    },
    skills: validInput.skills ?? [],
    inputModes: validInput.inputModes ?? ["text"],
    outputModes: validInput.outputModes ?? ["text"],
    provider: validInput.provider,
    tags: validInput.tags,
    updatedAt: new Date().toISOString(),
  };

  // Validate the complete card
  const cardResult = AgentCardSchema.safeParse(card);
  if (!cardResult.success) {
    return err(
      new AgentCardError(
        `Generated invalid card: ${cardResult.error.message}`,
        "VALIDATION_ERROR"
      )
    );
  }

  return ok(cardResult.data);
}

/**
 * Validate an Agent Card structure.
 */
export function validateAgentCard(card: unknown): Result<AgentCard, AgentCardError> {
  const result = AgentCardSchema.safeParse(card);
  if (!result.success) {
    return err(
      new AgentCardError(
        `Invalid agent card: ${result.error.message}`,
        "VALIDATION_ERROR"
      )
    );
  }
  return ok(result.data);
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
export function parseAgentCard(json: string): Result<AgentCard, AgentCardError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    return err(
      new AgentCardError(
        `Failed to parse JSON: ${e instanceof Error ? e.message : String(e)}`,
        "PARSE_ERROR"
      )
    );
  }
  return validateAgentCard(parsed);
}

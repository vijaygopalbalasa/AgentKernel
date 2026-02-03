// Identity Manager — agent registration, DIDs, and Agent Card management
// Like Android's AccountManager but for AI agents

import { randomUUID, createHash } from "crypto";
import { z } from "zod";
import { type Result, ok, err } from "@agent-os/shared";
import { type Logger, createLogger } from "@agent-os/kernel";
import {
  type AgentCard,
  type AgentCardInput,
  type AgentSkill,
  AgentCardInputSchema,
  AgentSkillSchema,
  createAgentCard,
  serializeAgentCard,
  AgentCardError,
} from "./agent-card.js";

// ─── Zod Schemas ─────────────────────────────────────────────

/** DID methods we support */
export const DIDMethodSchema = z.enum(["key", "web", "agentos"]);
export type DIDMethod = z.infer<typeof DIDMethodSchema>;

/** Agent identity record schema */
export const AgentIdentitySchema = z.object({
  /** Decentralized Identifier (DID) */
  did: z.string().min(1),
  /** Short ID for internal use */
  shortId: z.string().min(1),
  /** Agent Card (A2A metadata) */
  card: z.custom<AgentCard>((val) => typeof val === "object" && val !== null),
  /** When the identity was created */
  createdAt: z.date(),
  /** When the identity was last updated */
  updatedAt: z.date(),
  /** Whether this identity is active */
  active: z.boolean(),
  /** Public key for verification (if using signatures) */
  publicKey: z.string().optional(),
  /** Secret key hash (for ownership verification) */
  secretKeyHash: z.string().optional(),
});
export type AgentIdentity = z.infer<typeof AgentIdentitySchema>;

/** Options for identity manager */
export const IdentityManagerOptionsSchema = z.object({
  /** Base URL for agent endpoints */
  baseUrl: z.string().url().optional(),
  /** DID method to use */
  didMethod: DIDMethodSchema.optional(),
  /** Domain for did:web method */
  domain: z.string().optional(),
});
export type IdentityManagerOptions = z.infer<typeof IdentityManagerOptionsSchema>;

/** Result of agent registration */
export interface RegistrationResult {
  identity: AgentIdentity;
  /** Secret key (only returned once at registration) */
  secretKey: string;
}

// ─── Error Types ─────────────────────────────────────────────

export class IdentityError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "NOT_FOUND"
      | "ALREADY_EXISTS"
      | "UNAUTHORIZED"
      | "VALIDATION_ERROR"
      | "STORAGE_ERROR"
  ) {
    super(message);
    this.name = "IdentityError";
  }
}

// ─── Persistence Interface ───────────────────────────────────

/** Storage interface for identity persistence */
export interface IdentityStorage {
  save(identity: AgentIdentity): Promise<void>;
  load(shortId: string): Promise<AgentIdentity | null>;
  loadByDID(did: string): Promise<AgentIdentity | null>;
  delete(shortId: string): Promise<void>;
  list(): Promise<AgentIdentity[]>;
}

/** In-memory storage implementation */
export class InMemoryIdentityStorage implements IdentityStorage {
  private identities: Map<string, AgentIdentity> = new Map();
  private didIndex: Map<string, string> = new Map(); // DID -> shortId

  async save(identity: AgentIdentity): Promise<void> {
    this.identities.set(identity.shortId, identity);
    this.didIndex.set(identity.did, identity.shortId);
  }

  async load(shortId: string): Promise<AgentIdentity | null> {
    return this.identities.get(shortId) ?? null;
  }

  async loadByDID(did: string): Promise<AgentIdentity | null> {
    const shortId = this.didIndex.get(did);
    if (!shortId) return null;
    return this.identities.get(shortId) ?? null;
  }

  async delete(shortId: string): Promise<void> {
    const identity = this.identities.get(shortId);
    if (identity) {
      this.didIndex.delete(identity.did);
      this.identities.delete(shortId);
    }
  }

  async list(): Promise<AgentIdentity[]> {
    return Array.from(this.identities.values());
  }

  /** Clear all identities (for testing) */
  clear(): void {
    this.identities.clear();
    this.didIndex.clear();
  }
}

// ─── Identity Manager ────────────────────────────────────────

/**
 * Identity Manager — handles agent registration and identity.
 *
 * Responsibilities:
 * - Generate DIDs for agents
 * - Create and store Agent Cards
 * - Manage agent lifecycle (activate/deactivate)
 * - Verify agent ownership
 */
export class IdentityManager {
  private storage: IdentityStorage;
  private options: Required<IdentityManagerOptions>;
  private log: Logger;

  constructor(
    options: IdentityManagerOptions = {},
    storage?: IdentityStorage
  ) {
    // Validate and set options
    const validatedOptions = IdentityManagerOptionsSchema.safeParse(options);
    if (!validatedOptions.success) {
      throw new IdentityError(
        `Invalid options: ${validatedOptions.error.message}`,
        "VALIDATION_ERROR"
      );
    }

    this.options = {
      baseUrl: options.baseUrl ?? "http://localhost:18800",
      didMethod: options.didMethod ?? "agentos",
      domain: options.domain ?? "localhost",
    };

    this.storage = storage ?? new InMemoryIdentityStorage();
    this.log = createLogger({ name: "identity-manager" });
  }

  /**
   * Register a new agent identity.
   * Returns the identity and a secret key (save this — it's only shown once).
   */
  async register(input: AgentCardInput): Promise<Result<RegistrationResult, IdentityError>> {
    // Validate input
    const inputResult = AgentCardInputSchema.safeParse(input);
    if (!inputResult.success) {
      return err(
        new IdentityError(
          `Invalid input: ${inputResult.error.message}`,
          "VALIDATION_ERROR"
        )
      );
    }

    // Generate short ID
    const shortId = `agent-${randomUUID().slice(0, 8)}`;

    // Generate DID based on method
    const did = this.generateDID(shortId);

    // Generate secret key for ownership verification
    const secretKey = `sk-${randomUUID()}`;
    const secretKeyHash = this.hashSecret(secretKey);

    // Create Agent Card
    const cardResult = createAgentCard(did, inputResult.data, this.options.baseUrl);
    if (!cardResult.ok) {
      return err(
        new IdentityError(cardResult.error.message, "VALIDATION_ERROR")
      );
    }

    // Create identity record
    const identity: AgentIdentity = {
      did,
      shortId,
      card: cardResult.value,
      createdAt: new Date(),
      updatedAt: new Date(),
      active: true,
      secretKeyHash,
    };

    // Store identity
    try {
      await this.storage.save(identity);
    } catch (e) {
      this.log.error("Failed to save identity", {
        shortId,
        error: e instanceof Error ? e.message : String(e),
      });
      return err(
        new IdentityError(
          `Failed to save identity: ${e instanceof Error ? e.message : String(e)}`,
          "STORAGE_ERROR"
        )
      );
    }

    this.log.info("Agent registered", { shortId, did, name: input.name });
    return ok({ identity, secretKey });
  }

  /**
   * Get identity by short ID.
   */
  async getById(shortId: string): Promise<Result<AgentIdentity, IdentityError>> {
    const identity = await this.storage.load(shortId);
    if (!identity) {
      return err(new IdentityError(`Identity not found: ${shortId}`, "NOT_FOUND"));
    }
    return ok(identity);
  }

  /**
   * Get identity by DID.
   */
  async getByDID(did: string): Promise<Result<AgentIdentity, IdentityError>> {
    const identity = await this.storage.loadByDID(did);
    if (!identity) {
      return err(new IdentityError(`Identity not found for DID: ${did}`, "NOT_FOUND"));
    }
    return ok(identity);
  }

  /**
   * Get Agent Card by ID (for A2A discovery).
   */
  async getAgentCard(idOrDid: string): Promise<Result<AgentCard, IdentityError>> {
    const byIdResult = await this.storage.load(idOrDid);
    const identity = byIdResult ?? (await this.storage.loadByDID(idOrDid));

    if (!identity) {
      return err(new IdentityError(`Agent not found: ${idOrDid}`, "NOT_FOUND"));
    }
    if (!identity.active) {
      return err(new IdentityError(`Agent is inactive: ${idOrDid}`, "NOT_FOUND"));
    }
    return ok(identity.card);
  }

  /**
   * Update an agent's card.
   * Requires secret key for verification.
   */
  async updateCard(
    shortId: string,
    secretKey: string,
    updates: Partial<AgentCardInput>
  ): Promise<Result<AgentCard, IdentityError>> {
    const identity = await this.storage.load(shortId);
    if (!identity) {
      return err(new IdentityError(`Identity not found: ${shortId}`, "NOT_FOUND"));
    }

    // Verify ownership
    if (!this.verifyOwnershipSync(identity, secretKey)) {
      this.log.warn("Unauthorized card update attempt", { shortId });
      return err(new IdentityError("Invalid secret key", "UNAUTHORIZED"));
    }

    // Update card fields
    const card = { ...identity.card };
    if (updates.name) card.name = updates.name;
    if (updates.description) card.description = updates.description;
    if (updates.version) card.version = updates.version;
    if (updates.skills) card.skills = updates.skills;
    if (updates.inputModes) card.inputModes = updates.inputModes;
    if (updates.outputModes) card.outputModes = updates.outputModes;
    if (updates.tags) card.tags = updates.tags;

    card.updatedAt = new Date().toISOString();
    identity.card = card;
    identity.updatedAt = new Date();

    try {
      await this.storage.save(identity);
    } catch (e) {
      return err(
        new IdentityError(
          `Failed to save identity: ${e instanceof Error ? e.message : String(e)}`,
          "STORAGE_ERROR"
        )
      );
    }

    this.log.info("Agent card updated", { shortId });
    return ok(card);
  }

  /**
   * Add a skill to an agent's card.
   */
  async addSkill(
    shortId: string,
    secretKey: string,
    skill: AgentSkill
  ): Promise<Result<void, IdentityError>> {
    // Validate skill
    const skillResult = AgentSkillSchema.safeParse(skill);
    if (!skillResult.success) {
      return err(
        new IdentityError(
          `Invalid skill: ${skillResult.error.message}`,
          "VALIDATION_ERROR"
        )
      );
    }

    const identity = await this.storage.load(shortId);
    if (!identity) {
      return err(new IdentityError(`Identity not found: ${shortId}`, "NOT_FOUND"));
    }

    if (!this.verifyOwnershipSync(identity, secretKey)) {
      return err(new IdentityError("Invalid secret key", "UNAUTHORIZED"));
    }

    // Check for duplicate skill ID
    const existingIndex = identity.card.skills.findIndex((s) => s.id === skill.id);
    if (existingIndex >= 0) {
      // Update existing skill
      identity.card.skills[existingIndex] = skillResult.data;
    } else {
      // Add new skill
      identity.card.skills.push(skillResult.data);
    }

    identity.card.updatedAt = new Date().toISOString();
    identity.updatedAt = new Date();

    try {
      await this.storage.save(identity);
    } catch (e) {
      return err(
        new IdentityError(
          `Failed to save identity: ${e instanceof Error ? e.message : String(e)}`,
          "STORAGE_ERROR"
        )
      );
    }

    this.log.info("Skill added to agent", { shortId, skillId: skill.id });
    return ok(undefined);
  }

  /**
   * Remove a skill from an agent's card.
   */
  async removeSkill(
    shortId: string,
    secretKey: string,
    skillId: string
  ): Promise<Result<void, IdentityError>> {
    const identity = await this.storage.load(shortId);
    if (!identity) {
      return err(new IdentityError(`Identity not found: ${shortId}`, "NOT_FOUND"));
    }

    if (!this.verifyOwnershipSync(identity, secretKey)) {
      return err(new IdentityError("Invalid secret key", "UNAUTHORIZED"));
    }

    identity.card.skills = identity.card.skills.filter((s) => s.id !== skillId);
    identity.card.updatedAt = new Date().toISOString();
    identity.updatedAt = new Date();

    try {
      await this.storage.save(identity);
    } catch (e) {
      return err(
        new IdentityError(
          `Failed to save identity: ${e instanceof Error ? e.message : String(e)}`,
          "STORAGE_ERROR"
        )
      );
    }

    this.log.info("Skill removed from agent", { shortId, skillId });
    return ok(undefined);
  }

  /**
   * Deactivate an agent identity.
   */
  async deactivate(
    shortId: string,
    secretKey: string
  ): Promise<Result<void, IdentityError>> {
    const identity = await this.storage.load(shortId);
    if (!identity) {
      return err(new IdentityError(`Identity not found: ${shortId}`, "NOT_FOUND"));
    }

    if (!this.verifyOwnershipSync(identity, secretKey)) {
      return err(new IdentityError("Invalid secret key", "UNAUTHORIZED"));
    }

    identity.active = false;
    identity.updatedAt = new Date();

    try {
      await this.storage.save(identity);
    } catch (e) {
      return err(
        new IdentityError(
          `Failed to save identity: ${e instanceof Error ? e.message : String(e)}`,
          "STORAGE_ERROR"
        )
      );
    }

    this.log.info("Agent deactivated", { shortId });
    return ok(undefined);
  }

  /**
   * Reactivate an agent identity.
   */
  async reactivate(
    shortId: string,
    secretKey: string
  ): Promise<Result<void, IdentityError>> {
    const identity = await this.storage.load(shortId);
    if (!identity) {
      return err(new IdentityError(`Identity not found: ${shortId}`, "NOT_FOUND"));
    }

    if (!this.verifyOwnershipSync(identity, secretKey)) {
      return err(new IdentityError("Invalid secret key", "UNAUTHORIZED"));
    }

    identity.active = true;
    identity.updatedAt = new Date();

    try {
      await this.storage.save(identity);
    } catch (e) {
      return err(
        new IdentityError(
          `Failed to save identity: ${e instanceof Error ? e.message : String(e)}`,
          "STORAGE_ERROR"
        )
      );
    }

    this.log.info("Agent reactivated", { shortId });
    return ok(undefined);
  }

  /**
   * Verify ownership of an identity.
   */
  async verifyOwnership(shortId: string, secretKey: string): Promise<boolean> {
    const identity = await this.storage.load(shortId);
    if (!identity) return false;
    return this.verifyOwnershipSync(identity, secretKey);
  }

  /**
   * List all active agents.
   */
  async listActive(): Promise<AgentIdentity[]> {
    const all = await this.storage.list();
    return all.filter((i) => i.active);
  }

  /**
   * List all agents (including inactive).
   */
  async listAll(): Promise<AgentIdentity[]> {
    return this.storage.list();
  }

  /**
   * Find agents by skill.
   */
  async findBySkill(skillId: string): Promise<AgentIdentity[]> {
    const active = await this.listActive();
    return active.filter((identity) =>
      identity.card.skills.some((s) => s.id === skillId)
    );
  }

  /**
   * Find agents by tag.
   */
  async findByTag(tag: string): Promise<AgentIdentity[]> {
    const active = await this.listActive();
    return active.filter((identity) =>
      identity.card.tags?.includes(tag)
    );
  }

  /**
   * Get Agent Card JSON for publishing.
   */
  async getAgentCardJSON(shortId: string): Promise<Result<string, IdentityError>> {
    const cardResult = await this.getAgentCard(shortId);
    if (!cardResult.ok) {
      return cardResult;
    }
    return ok(serializeAgentCard(cardResult.value));
  }

  /**
   * Delete an identity permanently.
   */
  async delete(
    shortId: string,
    secretKey: string
  ): Promise<Result<void, IdentityError>> {
    const identity = await this.storage.load(shortId);
    if (!identity) {
      return err(new IdentityError(`Identity not found: ${shortId}`, "NOT_FOUND"));
    }

    if (!this.verifyOwnershipSync(identity, secretKey)) {
      return err(new IdentityError("Invalid secret key", "UNAUTHORIZED"));
    }

    try {
      await this.storage.delete(shortId);
    } catch (e) {
      return err(
        new IdentityError(
          `Failed to delete identity: ${e instanceof Error ? e.message : String(e)}`,
          "STORAGE_ERROR"
        )
      );
    }

    this.log.info("Agent deleted", { shortId });
    return ok(undefined);
  }

  /** Generate a DID based on the configured method */
  private generateDID(shortId: string): string {
    switch (this.options.didMethod) {
      case "key": {
        // did:key method (simplified — real implementation would use public key)
        const keyId = createHash("sha256").update(shortId).digest("hex").slice(0, 32);
        return `did:key:z${keyId}`;
      }
      case "web":
        // did:web method
        return `did:web:${this.options.domain}:agents:${shortId}`;

      case "agentos":
      default:
        // Custom did:agentos method
        return `did:agentos:${shortId}`;
    }
  }

  /** Hash a secret key for storage */
  private hashSecret(secret: string): string {
    return createHash("sha256").update(secret).digest("hex");
  }

  /** Verify ownership synchronously (internal helper) */
  private verifyOwnershipSync(identity: AgentIdentity, secretKey: string): boolean {
    if (!identity.secretKeyHash) return false;
    const hash = this.hashSecret(secretKey);
    return hash === identity.secretKeyHash;
  }
}

/** Create a new identity manager */
export function createIdentityManager(
  options?: IdentityManagerOptions,
  storage?: IdentityStorage
): IdentityManager {
  return new IdentityManager(options, storage);
}

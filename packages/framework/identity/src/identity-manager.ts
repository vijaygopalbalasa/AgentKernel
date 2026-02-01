// Identity Manager — agent registration, DIDs, and Agent Card management
// Like Android's AccountManager but for AI agents

import { randomUUID, createHash } from "crypto";
import {
  type AgentCard,
  type AgentCardInput,
  type AgentSkill,
  createAgentCard,
  validateAgentCard,
  serializeAgentCard,
} from "./agent-card.js";

/** Agent identity record */
export interface AgentIdentity {
  /** Decentralized Identifier (DID) */
  did: string;
  /** Short ID for internal use */
  shortId: string;
  /** Agent Card (A2A metadata) */
  card: AgentCard;
  /** When the identity was created */
  createdAt: Date;
  /** When the identity was last updated */
  updatedAt: Date;
  /** Whether this identity is active */
  active: boolean;
  /** Public key for verification (if using signatures) */
  publicKey?: string;
  /** Secret key hash (for ownership verification) */
  secretKeyHash?: string;
}

/** Options for identity manager */
export interface IdentityManagerOptions {
  /** Base URL for agent endpoints */
  baseUrl?: string;
  /** DID method to use */
  didMethod?: "key" | "web" | "agentos";
  /** Domain for did:web method */
  domain?: string;
}

/** Result of agent registration */
export interface RegistrationResult {
  identity: AgentIdentity;
  /** Secret key (only returned once at registration) */
  secretKey: string;
}

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
  private identities: Map<string, AgentIdentity> = new Map();
  private didIndex: Map<string, string> = new Map(); // DID -> shortId
  private options: Required<IdentityManagerOptions>;

  constructor(options: IdentityManagerOptions = {}) {
    this.options = {
      baseUrl: options.baseUrl ?? "http://localhost:18800",
      didMethod: options.didMethod ?? "agentos",
      domain: options.domain ?? "localhost",
    };
  }

  /**
   * Register a new agent identity.
   * Returns the identity and a secret key (save this — it's only shown once).
   */
  register(input: AgentCardInput): RegistrationResult {
    // Generate short ID
    const shortId = `agent-${randomUUID().slice(0, 8)}`;

    // Generate DID based on method
    const did = this.generateDID(shortId);

    // Generate secret key for ownership verification
    const secretKey = `sk-${randomUUID()}`;
    const secretKeyHash = this.hashSecret(secretKey);

    // Create Agent Card
    const card = createAgentCard(did, input, this.options.baseUrl);

    // Create identity record
    const identity: AgentIdentity = {
      did,
      shortId,
      card,
      createdAt: new Date(),
      updatedAt: new Date(),
      active: true,
      secretKeyHash,
    };

    // Store identity
    this.identities.set(shortId, identity);
    this.didIndex.set(did, shortId);

    return { identity, secretKey };
  }

  /**
   * Get identity by short ID.
   */
  getById(shortId: string): AgentIdentity | null {
    return this.identities.get(shortId) ?? null;
  }

  /**
   * Get identity by DID.
   */
  getByDID(did: string): AgentIdentity | null {
    const shortId = this.didIndex.get(did);
    if (!shortId) return null;
    return this.identities.get(shortId) ?? null;
  }

  /**
   * Get Agent Card by ID (for A2A discovery).
   */
  getAgentCard(idOrDid: string): AgentCard | null {
    const identity = this.getById(idOrDid) ?? this.getByDID(idOrDid);
    if (!identity || !identity.active) return null;
    return identity.card;
  }

  /**
   * Update an agent's card.
   * Requires secret key for verification.
   */
  updateCard(
    shortId: string,
    secretKey: string,
    updates: Partial<AgentCardInput>
  ): boolean {
    const identity = this.identities.get(shortId);
    if (!identity) return false;

    // Verify ownership
    if (!this.verifyOwnership(shortId, secretKey)) {
      return false;
    }

    // Update card fields
    const card = identity.card;
    if (updates.name) card.name = updates.name;
    if (updates.description) card.description = updates.description;
    if (updates.version) card.version = updates.version;
    if (updates.skills) card.skills = updates.skills;
    if (updates.inputModes) card.inputModes = updates.inputModes;
    if (updates.outputModes) card.outputModes = updates.outputModes;
    if (updates.tags) card.tags = updates.tags;

    card.updatedAt = new Date().toISOString();
    identity.updatedAt = new Date();

    return true;
  }

  /**
   * Add a skill to an agent's card.
   */
  addSkill(shortId: string, secretKey: string, skill: AgentSkill): boolean {
    const identity = this.identities.get(shortId);
    if (!identity || !this.verifyOwnership(shortId, secretKey)) {
      return false;
    }

    // Check for duplicate skill ID
    if (identity.card.skills.some((s) => s.id === skill.id)) {
      // Update existing skill
      identity.card.skills = identity.card.skills.map((s) =>
        s.id === skill.id ? skill : s
      );
    } else {
      // Add new skill
      identity.card.skills.push(skill);
    }

    identity.card.updatedAt = new Date().toISOString();
    identity.updatedAt = new Date();

    return true;
  }

  /**
   * Remove a skill from an agent's card.
   */
  removeSkill(shortId: string, secretKey: string, skillId: string): boolean {
    const identity = this.identities.get(shortId);
    if (!identity || !this.verifyOwnership(shortId, secretKey)) {
      return false;
    }

    identity.card.skills = identity.card.skills.filter((s) => s.id !== skillId);
    identity.card.updatedAt = new Date().toISOString();
    identity.updatedAt = new Date();

    return true;
  }

  /**
   * Deactivate an agent identity.
   */
  deactivate(shortId: string, secretKey: string): boolean {
    const identity = this.identities.get(shortId);
    if (!identity || !this.verifyOwnership(shortId, secretKey)) {
      return false;
    }

    identity.active = false;
    identity.updatedAt = new Date();
    return true;
  }

  /**
   * Reactivate an agent identity.
   */
  reactivate(shortId: string, secretKey: string): boolean {
    const identity = this.identities.get(shortId);
    if (!identity || !this.verifyOwnership(shortId, secretKey)) {
      return false;
    }

    identity.active = true;
    identity.updatedAt = new Date();
    return true;
  }

  /**
   * Verify ownership of an identity.
   */
  verifyOwnership(shortId: string, secretKey: string): boolean {
    const identity = this.identities.get(shortId);
    if (!identity || !identity.secretKeyHash) return false;

    const hash = this.hashSecret(secretKey);
    return hash === identity.secretKeyHash;
  }

  /**
   * List all active agents.
   */
  listActive(): AgentIdentity[] {
    return Array.from(this.identities.values()).filter((i) => i.active);
  }

  /**
   * List all agents (including inactive).
   */
  listAll(): AgentIdentity[] {
    return Array.from(this.identities.values());
  }

  /**
   * Find agents by skill.
   */
  findBySkill(skillId: string): AgentIdentity[] {
    return this.listActive().filter((identity) =>
      identity.card.skills.some((s) => s.id === skillId)
    );
  }

  /**
   * Find agents by tag.
   */
  findByTag(tag: string): AgentIdentity[] {
    return this.listActive().filter((identity) =>
      identity.card.tags?.includes(tag)
    );
  }

  /**
   * Get Agent Card JSON for publishing.
   */
  getAgentCardJSON(shortId: string): string | null {
    const card = this.getAgentCard(shortId);
    if (!card) return null;
    return serializeAgentCard(card);
  }

  /**
   * Delete an identity permanently.
   */
  delete(shortId: string, secretKey: string): boolean {
    const identity = this.identities.get(shortId);
    if (!identity || !this.verifyOwnership(shortId, secretKey)) {
      return false;
    }

    this.didIndex.delete(identity.did);
    this.identities.delete(shortId);
    return true;
  }

  /** Generate a DID based on the configured method */
  private generateDID(shortId: string): string {
    switch (this.options.didMethod) {
      case "key":
        // did:key method (simplified — real implementation would use public key)
        const keyId = createHash("sha256").update(shortId).digest("hex").slice(0, 32);
        return `did:key:z${keyId}`;

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
}

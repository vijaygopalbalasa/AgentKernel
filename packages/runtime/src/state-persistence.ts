// State Persistence — PostgreSQL-backed state storage for agents
// Persists agent state, capability tokens, and rate limit buckets

import { randomBytes, randomUUID } from "node:crypto";
import type { Database } from "@agentkernel/kernel";
import type { AgentId } from "./agent-context.js";
import type { Capability, CapabilityGrant } from "./sandbox.js";
import type { AgentState } from "./state-machine.js";

// ─── TYPES ────────────────────────────────────────────────────────────────

/** Persisted agent state */
export interface PersistedAgentState {
  agentId: string;
  state: AgentState;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

/** Capability token for database storage */
export interface CapabilityToken {
  token: string;
  agentId: string;
  capability: Capability;
  grantedBy: AgentId | "system";
  grantedAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  constraints?: Record<string, unknown>;
}

/** Rate limit bucket state */
export interface RateLimitBucket {
  agentId: string;
  bucketType: "tool_calls" | "tokens" | "messages";
  tokens: number;
  capacity: number;
  refillRate: number;
  lastRefill: Date;
}

/** State persistence interface */
export interface StatePersistence {
  /** Save agent state */
  saveState(agentId: string, state: AgentState, metadata?: Record<string, unknown>): Promise<void>;
  /** Load agent state */
  loadState(agentId: string): Promise<PersistedAgentState | null>;
  /** Delete agent state */
  deleteState(agentId: string): Promise<boolean>;
  /** List all agent states */
  listStates(options?: { limit?: number; offset?: number }): Promise<PersistedAgentState[]>;
}

/** Capability token store interface */
export interface CapabilityStore {
  /** Grant a capability and return a token */
  grantCapability(
    agentId: string,
    capability: Capability,
    options?: {
      grantedBy?: AgentId | "system";
      expiresAt?: Date | null;
      constraints?: Record<string, unknown>;
    },
  ): Promise<CapabilityToken>;
  /** Validate a capability token */
  validateCapability(token: string, capability: Capability): Promise<boolean>;
  /** Revoke a capability token */
  revokeCapability(token: string): Promise<boolean>;
  /** Revoke all capabilities for an agent */
  revokeAllCapabilities(agentId: string): Promise<number>;
  /** List all active capabilities for an agent */
  listCapabilities(agentId: string): Promise<CapabilityToken[]>;
}

/** Rate limit bucket store interface */
export interface RateLimitStore {
  /** Get or create a rate limit bucket */
  getBucket(agentId: string, bucketType: RateLimitBucket["bucketType"]): Promise<RateLimitBucket>;
  /** Save bucket state */
  saveBucket(bucket: RateLimitBucket): Promise<void>;
  /** Reset all buckets for an agent */
  resetBuckets(agentId: string): Promise<void>;
}

// ─── GENERATE SECURE TOKEN ────────────────────────────────────────────────

/** Generate a cryptographically secure token */
function generateSecureToken(): string {
  return randomBytes(32).toString("base64url");
}

// ─── POSTGRES STATE PERSISTENCE ───────────────────────────────────────────

/**
 * PostgreSQL-backed state persistence.
 */
export class PostgresStatePersistence implements StatePersistence {
  constructor(private readonly db: Database) {}

  async saveState(
    agentId: string,
    state: AgentState,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.db.query(async (sql) => {
      return sql`
        INSERT INTO agent_state (agent_id, state, lifecycle_status, metadata, updated_at)
        VALUES (${agentId}, ${JSON.stringify({ lifecycle: state })}, ${state}, ${JSON.stringify(metadata ?? {})}, NOW())
        ON CONFLICT (agent_id) DO UPDATE SET
          state = ${JSON.stringify({ lifecycle: state })},
          lifecycle_status = ${state},
          metadata = ${JSON.stringify(metadata ?? {})},
          updated_at = NOW()
      `;
    });
  }

  async loadState(agentId: string): Promise<PersistedAgentState | null> {
    const result = await this.db.queryOne<{
      agent_id: string;
      state: { lifecycle: AgentState };
      lifecycle_status: AgentState;
      metadata: Record<string, unknown>;
      created_at: Date;
      updated_at: Date;
    }>(async (sql) => {
      return sql`
        SELECT agent_id, state, lifecycle_status, metadata, created_at, updated_at
        FROM agent_state
        WHERE agent_id = ${agentId}
      `;
    });

    if (!result) {
      return null;
    }

    return {
      agentId: result.agent_id,
      state: result.lifecycle_status,
      metadata: result.metadata,
      createdAt: result.created_at,
      updatedAt: result.updated_at,
    };
  }

  async deleteState(agentId: string): Promise<boolean> {
    const result = await this.db.query<{ count: number }>(async (sql) => {
      await sql`DELETE FROM agent_state WHERE agent_id = ${agentId}`;
      return sql`SELECT 1 as count`;
    });
    return result.length > 0;
  }

  async listStates(options?: { limit?: number; offset?: number }): Promise<PersistedAgentState[]> {
    const limit = options?.limit ?? 100;
    const offset = options?.offset ?? 0;

    const results = await this.db.query<{
      agent_id: string;
      lifecycle_status: AgentState;
      metadata: Record<string, unknown>;
      created_at: Date;
      updated_at: Date;
    }>(async (sql) => {
      return sql`
        SELECT agent_id, lifecycle_status, metadata, created_at, updated_at
        FROM agent_state
        ORDER BY updated_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    });

    return results.map((r) => ({
      agentId: r.agent_id,
      state: r.lifecycle_status,
      metadata: r.metadata,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }
}

// ─── POSTGRES CAPABILITY STORE ────────────────────────────────────────────

/**
 * PostgreSQL-backed capability token store.
 */
export class PostgresCapabilityStore implements CapabilityStore {
  constructor(private readonly db: Database) {}

  async grantCapability(
    agentId: string,
    capability: Capability,
    options?: {
      grantedBy?: AgentId | "system";
      expiresAt?: Date | null;
      constraints?: Record<string, unknown>;
    },
  ): Promise<CapabilityToken> {
    const token = generateSecureToken();
    const grantedBy = options?.grantedBy ?? "system";
    const expiresAt = options?.expiresAt ?? null;
    const constraints = options?.constraints ?? null;

    await this.db.query(async (sql) => {
      return sql`
        INSERT INTO capability_tokens (
          id, token, agent_id, capability, granted_by, expires_at, constraints
        ) VALUES (
          ${randomUUID()},
          ${token},
          ${agentId},
          ${capability},
          ${grantedBy},
          ${expiresAt},
          ${JSON.stringify(constraints)}
        )
      `;
    });

    return {
      token,
      agentId,
      capability,
      grantedBy,
      grantedAt: new Date(),
      expiresAt,
      revokedAt: null,
      constraints: constraints ?? undefined,
    };
  }

  async validateCapability(token: string, capability: Capability): Promise<boolean> {
    const result = await this.db.queryOne<{ valid: boolean }>(async (sql) => {
      return sql`
        SELECT EXISTS(
          SELECT 1 FROM capability_tokens
          WHERE token = ${token}
            AND capability = ${capability}
            AND (expires_at IS NULL OR expires_at > NOW())
            AND revoked_at IS NULL
        ) as valid
      `;
    });

    return result?.valid ?? false;
  }

  async revokeCapability(token: string): Promise<boolean> {
    const result = await this.db.query(async (sql) => {
      return sql`
        UPDATE capability_tokens
        SET revoked_at = NOW()
        WHERE token = ${token} AND revoked_at IS NULL
        RETURNING id
      `;
    });

    return result.length > 0;
  }

  async revokeAllCapabilities(agentId: string): Promise<number> {
    const result = await this.db.query<{ id: string }>(async (sql) => {
      return sql`
        UPDATE capability_tokens
        SET revoked_at = NOW()
        WHERE agent_id = ${agentId} AND revoked_at IS NULL
        RETURNING id
      `;
    });

    return result.length;
  }

  async listCapabilities(agentId: string): Promise<CapabilityToken[]> {
    const results = await this.db.query<{
      token: string;
      agent_id: string;
      capability: Capability;
      granted_by: string;
      granted_at: Date;
      expires_at: Date | null;
      revoked_at: Date | null;
      constraints: Record<string, unknown> | null;
    }>(async (sql) => {
      return sql`
        SELECT token, agent_id, capability, granted_by, granted_at, expires_at, revoked_at, constraints
        FROM capability_tokens
        WHERE agent_id = ${agentId}
          AND (expires_at IS NULL OR expires_at > NOW())
          AND revoked_at IS NULL
        ORDER BY granted_at DESC
      `;
    });

    return results.map((r) => ({
      token: r.token,
      agentId: r.agent_id,
      capability: r.capability,
      grantedBy: r.granted_by as AgentId | "system",
      grantedAt: r.granted_at,
      expiresAt: r.expires_at,
      revokedAt: r.revoked_at,
      constraints: r.constraints ?? undefined,
    }));
  }
}

// ─── POSTGRES RATE LIMIT STORE ────────────────────────────────────────────

/** Default rate limit configurations */
const DEFAULT_BUCKET_CONFIGS: Record<
  RateLimitBucket["bucketType"],
  { capacity: number; refillRate: number }
> = {
  tool_calls: { capacity: 60, refillRate: 1 }, // 60 tool calls, refill 1/sec
  tokens: { capacity: 100000, refillRate: 1666 }, // 100k tokens, refill ~100k/min
  messages: { capacity: 30, refillRate: 0.5 }, // 30 messages, refill 1 every 2 sec
};

/**
 * PostgreSQL-backed rate limit bucket store.
 */
export class PostgresRateLimitStore implements RateLimitStore {
  constructor(private readonly db: Database) {}

  async getBucket(
    agentId: string,
    bucketType: RateLimitBucket["bucketType"],
  ): Promise<RateLimitBucket> {
    const result = await this.db.queryOne<{
      agent_id: string;
      bucket_type: string;
      tokens: number;
      capacity: number;
      refill_rate: number;
      last_refill: Date;
    }>(async (sql) => {
      return sql`
        SELECT agent_id, bucket_type, tokens, capacity, refill_rate, last_refill
        FROM rate_limit_buckets
        WHERE agent_id = ${agentId} AND bucket_type = ${bucketType}
      `;
    });

    if (result) {
      return {
        agentId: result.agent_id,
        bucketType: result.bucket_type as RateLimitBucket["bucketType"],
        tokens: result.tokens,
        capacity: result.capacity,
        refillRate: result.refill_rate,
        lastRefill: result.last_refill,
      };
    }

    // Create new bucket with defaults
    const config = DEFAULT_BUCKET_CONFIGS[bucketType];
    const newBucket: RateLimitBucket = {
      agentId,
      bucketType,
      tokens: config.capacity,
      capacity: config.capacity,
      refillRate: config.refillRate,
      lastRefill: new Date(),
    };

    await this.saveBucket(newBucket);
    return newBucket;
  }

  async saveBucket(bucket: RateLimitBucket): Promise<void> {
    await this.db.query(async (sql) => {
      return sql`
        INSERT INTO rate_limit_buckets (
          agent_id, bucket_type, tokens, capacity, refill_rate, last_refill
        ) VALUES (
          ${bucket.agentId},
          ${bucket.bucketType},
          ${bucket.tokens},
          ${bucket.capacity},
          ${bucket.refillRate},
          ${bucket.lastRefill}
        )
        ON CONFLICT (agent_id, bucket_type) DO UPDATE SET
          tokens = ${bucket.tokens},
          capacity = ${bucket.capacity},
          refill_rate = ${bucket.refillRate},
          last_refill = ${bucket.lastRefill}
      `;
    });
  }

  async resetBuckets(agentId: string): Promise<void> {
    await this.db.query(async (sql) => {
      return sql`DELETE FROM rate_limit_buckets WHERE agent_id = ${agentId}`;
    });
  }
}

// ─── FACTORY FUNCTIONS ────────────────────────────────────────────────────

/** Create all persistence stores from a database connection */
export function createPersistenceStores(db: Database): {
  statePersistence: PostgresStatePersistence;
  capabilityStore: PostgresCapabilityStore;
  rateLimitStore: PostgresRateLimitStore;
} {
  return {
    statePersistence: new PostgresStatePersistence(db),
    capabilityStore: new PostgresCapabilityStore(db),
    rateLimitStore: new PostgresRateLimitStore(db),
  };
}

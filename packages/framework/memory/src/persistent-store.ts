// Persistent Memory Store — PostgreSQL + Qdrant implementation
// Stores metadata in Postgres and embeddings in Qdrant

import { randomUUID, createHmac, createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";
import { type Result, ok, err } from "@agentkernel/shared";
import {
  createLogger,
  type Logger,
  type Database,
  type Sql,
  type VectorStore,
  type SearchFilter,
} from "@agentkernel/kernel";
import type { AgentId } from "@agentkernel/runtime";
import type {
  MemoryId,
  EpisodicMemory,
  SemanticMemory,
  ProceduralMemory,
  MemoryScope,
  MemoryQuery,
  MemoryQueryResult,
  MemoryStats,
} from "./types.js";
import {
  MemoryError,
  type Memory,
  type MemoryStore,
  calculateStrength,
} from "./store.js";

interface EpisodicRow {
  id: string;
  agent_id: string;
  scope: string;
  event: string;
  context: string;
  outcome: string | null;
  success: boolean | null;
  valence: number | null;
  importance: number | string;
  strength: number | string;
  access_count: number | string;
  session_id: string | null;
  related_episodes: string[] | null;
  created_at: Date;
  last_accessed_at: Date;
  tags: string[] | null;
  metadata: Record<string, unknown> | null;
}

interface SemanticRow {
  id: string;
  agent_id: string;
  scope: string;
  subject: string;
  predicate: string;
  object: string;
  confidence: number | string;
  source: string | null;
  verified_at: Date | null;
  related_concepts: string[] | null;
  importance: number | string;
  strength: number | string;
  access_count: number | string;
  created_at: Date;
  last_accessed_at: Date;
  tags: string[] | null;
  metadata: Record<string, unknown> | null;
}

interface ProceduralRow {
  id: string;
  agent_id: string;
  scope: string;
  name: string;
  description: string;
  trigger: string;
  steps: unknown;
  inputs: unknown;
  outputs: unknown;
  success_rate: number | string;
  execution_count: number | string;
  version: number | string;
  active: boolean;
  importance: number | string;
  strength: number | string;
  access_count: number | string;
  created_at: Date;
  last_accessed_at: Date;
  tags: string[] | null;
  metadata: Record<string, unknown> | null;
}

export interface PersistentMemoryStoreOptions {
  db: Database;
  vectorStore?: VectorStore;
  logger?: Logger;
  /** Optional master key for at-rest encryption (per-agent derived keys) */
  encryptionKey?: string;
  /** Skip creating a minimal agent row (default: false) */
  skipAgentRegistration?: boolean;
  /** Use vector search when query.embedding is provided (default: true) */
  enableVectorSearch?: boolean;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENCRYPTION_PREFIX = "enc:v1:";
const ENCRYPTION_IV_BYTES = 12;

function isUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

function toNumber(value: number | string | null | undefined, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const num = Number(value);
  return Number.isNaN(num) ? fallback : num;
}

function toOptionalNumber(value: number | string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const num = Number(value);
  return Number.isNaN(num) ? undefined : num;
}

function normalizeTags(tags: string[] | null | undefined): string[] | undefined {
  if (!tags || tags.length === 0) return undefined;
  return tags;
}

function normalizeScope(value: string | null | undefined): MemoryScope {
  if (value === "shared" || value === "public") return value;
  return "private";
}

function normalizeMetadata(
  metadata: Record<string, unknown> | null | undefined
): Record<string, unknown> | undefined {
  if (!metadata || Object.keys(metadata).length === 0) return undefined;
  return metadata;
}

function normalizeArray<T>(value: unknown, fallback: T[] = []): T[] {
  if (Array.isArray(value)) return value as T[];
  return fallback;
}

type JsonValue =
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue };

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export class PersistentMemoryStore implements MemoryStore {
  private readonly db: Database;
  private readonly vectorStore?: VectorStore;
  private readonly log: Logger;
  private readonly options: Required<
    Pick<PersistentMemoryStoreOptions, "skipAgentRegistration" | "enableVectorSearch">
  >;
  private readonly encryptionKey?: string;
  private readonly encryptionEnabled: boolean;

  constructor(options: PersistentMemoryStoreOptions) {
    this.db = options.db;
    this.vectorStore = options.vectorStore;
    this.log = options.logger ?? createLogger({ name: "persistent-memory-store" });
    this.options = {
      skipAgentRegistration: options.skipAgentRegistration ?? false,
      enableVectorSearch: options.enableVectorSearch ?? true,
    };
    this.encryptionKey = options.encryptionKey?.trim() || undefined;
    this.encryptionEnabled = Boolean(this.encryptionKey);
  }

  async save(memory: Memory): Promise<Result<MemoryId, MemoryError>> {
    const id = memory.id || randomUUID();
    const agentId = memory.agentId;

    if (!isUuid(id)) {
      return err(new MemoryError(`Invalid memory ID (expected UUID): ${id}`, "VALIDATION_ERROR", id));
    }
    if (!isUuid(agentId)) {
      return err(
        new MemoryError(`Invalid agent ID (expected UUID): ${agentId}`, "VALIDATION_ERROR")
      );
    }

    try {
      if (!this.options.skipAgentRegistration) {
        await this.ensureAgent(agentId);
      }

      if (memory.type === "episodic") {
        await this.saveEpisodic({ ...memory, id });
      } else if (memory.type === "semantic") {
        await this.saveSemantic({ ...memory, id });
      } else {
        await this.saveProcedural({ ...memory, id });
      }

      await this.upsertEmbedding(memory, id);
      return ok(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error("Failed to save memory", { id, error: message });
      return err(new MemoryError(`Failed to save memory: ${message}`, "STORE_ERROR", id));
    }
  }

  async get(id: MemoryId): Promise<Result<Memory, MemoryError>> {
    if (!isUuid(id)) {
      return err(new MemoryError(`Invalid memory ID (expected UUID): ${id}`, "VALIDATION_ERROR", id));
    }

    const memoryResult = await this.findById(id);
    if (!memoryResult.ok) return memoryResult;

    const memory = memoryResult.value;
    const now = new Date();
    const newAccessCount = memory.accessCount + 1;
    const newStrength = calculateStrength(now, newAccessCount);

    await this.update(id, {
      accessCount: newAccessCount,
      lastAccessedAt: now,
      strength: newStrength,
    });

    memory.accessCount = newAccessCount;
    memory.lastAccessedAt = now;
    memory.strength = newStrength;

    return ok(memory);
  }

  async update(id: MemoryId, updates: Partial<Memory>): Promise<Result<void, MemoryError>> {
    if (!isUuid(id)) {
      return err(new MemoryError(`Invalid memory ID (expected UUID): ${id}`, "VALIDATION_ERROR", id));
    }

    const existingResult = await this.findById(id);
    if (!existingResult.ok) return err(existingResult.error);

    const existing = existingResult.value;
    const merged: Memory = { ...existing, ...updates, id } as Memory;

    try {
      if (merged.type === "episodic") {
        await this.saveEpisodic(merged);
      } else if (merged.type === "semantic") {
        await this.saveSemantic(merged);
      } else {
        await this.saveProcedural(merged);
      }

      await this.upsertEmbedding(merged, id);
      return ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error("Failed to update memory", { id, error: message });
      return err(new MemoryError(`Failed to update memory: ${message}`, "STORE_ERROR", id));
    }
  }

  async delete(id: MemoryId): Promise<Result<void, MemoryError>> {
    if (!isUuid(id)) {
      return err(new MemoryError(`Invalid memory ID (expected UUID): ${id}`, "VALIDATION_ERROR", id));
    }

    const existingResult = await this.findById(id);
    if (!existingResult.ok) return err(existingResult.error);

    try {
      const type = existingResult.value.type;
      await this.db.query((sql) => {
        if (type === "episodic") {
          return sql`DELETE FROM episodic_memories WHERE id = ${id}`;
        }
        if (type === "semantic") {
          return sql`DELETE FROM semantic_memories WHERE id = ${id}`;
        }
        return sql`DELETE FROM procedural_memories WHERE id = ${id}`;
      });

      if (this.vectorStore) {
        await this.vectorStore.delete(id);
      }

      return ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error("Failed to delete memory", { id, error: message });
      return err(new MemoryError(`Failed to delete memory: ${message}`, "STORE_ERROR", id));
    }
  }

  async query(agentId: AgentId, query: MemoryQuery): Promise<Result<MemoryQueryResult, MemoryError>> {
    if (!isUuid(agentId)) {
      return err(
        new MemoryError(`Invalid agent ID (expected UUID): ${agentId}`, "VALIDATION_ERROR")
      );
    }

    const startTime = Date.now();

    try {
      const types = query.types ?? ["episodic", "semantic", "procedural"];
      const limit = query.limit ?? 10;

      let memories: Memory[] = [];
      let total = 0;

      if (query.embedding && this.vectorStore && this.options.enableVectorSearch) {
        const vectorResult = await this.queryByVector(agentId, query, limit, types);
        memories = vectorResult.memories;
        total = vectorResult.total;

        if (memories.length === 0 && query.query) {
          // Fallback to text search if vector search yields nothing
          const textResult = await this.queryByText(agentId, query, limit, types);
          memories = textResult.memories;
          total = textResult.total;
        }
      } else {
        const textResult = await this.queryByText(agentId, query, limit, types);
        memories = textResult.memories;
        total = textResult.total;
      }

      if (!query.includeEmbeddings) {
        memories = memories.map((memory) => {
          if (memory.type === "episodic" || memory.type === "semantic") {
            const { embedding, ...rest } = memory as EpisodicMemory | SemanticMemory;
            return rest as Memory;
          }
          return memory;
        });
      } else {
        await this.attachEmbeddings(memories);
      }

      return ok({
        memories,
        total,
        queryTime: Date.now() - startTime,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error("Failed to query memory", { agentId, error: message });
      return err(new MemoryError(`Failed to query memory: ${message}`, "QUERY_ERROR"));
    }
  }

  async getByAgent(agentId: AgentId, type?: Memory["type"]): Promise<Result<Memory[], MemoryError>> {
    const result = await this.query(agentId, {
      types: type ? [type] : undefined,
      limit: 1000,
    });

    if (!result.ok) return result;
    return ok(result.value.memories);
  }

  async getStats(agentId: AgentId): Promise<Result<MemoryStats, MemoryError>> {
    if (!isUuid(agentId)) {
      return err(
        new MemoryError(`Invalid agent ID (expected UUID): ${agentId}`, "VALIDATION_ERROR")
      );
    }

    try {
      const episodic = await this.db.queryOne<{
        count: number | string;
        importance_sum: number | string | null;
        strength_sum: number | string | null;
        oldest: Date | null;
        newest: Date | null;
      }>((sql) => sql`
        SELECT
          COUNT(*) AS count,
          COALESCE(SUM(importance), 0) AS importance_sum,
          COALESCE(SUM(strength), 0) AS strength_sum,
          MIN(created_at) AS oldest,
          MAX(created_at) AS newest
        FROM episodic_memories
        WHERE agent_id = ${agentId}
      `);

      const semantic = await this.db.queryOne<{
        count: number | string;
        importance_sum: number | string | null;
        strength_sum: number | string | null;
        oldest: Date | null;
        newest: Date | null;
      }>((sql) => sql`
        SELECT
          COUNT(*) AS count,
          COALESCE(SUM(importance), 0) AS importance_sum,
          COALESCE(SUM(strength), 0) AS strength_sum,
          MIN(created_at) AS oldest,
          MAX(created_at) AS newest
        FROM semantic_memories
        WHERE agent_id = ${agentId}
      `);

      const procedural = await this.db.queryOne<{
        count: number | string;
        importance_sum: number | string | null;
        strength_sum: number | string | null;
        oldest: Date | null;
        newest: Date | null;
      }>((sql) => sql`
        SELECT
          COUNT(*) AS count,
          COALESCE(SUM(importance), 0) AS importance_sum,
          COALESCE(SUM(strength), 0) AS strength_sum,
          MIN(created_at) AS oldest,
          MAX(created_at) AS newest
        FROM procedural_memories
        WHERE agent_id = ${agentId}
      `);

      const episodicCount = toNumber(episodic?.count);
      const semanticCount = toNumber(semantic?.count);
      const proceduralCount = toNumber(procedural?.count);
      const totalCount = episodicCount + semanticCount + proceduralCount;

      const totalImportance =
        toNumber(episodic?.importance_sum) +
        toNumber(semantic?.importance_sum) +
        toNumber(procedural?.importance_sum);

      const totalStrength =
        toNumber(episodic?.strength_sum) +
        toNumber(semantic?.strength_sum) +
        toNumber(procedural?.strength_sum);

      const oldestMemory = [episodic?.oldest, semantic?.oldest, procedural?.oldest]
        .filter((value): value is Date => value instanceof Date)
        .sort((a, b) => a.getTime() - b.getTime())[0];

      const newestMemory = [episodic?.newest, semantic?.newest, procedural?.newest]
        .filter((value): value is Date => value instanceof Date)
        .sort((a, b) => b.getTime() - a.getTime())[0];

      return ok({
        agentId,
        episodicCount,
        semanticCount,
        proceduralCount,
        totalCount,
        oldestMemory,
        newestMemory,
        averageImportance: totalCount > 0 ? totalImportance / totalCount : 0,
        averageStrength: totalCount > 0 ? totalStrength / totalCount : 0,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error("Failed to compute memory stats", { agentId, error: message });
      return err(new MemoryError(`Failed to compute stats: ${message}`, "STORE_ERROR"));
    }
  }

  async decayStrength(agentId: AgentId, decayRate: number): Promise<Result<number, MemoryError>> {
    if (!isUuid(agentId)) {
      return err(
        new MemoryError(`Invalid agent ID (expected UUID): ${agentId}`, "VALIDATION_ERROR")
      );
    }

    try {
      const updated = await this.updateStrengthForAgent(agentId, 1 - decayRate);
      return ok(updated);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error("Failed to decay strength", { agentId, error: message });
      return err(new MemoryError(`Failed to decay strength: ${message}`, "STORE_ERROR"));
    }
  }

  async prune(agentId: AgentId, minStrength: number): Promise<Result<number, MemoryError>> {
    if (!isUuid(agentId)) {
      return err(
        new MemoryError(`Invalid agent ID (expected UUID): ${agentId}`, "VALIDATION_ERROR")
      );
    }

    try {
      const deleted = await this.pruneByStrength(agentId, minStrength);
      return ok(deleted);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error("Failed to prune memory", { agentId, error: message });
      return err(new MemoryError(`Failed to prune memory: ${message}`, "STORE_ERROR"));
    }
  }

  async clear(agentId: AgentId): Promise<Result<void, MemoryError>> {
    if (!isUuid(agentId)) {
      return err(
        new MemoryError(`Invalid agent ID (expected UUID): ${agentId}`, "VALIDATION_ERROR")
      );
    }

    try {
      await this.db.transaction(async (sql) => {
        await sql`DELETE FROM episodic_memories WHERE agent_id = ${agentId}`;
        await sql`DELETE FROM semantic_memories WHERE agent_id = ${agentId}`;
        await sql`DELETE FROM procedural_memories WHERE agent_id = ${agentId}`;
      });

      if (this.vectorStore) {
        await this.vectorStore.deleteByFilter([{ field: "agentId", match: agentId }]);
      }

      return ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error("Failed to clear memory", { agentId, error: message });
      return err(new MemoryError(`Failed to clear memory: ${message}`, "STORE_ERROR"));
    }
  }

  private async ensureAgent(agentId: AgentId): Promise<void> {
    await this.db.query((sql) => sql`
      INSERT INTO agents (id, name)
      VALUES (${agentId}, ${agentId})
      ON CONFLICT (id) DO NOTHING
    `);
  }

  private async saveEpisodic(memory: EpisodicMemory): Promise<void> {
    const now = new Date();
    const event = this.encryptValue(memory.agentId, memory.event);
    const context = this.encryptValue(memory.agentId, memory.context);
    const outcome = this.encryptValue(memory.agentId, memory.outcome ?? null);
    await this.db.query((sql) => sql`
      INSERT INTO episodic_memories (
        id,
        agent_id,
        scope,
        event,
        context,
        outcome,
        success,
        valence,
        importance,
        strength,
        access_count,
        session_id,
        related_episodes,
        created_at,
        last_accessed_at,
        tags,
        metadata
      ) VALUES (
        ${memory.id},
        ${memory.agentId},
        ${memory.scope},
        ${event},
        ${context},
        ${outcome},
        ${memory.success ?? null},
        ${memory.valence ?? null},
        ${memory.importance},
        ${memory.strength},
        ${memory.accessCount},
        ${memory.sessionId ?? null},
        ${sql.array(memory.relatedEpisodes ?? [])},
        ${memory.createdAt ?? now},
        ${memory.lastAccessedAt ?? now},
        ${sql.array(memory.tags ?? [])},
        ${sql.json(toJsonValue(memory.metadata ?? {}))}
      )
      ON CONFLICT (id) DO UPDATE SET
        scope = EXCLUDED.scope,
        event = EXCLUDED.event,
        context = EXCLUDED.context,
        outcome = EXCLUDED.outcome,
        success = EXCLUDED.success,
        valence = EXCLUDED.valence,
        importance = EXCLUDED.importance,
        strength = EXCLUDED.strength,
        access_count = EXCLUDED.access_count,
        session_id = EXCLUDED.session_id,
        related_episodes = EXCLUDED.related_episodes,
        last_accessed_at = EXCLUDED.last_accessed_at,
        tags = EXCLUDED.tags,
        metadata = EXCLUDED.metadata
    `);
  }

  private async saveSemantic(memory: SemanticMemory): Promise<void> {
    const now = new Date();
    const object = this.encryptValue(memory.agentId, memory.object);
    await this.db.query((sql) => sql`
      INSERT INTO semantic_memories (
        id,
        agent_id,
        scope,
        subject,
        predicate,
        object,
        confidence,
        source,
        verified_at,
        related_concepts,
        importance,
        strength,
        access_count,
        created_at,
        last_accessed_at,
        tags,
        metadata
      ) VALUES (
        ${memory.id},
        ${memory.agentId},
        ${memory.scope},
        ${memory.subject},
        ${memory.predicate},
        ${object},
        ${memory.confidence},
        ${memory.source ?? null},
        ${memory.verifiedAt ?? null},
        ${sql.array(memory.relatedConcepts ?? [])},
        ${memory.importance},
        ${memory.strength},
        ${memory.accessCount},
        ${memory.createdAt ?? now},
        ${memory.lastAccessedAt ?? now},
        ${sql.array(memory.tags ?? [])},
        ${sql.json(toJsonValue(memory.metadata ?? {}))}
      )
      ON CONFLICT (id) DO UPDATE SET
        scope = EXCLUDED.scope,
        subject = EXCLUDED.subject,
        predicate = EXCLUDED.predicate,
        object = EXCLUDED.object,
        confidence = EXCLUDED.confidence,
        source = EXCLUDED.source,
        verified_at = EXCLUDED.verified_at,
        related_concepts = EXCLUDED.related_concepts,
        importance = EXCLUDED.importance,
        strength = EXCLUDED.strength,
        access_count = EXCLUDED.access_count,
        last_accessed_at = EXCLUDED.last_accessed_at,
        tags = EXCLUDED.tags,
        metadata = EXCLUDED.metadata
    `);
  }

  private async saveProcedural(memory: ProceduralMemory): Promise<void> {
    const now = new Date();
    const description = this.encryptValue(memory.agentId, memory.description);
    const trigger = this.encryptValue(memory.agentId, memory.trigger);
    await this.db.query((sql) => sql`
      INSERT INTO procedural_memories (
        id,
        agent_id,
        scope,
        name,
        description,
        trigger,
        steps,
        inputs,
        outputs,
        success_rate,
        execution_count,
        version,
        active,
        importance,
        strength,
        access_count,
        created_at,
        last_accessed_at,
        tags,
        metadata
      ) VALUES (
        ${memory.id},
        ${memory.agentId},
        ${memory.scope},
        ${memory.name},
        ${description},
        ${trigger},
        ${sql.json(toJsonValue(memory.steps ?? []))},
        ${sql.json(toJsonValue(memory.inputs ?? []))},
        ${sql.json(toJsonValue(memory.outputs ?? []))},
        ${memory.successRate},
        ${memory.executionCount},
        ${memory.version},
        ${memory.active},
        ${memory.importance},
        ${memory.strength},
        ${memory.accessCount},
        ${memory.createdAt ?? now},
        ${memory.lastAccessedAt ?? now},
        ${sql.array(memory.tags ?? [])},
        ${sql.json(toJsonValue(memory.metadata ?? {}))}
      )
      ON CONFLICT (id) DO UPDATE SET
        scope = EXCLUDED.scope,
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        trigger = EXCLUDED.trigger,
        steps = EXCLUDED.steps,
        inputs = EXCLUDED.inputs,
        outputs = EXCLUDED.outputs,
        success_rate = EXCLUDED.success_rate,
        execution_count = EXCLUDED.execution_count,
        version = EXCLUDED.version,
        active = EXCLUDED.active,
        importance = EXCLUDED.importance,
        strength = EXCLUDED.strength,
        access_count = EXCLUDED.access_count,
        last_accessed_at = EXCLUDED.last_accessed_at,
        tags = EXCLUDED.tags,
        metadata = EXCLUDED.metadata
    `);
  }

  private async findById(id: MemoryId): Promise<Result<Memory, MemoryError>> {
    try {
      const episodic = await this.db.queryOne<EpisodicRow>((sql) => sql`
        SELECT *
        FROM episodic_memories
        WHERE id = ${id}
        LIMIT 1
      `);
      if (episodic) return ok(this.mapEpisodicRow(episodic));

      const semantic = await this.db.queryOne<SemanticRow>((sql) => sql`
        SELECT *
        FROM semantic_memories
        WHERE id = ${id}
        LIMIT 1
      `);
      if (semantic) return ok(this.mapSemanticRow(semantic));

      const procedural = await this.db.queryOne<ProceduralRow>((sql) => sql`
        SELECT *
        FROM procedural_memories
        WHERE id = ${id}
        LIMIT 1
      `);
      if (procedural) return ok(this.mapProceduralRow(procedural));

      return err(new MemoryError(`Memory not found: ${id}`, "NOT_FOUND", id));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error("Failed to lookup memory", { id, error: message });
      return err(new MemoryError(`Failed to lookup memory: ${message}`, "STORE_ERROR", id));
    }
  }

  private mapEpisodicRow(row: EpisodicRow): EpisodicMemory {
    return {
      id: row.id,
      type: "episodic",
      agentId: row.agent_id,
      scope: normalizeScope(row.scope),
      event: this.decryptValue(row.agent_id, row.event) ?? "",
      context: this.decryptValue(row.agent_id, row.context) ?? "",
      outcome: this.decryptValue(row.agent_id, row.outcome ?? undefined),
      success: row.success ?? undefined,
      valence: toOptionalNumber(row.valence),
      importance: toNumber(row.importance, 0.5),
      strength: toNumber(row.strength, 1),
      accessCount: toNumber(row.access_count, 0),
      sessionId: row.session_id ?? undefined,
      relatedEpisodes: row.related_episodes ?? undefined,
      createdAt: row.created_at,
      lastAccessedAt: row.last_accessed_at,
      tags: normalizeTags(row.tags),
      metadata: normalizeMetadata(row.metadata),
    };
  }

  private mapSemanticRow(row: SemanticRow): SemanticMemory {
    return {
      id: row.id,
      type: "semantic",
      agentId: row.agent_id,
      scope: normalizeScope(row.scope),
      subject: row.subject,
      predicate: row.predicate,
      object: this.decryptValue(row.agent_id, row.object) ?? "",
      confidence: toNumber(row.confidence, 0.8),
      source: row.source ?? undefined,
      verifiedAt: row.verified_at ?? undefined,
      relatedConcepts: row.related_concepts ?? undefined,
      importance: toNumber(row.importance, 0.5),
      strength: toNumber(row.strength, 1),
      accessCount: toNumber(row.access_count, 0),
      createdAt: row.created_at,
      lastAccessedAt: row.last_accessed_at,
      tags: normalizeTags(row.tags),
      metadata: normalizeMetadata(row.metadata),
    };
  }

  private mapProceduralRow(row: ProceduralRow): ProceduralMemory {
    return {
      id: row.id,
      type: "procedural",
      agentId: row.agent_id,
      scope: normalizeScope(row.scope),
      name: row.name,
      description: this.decryptValue(row.agent_id, row.description) ?? "",
      trigger: this.decryptValue(row.agent_id, row.trigger) ?? "",
      steps: normalizeArray(row.steps, []),
      inputs: normalizeArray(row.inputs, []),
      outputs: normalizeArray(row.outputs, []),
      successRate: toNumber(row.success_rate, 1),
      executionCount: toNumber(row.execution_count, 0),
      version: toNumber(row.version, 1),
      active: row.active,
      importance: toNumber(row.importance, 0.5),
      strength: toNumber(row.strength, 1),
      accessCount: toNumber(row.access_count, 0),
      createdAt: row.created_at,
      lastAccessedAt: row.last_accessed_at,
      tags: normalizeTags(row.tags),
      metadata: normalizeMetadata(row.metadata),
    };
  }

  private async queryByText(
    agentId: AgentId,
    query: MemoryQuery,
    limit: number,
    types: Array<"episodic" | "semantic" | "procedural">
  ): Promise<{ memories: Memory[]; total: number }> {
    const memories: Memory[] = [];
    let total = 0;

    if (types.includes("episodic")) {
      const result = await this.queryEpisodic(agentId, query, limit);
      memories.push(...result.memories);
      total += result.total;
    }
    if (types.includes("semantic")) {
      const result = await this.querySemantic(agentId, query, limit);
      memories.push(...result.memories);
      total += result.total;
    }
    if (types.includes("procedural")) {
      const result = await this.queryProcedural(agentId, query, limit);
      memories.push(...result.memories);
      total += result.total;
    }

    memories.sort((a, b) => b.importance * b.strength - a.importance * a.strength);
    return {
      memories: memories.slice(0, limit),
      total,
    };
  }

  private async queryByVector(
    agentId: AgentId,
    query: MemoryQuery,
    limit: number,
    types: Array<"episodic" | "semantic" | "procedural">
  ): Promise<{ memories: Memory[]; total: number }> {
    if (!query.embedding || !this.vectorStore) {
      return { memories: [], total: 0 };
    }

    const filters: SearchFilter[] = [
      { field: "agentId", match: agentId },
    ];

    if (types.length > 0) {
      filters.push({ field: "type", matchAny: types });
    }
    if (query.tags && query.tags.length > 0) {
      filters.push({ field: "tags", matchAny: query.tags });
    }
    if (query.minImportance !== undefined) {
      filters.push({ field: "importance", range: { gte: query.minImportance } });
    }
    if (query.minStrength !== undefined) {
      filters.push({ field: "strength", range: { gte: query.minStrength } });
    }

    const results = await this.vectorStore.search(query.embedding, {
      limit,
      filter: filters,
      scoreThreshold: query.minSimilarity ?? 0,
    });

    if (results.length === 0) {
      return { memories: [], total: 0 };
    }

    const scores = new Map<string, number>();
    const episodicIds: string[] = [];
    const semanticIds: string[] = [];
    const proceduralIds: string[] = [];

    for (const result of results) {
      scores.set(result.id, result.score);
      const type = result.payload.type;
      if (type === "episodic") {
        episodicIds.push(result.id);
      } else if (type === "semantic") {
        semanticIds.push(result.id);
      } else if (type === "procedural") {
        proceduralIds.push(result.id);
      }
    }

    const memories: Memory[] = [];
    memories.push(...(await this.loadEpisodicByIds(episodicIds)));
    memories.push(...(await this.loadSemanticByIds(semanticIds)));
    memories.push(...(await this.loadProceduralByIds(proceduralIds)));

    const filtered = this.applyTimeFilters(memories, query);
    filtered.sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0));

    return { memories: filtered.slice(0, limit), total: results.length };
  }

  private applyTimeFilters(memories: Memory[], query: MemoryQuery): Memory[] {
    return memories.filter((memory) => {
      if (query.after && memory.createdAt < query.after) return false;
      if (query.before && memory.createdAt > query.before) return false;
      return true;
    });
  }

  private async queryEpisodic(
    agentId: AgentId,
    query: MemoryQuery,
    limit: number
  ): Promise<{ memories: EpisodicMemory[]; total: number }> {
    const searchText = query.query && !this.encryptionEnabled ? `%${query.query}%` : null;
    if (query.query && this.encryptionEnabled) {
      this.log.warn("Text search disabled when memory encryption is enabled", {
        agentId,
        type: "episodic",
      });
    }
    const rows = await this.db.query<EpisodicRow>((sql) => {
      const conditions = [sql`agent_id = ${agentId}`];
      if (query.minImportance !== undefined) {
        conditions.push(sql`importance >= ${query.minImportance}`);
      }
      if (query.minStrength !== undefined) {
        conditions.push(sql`strength >= ${query.minStrength}`);
      }
      if (query.after) {
        conditions.push(sql`created_at >= ${query.after}`);
      }
      if (query.before) {
        conditions.push(sql`created_at <= ${query.before}`);
      }
      if (query.tags && query.tags.length > 0) {
        conditions.push(sql`tags && ${sql.array(query.tags)}`);
      }
      if (searchText) {
        conditions.push(
          sql`(event ILIKE ${searchText} OR context ILIKE ${searchText} OR outcome ILIKE ${searchText})`
        );
      }

      let where = sql``;
      if (conditions.length > 0) {
        let combined = conditions[0]!;
        for (let i = 1; i < conditions.length; i++) {
          combined = sql`${combined} AND ${conditions[i]!}`;
        }
        where = sql`WHERE ${combined}`;
      }

      return sql`
        SELECT *
        FROM episodic_memories
        ${where}
        ORDER BY importance DESC, strength DESC
        LIMIT ${limit}
      `;
    });

    const countResult = await this.db.queryOne<{ count: number | string }>((sql) => {
      const conditions = [sql`agent_id = ${agentId}`];
      if (query.minImportance !== undefined) {
        conditions.push(sql`importance >= ${query.minImportance}`);
      }
      if (query.minStrength !== undefined) {
        conditions.push(sql`strength >= ${query.minStrength}`);
      }
      if (query.after) {
        conditions.push(sql`created_at >= ${query.after}`);
      }
      if (query.before) {
        conditions.push(sql`created_at <= ${query.before}`);
      }
      if (query.tags && query.tags.length > 0) {
        conditions.push(sql`tags && ${sql.array(query.tags)}`);
      }
      if (searchText) {
        conditions.push(
          sql`(event ILIKE ${searchText} OR context ILIKE ${searchText} OR outcome ILIKE ${searchText})`
        );
      }

      let where = sql``;
      if (conditions.length > 0) {
        let combined = conditions[0]!;
        for (let i = 1; i < conditions.length; i++) {
          combined = sql`${combined} AND ${conditions[i]!}`;
        }
        where = sql`WHERE ${combined}`;
      }

      return sql`
        SELECT COUNT(*) AS count
        FROM episodic_memories
        ${where}
      `;
    });

    return {
      memories: rows.map((row) => this.mapEpisodicRow(row)),
      total: toNumber(countResult?.count),
    };
  }

  private deriveAgentKey(agentId: AgentId): Buffer | null {
    if (!this.encryptionKey) return null;
    // Use scrypt KDF with agent-specific salt for proper key derivation
    const salt = createHmac("sha256", "agentkernel-memory-salt").update(agentId).digest();
    return scryptSync(this.encryptionKey, salt, 32, { N: 16384, r: 8, p: 1 });
  }

  private encryptValue(agentId: AgentId, value?: string | null): string | null {
    if (value === null || value === undefined) return value ?? null;
    if (!this.encryptionEnabled) return value;
    if (value.startsWith(ENCRYPTION_PREFIX)) return value;
    const key = this.deriveAgentKey(agentId);
    if (!key) return value;
    try {
      const iv = randomBytes(ENCRYPTION_IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `${ENCRYPTION_PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
    } catch (error) {
      this.log.warn("Failed to encrypt memory value", {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return value;
    }
  }

  private decryptValue(agentId: AgentId, value?: string | null): string | undefined {
    if (value === null || value === undefined) return value ?? undefined;
    if (!this.encryptionEnabled) return value;
    if (!value.startsWith(ENCRYPTION_PREFIX)) return value;
    const key = this.deriveAgentKey(agentId);
    if (!key) return value;
    try {
      const payload = value.slice(ENCRYPTION_PREFIX.length);
      const parts = payload.split(":");
      if (parts.length !== 3) return value;
      const [ivPart, tagPart, cipherPart] = parts;
      if (!ivPart || !tagPart || !cipherPart) return value;
      const iv = Buffer.from(ivPart, "base64");
      const tag = Buffer.from(tagPart, "base64");
      const ciphertext = Buffer.from(cipherPart, "base64");
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch (error) {
      this.log.warn("Failed to decrypt memory value", {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return value;
    }
  }

  private async querySemantic(
    agentId: AgentId,
    query: MemoryQuery,
    limit: number
  ): Promise<{ memories: SemanticMemory[]; total: number }> {
    const searchText = query.query && !this.encryptionEnabled ? `%${query.query}%` : null;
    if (query.query && this.encryptionEnabled) {
      this.log.warn("Text search disabled when memory encryption is enabled", {
        agentId,
        type: "semantic",
      });
    }
    const rows = await this.db.query<SemanticRow>((sql) => {
      const conditions = [sql`agent_id = ${agentId}`];
      if (query.minImportance !== undefined) {
        conditions.push(sql`importance >= ${query.minImportance}`);
      }
      if (query.minStrength !== undefined) {
        conditions.push(sql`strength >= ${query.minStrength}`);
      }
      if (query.after) {
        conditions.push(sql`created_at >= ${query.after}`);
      }
      if (query.before) {
        conditions.push(sql`created_at <= ${query.before}`);
      }
      if (query.tags && query.tags.length > 0) {
        conditions.push(sql`tags && ${sql.array(query.tags)}`);
      }
      if (searchText) {
        conditions.push(
          sql`(subject ILIKE ${searchText} OR predicate ILIKE ${searchText} OR object ILIKE ${searchText})`
        );
      }

      let where = sql``;
      if (conditions.length > 0) {
        let combined = conditions[0]!;
        for (let i = 1; i < conditions.length; i++) {
          combined = sql`${combined} AND ${conditions[i]!}`;
        }
        where = sql`WHERE ${combined}`;
      }

      return sql`
        SELECT *
        FROM semantic_memories
        ${where}
        ORDER BY importance DESC, strength DESC
        LIMIT ${limit}
      `;
    });

    const countResult = await this.db.queryOne<{ count: number | string }>((sql) => {
      const conditions = [sql`agent_id = ${agentId}`];
      if (query.minImportance !== undefined) {
        conditions.push(sql`importance >= ${query.minImportance}`);
      }
      if (query.minStrength !== undefined) {
        conditions.push(sql`strength >= ${query.minStrength}`);
      }
      if (query.after) {
        conditions.push(sql`created_at >= ${query.after}`);
      }
      if (query.before) {
        conditions.push(sql`created_at <= ${query.before}`);
      }
      if (query.tags && query.tags.length > 0) {
        conditions.push(sql`tags && ${sql.array(query.tags)}`);
      }
      if (searchText) {
        conditions.push(
          sql`(subject ILIKE ${searchText} OR predicate ILIKE ${searchText} OR object ILIKE ${searchText})`
        );
      }

      let where = sql``;
      if (conditions.length > 0) {
        let combined = conditions[0]!;
        for (let i = 1; i < conditions.length; i++) {
          combined = sql`${combined} AND ${conditions[i]!}`;
        }
        where = sql`WHERE ${combined}`;
      }

      return sql`
        SELECT COUNT(*) AS count
        FROM semantic_memories
        ${where}
      `;
    });

    return {
      memories: rows.map((row) => this.mapSemanticRow(row)),
      total: toNumber(countResult?.count),
    };
  }

  private async queryProcedural(
    agentId: AgentId,
    query: MemoryQuery,
    limit: number
  ): Promise<{ memories: ProceduralMemory[]; total: number }> {
    const searchText = query.query && !this.encryptionEnabled ? `%${query.query}%` : null;
    if (query.query && this.encryptionEnabled) {
      this.log.warn("Text search disabled when memory encryption is enabled", {
        agentId,
        type: "procedural",
      });
    }
    const rows = await this.db.query<ProceduralRow>((sql) => {
      const conditions = [sql`agent_id = ${agentId}`];
      if (query.minImportance !== undefined) {
        conditions.push(sql`importance >= ${query.minImportance}`);
      }
      if (query.minStrength !== undefined) {
        conditions.push(sql`strength >= ${query.minStrength}`);
      }
      if (query.after) {
        conditions.push(sql`created_at >= ${query.after}`);
      }
      if (query.before) {
        conditions.push(sql`created_at <= ${query.before}`);
      }
      if (query.tags && query.tags.length > 0) {
        conditions.push(sql`tags && ${sql.array(query.tags)}`);
      }
      if (searchText) {
        conditions.push(
          sql`(name ILIKE ${searchText} OR description ILIKE ${searchText} OR trigger ILIKE ${searchText})`
        );
      }

      let where = sql``;
      if (conditions.length > 0) {
        let combined = conditions[0]!;
        for (let i = 1; i < conditions.length; i++) {
          combined = sql`${combined} AND ${conditions[i]!}`;
        }
        where = sql`WHERE ${combined}`;
      }

      return sql`
        SELECT *
        FROM procedural_memories
        ${where}
        ORDER BY importance DESC, strength DESC
        LIMIT ${limit}
      `;
    });

    const countResult = await this.db.queryOne<{ count: number | string }>((sql) => {
      const conditions = [sql`agent_id = ${agentId}`];
      if (query.minImportance !== undefined) {
        conditions.push(sql`importance >= ${query.minImportance}`);
      }
      if (query.minStrength !== undefined) {
        conditions.push(sql`strength >= ${query.minStrength}`);
      }
      if (query.after) {
        conditions.push(sql`created_at >= ${query.after}`);
      }
      if (query.before) {
        conditions.push(sql`created_at <= ${query.before}`);
      }
      if (query.tags && query.tags.length > 0) {
        conditions.push(sql`tags && ${sql.array(query.tags)}`);
      }
      if (searchText) {
        conditions.push(
          sql`(name ILIKE ${searchText} OR description ILIKE ${searchText} OR trigger ILIKE ${searchText})`
        );
      }

      let where = sql``;
      if (conditions.length > 0) {
        let combined = conditions[0]!;
        for (let i = 1; i < conditions.length; i++) {
          combined = sql`${combined} AND ${conditions[i]!}`;
        }
        where = sql`WHERE ${combined}`;
      }

      return sql`
        SELECT COUNT(*) AS count
        FROM procedural_memories
        ${where}
      `;
    });

    return {
      memories: rows.map((row) => this.mapProceduralRow(row)),
      total: toNumber(countResult?.count),
    };
  }

  private async loadEpisodicByIds(ids: string[]): Promise<EpisodicMemory[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.query<EpisodicRow>((sql) => sql`
      SELECT *
      FROM episodic_memories
      WHERE id = ANY(${sql.array(ids)})
    `);
    return rows.map((row) => this.mapEpisodicRow(row));
  }

  private async loadSemanticByIds(ids: string[]): Promise<SemanticMemory[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.query<SemanticRow>((sql) => sql`
      SELECT *
      FROM semantic_memories
      WHERE id = ANY(${sql.array(ids)})
    `);
    return rows.map((row) => this.mapSemanticRow(row));
  }

  private async loadProceduralByIds(ids: string[]): Promise<ProceduralMemory[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.query<ProceduralRow>((sql) => sql`
      SELECT *
      FROM procedural_memories
      WHERE id = ANY(${sql.array(ids)})
    `);
    return rows.map((row) => this.mapProceduralRow(row));
  }

  private async updateStrengthForAgent(agentId: AgentId, multiplier: number): Promise<number> {
    const episodic = await this.db.query<{ id: string }>((sql) => sql`
      UPDATE episodic_memories
      SET strength = strength * ${multiplier}
      WHERE agent_id = ${agentId}
      RETURNING id
    `);

    const semantic = await this.db.query<{ id: string }>((sql) => sql`
      UPDATE semantic_memories
      SET strength = strength * ${multiplier}
      WHERE agent_id = ${agentId}
      RETURNING id
    `);

    const procedural = await this.db.query<{ id: string }>((sql) => sql`
      UPDATE procedural_memories
      SET strength = strength * ${multiplier}
      WHERE agent_id = ${agentId}
      RETURNING id
    `);

    return episodic.length + semantic.length + procedural.length;
  }

  private async pruneByStrength(agentId: AgentId, minStrength: number): Promise<number> {
    const episodic = await this.db.query<{ id: string }>((sql) => sql`
      DELETE FROM episodic_memories
      WHERE agent_id = ${agentId} AND strength < ${minStrength}
      RETURNING id
    `);

    const semantic = await this.db.query<{ id: string }>((sql) => sql`
      DELETE FROM semantic_memories
      WHERE agent_id = ${agentId} AND strength < ${minStrength}
      RETURNING id
    `);

    const procedural = await this.db.query<{ id: string }>((sql) => sql`
      DELETE FROM procedural_memories
      WHERE agent_id = ${agentId} AND strength < ${minStrength}
      RETURNING id
    `);

    return episodic.length + semantic.length + procedural.length;
  }

  private async upsertEmbedding(memory: Memory, id: MemoryId): Promise<void> {
    if (!this.vectorStore) return;
    if (this.encryptionEnabled) {
      this.log.warn("Skipping embedding storage while memory encryption is enabled", {
        memoryId: id,
        agentId: memory.agentId,
      });
      return;
    }

    if (memory.type !== "episodic" && memory.type !== "semantic") {
      return;
    }

    const embedding = memory.embedding;
    if (!embedding || embedding.length === 0) return;

    await this.vectorStore.upsert({
      id,
      vector: embedding,
      payload: {
        agentId: memory.agentId,
        type: memory.type,
        scope: memory.scope ?? "private",
        importance: memory.importance,
        strength: memory.strength,
        tags: memory.tags ?? [],
        createdAt: memory.createdAt.toISOString(),
      },
    });
  }

  private async attachEmbeddings(memories: Memory[]): Promise<void> {
    if (!this.vectorStore) return;
    if (this.encryptionEnabled) return;

    const ids = memories
      .filter((memory) => memory.type === "episodic" || memory.type === "semantic")
      .map((memory) => memory.id);

    if (ids.length === 0) return;

    const vectors = await this.vectorStore.getBatch(ids);
    const vectorMap = new Map<string, number[]>();
    for (const point of vectors) {
      vectorMap.set(point.id, point.vector);
    }

    for (const memory of memories) {
      if (memory.type === "episodic" || memory.type === "semantic") {
        const vector = vectorMap.get(memory.id);
        if (vector) {
          (memory as EpisodicMemory | SemanticMemory).embedding = vector;
        }
      }
    }
  }
}

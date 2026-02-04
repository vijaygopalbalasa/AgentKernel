// Memory Store — persistence layer for agent memories
// Starts with in-memory, can be swapped for Qdrant/PostgreSQL

import { randomUUID } from "crypto";
import { type Result, ok, err } from "@agentrun/shared";
import type { AgentId } from "@agentrun/runtime";
import type {
  MemoryId,
  EpisodicMemory,
  SemanticMemory,
  ProceduralMemory,
  MemoryQuery,
  MemoryQueryResult,
  MemoryStats,
  Strength,
  Importance,
} from "./types.js";

/** Union type for all memory types */
export type Memory = EpisodicMemory | SemanticMemory | ProceduralMemory;

// ─── ERROR CLASS ────────────────────────────────────────────

/** Memory error codes */
export type MemoryErrorCode =
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "STORE_ERROR"
  | "QUERY_ERROR";

/**
 * Error class for memory operations.
 */
export class MemoryError extends Error {
  constructor(
    message: string,
    public readonly code: MemoryErrorCode,
    public readonly memoryId?: MemoryId
  ) {
    super(message);
    this.name = "MemoryError";
  }
}

// ─── STORE INTERFACE ────────────────────────────────────────

/** Interface for memory storage backends */
export interface MemoryStore {
  // ─── CRUD Operations ───
  save(memory: Memory): Promise<Result<MemoryId, MemoryError>>;
  get(id: MemoryId): Promise<Result<Memory, MemoryError>>;
  update(id: MemoryId, updates: Partial<Memory>): Promise<Result<void, MemoryError>>;
  delete(id: MemoryId): Promise<Result<void, MemoryError>>;

  // ─── Query Operations ───
  query(agentId: AgentId, query: MemoryQuery): Promise<Result<MemoryQueryResult, MemoryError>>;
  getByAgent(agentId: AgentId, type?: Memory["type"]): Promise<Result<Memory[], MemoryError>>;

  // ─── Stats ───
  getStats(agentId: AgentId): Promise<Result<MemoryStats, MemoryError>>;

  // ─── Maintenance ───
  /** Decay strength of old memories */
  decayStrength(agentId: AgentId, decayRate: number): Promise<Result<number, MemoryError>>;
  /** Remove memories below strength threshold */
  prune(agentId: AgentId, minStrength: number): Promise<Result<number, MemoryError>>;
  /** Clear all memories for an agent */
  clear(agentId: AgentId): Promise<Result<void, MemoryError>>;
}

// ─── STRENGTH DECAY CALCULATION ──────────────────────────────

/** Calculate memory strength decay based on time and access */
export function calculateStrength(
  lastAccessedAt: Date,
  accessCount: number,
  baseStrength: Strength = 1.0,
  halfLifeHours: number = 24
): Strength {
  const now = new Date();
  const hoursSinceAccess = (now.getTime() - lastAccessedAt.getTime()) / (1000 * 60 * 60);

  // Exponential decay with access boost
  const decayFactor = Math.pow(0.5, hoursSinceAccess / halfLifeHours);
  const accessBoost = Math.log2(accessCount + 1) * 0.1; // Logarithmic boost

  return Math.min(1.0, baseStrength * decayFactor + accessBoost);
}

/** Calculate relevance score combining similarity, importance, and strength */
export function calculateRelevance(
  similarity: number,
  importance: Importance,
  strength: Strength,
  weights: { similarity: number; importance: number; strength: number } = {
    similarity: 0.5,
    importance: 0.3,
    strength: 0.2,
  }
): number {
  return (
    similarity * weights.similarity +
    importance * weights.importance +
    strength * weights.strength
  );
}

// ─── IN-MEMORY STORE IMPLEMENTATION ──────────────────────────

/**
 * Simple in-memory memory store for development/testing.
 * Replace with Qdrant + PostgreSQL for production.
 */
export class InMemoryStore implements MemoryStore {
  private memories: Map<MemoryId, Memory> = new Map();
  private agentIndex: Map<AgentId, Set<MemoryId>> = new Map();

  async save(memory: Memory): Promise<Result<MemoryId, MemoryError>> {
    const id = memory.id || randomUUID();
    const now = new Date();

    const entry: Memory = {
      ...memory,
      id,
      scope: memory.scope ?? "private",
      createdAt: memory.createdAt || now,
      lastAccessedAt: memory.lastAccessedAt || now,
      accessCount: memory.accessCount || 0,
      importance: memory.importance ?? 0.5,
      strength: memory.strength ?? 1.0,
    };

    this.memories.set(id, entry);

    // Update agent index
    if (!this.agentIndex.has(memory.agentId)) {
      this.agentIndex.set(memory.agentId, new Set());
    }
    this.agentIndex.get(memory.agentId)!.add(id);

    return ok(id);
  }

  async get(id: MemoryId): Promise<Result<Memory, MemoryError>> {
    const memory = this.memories.get(id);
    if (!memory) {
      return err(new MemoryError(`Memory not found: ${id}`, "NOT_FOUND", id));
    }

    // Update access stats
    memory.lastAccessedAt = new Date();
    memory.accessCount += 1;
    memory.strength = calculateStrength(memory.lastAccessedAt, memory.accessCount);

    return ok(memory);
  }

  async update(id: MemoryId, updates: Partial<Memory>): Promise<Result<void, MemoryError>> {
    const memory = this.memories.get(id);
    if (!memory) {
      return err(new MemoryError(`Memory not found: ${id}`, "NOT_FOUND", id));
    }

    // Merge updates (type-safe partial update)
    Object.assign(memory, updates, { id }); // Preserve ID
    return ok(undefined);
  }

  async delete(id: MemoryId): Promise<Result<void, MemoryError>> {
    const memory = this.memories.get(id);
    if (!memory) {
      return err(new MemoryError(`Memory not found: ${id}`, "NOT_FOUND", id));
    }

    this.memories.delete(id);
    this.agentIndex.get(memory.agentId)?.delete(id);
    return ok(undefined);
  }

  async query(agentId: AgentId, query: MemoryQuery): Promise<Result<MemoryQueryResult, MemoryError>> {
    const startTime = Date.now();
    const agentMemoryIds = this.agentIndex.get(agentId);

    if (!agentMemoryIds) {
      return ok({ memories: [], total: 0, queryTime: Date.now() - startTime });
    }

    let results: Memory[] = [];

    for (const id of agentMemoryIds) {
      const memory = this.memories.get(id);
      if (!memory) continue;

      // Filter by type
      if (query.types && !query.types.includes(memory.type)) continue;

      // Filter by importance
      if (query.minImportance !== undefined && memory.importance < query.minImportance) continue;

      // Filter by strength
      if (query.minStrength !== undefined && memory.strength < query.minStrength) continue;

      // Filter by time range
      if (query.after && memory.createdAt < query.after) continue;
      if (query.before && memory.createdAt > query.before) continue;

      // Filter by tags
      if (query.tags && query.tags.length > 0) {
        const memoryTags = memory.tags || [];
        if (!query.tags.some((tag) => memoryTags.includes(tag))) continue;
      }

      // Text search (simple substring match for in-memory)
      if (query.query) {
        const searchText = query.query.toLowerCase();
        const memoryText = this.getSearchableText(memory).toLowerCase();
        if (!memoryText.includes(searchText)) continue;
      }

      results.push(memory);
    }

    // Sort by relevance (importance * strength)
    results.sort((a, b) => b.importance * b.strength - a.importance * a.strength);

    const total = results.length;

    // Apply limit
    if (query.limit) {
      results = results.slice(0, query.limit);
    }

    // Remove embeddings if not requested
    if (!query.includeEmbeddings) {
      results = results.map((m) => {
        const { embedding, ...rest } = m as EpisodicMemory | SemanticMemory;
        return rest as Memory;
      });
    }

    return ok({
      memories: results,
      total,
      queryTime: Date.now() - startTime,
    });
  }

  async getByAgent(agentId: AgentId, type?: Memory["type"]): Promise<Result<Memory[], MemoryError>> {
    const result = await this.query(agentId, {
      types: type ? [type] : undefined,
    });

    if (!result.ok) return result;
    return ok(result.value.memories);
  }

  async getStats(agentId: AgentId): Promise<Result<MemoryStats, MemoryError>> {
    const memoriesResult = await this.getByAgent(agentId);
    if (!memoriesResult.ok) return memoriesResult;

    const memories = memoriesResult.value;

    const stats: MemoryStats = {
      agentId,
      episodicCount: 0,
      semanticCount: 0,
      proceduralCount: 0,
      totalCount: memories.length,
      averageImportance: 0,
      averageStrength: 0,
    };

    if (memories.length === 0) return ok(stats);

    let totalImportance = 0;
    let totalStrength = 0;
    let oldest: Date | undefined;
    let newest: Date | undefined;

    for (const memory of memories) {
      // Count by type
      if (memory.type === "episodic") stats.episodicCount++;
      else if (memory.type === "semantic") stats.semanticCount++;
      else if (memory.type === "procedural") stats.proceduralCount++;

      // Aggregate scores
      totalImportance += memory.importance;
      totalStrength += memory.strength;

      // Track dates
      if (!oldest || memory.createdAt < oldest) oldest = memory.createdAt;
      if (!newest || memory.createdAt > newest) newest = memory.createdAt;
    }

    stats.averageImportance = totalImportance / memories.length;
    stats.averageStrength = totalStrength / memories.length;
    stats.oldestMemory = oldest;
    stats.newestMemory = newest;

    return ok(stats);
  }

  async decayStrength(agentId: AgentId, decayRate: number): Promise<Result<number, MemoryError>> {
    const agentMemoryIds = this.agentIndex.get(agentId);
    if (!agentMemoryIds) return ok(0);

    let updated = 0;
    for (const id of agentMemoryIds) {
      const memory = this.memories.get(id);
      if (!memory) continue;

      const newStrength = memory.strength * (1 - decayRate);
      if (newStrength !== memory.strength) {
        memory.strength = newStrength;
        updated++;
      }
    }

    return ok(updated);
  }

  async prune(agentId: AgentId, minStrength: number): Promise<Result<number, MemoryError>> {
    const agentMemoryIds = this.agentIndex.get(agentId);
    if (!agentMemoryIds) return ok(0);

    const toDelete: MemoryId[] = [];
    for (const id of agentMemoryIds) {
      const memory = this.memories.get(id);
      if (memory && memory.strength < minStrength) {
        toDelete.push(id);
      }
    }

    for (const id of toDelete) {
      await this.delete(id);
    }

    return ok(toDelete.length);
  }

  async clear(agentId: AgentId): Promise<Result<void, MemoryError>> {
    const agentMemoryIds = this.agentIndex.get(agentId);
    if (!agentMemoryIds) return ok(undefined);

    for (const id of agentMemoryIds) {
      this.memories.delete(id);
    }
    this.agentIndex.delete(agentId);

    return ok(undefined);
  }

  /** Get searchable text from any memory type */
  private getSearchableText(memory: Memory): string {
    switch (memory.type) {
      case "episodic":
        return `${memory.event} ${memory.context} ${memory.outcome || ""}`;
      case "semantic":
        return `${memory.subject} ${memory.predicate} ${memory.object}`;
      case "procedural":
        return `${memory.name} ${memory.description} ${memory.trigger}`;
    }
  }
}

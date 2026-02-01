// Memory Store — persistence layer for agent memories
// Starts with in-memory, can be swapped for Qdrant/PostgreSQL

import { randomUUID } from "crypto";
import type { AgentId } from "@agent-os/runtime";
import type {
  MemoryId,
  EpisodicMemory,
  SemanticMemory,
  ProceduralMemory,
  MemoryQuery,
  MemoryQueryResult,
  MemoryStats,
  MemoryEntry,
  Importance,
  Strength,
} from "./types.js";

/** Union type for all memory types */
export type Memory = EpisodicMemory | SemanticMemory | ProceduralMemory;

/** Interface for memory storage backends */
export interface MemoryStore {
  // ─── CRUD Operations ───
  save(memory: Memory): Promise<MemoryId>;
  get(id: MemoryId): Promise<Memory | null>;
  update(id: MemoryId, updates: Partial<Memory>): Promise<boolean>;
  delete(id: MemoryId): Promise<boolean>;

  // ─── Query Operations ───
  query(agentId: AgentId, query: MemoryQuery): Promise<MemoryQueryResult>;
  getByAgent(agentId: AgentId, type?: Memory["type"]): Promise<Memory[]>;

  // ─── Stats ───
  getStats(agentId: AgentId): Promise<MemoryStats>;

  // ─── Maintenance ───
  /** Decay strength of old memories */
  decayStrength(agentId: AgentId, decayRate: number): Promise<number>;
  /** Remove memories below strength threshold */
  prune(agentId: AgentId, minStrength: number): Promise<number>;
  /** Clear all memories for an agent */
  clear(agentId: AgentId): Promise<void>;
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

  async save(memory: Memory): Promise<MemoryId> {
    const id = memory.id || `mem-${randomUUID().slice(0, 12)}`;
    const now = new Date();

    const entry: Memory = {
      ...memory,
      id,
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

    return id;
  }

  async get(id: MemoryId): Promise<Memory | null> {
    const memory = this.memories.get(id);
    if (!memory) return null;

    // Update access stats
    memory.lastAccessedAt = new Date();
    memory.accessCount += 1;
    memory.strength = calculateStrength(memory.lastAccessedAt, memory.accessCount);

    return memory;
  }

  async update(id: MemoryId, updates: Partial<Memory>): Promise<boolean> {
    const memory = this.memories.get(id);
    if (!memory) return false;

    // Merge updates (type-safe partial update)
    Object.assign(memory, updates, { id }); // Preserve ID
    return true;
  }

  async delete(id: MemoryId): Promise<boolean> {
    const memory = this.memories.get(id);
    if (!memory) return false;

    this.memories.delete(id);
    this.agentIndex.get(memory.agentId)?.delete(id);
    return true;
  }

  async query(agentId: AgentId, query: MemoryQuery): Promise<MemoryQueryResult> {
    const startTime = Date.now();
    const agentMemoryIds = this.agentIndex.get(agentId);

    if (!agentMemoryIds) {
      return { memories: [], total: 0, queryTime: Date.now() - startTime };
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

    return {
      memories: results,
      total,
      queryTime: Date.now() - startTime,
    };
  }

  async getByAgent(agentId: AgentId, type?: Memory["type"]): Promise<Memory[]> {
    const result = await this.query(agentId, {
      types: type ? [type] : undefined,
    });
    return result.memories;
  }

  async getStats(agentId: AgentId): Promise<MemoryStats> {
    const memories = await this.getByAgent(agentId);

    const stats: MemoryStats = {
      agentId,
      episodicCount: 0,
      semanticCount: 0,
      proceduralCount: 0,
      totalCount: memories.length,
      averageImportance: 0,
      averageStrength: 0,
    };

    if (memories.length === 0) return stats;

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

    return stats;
  }

  async decayStrength(agentId: AgentId, decayRate: number): Promise<number> {
    const agentMemoryIds = this.agentIndex.get(agentId);
    if (!agentMemoryIds) return 0;

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

    return updated;
  }

  async prune(agentId: AgentId, minStrength: number): Promise<number> {
    const agentMemoryIds = this.agentIndex.get(agentId);
    if (!agentMemoryIds) return 0;

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

    return toDelete.length;
  }

  async clear(agentId: AgentId): Promise<void> {
    const agentMemoryIds = this.agentIndex.get(agentId);
    if (!agentMemoryIds) return;

    for (const id of agentMemoryIds) {
      this.memories.delete(id);
    }
    this.agentIndex.delete(agentId);
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

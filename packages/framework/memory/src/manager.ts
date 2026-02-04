// Memory Manager — high-level API for agent memory operations
// Like Android's ContentProvider but for agent memories

import { randomUUID } from "crypto";
import { z } from "zod";
import { type Result, ok, err } from "@agentrun/shared";
import { type Logger, createLogger } from "@agentrun/kernel";
import type { AgentId } from "@agentrun/runtime";
import type {
  MemoryId,
  EpisodicMemory,
  SemanticMemory,
  ProceduralMemory,
  MemoryQuery,
  MemoryQueryResult,
  MemoryStats,
  WorkingMemory,
  WorkingMemoryItem,
  KnowledgeTriple,
  ProcedureStep,
  Importance,
  EpisodeInput,
  FactInput,
  ProcedureInput,
} from "./types.js";
import {
  EpisodeInputSchema,
  FactInputSchema,
  ProcedureInputSchema,
  KnowledgeTripleSchema,
  MemoryQuerySchema,
} from "./types.js";
import { type MemoryStore, type Memory, InMemoryStore, MemoryError } from "./store.js";

// ─── MANAGER OPTIONS ────────────────────────────────────────

/** Options schema for the memory manager */
export const MemoryManagerOptionsSchema = z.object({
  /** Working memory capacity (default: 10) */
  workingMemoryCapacity: z.number().int().min(1).optional(),
  /** Enable automatic strength decay */
  enableDecay: z.boolean().optional(),
  /** Decay interval in ms (default: 1 hour) */
  decayIntervalMs: z.number().int().min(1000).optional(),
  /** Decay rate per interval (default: 0.1) */
  decayRate: z.number().min(0).max(1).optional(),
  /** Minimum strength before pruning (default: 0.1) */
  pruneThreshold: z.number().min(0).max(1).optional(),
});

/** Options for the memory manager */
export interface MemoryManagerOptions {
  /** Memory store backend */
  store?: MemoryStore;
  /** Working memory capacity (default: 10) */
  workingMemoryCapacity?: number;
  /** Enable automatic strength decay */
  enableDecay?: boolean;
  /** Decay interval in ms (default: 1 hour) */
  decayIntervalMs?: number;
  /** Decay rate per interval (default: 0.1) */
  decayRate?: number;
  /** Minimum strength before pruning (default: 0.1) */
  pruneThreshold?: number;
}

/**
 * Memory Manager — the main interface for agent memory operations.
 * Provides high-level methods for storing, retrieving, and managing
 * episodic, semantic, and procedural memories.
 */
export class MemoryManager {
  private store: MemoryStore;
  private workingMemories: Map<AgentId, WorkingMemory> = new Map();
  private options: Required<Omit<MemoryManagerOptions, "store">>;
  private decayTimer?: ReturnType<typeof setInterval>;
  private log: Logger;

  constructor(options: MemoryManagerOptions = {}) {
    this.store = options.store ?? new InMemoryStore();
    this.options = {
      workingMemoryCapacity: options.workingMemoryCapacity ?? 10,
      enableDecay: options.enableDecay ?? false,
      decayIntervalMs: options.decayIntervalMs ?? 60 * 60 * 1000, // 1 hour
      decayRate: options.decayRate ?? 0.1,
      pruneThreshold: options.pruneThreshold ?? 0.1,
    };
    this.log = createLogger({ name: "memory-manager" });

    // Start decay timer if enabled
    if (this.options.enableDecay) {
      this.startDecayTimer();
    }
  }

  // ─── EPISODIC MEMORY ─────────────────────────────────────────

  /**
   * Record an episode (event/interaction).
   * Use for: conversations, task completions, errors, learning moments.
   */
  async recordEpisode(
    agentId: AgentId,
    event: string,
    context: string,
    options: Omit<EpisodeInput, "event" | "context"> = {}
  ): Promise<Result<MemoryId, MemoryError>> {
    const input: EpisodeInput = { event, context, ...options };

    // Validate input
    const inputResult = EpisodeInputSchema.safeParse(input);
    if (!inputResult.success) {
      return err(
        new MemoryError(
          `Invalid episode input: ${inputResult.error.message}`,
          "VALIDATION_ERROR"
        )
      );
    }

    const memory: EpisodicMemory = {
      id: randomUUID(),
      type: "episodic",
      agentId,
      scope: options.scope ?? "private",
      event,
      context,
      outcome: options.outcome,
      success: options.success,
      importance: options.importance ?? this.calculateEpisodeImportance(event, options.success),
      strength: 1.0,
      embedding: options.embedding,
      tags: options.tags,
      sessionId: options.sessionId,
      relatedEpisodes: options.relatedEpisodes,
      createdAt: new Date(),
      lastAccessedAt: new Date(),
      accessCount: 0,
    };

    const result = await this.store.save(memory);
    if (result.ok) {
      this.log.debug("Episode recorded", { agentId, memoryId: result.value, event: event.slice(0, 50) });
    }
    return result;
  }

  /**
   * Recall episodes relevant to a query.
   */
  async recallEpisodes(
    agentId: AgentId,
    query: string,
    options: { limit?: number; minImportance?: number; sessionId?: string } = {}
  ): Promise<Result<EpisodicMemory[], MemoryError>> {
    const result = await this.store.query(agentId, {
      query,
      types: ["episodic"],
      limit: options.limit ?? 5,
      minImportance: options.minImportance,
    });

    if (!result.ok) return result;
    return ok(result.value.memories as EpisodicMemory[]);
  }

  // ─── SEMANTIC MEMORY ─────────────────────────────────────────

  /**
   * Store a fact/knowledge triple.
   * Use for: learned facts, user preferences, domain knowledge.
   */
  async storeFact(
    agentId: AgentId,
    subject: string,
    predicate: string,
    object: string,
    options: Omit<FactInput, "subject" | "predicate" | "object"> = {}
  ): Promise<Result<MemoryId, MemoryError>> {
    const input: FactInput = { subject, predicate, object, ...options };

    // Validate input
    const inputResult = FactInputSchema.safeParse(input);
    if (!inputResult.success) {
      return err(
        new MemoryError(
          `Invalid fact input: ${inputResult.error.message}`,
          "VALIDATION_ERROR"
        )
      );
    }

    // Check for existing fact with same triple
    const existingResult = await this.findFact(agentId, subject, predicate);
    if (existingResult.ok && existingResult.value) {
      const existing = existingResult.value;
      // Update existing fact
      const updateResult = await this.store.update(existing.id, {
        object,
        confidence: options.confidence ?? existing.confidence,
        verifiedAt: new Date(),
        lastAccessedAt: new Date(),
        accessCount: existing.accessCount + 1,
      });
      if (!updateResult.ok) return err(updateResult.error);

      this.log.debug("Fact updated", { agentId, memoryId: existing.id, subject, predicate });
      return ok(existing.id);
    }

    const memory: SemanticMemory = {
      id: randomUUID(),
      type: "semantic",
      agentId,
      scope: options.scope ?? "private",
      subject,
      predicate,
      object,
      confidence: options.confidence ?? 0.8,
      source: options.source,
      importance: options.importance ?? 0.5,
      strength: 1.0,
      embedding: options.embedding,
      tags: options.tags,
      createdAt: new Date(),
      lastAccessedAt: new Date(),
      accessCount: 0,
    };

    const result = await this.store.save(memory);
    if (result.ok) {
      this.log.debug("Fact stored", { agentId, memoryId: result.value, subject, predicate });
    }
    return result;
  }

  /**
   * Store multiple facts as knowledge triples.
   */
  async storeKnowledge(
    agentId: AgentId,
    triples: KnowledgeTriple[],
    options: { source?: string; tags?: string[] } = {}
  ): Promise<Result<MemoryId[], MemoryError>> {
    // Validate all triples
    for (const triple of triples) {
      const validResult = KnowledgeTripleSchema.safeParse(triple);
      if (!validResult.success) {
        return err(
          new MemoryError(
            `Invalid knowledge triple: ${validResult.error.message}`,
            "VALIDATION_ERROR"
          )
        );
      }
    }

    const ids: MemoryId[] = [];
    for (const triple of triples) {
      const result = await this.storeFact(
        agentId,
        triple.subject,
        triple.predicate,
        triple.object,
        {
          confidence: triple.confidence,
          source: options.source,
          tags: options.tags,
        }
      );
      if (!result.ok) return result;
      ids.push(result.value);
    }

    this.log.debug("Knowledge stored", { agentId, count: ids.length });
    return ok(ids);
  }

  /**
   * Find a specific fact by subject and predicate.
   */
  async findFact(
    agentId: AgentId,
    subject: string,
    predicate: string
  ): Promise<Result<SemanticMemory | null, MemoryError>> {
    const result = await this.store.query(agentId, {
      query: `${subject} ${predicate}`,
      types: ["semantic"],
      limit: 10,
    });

    if (!result.ok) return result;

    const facts = result.value.memories as SemanticMemory[];
    const found =
      facts.find(
        (f) =>
          f.subject.toLowerCase() === subject.toLowerCase() &&
          f.predicate.toLowerCase() === predicate.toLowerCase()
      ) ?? null;

    return ok(found);
  }

  /**
   * Query knowledge/facts relevant to a topic.
   */
  async queryKnowledge(
    agentId: AgentId,
    query: string,
    options: { limit?: number; minConfidence?: number } = {}
  ): Promise<Result<SemanticMemory[], MemoryError>> {
    const result = await this.store.query(agentId, {
      query,
      types: ["semantic"],
      limit: options.limit ?? 10,
    });

    if (!result.ok) return result;

    let facts = result.value.memories as SemanticMemory[];

    // Filter by confidence if specified
    if (options.minConfidence !== undefined) {
      facts = facts.filter((f) => f.confidence >= options.minConfidence!);
    }

    return ok(facts);
  }

  // ─── PROCEDURAL MEMORY ───────────────────────────────────────

  /**
   * Learn a new procedure/skill.
   * Use for: task templates, workflows, behavioral patterns.
   */
  async learnProcedure(
    agentId: AgentId,
    name: string,
    description: string,
    trigger: string,
    steps: ProcedureStep[],
    options: Omit<ProcedureInput, "name" | "description" | "trigger" | "steps"> = {}
  ): Promise<Result<MemoryId, MemoryError>> {
    const input: ProcedureInput = { name, description, trigger, steps, ...options };

    // Validate input
    const inputResult = ProcedureInputSchema.safeParse(input);
    if (!inputResult.success) {
      return err(
        new MemoryError(
          `Invalid procedure input: ${inputResult.error.message}`,
          "VALIDATION_ERROR"
        )
      );
    }

    // Check for existing procedure with same name
    const existingResult = await this.findProcedure(agentId, name);
    if (existingResult.ok && existingResult.value) {
      const existing = existingResult.value;
      // Update existing procedure (increment version)
      const updateResult = await this.store.update(existing.id, {
        description,
        trigger,
        steps,
        inputs: options.inputs,
        outputs: options.outputs,
        version: existing.version + 1,
        lastAccessedAt: new Date(),
      });
      if (!updateResult.ok) return err(updateResult.error);

      this.log.debug("Procedure updated", { agentId, memoryId: existing.id, name, version: existing.version + 1 });
      return ok(existing.id);
    }

    const memory: ProceduralMemory = {
      id: randomUUID(),
      type: "procedural",
      agentId,
      scope: options.scope ?? "private",
      name,
      description,
      trigger,
      steps,
      inputs: options.inputs,
      outputs: options.outputs,
      importance: options.importance ?? 0.7,
      strength: 1.0,
      successRate: 1.0,
      executionCount: 0,
      version: 1,
      active: true,
      tags: options.tags,
      createdAt: new Date(),
      lastAccessedAt: new Date(),
      accessCount: 0,
    };

    const result = await this.store.save(memory);
    if (result.ok) {
      this.log.debug("Procedure learned", { agentId, memoryId: result.value, name });
    }
    return result;
  }

  /**
   * Find a procedure by name.
   */
  async findProcedure(
    agentId: AgentId,
    name: string
  ): Promise<Result<ProceduralMemory | null, MemoryError>> {
    const result = await this.store.query(agentId, {
      types: ["procedural"],
      limit: 100,
    });

    if (!result.ok) return result;

    const procedures = result.value.memories as ProceduralMemory[];
    const found =
      procedures.find((p) => p.name.toLowerCase() === name.toLowerCase() && p.active) ?? null;

    return ok(found);
  }

  /**
   * Find procedures that match a trigger/situation.
   */
  async matchProcedures(
    agentId: AgentId,
    situation: string,
    options: { limit?: number; minSuccessRate?: number } = {}
  ): Promise<Result<ProceduralMemory[], MemoryError>> {
    const result = await this.store.query(agentId, {
      query: situation,
      types: ["procedural"],
      limit: options.limit ?? 5,
    });

    if (!result.ok) return result;

    let procedures = (result.value.memories as ProceduralMemory[]).filter((p) => p.active);

    // Filter by success rate if specified
    if (options.minSuccessRate !== undefined) {
      procedures = procedures.filter((p) => p.successRate >= options.minSuccessRate!);
    }

    return ok(procedures);
  }

  /**
   * Record procedure execution result (for learning).
   */
  async recordProcedureExecution(
    procedureId: MemoryId,
    success: boolean
  ): Promise<Result<void, MemoryError>> {
    const memoryResult = await this.store.get(procedureId);
    if (!memoryResult.ok) return memoryResult;

    const memory = memoryResult.value;
    if (memory.type !== "procedural") {
      return err(new MemoryError("Memory is not a procedure", "VALIDATION_ERROR", procedureId));
    }

    const procedure = memory as ProceduralMemory;
    const newExecutionCount = procedure.executionCount + 1;

    // Update success rate with exponential moving average
    const alpha = 0.1; // Weight for new observation
    const newSuccessRate = procedure.successRate * (1 - alpha) + (success ? 1 : 0) * alpha;

    const updateResult = await this.store.update(procedureId, {
      executionCount: newExecutionCount,
      successRate: newSuccessRate,
      lastAccessedAt: new Date(),
    });

    if (updateResult.ok) {
      this.log.debug("Procedure execution recorded", {
        procedureId,
        success,
        newSuccessRate: newSuccessRate.toFixed(2),
      });
    }

    return updateResult;
  }

  // ─── WORKING MEMORY ──────────────────────────────────────────

  /**
   * Get or create working memory for an agent.
   */
  getWorkingMemory(agentId: AgentId): WorkingMemory {
    let wm = this.workingMemories.get(agentId);
    if (!wm) {
      wm = {
        context: [],
        capacity: this.options.workingMemoryCapacity,
        updatedAt: new Date(),
      };
      this.workingMemories.set(agentId, wm);
    }
    return wm;
  }

  /**
   * Add an item to working memory.
   */
  addToWorkingMemory(
    agentId: AgentId,
    content: string,
    source: WorkingMemoryItem["source"],
    relevance: number,
    sourceId?: MemoryId
  ): void {
    const wm = this.getWorkingMemory(agentId);

    const item: WorkingMemoryItem = {
      content,
      source,
      sourceId,
      relevance,
      addedAt: new Date(),
    };

    // Add to context
    wm.context.push(item);

    // Sort by relevance and trim to capacity
    wm.context.sort((a, b) => b.relevance - a.relevance);
    if (wm.context.length > wm.capacity) {
      wm.context = wm.context.slice(0, wm.capacity);
    }

    wm.updatedAt = new Date();
  }

  /**
   * Set current task for an agent.
   */
  setCurrentTask(agentId: AgentId, task: string): void {
    const wm = this.getWorkingMemory(agentId);
    wm.currentTask = task;
    wm.updatedAt = new Date();
  }

  /**
   * Clear working memory for an agent.
   */
  clearWorkingMemory(agentId: AgentId): void {
    this.workingMemories.delete(agentId);
  }

  // ─── RECALL (UNIFIED QUERY) ──────────────────────────────────

  /**
   * Recall relevant memories across all types.
   * This is the main method agents should use for memory retrieval.
   */
  async recall(
    agentId: AgentId,
    query: string,
    options: {
      types?: Memory["type"][];
      limit?: number;
      minImportance?: number;
      embedding?: number[];
      minSimilarity?: number;
      includeEmbeddings?: boolean;
      includeWorkingMemory?: boolean;
    } = {}
  ): Promise<Result<{ memories: Memory[]; workingMemory?: WorkingMemory }, MemoryError>> {
    const result = await this.store.query(agentId, {
      query,
      types: options.types,
      limit: options.limit ?? 10,
      minImportance: options.minImportance,
      embedding: options.embedding,
      minSimilarity: options.minSimilarity,
      includeEmbeddings: options.includeEmbeddings,
    });

    if (!result.ok) return result;

    const response: { memories: Memory[]; workingMemory?: WorkingMemory } = {
      memories: result.value.memories,
    };

    // Include working memory if requested
    if (options.includeWorkingMemory) {
      response.workingMemory = this.getWorkingMemory(agentId);
    }

    return ok(response);
  }

  // ─── STATS & MAINTENANCE ─────────────────────────────────────

  /**
   * Get memory statistics for an agent.
   */
  async getStats(agentId: AgentId): Promise<Result<MemoryStats, MemoryError>> {
    return this.store.getStats(agentId);
  }

  /**
   * Clear all memories for an agent.
   */
  async clearMemories(agentId: AgentId): Promise<Result<void, MemoryError>> {
    const result = await this.store.clear(agentId);
    if (result.ok) {
      this.clearWorkingMemory(agentId);
      this.log.info("Memories cleared", { agentId });
    }
    return result;
  }

  /**
   * Low-level memory search with full query options.
   */
  async search(
    agentId: AgentId,
    query: MemoryQuery
  ): Promise<Result<MemoryQueryResult, MemoryError>> {
    const queryResult = MemoryQuerySchema.safeParse(query);
    if (!queryResult.success) {
      return err(
        new MemoryError(
          `Invalid memory query: ${queryResult.error.message}`,
          "VALIDATION_ERROR"
        )
      );
    }

    return this.store.query(agentId, queryResult.data);
  }

  /**
   * Stop the memory manager (cleanup timers).
   */
  stop(): void {
    if (this.decayTimer) {
      clearInterval(this.decayTimer);
      this.decayTimer = undefined;
      this.log.debug("Memory manager stopped");
    }
  }

  // ─── PRIVATE METHODS ─────────────────────────────────────────

  /** Calculate importance for an episode based on content */
  private calculateEpisodeImportance(event: string, success?: boolean): Importance {
    let importance = 0.5;

    // Boost for explicit success/failure (learning opportunities)
    if (success === true) importance += 0.2;
    if (success === false) importance += 0.3; // Failures are valuable for learning

    // Boost for certain keywords
    const importantKeywords = ["error", "success", "learned", "important", "remember", "goal"];
    const eventLower = event.toLowerCase();
    for (const keyword of importantKeywords) {
      if (eventLower.includes(keyword)) {
        importance += 0.1;
      }
    }

    return Math.min(1.0, importance);
  }

  /** Start the decay timer for automatic strength decay */
  private startDecayTimer(): void {
    this.decayTimer = setInterval(async () => {
      // Decay and prune for all agents
      for (const agentId of this.workingMemories.keys()) {
        await this.store.decayStrength(agentId, this.options.decayRate);
        await this.store.prune(agentId, this.options.pruneThreshold);
      }
    }, this.options.decayIntervalMs);
  }
}

/** Factory function to create a memory manager */
export function createMemoryManager(options?: MemoryManagerOptions): MemoryManager {
  return new MemoryManager(options);
}

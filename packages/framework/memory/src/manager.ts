// Memory Manager — high-level API for agent memory operations
// Like Android's ContentProvider but for agent memories

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
  WorkingMemory,
  WorkingMemoryItem,
  KnowledgeTriple,
  ProcedureStep,
  Importance,
} from "./types.js";
import { type MemoryStore, type Memory, InMemoryStore, calculateRelevance } from "./store.js";

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
  private options: Required<MemoryManagerOptions>;
  private decayTimer?: ReturnType<typeof setInterval>;

  constructor(options: MemoryManagerOptions = {}) {
    this.store = options.store ?? new InMemoryStore();
    this.options = {
      store: this.store,
      workingMemoryCapacity: options.workingMemoryCapacity ?? 10,
      enableDecay: options.enableDecay ?? false,
      decayIntervalMs: options.decayIntervalMs ?? 60 * 60 * 1000, // 1 hour
      decayRate: options.decayRate ?? 0.1,
      pruneThreshold: options.pruneThreshold ?? 0.1,
    };

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
    options: {
      outcome?: string;
      success?: boolean;
      importance?: Importance;
      tags?: string[];
      sessionId?: string;
      relatedEpisodes?: MemoryId[];
    } = {}
  ): Promise<MemoryId> {
    const memory: EpisodicMemory = {
      id: `ep-${randomUUID().slice(0, 12)}`,
      type: "episodic",
      agentId,
      event,
      context,
      outcome: options.outcome,
      success: options.success,
      importance: options.importance ?? this.calculateEpisodeImportance(event, options.success),
      strength: 1.0,
      tags: options.tags,
      sessionId: options.sessionId,
      relatedEpisodes: options.relatedEpisodes,
      createdAt: new Date(),
      lastAccessedAt: new Date(),
      accessCount: 0,
    };

    return this.store.save(memory);
  }

  /**
   * Recall episodes relevant to a query.
   */
  async recallEpisodes(
    agentId: AgentId,
    query: string,
    options: { limit?: number; minImportance?: number; sessionId?: string } = {}
  ): Promise<EpisodicMemory[]> {
    const result = await this.store.query(agentId, {
      query,
      types: ["episodic"],
      limit: options.limit ?? 5,
      minImportance: options.minImportance,
    });

    return result.memories as EpisodicMemory[];
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
    options: {
      confidence?: number;
      source?: string;
      importance?: Importance;
      tags?: string[];
    } = {}
  ): Promise<MemoryId> {
    // Check for existing fact with same triple
    const existing = await this.findFact(agentId, subject, predicate);
    if (existing) {
      // Update existing fact
      await this.store.update(existing.id, {
        object,
        confidence: options.confidence ?? existing.confidence,
        verifiedAt: new Date(),
        lastAccessedAt: new Date(),
        accessCount: existing.accessCount + 1,
      });
      return existing.id;
    }

    const memory: SemanticMemory = {
      id: `sem-${randomUUID().slice(0, 12)}`,
      type: "semantic",
      agentId,
      subject,
      predicate,
      object,
      confidence: options.confidence ?? 0.8,
      source: options.source,
      importance: options.importance ?? 0.5,
      strength: 1.0,
      tags: options.tags,
      createdAt: new Date(),
      lastAccessedAt: new Date(),
      accessCount: 0,
    };

    return this.store.save(memory);
  }

  /**
   * Store multiple facts as knowledge triples.
   */
  async storeKnowledge(
    agentId: AgentId,
    triples: KnowledgeTriple[],
    options: { source?: string; tags?: string[] } = {}
  ): Promise<MemoryId[]> {
    const ids: MemoryId[] = [];
    for (const triple of triples) {
      const id = await this.storeFact(agentId, triple.subject, triple.predicate, triple.object, {
        confidence: triple.confidence,
        source: options.source,
        tags: options.tags,
      });
      ids.push(id);
    }
    return ids;
  }

  /**
   * Find a specific fact by subject and predicate.
   */
  async findFact(
    agentId: AgentId,
    subject: string,
    predicate: string
  ): Promise<SemanticMemory | null> {
    const result = await this.store.query(agentId, {
      query: `${subject} ${predicate}`,
      types: ["semantic"],
      limit: 10,
    });

    const facts = result.memories as SemanticMemory[];
    return (
      facts.find(
        (f) =>
          f.subject.toLowerCase() === subject.toLowerCase() &&
          f.predicate.toLowerCase() === predicate.toLowerCase()
      ) ?? null
    );
  }

  /**
   * Query knowledge/facts relevant to a topic.
   */
  async queryKnowledge(
    agentId: AgentId,
    query: string,
    options: { limit?: number; minConfidence?: number } = {}
  ): Promise<SemanticMemory[]> {
    const result = await this.store.query(agentId, {
      query,
      types: ["semantic"],
      limit: options.limit ?? 10,
    });

    let facts = result.memories as SemanticMemory[];

    // Filter by confidence if specified
    if (options.minConfidence !== undefined) {
      facts = facts.filter((f) => f.confidence >= options.minConfidence!);
    }

    return facts;
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
    options: {
      inputs?: ProceduralMemory["inputs"];
      outputs?: ProceduralMemory["outputs"];
      importance?: Importance;
      tags?: string[];
    } = {}
  ): Promise<MemoryId> {
    // Check for existing procedure with same name
    const existing = await this.findProcedure(agentId, name);
    if (existing) {
      // Update existing procedure (increment version)
      await this.store.update(existing.id, {
        description,
        trigger,
        steps,
        inputs: options.inputs,
        outputs: options.outputs,
        version: existing.version + 1,
        lastAccessedAt: new Date(),
      });
      return existing.id;
    }

    const memory: ProceduralMemory = {
      id: `proc-${randomUUID().slice(0, 12)}`,
      type: "procedural",
      agentId,
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

    return this.store.save(memory);
  }

  /**
   * Find a procedure by name.
   */
  async findProcedure(agentId: AgentId, name: string): Promise<ProceduralMemory | null> {
    const result = await this.store.query(agentId, {
      types: ["procedural"],
      limit: 100,
    });

    const procedures = result.memories as ProceduralMemory[];
    return (
      procedures.find((p) => p.name.toLowerCase() === name.toLowerCase() && p.active) ?? null
    );
  }

  /**
   * Find procedures that match a trigger/situation.
   */
  async matchProcedures(
    agentId: AgentId,
    situation: string,
    options: { limit?: number; minSuccessRate?: number } = {}
  ): Promise<ProceduralMemory[]> {
    const result = await this.store.query(agentId, {
      query: situation,
      types: ["procedural"],
      limit: options.limit ?? 5,
    });

    let procedures = (result.memories as ProceduralMemory[]).filter((p) => p.active);

    // Filter by success rate if specified
    if (options.minSuccessRate !== undefined) {
      procedures = procedures.filter((p) => p.successRate >= options.minSuccessRate!);
    }

    return procedures;
  }

  /**
   * Record procedure execution result (for learning).
   */
  async recordProcedureExecution(
    procedureId: MemoryId,
    success: boolean
  ): Promise<void> {
    const memory = await this.store.get(procedureId);
    if (!memory || memory.type !== "procedural") return;

    const procedure = memory as ProceduralMemory;
    const newExecutionCount = procedure.executionCount + 1;

    // Update success rate with exponential moving average
    const alpha = 0.1; // Weight for new observation
    const newSuccessRate = procedure.successRate * (1 - alpha) + (success ? 1 : 0) * alpha;

    await this.store.update(procedureId, {
      executionCount: newExecutionCount,
      successRate: newSuccessRate,
      lastAccessedAt: new Date(),
    });
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
      includeWorkingMemory?: boolean;
    } = {}
  ): Promise<{
    memories: Memory[];
    workingMemory?: WorkingMemory;
  }> {
    const result = await this.store.query(agentId, {
      query,
      types: options.types,
      limit: options.limit ?? 10,
      minImportance: options.minImportance,
    });

    const response: { memories: Memory[]; workingMemory?: WorkingMemory } = {
      memories: result.memories,
    };

    // Include working memory if requested
    if (options.includeWorkingMemory) {
      response.workingMemory = this.getWorkingMemory(agentId);
    }

    return response;
  }

  // ─── STATS & MAINTENANCE ─────────────────────────────────────

  /**
   * Get memory statistics for an agent.
   */
  async getStats(agentId: AgentId): Promise<MemoryStats> {
    return this.store.getStats(agentId);
  }

  /**
   * Clear all memories for an agent.
   */
  async clearMemories(agentId: AgentId): Promise<void> {
    await this.store.clear(agentId);
    this.clearWorkingMemory(agentId);
  }

  /**
   * Stop the memory manager (cleanup timers).
   */
  stop(): void {
    if (this.decayTimer) {
      clearInterval(this.decayTimer);
      this.decayTimer = undefined;
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

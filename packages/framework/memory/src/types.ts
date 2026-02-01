// Memory Types — the three pillars of agent memory
// Based on cognitive science: episodic, semantic, procedural

import type { AgentId } from "@agent-os/runtime";

/** Unique identifier for a memory entry */
export type MemoryId = string;

/** Memory importance score (0-1) */
export type Importance = number;

/** Memory strength (decays over time, increases with access) */
export type Strength = number;

/** Vector embedding for semantic similarity search */
export type Embedding = number[];

/** Base interface for all memory entries */
export interface MemoryEntry {
  /** Unique identifier */
  id: MemoryId;
  /** Owning agent */
  agentId: AgentId;
  /** When the memory was created */
  createdAt: Date;
  /** When the memory was last accessed */
  lastAccessedAt: Date;
  /** Number of times accessed */
  accessCount: number;
  /** Importance score (0-1, higher = more important) */
  importance: Importance;
  /** Strength score (decays over time, boosts with access) */
  strength: Strength;
  /** Optional tags for filtering */
  tags?: string[];
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

// ─── EPISODIC MEMORY ─────────────────────────────────────────

/**
 * Episodic Memory Entry — stores specific events/interactions.
 * "What happened" — captures full context of an interaction.
 * Used for learning from experience.
 */
export interface EpisodicMemory extends MemoryEntry {
  type: "episodic";
  /** The event/interaction that occurred */
  event: string;
  /** Context surrounding the event */
  context: string;
  /** Outcome or result of the event */
  outcome?: string;
  /** Whether this was a successful interaction */
  success?: boolean;
  /** Emotional valence (-1 to 1, negative to positive) */
  valence?: number;
  /** Related episode IDs (for threading) */
  relatedEpisodes?: MemoryId[];
  /** Session ID this episode belongs to */
  sessionId?: string;
  /** Vector embedding for similarity search */
  embedding?: Embedding;
}

// ─── SEMANTIC MEMORY ─────────────────────────────────────────

/**
 * Semantic Memory Entry — stores facts and knowledge.
 * "What I know" — generalized information, facts, rules.
 * Used for reasoning and retrieval.
 */
export interface SemanticMemory extends MemoryEntry {
  type: "semantic";
  /** The subject/topic of this knowledge */
  subject: string;
  /** The predicate/relationship */
  predicate: string;
  /** The object/value */
  object: string;
  /** Confidence score (0-1) */
  confidence: number;
  /** Source of this knowledge */
  source?: string;
  /** When this knowledge was verified */
  verifiedAt?: Date;
  /** Related concepts */
  relatedConcepts?: string[];
  /** Vector embedding for similarity search */
  embedding?: Embedding;
}

/** Triple representation for knowledge graph */
export interface KnowledgeTriple {
  subject: string;
  predicate: string;
  object: string;
  confidence?: number;
}

// ─── PROCEDURAL MEMORY ───────────────────────────────────────

/**
 * Procedural Memory Entry — stores skills and behaviors.
 * "How I do things" — learned procedures, patterns, workflows.
 * Used for task execution.
 */
export interface ProceduralMemory extends MemoryEntry {
  type: "procedural";
  /** Name of the skill/procedure */
  name: string;
  /** Description of what this procedure does */
  description: string;
  /** When to use this procedure (trigger conditions) */
  trigger: string;
  /** Steps to execute */
  steps: ProcedureStep[];
  /** Input parameters */
  inputs?: ProcedureParam[];
  /** Output format */
  outputs?: ProcedureParam[];
  /** Success rate (0-1) */
  successRate: number;
  /** Number of times executed */
  executionCount: number;
  /** Version for tracking updates */
  version: number;
  /** Whether this procedure is active */
  active: boolean;
}

/** A single step in a procedure */
export interface ProcedureStep {
  /** Step order (1-based) */
  order: number;
  /** Action to perform */
  action: string;
  /** Tool/skill to use */
  tool?: string;
  /** Expected result */
  expectedResult?: string;
  /** Error handling */
  onError?: "retry" | "skip" | "abort";
}

/** Parameter definition for procedures */
export interface ProcedureParam {
  name: string;
  type: "string" | "number" | "boolean" | "array" | "object";
  description?: string;
  required?: boolean;
  default?: unknown;
}

// ─── WORKING MEMORY ──────────────────────────────────────────

/**
 * Working Memory — short-term context buffer.
 * Holds currently relevant information for ongoing tasks.
 */
export interface WorkingMemory {
  /** Current task/goal */
  currentTask?: string;
  /** Active context items */
  context: WorkingMemoryItem[];
  /** Maximum items to retain */
  capacity: number;
  /** When the working memory was last updated */
  updatedAt: Date;
}

export interface WorkingMemoryItem {
  /** Content of the item */
  content: string;
  /** Source (episodic, semantic, procedural, or external) */
  source: "episodic" | "semantic" | "procedural" | "external";
  /** Reference to original memory (if applicable) */
  sourceId?: MemoryId;
  /** Relevance to current task (0-1) */
  relevance: number;
  /** When this was added to working memory */
  addedAt: Date;
}

// ─── MEMORY QUERY ────────────────────────────────────────────

/** Query for retrieving memories */
export interface MemoryQuery {
  /** Text to search for (semantic similarity) */
  query?: string;
  /** Memory types to search */
  types?: Array<"episodic" | "semantic" | "procedural">;
  /** Filter by tags */
  tags?: string[];
  /** Minimum importance threshold */
  minImportance?: number;
  /** Minimum strength threshold */
  minStrength?: number;
  /** Time range */
  after?: Date;
  before?: Date;
  /** Maximum results */
  limit?: number;
  /** Include embeddings in results */
  includeEmbeddings?: boolean;
}

/** Result of a memory query */
export interface MemoryQueryResult {
  memories: Array<EpisodicMemory | SemanticMemory | ProceduralMemory>;
  /** Total matching (before limit) */
  total: number;
  /** Query execution time in ms */
  queryTime: number;
}

// ─── MEMORY STATS ────────────────────────────────────────────

/** Statistics about an agent's memory */
export interface MemoryStats {
  agentId: AgentId;
  episodicCount: number;
  semanticCount: number;
  proceduralCount: number;
  totalCount: number;
  oldestMemory?: Date;
  newestMemory?: Date;
  averageImportance: number;
  averageStrength: number;
}

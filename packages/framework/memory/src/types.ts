// Memory Types — the three pillars of agent memory
// Based on cognitive science: episodic, semantic, procedural

import { z } from "zod";
import type { AgentId } from "@agentrun/runtime";

/** Unique identifier for a memory entry */
export type MemoryId = string;

/** Memory importance score (0-1) */
export type Importance = number;

/** Memory strength (decays over time, increases with access) */
export type Strength = number;

/** Vector embedding for semantic similarity search */
export type Embedding = number[];

/** Memory visibility scope */
export const MemoryScopeSchema = z.enum(["private", "shared", "public"]);
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

// ─── ZOD SCHEMAS ────────────────────────────────────────────

/** Base schema for all memory entries */
export const MemoryEntrySchema = z.object({
  /** Unique identifier */
  id: z.string().min(1),
  /** Owning agent */
  agentId: z.string().min(1),
  /** Visibility scope */
  scope: MemoryScopeSchema.default("private"),
  /** When the memory was created */
  createdAt: z.date(),
  /** When the memory was last accessed */
  lastAccessedAt: z.date(),
  /** Number of times accessed */
  accessCount: z.number().int().min(0),
  /** Importance score (0-1, higher = more important) */
  importance: z.number().min(0).max(1),
  /** Strength score (decays over time, boosts with access) */
  strength: z.number().min(0).max(1),
  /** Optional tags for filtering */
  tags: z.array(z.string()).optional(),
  /** Optional metadata */
  metadata: z.record(z.unknown()).optional(),
});

/** Base interface for all memory entries */
export interface MemoryEntry {
  /** Unique identifier */
  id: MemoryId;
  /** Owning agent */
  agentId: AgentId;
  /** Visibility scope */
  scope: MemoryScope;
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
export const EpisodicMemorySchema = MemoryEntrySchema.extend({
  type: z.literal("episodic"),
  /** The event/interaction that occurred */
  event: z.string().min(1),
  /** Context surrounding the event */
  context: z.string(),
  /** Outcome or result of the event */
  outcome: z.string().optional(),
  /** Whether this was a successful interaction */
  success: z.boolean().optional(),
  /** Emotional valence (-1 to 1, negative to positive) */
  valence: z.number().min(-1).max(1).optional(),
  /** Related episode IDs (for threading) */
  relatedEpisodes: z.array(z.string()).optional(),
  /** Session ID this episode belongs to */
  sessionId: z.string().optional(),
  /** Vector embedding for similarity search */
  embedding: z.array(z.number()).optional(),
});

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
export const SemanticMemorySchema = MemoryEntrySchema.extend({
  type: z.literal("semantic"),
  /** The subject/topic of this knowledge */
  subject: z.string().min(1),
  /** The predicate/relationship */
  predicate: z.string().min(1),
  /** The object/value */
  object: z.string().min(1),
  /** Confidence score (0-1) */
  confidence: z.number().min(0).max(1),
  /** Source of this knowledge */
  source: z.string().optional(),
  /** When this knowledge was verified */
  verifiedAt: z.date().optional(),
  /** Related concepts */
  relatedConcepts: z.array(z.string()).optional(),
  /** Vector embedding for similarity search */
  embedding: z.array(z.number()).optional(),
});

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
export const KnowledgeTripleSchema = z.object({
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
});

export interface KnowledgeTriple {
  subject: string;
  predicate: string;
  object: string;
  confidence?: number;
}

// ─── PROCEDURAL MEMORY ───────────────────────────────────────

/** A single step in a procedure */
export const ProcedureStepSchema = z.object({
  /** Step order (1-based) */
  order: z.number().int().min(1),
  /** Action to perform */
  action: z.string().min(1),
  /** Tool/skill to use */
  tool: z.string().optional(),
  /** Expected result */
  expectedResult: z.string().optional(),
  /** Error handling */
  onError: z.enum(["retry", "skip", "abort"]).optional(),
});

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
export const ProcedureParamSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["string", "number", "boolean", "array", "object"]),
  description: z.string().optional(),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
});

export interface ProcedureParam {
  name: string;
  type: "string" | "number" | "boolean" | "array" | "object";
  description?: string;
  required?: boolean;
  default?: unknown;
}

/**
 * Procedural Memory Entry — stores skills and behaviors.
 * "How I do things" — learned procedures, patterns, workflows.
 * Used for task execution.
 */
export const ProceduralMemorySchema = MemoryEntrySchema.extend({
  type: z.literal("procedural"),
  /** Name of the skill/procedure */
  name: z.string().min(1),
  /** Description of what this procedure does */
  description: z.string(),
  /** When to use this procedure (trigger conditions) */
  trigger: z.string(),
  /** Steps to execute */
  steps: z.array(ProcedureStepSchema),
  /** Input parameters */
  inputs: z.array(ProcedureParamSchema).optional(),
  /** Output format */
  outputs: z.array(ProcedureParamSchema).optional(),
  /** Success rate (0-1) */
  successRate: z.number().min(0).max(1),
  /** Number of times executed */
  executionCount: z.number().int().min(0),
  /** Version for tracking updates */
  version: z.number().int().min(1),
  /** Whether this procedure is active */
  active: z.boolean(),
});

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

// ─── WORKING MEMORY ──────────────────────────────────────────

/** Working memory item schema */
export const WorkingMemoryItemSchema = z.object({
  /** Content of the item */
  content: z.string(),
  /** Source (episodic, semantic, procedural, or external) */
  source: z.enum(["episodic", "semantic", "procedural", "external"]),
  /** Reference to original memory (if applicable) */
  sourceId: z.string().optional(),
  /** Relevance to current task (0-1) */
  relevance: z.number().min(0).max(1),
  /** When this was added to working memory */
  addedAt: z.date(),
});

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

/**
 * Working Memory — short-term context buffer.
 * Holds currently relevant information for ongoing tasks.
 */
export const WorkingMemorySchema = z.object({
  /** Current task/goal */
  currentTask: z.string().optional(),
  /** Active context items */
  context: z.array(WorkingMemoryItemSchema),
  /** Maximum items to retain */
  capacity: z.number().int().min(1),
  /** When the working memory was last updated */
  updatedAt: z.date(),
});

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

// ─── MEMORY QUERY ────────────────────────────────────────────

/** Query for retrieving memories */
export const MemoryQuerySchema = z.object({
  /** Text to search for (semantic similarity) */
  query: z.string().optional(),
  /** Optional embedding vector for similarity search */
  embedding: z.array(z.number()).optional(),
  /** Memory types to search */
  types: z.array(z.enum(["episodic", "semantic", "procedural"])).optional(),
  /** Filter by tags */
  tags: z.array(z.string()).optional(),
  /** Minimum importance threshold */
  minImportance: z.number().min(0).max(1).optional(),
  /** Minimum strength threshold */
  minStrength: z.number().min(0).max(1).optional(),
  /** Minimum similarity score when using embeddings */
  minSimilarity: z.number().min(0).max(1).optional(),
  /** Time range */
  after: z.date().optional(),
  before: z.date().optional(),
  /** Maximum results */
  limit: z.number().int().min(1).optional(),
  /** Include embeddings in results */
  includeEmbeddings: z.boolean().optional(),
});

export interface MemoryQuery {
  /** Text to search for (semantic similarity) */
  query?: string;
  /** Optional embedding vector for similarity search */
  embedding?: number[];
  /** Memory types to search */
  types?: Array<"episodic" | "semantic" | "procedural">;
  /** Filter by tags */
  tags?: string[];
  /** Minimum importance threshold */
  minImportance?: number;
  /** Minimum strength threshold */
  minStrength?: number;
  /** Minimum similarity score when using embeddings */
  minSimilarity?: number;
  /** Time range */
  after?: Date;
  before?: Date;
  /** Maximum results */
  limit?: number;
  /** Include embeddings in results */
  includeEmbeddings?: boolean;
}

/** Result of a memory query */
export const MemoryQueryResultSchema = z.object({
  memories: z.array(
    z.union([EpisodicMemorySchema, SemanticMemorySchema, ProceduralMemorySchema])
  ),
  /** Total matching (before limit) */
  total: z.number().int().min(0),
  /** Query execution time in ms */
  queryTime: z.number().min(0),
});

export interface MemoryQueryResult {
  memories: Array<EpisodicMemory | SemanticMemory | ProceduralMemory>;
  /** Total matching (before limit) */
  total: number;
  /** Query execution time in ms */
  queryTime: number;
}

// ─── MEMORY STATS ────────────────────────────────────────────

/** Statistics about an agent's memory */
export const MemoryStatsSchema = z.object({
  agentId: z.string().min(1),
  episodicCount: z.number().int().min(0),
  semanticCount: z.number().int().min(0),
  proceduralCount: z.number().int().min(0),
  totalCount: z.number().int().min(0),
  oldestMemory: z.date().optional(),
  newestMemory: z.date().optional(),
  averageImportance: z.number().min(0).max(1),
  averageStrength: z.number().min(0).max(1),
});

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

// ─── INPUT SCHEMAS (for validation) ─────────────────────────

/** Input for recording an episode */
export const EpisodeInputSchema = z.object({
  event: z.string().min(1),
  context: z.string(),
  scope: MemoryScopeSchema.optional(),
  outcome: z.string().optional(),
  success: z.boolean().optional(),
  importance: z.number().min(0).max(1).optional(),
  embedding: z.array(z.number()).optional(),
  tags: z.array(z.string()).optional(),
  sessionId: z.string().optional(),
  relatedEpisodes: z.array(z.string()).optional(),
});

export interface EpisodeInput {
  event: string;
  context: string;
  scope?: MemoryScope;
  outcome?: string;
  success?: boolean;
  importance?: Importance;
  embedding?: Embedding;
  tags?: string[];
  sessionId?: string;
  relatedEpisodes?: MemoryId[];
}

/** Input for storing a fact */
export const FactInputSchema = z.object({
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.string().min(1),
  scope: MemoryScopeSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  source: z.string().optional(),
  importance: z.number().min(0).max(1).optional(),
  embedding: z.array(z.number()).optional(),
  tags: z.array(z.string()).optional(),
});

export interface FactInput {
  subject: string;
  predicate: string;
  object: string;
  scope?: MemoryScope;
  confidence?: number;
  source?: string;
  importance?: Importance;
  embedding?: Embedding;
  tags?: string[];
}

/** Input for learning a procedure */
export const ProcedureInputSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  trigger: z.string(),
  scope: MemoryScopeSchema.optional(),
  steps: z.array(ProcedureStepSchema),
  inputs: z.array(ProcedureParamSchema).optional(),
  outputs: z.array(ProcedureParamSchema).optional(),
  importance: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).optional(),
});

export interface ProcedureInput {
  name: string;
  description: string;
  trigger: string;
  scope?: MemoryScope;
  steps: ProcedureStep[];
  inputs?: ProcedureParam[];
  outputs?: ProcedureParam[];
  importance?: Importance;
  tags?: string[];
}

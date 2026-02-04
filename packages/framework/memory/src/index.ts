// @agentkernel/memory — Agent Memory System (Layer 4: Framework)
// The KILLER FEATURE — episodic, semantic, procedural memory that persists

// ─── Types ──────────────────────────────────────────────────
export type {
  MemoryId,
  Importance,
  Strength,
  Embedding,
  MemoryScope,
  MemoryEntry,
  EpisodicMemory,
  SemanticMemory,
  ProceduralMemory,
  ProcedureStep,
  ProcedureParam,
  WorkingMemory,
  WorkingMemoryItem,
  MemoryQuery,
  MemoryQueryResult,
  MemoryStats,
  KnowledgeTriple,
  EpisodeInput,
  FactInput,
  ProcedureInput,
} from "./types.js";

// ─── Zod Schemas ────────────────────────────────────────────
export {
  MemoryEntrySchema,
  MemoryScopeSchema,
  EpisodicMemorySchema,
  SemanticMemorySchema,
  ProceduralMemorySchema,
  ProcedureStepSchema,
  ProcedureParamSchema,
  WorkingMemorySchema,
  WorkingMemoryItemSchema,
  MemoryQuerySchema,
  MemoryQueryResultSchema,
  MemoryStatsSchema,
  KnowledgeTripleSchema,
  EpisodeInputSchema,
  FactInputSchema,
  ProcedureInputSchema,
} from "./types.js";

// ─── Store ──────────────────────────────────────────────────
export {
  type Memory,
  type MemoryStore,
  type MemoryErrorCode,
  InMemoryStore,
  MemoryError,
  calculateStrength,
  calculateRelevance,
} from "./store.js";

export {
  type PersistentMemoryStoreOptions,
  PersistentMemoryStore,
  PersistentMemoryStore as PostgresMemoryStore,
} from "./persistent-store.js";

// ─── Manager ────────────────────────────────────────────────
export {
  MemoryManager,
  createMemoryManager,
  type MemoryManagerOptions,
  MemoryManagerOptionsSchema,
} from "./manager.js";

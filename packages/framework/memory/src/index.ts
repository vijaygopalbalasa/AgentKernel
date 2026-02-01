// @agent-os/memory — Agent Memory System (Layer 4: Framework)
// The KILLER FEATURE — episodic, semantic, procedural memory that persists

console.log("✅ @agent-os/memory loaded");

// Types
export type {
  MemoryId,
  Importance,
  Strength,
  Embedding,
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
} from "./types.js";

// Store
export {
  type Memory,
  type MemoryStore,
  InMemoryStore,
  calculateStrength,
  calculateRelevance,
} from "./store.js";

// Manager
export { MemoryManager, type MemoryManagerOptions } from "./manager.js";

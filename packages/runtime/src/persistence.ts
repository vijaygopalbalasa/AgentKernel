// Persistence — state checkpointing and recovery
// Enables agents to survive restarts

import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type AgentContext,
  type AgentId,
  type ResourceUsage,
  createInitialUsage,
} from "./agent-context.js";
import type { AgentManifest } from "./lifecycle.js";
import type { Capability, CapabilityGrant } from "./sandbox.js";
import type { AgentState, StateTransition } from "./state-machine.js";

/** Checkpoint data structure for an agent */
export interface AgentCheckpoint {
  /** Checkpoint version for migration */
  version: number;
  /** Agent ID */
  agentId: AgentId;
  /** Checkpoint timestamp */
  timestamp: Date;
  /** Current state */
  state: AgentState;
  /** State transition history */
  stateHistory: StateTransition[];
  /** Resource usage at checkpoint */
  usage: ResourceUsage;
  /** Original manifest */
  manifest: AgentManifest;
  /** Environment variables */
  env: Record<string, string>;
  /** Parent agent ID (if child) */
  parentId?: AgentId;
  /** When agent was created */
  createdAt: Date;
  /** Capability grants */
  capabilities: Array<{ capability: Capability; grant: CapabilityGrant }>;
  /** Custom agent data (opaque to runtime) */
  customData?: Record<string, unknown>;
}

/** Current checkpoint format version */
export const CHECKPOINT_VERSION = 1;

function migrateCheckpoint(checkpoint: AgentCheckpoint): AgentCheckpoint {
  if (checkpoint.version === CHECKPOINT_VERSION) {
    return checkpoint;
  }

  if (checkpoint.version > CHECKPOINT_VERSION) {
    throw new Error(
      `Checkpoint version ${checkpoint.version} is newer than supported version ${CHECKPOINT_VERSION}`,
    );
  }

  const migrated: AgentCheckpoint = {
    ...checkpoint,
    version: CHECKPOINT_VERSION,
    env: checkpoint.env ?? {},
    stateHistory: checkpoint.stateHistory ?? [],
    usage: checkpoint.usage ?? createInitialUsage(),
    capabilities: Array.isArray(checkpoint.capabilities) ? checkpoint.capabilities : [],
    createdAt: checkpoint.createdAt ?? checkpoint.timestamp ?? new Date(),
  };

  if (!migrated.state || !migrated.manifest) {
    throw new Error("Checkpoint missing required state or manifest for migration");
  }

  return migrated;
}

/** Persistence storage interface */
export interface PersistenceStorage {
  /** Save a checkpoint */
  save(agentId: AgentId, checkpoint: AgentCheckpoint): Promise<void>;
  /** Load a checkpoint */
  load(agentId: AgentId): Promise<AgentCheckpoint | null>;
  /** Delete a checkpoint */
  delete(agentId: AgentId): Promise<void>;
  /** List all checkpoint IDs */
  list(): Promise<AgentId[]>;
  /** Check if checkpoint exists */
  exists(agentId: AgentId): Promise<boolean>;
}

/** File-based persistence storage configuration */
export interface FilePersistenceConfig {
  /** Base directory for checkpoints */
  baseDir: string;
  /** File extension */
  extension?: string;
  /** Pretty-print JSON (for debugging) */
  prettyPrint?: boolean;
}

/**
 * File-based persistence storage.
 * Stores checkpoints as JSON files.
 */
export class FilePersistenceStorage implements PersistenceStorage {
  private readonly config: Required<FilePersistenceConfig>;
  private initialized = false;

  constructor(config: FilePersistenceConfig) {
    this.config = {
      baseDir: config.baseDir,
      extension: config.extension ?? ".checkpoint.json",
      prettyPrint: config.prettyPrint ?? false,
    };
  }

  /** Initialize storage directory */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    await mkdir(this.config.baseDir, { recursive: true });
    this.initialized = true;
  }

  /** Get file path for an agent checkpoint */
  private getPath(agentId: AgentId): string {
    // Sanitize agent ID for filesystem
    const safeName = agentId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.config.baseDir, `${safeName}${this.config.extension}`);
  }

  async save(agentId: AgentId, checkpoint: AgentCheckpoint): Promise<void> {
    await this.ensureInitialized();

    const path = this.getPath(agentId);
    await mkdir(dirname(path), { recursive: true });

    const data = this.config.prettyPrint
      ? JSON.stringify(checkpoint, null, 2)
      : JSON.stringify(checkpoint);

    await writeFile(path, data, "utf-8");
  }

  async load(agentId: AgentId): Promise<AgentCheckpoint | null> {
    await this.ensureInitialized();

    const path = this.getPath(agentId);

    try {
      const data = await readFile(path, "utf-8");
      const checkpoint = JSON.parse(data) as AgentCheckpoint;

      // Restore Date objects
      checkpoint.timestamp = new Date(checkpoint.timestamp);
      checkpoint.createdAt = new Date(checkpoint.createdAt);
      checkpoint.usage.minuteWindowStart = new Date(checkpoint.usage.minuteWindowStart);

      for (const transition of checkpoint.stateHistory) {
        transition.timestamp = new Date(transition.timestamp);
      }

      for (const cap of checkpoint.capabilities) {
        cap.grant.grantedAt = new Date(cap.grant.grantedAt);
        if (cap.grant.expiresAt) {
          cap.grant.expiresAt = new Date(cap.grant.expiresAt);
        }
      }

      return checkpoint;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async delete(agentId: AgentId): Promise<void> {
    await this.ensureInitialized();

    const path = this.getPath(agentId);

    try {
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      // File doesn't exist, that's fine
    }
  }

  async list(): Promise<AgentId[]> {
    await this.ensureInitialized();

    try {
      const files = await readdir(this.config.baseDir);
      return files
        .filter((f) => f.endsWith(this.config.extension))
        .map((f) => f.slice(0, -this.config.extension.length));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async exists(agentId: AgentId): Promise<boolean> {
    await this.ensureInitialized();

    const path = this.getPath(agentId);

    try {
      await readFile(path);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * In-memory persistence storage.
 * Useful for testing and ephemeral agents.
 */
export class MemoryPersistenceStorage implements PersistenceStorage {
  private readonly checkpoints: Map<AgentId, AgentCheckpoint> = new Map();

  async save(agentId: AgentId, checkpoint: AgentCheckpoint): Promise<void> {
    // Deep clone to prevent mutations
    this.checkpoints.set(agentId, JSON.parse(JSON.stringify(checkpoint)));
  }

  async load(agentId: AgentId): Promise<AgentCheckpoint | null> {
    const checkpoint = this.checkpoints.get(agentId);
    if (!checkpoint) return null;

    // Deep clone and restore dates
    const restored = JSON.parse(JSON.stringify(checkpoint)) as AgentCheckpoint;
    restored.timestamp = new Date(restored.timestamp);
    restored.createdAt = new Date(restored.createdAt);
    restored.usage.minuteWindowStart = new Date(restored.usage.minuteWindowStart);

    for (const transition of restored.stateHistory) {
      transition.timestamp = new Date(transition.timestamp);
    }

    for (const cap of restored.capabilities) {
      cap.grant.grantedAt = new Date(cap.grant.grantedAt);
      if (cap.grant.expiresAt) {
        cap.grant.expiresAt = new Date(cap.grant.expiresAt);
      }
    }

    return restored;
  }

  async delete(agentId: AgentId): Promise<void> {
    this.checkpoints.delete(agentId);
  }

  async list(): Promise<AgentId[]> {
    return Array.from(this.checkpoints.keys());
  }

  async exists(agentId: AgentId): Promise<boolean> {
    return this.checkpoints.has(agentId);
  }

  /** Clear all checkpoints (for testing) */
  clear(): void {
    this.checkpoints.clear();
  }
}

/** Persistence manager options */
export interface PersistenceManagerConfig {
  /** Storage backend */
  storage: PersistenceStorage;
  /** Auto-checkpoint interval in ms (0 = disabled) */
  autoCheckpointIntervalMs?: number;
  /** Max checkpoints to keep per agent (rolling) */
  maxCheckpointsPerAgent?: number;
}

/**
 * Persistence manager for agent checkpoints.
 * Coordinates checkpoint creation, storage, and recovery.
 */
export class PersistenceManager {
  private readonly storage: PersistenceStorage;
  private readonly config: Required<Omit<PersistenceManagerConfig, "storage">>;
  private autoCheckpointTimers: Map<AgentId, NodeJS.Timeout> = new Map();

  constructor(config: PersistenceManagerConfig) {
    this.storage = config.storage;
    this.config = {
      autoCheckpointIntervalMs: config.autoCheckpointIntervalMs ?? 0,
      maxCheckpointsPerAgent: config.maxCheckpointsPerAgent ?? 10,
    };
  }

  /**
   * Create a checkpoint for an agent.
   */
  async checkpoint(
    agentId: AgentId,
    data: Omit<AgentCheckpoint, "version" | "agentId" | "timestamp">,
  ): Promise<void> {
    const checkpoint: AgentCheckpoint = {
      version: CHECKPOINT_VERSION,
      agentId,
      timestamp: new Date(),
      ...data,
    };

    await this.storage.save(agentId, checkpoint);
  }

  /**
   * Recover an agent from checkpoint.
   * Returns null if no checkpoint exists.
   */
  async recover(agentId: AgentId): Promise<AgentCheckpoint | null> {
    const checkpoint = await this.storage.load(agentId);

    if (checkpoint) {
      const migrated = migrateCheckpoint(checkpoint);

      if (migrated.version !== checkpoint.version) {
        await this.storage.save(agentId, migrated);
      }

      return migrated;
    }

    return checkpoint;
  }

  /**
   * Delete checkpoint for an agent.
   */
  async deleteCheckpoint(agentId: AgentId): Promise<void> {
    await this.storage.delete(agentId);
    this.stopAutoCheckpoint(agentId);
  }

  /**
   * List all agents with checkpoints.
   */
  async listCheckpoints(): Promise<AgentId[]> {
    return this.storage.list();
  }

  /**
   * Check if agent has a checkpoint.
   */
  async hasCheckpoint(agentId: AgentId): Promise<boolean> {
    return this.storage.exists(agentId);
  }

  /**
   * Start auto-checkpointing for an agent.
   */
  startAutoCheckpoint(
    agentId: AgentId,
    getCheckpointData: () => Omit<AgentCheckpoint, "version" | "agentId" | "timestamp">,
  ): void {
    if (this.config.autoCheckpointIntervalMs <= 0) return;

    this.stopAutoCheckpoint(agentId);

    const timer = setInterval(async () => {
      try {
        await this.checkpoint(agentId, getCheckpointData());
      } catch (error) {
        // Log error but don't crash
        // In production, this would use the structured logger
      }
    }, this.config.autoCheckpointIntervalMs);

    this.autoCheckpointTimers.set(agentId, timer);
  }

  /**
   * Stop auto-checkpointing for an agent.
   */
  stopAutoCheckpoint(agentId: AgentId): void {
    const timer = this.autoCheckpointTimers.get(agentId);
    if (timer) {
      clearInterval(timer);
      this.autoCheckpointTimers.delete(agentId);
    }
  }

  /**
   * Stop all auto-checkpointing.
   */
  stopAllAutoCheckpoints(): void {
    for (const timer of this.autoCheckpointTimers.values()) {
      clearInterval(timer);
    }
    this.autoCheckpointTimers.clear();
  }

  /**
   * Create checkpoint from AgentContext.
   * Helper method for common use case.
   */
  createCheckpointData(
    context: AgentContext,
    stateHistory: StateTransition[],
    manifest: AgentManifest,
    capabilities: Array<{ capability: Capability; grant: CapabilityGrant }>,
    customData?: Record<string, unknown>,
  ): Omit<AgentCheckpoint, "version" | "agentId" | "timestamp"> {
    return {
      state: context.state,
      stateHistory,
      usage: { ...context.usage },
      manifest,
      env: { ...context.env },
      parentId: context.parentId,
      createdAt: context.createdAt,
      capabilities,
      customData,
    };
  }
}

/**
 * Create a file-based persistence manager.
 * Convenience factory function.
 */
export function createFilePersistence(
  baseDir: string,
  options?: Partial<Omit<PersistenceManagerConfig, "storage">>,
): PersistenceManager {
  const storage = new FilePersistenceStorage({ baseDir, prettyPrint: true });
  return new PersistenceManager({ storage, ...options });
}

/**
 * Create an in-memory persistence manager.
 * Useful for testing.
 */
export function createMemoryPersistence(
  options?: Partial<Omit<PersistenceManagerConfig, "storage">>,
): PersistenceManager {
  const storage = new MemoryPersistenceStorage();
  return new PersistenceManager({ storage, ...options });
}

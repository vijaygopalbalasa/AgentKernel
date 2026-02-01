// Skill Manager — manages skill installation and lifecycle
// The central manager for all skills on an agent

import type {
  SkillId,
  SkillManifest,
  SkillInstance,
  SkillState,
  SkillModule,
  SkillActivationContext,
  SkillInstallOptions,
  SkillEvent,
  SkillLogger,
} from "./types.js";
import type { ToolDefinition, ToolHandler, ToolRegistry } from "@agent-os/tools";

/** Skill manager configuration */
export interface SkillManagerConfig {
  /** Agent ID that owns this skill manager */
  agentId: string;
  /** Tool registry to register skill tools */
  toolRegistry: ToolRegistry;
  /** Data storage for skills */
  dataStore?: SkillDataStore;
}

/** Simple data store interface */
export interface SkillDataStore {
  get<T>(skillId: string, key: string): Promise<T | undefined>;
  set(skillId: string, key: string, value: unknown): Promise<void>;
  delete(skillId: string, key: string): Promise<void>;
  clear(skillId: string): Promise<void>;
}

/**
 * Skill Manager — manages skill installation, activation, and lifecycle.
 *
 * Features:
 * - Install skills from manifests or modules
 * - Activate/deactivate skills
 * - Manage skill dependencies
 * - Track skill state
 */
export class SkillManager {
  private config: SkillManagerConfig;
  private skills: Map<SkillId, SkillInstance> = new Map();
  private modules: Map<SkillId, SkillModule> = new Map();
  private skillConfigs: Map<SkillId, Record<string, unknown>> = new Map();
  private eventListeners: Array<(event: SkillEvent) => void> = [];

  constructor(config: SkillManagerConfig) {
    this.config = config;
  }

  /**
   * Install a skill from a module.
   */
  install(module: SkillModule, options: Partial<SkillInstallOptions> = {}): boolean {
    const { manifest } = module;

    // Check if already installed
    if (this.skills.has(manifest.id)) {
      return false;
    }

    // Validate manifest
    if (!manifest.id || !manifest.name || !manifest.version) {
      return false;
    }

    // Check dependencies
    if (!this.checkDependencies(manifest)) {
      return false;
    }

    // Create skill instance
    const instance: SkillInstance = {
      manifest,
      state: "installed",
      installedAt: new Date(),
      registeredTools: [],
    };

    this.skills.set(manifest.id, instance);
    this.modules.set(manifest.id, module);

    // Store config if provided
    if (options.config) {
      this.skillConfigs.set(manifest.id, options.config);
    }

    this.emit({
      type: "skill_installed",
      skillId: manifest.id,
      timestamp: new Date(),
      data: { manifest },
    });

    // Activate if requested
    if (options.activate) {
      this.activate(manifest.id);
    }

    return true;
  }

  /**
   * Uninstall a skill.
   */
  async uninstall(skillId: SkillId): Promise<boolean> {
    const instance = this.skills.get(skillId);
    if (!instance) {
      return false;
    }

    // Deactivate first if active
    if (instance.state === "active") {
      await this.deactivate(skillId);
    }

    // Clear skill data
    if (this.config.dataStore) {
      await this.config.dataStore.clear(skillId);
    }

    // Remove from maps
    this.skills.delete(skillId);
    this.modules.delete(skillId);
    this.skillConfigs.delete(skillId);

    this.emit({
      type: "skill_uninstalled",
      skillId,
      timestamp: new Date(),
    });

    return true;
  }

  /**
   * Activate a skill.
   */
  async activate(skillId: SkillId): Promise<boolean> {
    const instance = this.skills.get(skillId);
    const module = this.modules.get(skillId);

    if (!instance || !module) {
      return false;
    }

    if (instance.state === "active") {
      return true; // Already active
    }

    instance.state = "activating";

    try {
      // Create activation context
      const context = this.createActivationContext(skillId);

      // Call module's activate handler
      if (module.activate) {
        await module.activate(context);
      }

      // Register manifest-defined tools
      if (module.manifest.tools) {
        for (const tool of module.manifest.tools) {
          // Register with a no-op handler (tools should be registered in activate)
          this.config.toolRegistry.register(tool, async () => ({
            success: false,
            error: "Tool handler not implemented",
          }));
          instance.registeredTools.push(tool.id);
        }
      }

      instance.state = "active";
      instance.activatedAt = new Date();

      this.emit({
        type: "skill_activated",
        skillId,
        timestamp: new Date(),
      });

      return true;
    } catch (err) {
      instance.state = "error";
      instance.error = err instanceof Error ? err.message : String(err);

      this.emit({
        type: "skill_error",
        skillId,
        timestamp: new Date(),
        data: { error: instance.error },
      });

      return false;
    }
  }

  /**
   * Deactivate a skill.
   */
  async deactivate(skillId: SkillId): Promise<boolean> {
    const instance = this.skills.get(skillId);
    const module = this.modules.get(skillId);

    if (!instance) {
      return false;
    }

    if (instance.state !== "active") {
      return true; // Already inactive
    }

    instance.state = "deactivating";

    try {
      // Call module's deactivate handler
      if (module?.deactivate) {
        const context = this.createActivationContext(skillId);
        await module.deactivate(context);
      }

      // Unregister all tools
      for (const toolId of instance.registeredTools) {
        this.config.toolRegistry.unregister(toolId);
      }
      instance.registeredTools = [];

      instance.state = "installed";

      this.emit({
        type: "skill_deactivated",
        skillId,
        timestamp: new Date(),
      });

      return true;
    } catch (err) {
      instance.state = "error";
      instance.error = err instanceof Error ? err.message : String(err);

      this.emit({
        type: "skill_error",
        skillId,
        timestamp: new Date(),
        data: { error: instance.error },
      });

      return false;
    }
  }

  /**
   * Get a skill instance.
   */
  get(skillId: SkillId): SkillInstance | null {
    return this.skills.get(skillId) ?? null;
  }

  /**
   * Check if a skill is installed.
   */
  has(skillId: SkillId): boolean {
    return this.skills.has(skillId);
  }

  /**
   * Check if a skill is active.
   */
  isActive(skillId: SkillId): boolean {
    const instance = this.skills.get(skillId);
    return instance?.state === "active";
  }

  /**
   * List all installed skills.
   */
  list(): SkillInstance[] {
    return Array.from(this.skills.values());
  }

  /**
   * List active skills.
   */
  listActive(): SkillInstance[] {
    return this.list().filter((s) => s.state === "active");
  }

  /**
   * Find skills by category.
   */
  findByCategory(category: string): SkillInstance[] {
    return this.list().filter((s) =>
      s.manifest.categories?.includes(category)
    );
  }

  /**
   * Find skills by tag.
   */
  findByTag(tag: string): SkillInstance[] {
    return this.list().filter((s) => s.manifest.tags?.includes(tag));
  }

  /**
   * Search skills by name or description.
   */
  search(query: string): SkillInstance[] {
    const q = query.toLowerCase();
    return this.list().filter(
      (s) =>
        s.manifest.name.toLowerCase().includes(q) ||
        s.manifest.description.toLowerCase().includes(q)
    );
  }

  /**
   * Subscribe to skill events.
   */
  onEvent(listener: (event: SkillEvent) => void): () => void {
    this.eventListeners.push(listener);
    return () => {
      const index = this.eventListeners.indexOf(listener);
      if (index > -1) {
        this.eventListeners.splice(index, 1);
      }
    };
  }

  /**
   * Activate all installed skills.
   */
  async activateAll(): Promise<void> {
    for (const skillId of this.skills.keys()) {
      await this.activate(skillId);
    }
  }

  /**
   * Deactivate all active skills.
   */
  async deactivateAll(): Promise<void> {
    for (const [skillId, instance] of this.skills) {
      if (instance.state === "active") {
        await this.deactivate(skillId);
      }
    }
  }

  /** Check if all dependencies are met */
  private checkDependencies(manifest: SkillManifest): boolean {
    if (!manifest.dependencies) {
      return true;
    }

    for (const dep of manifest.dependencies) {
      if (dep.required !== false) {
        const instance = this.skills.get(dep.skillId);
        if (!instance) {
          return false;
        }
        // TODO: Check version compatibility
      }
    }

    return true;
  }

  /** Create activation context for a skill */
  private createActivationContext(skillId: SkillId): SkillActivationContext {
    const instance = this.skills.get(skillId)!;
    const config = this.skillConfigs.get(skillId) ?? {};

    return {
      agentId: this.config.agentId,
      log: this.createLogger(skillId),
      registerTool: <T>(definition: ToolDefinition, handler: ToolHandler<T>) => {
        // Prefix tool ID with skill ID for namespacing
        const namespacedId = `${skillId}:${definition.id}`;
        const namespacedDef = { ...definition, id: namespacedId };

        this.config.toolRegistry.register(namespacedDef, handler as ToolHandler);
        instance.registeredTools.push(namespacedId);

        this.emit({
          type: "tool_registered",
          skillId,
          timestamp: new Date(),
          data: { toolId: namespacedId },
        });
      },
      unregisterTool: (toolId: string) => {
        const namespacedId = toolId.includes(":") ? toolId : `${skillId}:${toolId}`;
        this.config.toolRegistry.unregister(namespacedId);

        const index = instance.registeredTools.indexOf(namespacedId);
        if (index > -1) {
          instance.registeredTools.splice(index, 1);
        }

        this.emit({
          type: "tool_unregistered",
          skillId,
          timestamp: new Date(),
          data: { toolId: namespacedId },
        });
      },
      getConfig: <T>(key: string, defaultValue?: T): T | undefined => {
        return (config[key] as T) ?? defaultValue;
      },
      setData: async (key: string, value: unknown): Promise<void> => {
        if (this.config.dataStore) {
          await this.config.dataStore.set(skillId, key, value);
        }
      },
      getData: async <T>(key: string): Promise<T | undefined> => {
        if (this.config.dataStore) {
          return this.config.dataStore.get<T>(skillId, key);
        }
        return undefined;
      },
    };
  }

  /** Create a logger for a skill */
  private createLogger(skillId: SkillId): SkillLogger {
    return {
      debug: (message: string, data?: unknown) => {
        console.debug(`[${skillId}] ${message}`, data ?? "");
      },
      info: (message: string, data?: unknown) => {
        console.info(`[${skillId}] ${message}`, data ?? "");
      },
      warn: (message: string, data?: unknown) => {
        console.warn(`[${skillId}] ${message}`, data ?? "");
      },
      error: (message: string, data?: unknown) => {
        console.error(`[${skillId}] ${message}`, data ?? "");
      },
    };
  }

  /** Emit an event */
  private emit(event: SkillEvent): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }
}

/** Create a new skill manager */
export function createSkillManager(config: SkillManagerConfig): SkillManager {
  return new SkillManager(config);
}

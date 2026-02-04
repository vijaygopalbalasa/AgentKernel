// Skill Manager — manages skill installation and lifecycle
// The central manager for all skills on an agent

import { z } from "zod";
import { satisfies, valid } from "semver";
import { type Result, ok, err } from "@agentrun/shared";
import { type Logger, createLogger } from "@agentrun/kernel";
import type {
  SkillId,
  SkillManifest,
  SkillInstance,
  SkillModule,
  SkillActivationContext,
  SkillInstallOptions,
  SkillEvent,
  SkillLogger,
} from "./types.js";
import { SkillError, SkillManifestSchema } from "./types.js";
import type { ToolDefinition, ToolHandler, ToolRegistry } from "@agentrun/tools";

// ─── ZOD SCHEMAS ────────────────────────────────────────────

/** Schema for skill manager configuration */
export const SkillManagerConfigSchema = z.object({
  agentId: z.string().min(1),
  toolRegistry: z.custom<ToolRegistry>((val) => typeof val === "object" && val !== null),
  dataStore: z.custom<SkillDataStore>((val) => typeof val === "object" && val !== null).optional(),
});

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
  private log: Logger;

  constructor(config: SkillManagerConfig) {
    this.config = config;
    this.log = createLogger({ name: "skill-manager" });
  }

  /**
   * Install a skill from a module.
   */
  install(module: SkillModule, options: Partial<SkillInstallOptions> = {}): Result<SkillId, SkillError> {
    const { manifest } = module;

    // Check if already installed
    if (this.skills.has(manifest.id)) {
      return err(
        new SkillError(
          `Skill already installed: ${manifest.id}`,
          "ALREADY_EXISTS",
          manifest.id
        )
      );
    }

    // Validate manifest using Zod schema
    const manifestResult = SkillManifestSchema.safeParse(manifest);
    if (!manifestResult.success) {
      this.log.warn("Invalid manifest", {
        skillId: manifest.id,
        error: manifestResult.error.message,
      });
      return err(
        new SkillError(
          `Invalid manifest: ${manifestResult.error.message}`,
          "VALIDATION_ERROR",
          manifest.id
        )
      );
    }

    // Check dependencies
    const depResult = this.checkDependencies(manifest);
    if (!depResult.ok) {
      return depResult;
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

    this.log.info("Skill installed", { skillId: manifest.id, name: manifest.name });

    // Activate if requested
    if (options.activate) {
      this.activate(manifest.id);
    }

    return ok(manifest.id);
  }

  /**
   * Uninstall a skill.
   */
  async uninstall(skillId: SkillId): Promise<Result<void, SkillError>> {
    const instance = this.skills.get(skillId);
    if (!instance) {
      return err(
        new SkillError(`Skill not found: ${skillId}`, "NOT_FOUND", skillId)
      );
    }

    // Deactivate first if active
    if (instance.state === "active") {
      const deactivateResult = await this.deactivate(skillId);
      if (!deactivateResult.ok) {
        this.log.warn("Failed to deactivate skill during uninstall", {
          skillId,
          error: deactivateResult.error.message,
        });
        // Continue with uninstall anyway
      }
    }

    // Clear skill data
    if (this.config.dataStore) {
      try {
        await this.config.dataStore.clear(skillId);
      } catch (e) {
        this.log.warn("Failed to clear skill data during uninstall", {
          skillId,
          error: e instanceof Error ? e.message : String(e),
        });
        // Continue with uninstall anyway
      }
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

    this.log.info("Skill uninstalled", { skillId });
    return ok(undefined);
  }

  /**
   * Activate a skill.
   */
  async activate(skillId: SkillId): Promise<Result<void, SkillError>> {
    const instance = this.skills.get(skillId);
    const module = this.modules.get(skillId);

    if (!instance || !module) {
      return err(
        new SkillError(`Skill not found: ${skillId}`, "NOT_FOUND", skillId)
      );
    }

    if (instance.state === "active") {
      return ok(undefined); // Already active
    }

    instance.state = "activating";
    this.log.debug("Activating skill", { skillId });

    try {
      // Create activation context
      const context = this.createActivationContext(skillId);

      // Call module's activate handler
      if (module.activate) {
        await module.activate(context);
      }

      // Verify manifest-defined tools were registered
      // Skills declare tools in their manifest and must register handlers in activate()
      if (module.manifest.tools) {
        const expectedTools = module.manifest.tools.map((t) => `${skillId}:${t.id}`);
        const missingTools = expectedTools.filter(
          (toolId) => !instance.registeredTools.includes(toolId)
        );

        if (missingTools.length > 0) {
          this.log.warn("Skill declared tools in manifest but did not register handlers", {
            skillId,
            missingTools,
            hint: "Use context.registerTool() in the activate() function to register tool handlers",
          });
        }
      }

      instance.state = "active";
      instance.activatedAt = new Date();

      this.emit({
        type: "skill_activated",
        skillId,
        timestamp: new Date(),
      });

      this.log.info("Skill activated", { skillId, toolCount: instance.registeredTools.length });
      return ok(undefined);
    } catch (e) {
      instance.state = "error";
      instance.error = e instanceof Error ? e.message : String(e);

      this.emit({
        type: "skill_error",
        skillId,
        timestamp: new Date(),
        data: { error: instance.error },
      });

      this.log.error("Failed to activate skill", { skillId, error: instance.error });
      return err(
        new SkillError(
          `Failed to activate skill: ${instance.error}`,
          "ACTIVATION_ERROR",
          skillId
        )
      );
    }
  }

  /**
   * Deactivate a skill.
   */
  async deactivate(skillId: SkillId): Promise<Result<void, SkillError>> {
    const instance = this.skills.get(skillId);
    const module = this.modules.get(skillId);

    if (!instance) {
      return err(
        new SkillError(`Skill not found: ${skillId}`, "NOT_FOUND", skillId)
      );
    }

    if (instance.state !== "active") {
      return ok(undefined); // Already inactive
    }

    instance.state = "deactivating";
    this.log.debug("Deactivating skill", { skillId });

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

      this.log.info("Skill deactivated", { skillId });
      return ok(undefined);
    } catch (e) {
      instance.state = "error";
      instance.error = e instanceof Error ? e.message : String(e);

      this.emit({
        type: "skill_error",
        skillId,
        timestamp: new Date(),
        data: { error: instance.error },
      });

      this.log.error("Failed to deactivate skill", { skillId, error: instance.error });
      return err(
        new SkillError(
          `Failed to deactivate skill: ${instance.error}`,
          "DEACTIVATION_ERROR",
          skillId
        )
      );
    }
  }

  /**
   * Get a skill instance.
   */
  get(skillId: SkillId): Result<SkillInstance, SkillError> {
    const instance = this.skills.get(skillId);
    if (!instance) {
      return err(
        new SkillError(`Skill not found: ${skillId}`, "NOT_FOUND", skillId)
      );
    }
    return ok(instance);
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
  private checkDependencies(manifest: SkillManifest): Result<void, SkillError> {
    if (!manifest.dependencies) {
      return ok(undefined);
    }

    const missingDeps: string[] = [];
    const incompatibleDeps: string[] = [];
    for (const dep of manifest.dependencies) {
      if (dep.required !== false) {
        const instance = this.skills.get(dep.skillId);
        if (!instance) {
          missingDeps.push(dep.skillId);
        }
        if (instance && dep.versionRange) {
          const installedVersion = instance.manifest.version;
          const parsedVersion = valid(installedVersion);
          const matches = parsedVersion
            ? satisfies(parsedVersion, dep.versionRange, { includePrerelease: true })
            : false;

          if (!matches) {
            incompatibleDeps.push(`${dep.skillId}@${installedVersion} (${dep.versionRange})`);
          }
        }
      }
    }

    if (missingDeps.length > 0 || incompatibleDeps.length > 0) {
      this.log.warn("Missing required dependencies", {
        skillId: manifest.id,
        missingDeps,
        incompatibleDeps,
      });
      return err(
        new SkillError(
          [
            missingDeps.length > 0 ? `Missing required dependencies: ${missingDeps.join(", ")}` : null,
            incompatibleDeps.length > 0
              ? `Incompatible dependency versions: ${incompatibleDeps.join(", ")}`
              : null,
          ]
            .filter((message): message is string => Boolean(message))
            .join("; "),
          "DEPENDENCY_ERROR",
          manifest.id
        )
      );
    }

    return ok(undefined);
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
    const skillLog = createLogger({ name: `skill:${skillId}` });
    return {
      debug: (message: string, data?: unknown) => {
        skillLog.debug(message, data ? { data } : undefined);
      },
      info: (message: string, data?: unknown) => {
        skillLog.info(message, data ? { data } : undefined);
      },
      warn: (message: string, data?: unknown) => {
        skillLog.warn(message, data ? { data } : undefined);
      },
      error: (message: string, data?: unknown) => {
        skillLog.error(message, data ? { data } : undefined);
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

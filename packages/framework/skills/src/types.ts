// Skill Types — definitions for installable agent capabilities
// Skills are like Android apps — modular, installable, and sandboxed

import { z } from "zod";
import type { ToolDefinition, ToolHandler } from "@agent-os/tools";

// ─── ERROR CLASS ────────────────────────────────────────────

/** Skill error codes */
export type SkillErrorCode =
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "VALIDATION_ERROR"
  | "ACTIVATION_ERROR"
  | "DEACTIVATION_ERROR"
  | "DEPENDENCY_ERROR"
  | "STORAGE_ERROR"
  | "REGISTRY_ERROR"
  | "FETCH_ERROR"
  | "PARSE_ERROR";

/**
 * Error class for skill operations.
 */
export class SkillError extends Error {
  constructor(
    message: string,
    public readonly code: SkillErrorCode,
    public readonly skillId?: string
  ) {
    super(message);
    this.name = "SkillError";
  }
}

// ─── TYPES ────────────────────────────────────────────────────

/** Unique identifier for a skill */
export type SkillId = string;

/** Skill version (semver) */
export type SkillVersion = string;

/**
 * Skill Manifest — metadata about an installable skill.
 * Similar to Android's AndroidManifest.xml or package.json.
 */
export interface SkillManifest {
  /** Unique skill identifier (e.g., "web-browse", "file-system") */
  id: SkillId;
  /** Human-readable name */
  name: string;
  /** Description of what the skill does */
  description: string;
  /** Skill version (semver) */
  version: SkillVersion;
  /** Author/publisher */
  author?: string;
  /** Homepage URL */
  homepage?: string;
  /** License identifier (e.g., "MIT", "Apache-2.0") */
  license?: string;
  /** Categories for discovery */
  categories?: string[];
  /** Tags for search */
  tags?: string[];
  /** Required permissions */
  permissions?: SkillPermission[];
  /** Dependencies on other skills */
  dependencies?: SkillDependency[];
  /** Tools provided by this skill */
  tools?: ToolDefinition[];
  /** Entry point (for dynamic loading) */
  entryPoint?: string;
  /** Minimum Agent OS version required */
  minAgentOSVersion?: string;
  /** Icon URL */
  icon?: string;
}

/** Permission required by a skill */
export interface SkillPermission {
  /** Permission ID (e.g., "file:read", "network:fetch") */
  id: string;
  /** Why this permission is needed */
  reason: string;
  /** Whether this is required or optional */
  required?: boolean;
}

/** Dependency on another skill */
export interface SkillDependency {
  /** Skill ID */
  skillId: SkillId;
  /** Version requirement (semver range) */
  versionRange?: string;
  /** Whether this is required or optional */
  required?: boolean;
}

/** Skill instance — a loaded and activated skill */
export interface SkillInstance {
  /** Skill manifest */
  manifest: SkillManifest;
  /** Current state */
  state: SkillState;
  /** When the skill was installed */
  installedAt: Date;
  /** When the skill was last activated */
  activatedAt?: Date;
  /** Tools registered by this skill */
  registeredTools: string[];
  /** Error message (if state is error) */
  error?: string;
}

/** Skill lifecycle states */
export type SkillState =
  | "installed"    // Skill is installed but not active
  | "activating"   // Skill is being activated
  | "active"       // Skill is active and tools are available
  | "deactivating" // Skill is being deactivated
  | "error";       // Skill encountered an error

/** Skill activation context */
export interface SkillActivationContext {
  /** Agent ID that owns this skill */
  agentId: string;
  /** Logger for the skill */
  log: SkillLogger;
  /** Register a tool */
  registerTool: <T>(definition: ToolDefinition, handler: ToolHandler<T>) => void;
  /** Unregister a tool */
  unregisterTool: (toolId: string) => void;
  /** Get configuration value */
  getConfig: <T>(key: string, defaultValue?: T) => T | undefined;
  /** Store data persistently */
  setData: (key: string, value: unknown) => Promise<void>;
  /** Retrieve stored data */
  getData: <T>(key: string) => Promise<T | undefined>;
}

/** Skill logger interface */
export interface SkillLogger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

/** Skill module — exported by skill entry points */
export interface SkillModule {
  /** Skill manifest */
  manifest: SkillManifest;
  /** Activation handler — called when skill is activated */
  activate?: (context: SkillActivationContext) => Promise<void> | void;
  /** Deactivation handler — called when skill is deactivated */
  deactivate?: (context: SkillActivationContext) => Promise<void> | void;
}

/** Skill registry entry */
export interface SkillRegistryEntry {
  /** Skill manifest */
  manifest: SkillManifest;
  /** Source (local, remote URL, etc.) */
  source: string;
  /** When it was added to registry */
  registeredAt: Date;
  /** Download count (for remote registry) */
  downloads?: number;
  /** Rating (1-5) */
  rating?: number;
}

/** Skill installation options */
export interface SkillInstallOptions {
  /** Source URL or path */
  source: string;
  /** Whether to activate immediately */
  activate?: boolean;
  /** Configuration for the skill */
  config?: Record<string, unknown>;
}

/** Skill event */
export interface SkillEvent {
  type:
    | "skill_installed"
    | "skill_activated"
    | "skill_deactivated"
    | "skill_uninstalled"
    | "skill_error"
    | "tool_registered"
    | "tool_unregistered";
  skillId: SkillId;
  timestamp: Date;
  data?: unknown;
}

// ─── ZOD SCHEMAS ────────────────────────────────────────────

/** Schema for skill permission */
export const SkillPermissionSchema = z.object({
  id: z.string().min(1),
  reason: z.string().min(1),
  required: z.boolean().optional(),
});

/** Schema for skill dependency */
export const SkillDependencySchema = z.object({
  skillId: z.string().min(1),
  versionRange: z.string().optional(),
  required: z.boolean().optional(),
});

/** Schema for skill manifest (the main validation schema) */
export const SkillManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.string().min(1),
  author: z.string().optional(),
  homepage: z.string().url().optional(),
  license: z.string().optional(),
  categories: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  permissions: z.array(SkillPermissionSchema).optional(),
  dependencies: z.array(SkillDependencySchema).optional(),
  entryPoint: z.string().optional(),
  minAgentOSVersion: z.string().optional(),
  icon: z.string().optional(),
});

/** Schema for skill lifecycle states */
export const SkillStateSchema = z.enum([
  "installed",
  "activating",
  "active",
  "deactivating",
  "error",
]);

/** Schema for skill instance */
export const SkillInstanceSchema = z.object({
  manifest: SkillManifestSchema,
  state: SkillStateSchema,
  installedAt: z.date(),
  activatedAt: z.date().optional(),
  registeredTools: z.array(z.string()),
  error: z.string().optional(),
});

/** Schema for skill registry entry */
export const SkillRegistryEntrySchema = z.object({
  manifest: SkillManifestSchema,
  source: z.string().min(1),
  registeredAt: z.date(),
  downloads: z.number().int().min(0).optional(),
  rating: z.number().min(1).max(5).optional(),
});

/** Schema for skill installation options */
export const SkillInstallOptionsSchema = z.object({
  source: z.string().min(1),
  activate: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
});

/** Schema for skill event types */
export const SkillEventTypeSchema = z.enum([
  "skill_installed",
  "skill_activated",
  "skill_deactivated",
  "skill_uninstalled",
  "skill_error",
  "tool_registered",
  "tool_unregistered",
]);

/** Schema for skill events */
export const SkillEventSchema = z.object({
  type: SkillEventTypeSchema,
  skillId: z.string().min(1),
  timestamp: z.date(),
  data: z.unknown().optional(),
});

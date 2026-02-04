// @agentrun/skills — Skill System (Layer 4: Framework)
// Installable capabilities like Android apps

// Types
export type {
  SkillId,
  SkillVersion,
  SkillManifest,
  SkillPermission,
  SkillDependency,
  SkillInstance,
  SkillState,
  SkillActivationContext,
  SkillLogger,
  SkillModule,
  SkillRegistryEntry,
  SkillInstallOptions,
  SkillEvent,
  SkillErrorCode,
} from "./types.js";

// Error class
export { SkillError } from "./types.js";

// Zod schemas
export {
  SkillPermissionSchema,
  SkillDependencySchema,
  SkillManifestSchema,
  SkillStateSchema,
  SkillInstanceSchema,
  SkillRegistryEntrySchema,
  SkillInstallOptionsSchema,
  SkillEventTypeSchema,
  SkillEventSchema,
} from "./types.js";

// Manager
export {
  SkillManager,
  createSkillManager,
  SkillManagerConfigSchema,
  type SkillManagerConfig,
  type SkillDataStore,
} from "./manager.js";

// Registry
export {
  SkillRegistry,
  createSkillRegistry,
  type RegistryStats,
} from "./registry.js";

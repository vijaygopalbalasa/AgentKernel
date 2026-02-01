// @agent-os/skills — Skill System (Layer 4: Framework)
// Installable capabilities like Android apps

console.log("✅ @agent-os/skills loaded");

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
} from "./types.js";

export {
  SkillPermissionSchema,
  SkillDependencySchema,
  SkillManifestSchema,
} from "./types.js";

// Manager
export {
  SkillManager,
  createSkillManager,
  type SkillManagerConfig,
  type SkillDataStore,
} from "./manager.js";

// Registry
export {
  SkillRegistry,
  createSkillRegistry,
  type RegistryStats,
} from "./registry.js";

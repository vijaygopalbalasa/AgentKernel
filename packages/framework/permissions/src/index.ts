// @agentkernel/permissions — Capability-based Security (Layer 4: Framework)
// OWASP 2026 compliant permission system

// ─── Types ──────────────────────────────────────────────────
export type {
  CapabilityToken,
  CapabilityRequest,
  CapabilityAuditEntry,
  Permission,
  PermissionScope,
  PermissionCategory,
  PermissionAction,
  PermissionCheckResult,
  CapabilityManagerOptions,
  PermissionErrorCode,
} from "./capabilities.js";

// ─── Zod Schemas ────────────────────────────────────────────
export {
  PermissionScopeSchema,
  PermissionCategorySchema,
  PermissionActionSchema,
  PermissionSchema,
  CapabilityTokenSchema,
  CapabilityRequestSchema,
  PermissionCheckResultSchema,
  CapabilityAuditEntrySchema,
  CapabilityManagerOptionsSchema,
} from "./capabilities.js";

// ─── Classes ────────────────────────────────────────────────
export {
  CapabilityManager,
  createCapabilityManager,
  PermissionError,
} from "./capabilities.js";

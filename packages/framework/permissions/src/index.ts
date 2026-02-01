// @agent-os/permissions — Capability-based Security (Layer 4: Framework)
// OWASP 2026 compliant permission system

console.log("✅ @agent-os/permissions loaded");

// Capabilities
export {
  CapabilityManager,
  type CapabilityToken,
  type CapabilityRequest,
  type CapabilityAuditEntry,
  type Permission,
  type PermissionScope,
  type PermissionCategory,
  type PermissionAction,
  type PermissionCheckResult,
} from "./capabilities.js";

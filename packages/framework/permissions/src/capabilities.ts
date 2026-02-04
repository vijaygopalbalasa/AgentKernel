// Capability-based Security — OWASP 2026 compliant
// Implements least privilege and least agency principles

import { z } from "zod";
import { randomUUID, createHmac, timingSafeEqual } from "crypto";
import { type Result, ok, err } from "@agentkernel/shared";
import { type Logger, createLogger } from "@agentkernel/kernel";

// ─── ZOD SCHEMAS ────────────────────────────────────────────

/** Permission scope levels */
export const PermissionScopeSchema = z.enum(["system", "user", "agent", "task"]);
export type PermissionScope = z.infer<typeof PermissionScopeSchema>;

/** Standard permission categories */
export const PermissionCategorySchema = z.enum([
  "memory",      // Read/write agent memory
  "tools",       // Use MCP tools
  "network",     // Make network requests
  "filesystem",  // Access files
  "agents",      // Communicate with other agents
  "llm",         // Make LLM API calls
  "secrets",     // Access secrets/credentials
  "admin",       // Administrative operations
  "system",      // System-level operations
  "shell",       // Shell command execution
  "skill",       // Skill management
  "social",      // Social/community operations
]);
export type PermissionCategory = z.infer<typeof PermissionCategorySchema>;

/** Permission action types */
export const PermissionActionSchema = z.enum(["read", "write", "execute", "delete", "admin"]);
export type PermissionAction = z.infer<typeof PermissionActionSchema>;

/** A specific permission */
export const PermissionSchema = z.object({
  /** Permission category */
  category: PermissionCategorySchema,
  /** Allowed actions */
  actions: z.array(PermissionActionSchema).min(1),
  /** Resource pattern (glob-style) */
  resource: z.string().optional(),
  /** Additional constraints */
  constraints: z.record(z.unknown()).optional(),
});
export type Permission = z.infer<typeof PermissionSchema>;

/** Capability token — unforgeable permission grant */
export const CapabilityTokenSchema = z.object({
  /** Unique token ID */
  id: z.string().min(1),
  /** Agent ID this capability is granted to */
  agentId: z.string().min(1),
  /** Permissions granted */
  permissions: z.array(PermissionSchema),
  /** Scope level */
  scope: PermissionScopeSchema,
  /** When the token was issued */
  issuedAt: z.date(),
  /** When the token expires */
  expiresAt: z.date(),
  /** Issuer (system, user, or agent ID) */
  issuedBy: z.string().min(1),
  /** Purpose/reason for this grant */
  purpose: z.string().optional(),
  /** Whether the token can be delegated */
  delegatable: z.boolean(),
  /** Parent token ID (if delegated) */
  parentTokenId: z.string().optional(),
  /** Cryptographic signature for verification */
  signature: z.string().min(1),
});
export type CapabilityToken = z.infer<typeof CapabilityTokenSchema>;

/** Request for a capability */
export const CapabilityRequestSchema = z.object({
  agentId: z.string().min(1),
  permissions: z.array(PermissionSchema),
  purpose: z.string().min(1),
  durationMs: z.number().int().min(1).optional(),
  delegatable: z.boolean().optional(),
});
export type CapabilityRequest = z.infer<typeof CapabilityRequestSchema>;

/** Result of a permission check */
export const PermissionCheckResultSchema = z.object({
  allowed: z.boolean(),
  reason: z.string().optional(),
  matchedToken: CapabilityTokenSchema.optional(),
});
export type PermissionCheckResult = z.infer<typeof PermissionCheckResultSchema>;

/** Audit log entry */
export const CapabilityAuditEntrySchema = z.object({
  action: z.enum(["grant", "delegate", "revoke", "check_allowed", "check_denied"]),
  tokenId: z.string().optional(),
  agentId: z.string().min(1),
  permissions: z.array(PermissionSchema).optional(),
  issuedBy: z.string().optional(),
  timestamp: z.date(),
});
export type CapabilityAuditEntry = z.infer<typeof CapabilityAuditEntrySchema>;

// ─── ERROR CLASS ────────────────────────────────────────────

/** Permission error codes */
export type PermissionErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "EXPIRED"
  | "NOT_DELEGATABLE"
  | "INSUFFICIENT_PERMISSIONS"
  | "INVALID_SIGNATURE";

/**
 * Error class for permission operations.
 */
export class PermissionError extends Error {
  constructor(
    message: string,
    public readonly code: PermissionErrorCode,
    public readonly tokenId?: string
  ) {
    super(message);
    this.name = "PermissionError";
  }
}

// ─── MANAGER OPTIONS ────────────────────────────────────────

/** Options schema for the capability manager */
export const CapabilityManagerOptionsSchema = z.object({
  /** Secret for signing tokens (required, minimum 32 characters) */
  secret: z.string().min(32),
  /** Maximum audit log entries */
  maxAuditLogSize: z.number().int().min(100).optional(),
  /** Default token duration in ms */
  defaultDurationMs: z.number().int().min(1000).optional(),
});

export interface CapabilityManagerOptions {
  /** Secret for signing tokens (required, minimum 32 characters) */
  secret: string;
  /** Maximum audit log entries */
  maxAuditLogSize?: number;
  /** Default token duration in ms */
  defaultDurationMs?: number;
}

/**
 * Capability Manager — handles permission grants and checks.
 *
 * Implements OWASP 2026 recommendations:
 * - Least privilege: minimal permissions by default
 * - Least agency: minimal autonomy for tasks
 * - Time-bounded: all grants expire
 * - Auditable: all grants are logged
 */
export class CapabilityManager {
  private tokens: Map<string, CapabilityToken> = new Map();
  private agentTokens: Map<string, Set<string>> = new Map(); // agentId -> tokenIds
  private secret: string;
  private auditLog: CapabilityAuditEntry[] = [];
  private maxAuditLogSize: number;
  private defaultDurationMs: number;
  private log: Logger;

  constructor(options: CapabilityManagerOptions) {
    if (!options.secret || options.secret.length < 32) {
      throw new Error(
        "PERMISSION_SECRET is required and must be at least 32 characters. " +
        "Set the PERMISSION_SECRET environment variable to a secure random string."
      );
    }
    this.secret = options.secret;
    this.maxAuditLogSize = options.maxAuditLogSize ?? 10000;
    this.defaultDurationMs = options.defaultDurationMs ?? 60 * 60 * 1000; // 1 hour
    this.log = createLogger({ name: "capability-manager" });
  }

  /**
   * Grant a capability to an agent.
   */
  grant(request: CapabilityRequest, issuedBy: string = "system"): Result<CapabilityToken, PermissionError> {
    // Validate request
    const reqResult = CapabilityRequestSchema.safeParse(request);
    if (!reqResult.success) {
      return err(
        new PermissionError(
          `Invalid request: ${reqResult.error.message}`,
          "VALIDATION_ERROR"
        )
      );
    }

    const now = new Date();
    const durationMs = request.durationMs ?? this.defaultDurationMs;

    const token: CapabilityToken = {
      id: `cap-${randomUUID().slice(0, 12)}`,
      agentId: request.agentId,
      permissions: request.permissions,
      scope: this.inferScope(request.permissions),
      issuedAt: now,
      expiresAt: new Date(now.getTime() + durationMs),
      issuedBy,
      purpose: request.purpose,
      delegatable: request.delegatable ?? false,
      signature: "", // Will be set below
    };

    // Sign the token
    token.signature = this.signToken(token);

    // Store token
    this.tokens.set(token.id, token);

    // Index by agent
    if (!this.agentTokens.has(request.agentId)) {
      this.agentTokens.set(request.agentId, new Set());
    }
    this.agentTokens.get(request.agentId)!.add(token.id);

    // Audit log
    this.logAudit({
      action: "grant",
      tokenId: token.id,
      agentId: request.agentId,
      permissions: request.permissions,
      issuedBy,
      timestamp: now,
    });

    this.log.info("Capability granted", {
      tokenId: token.id,
      agentId: request.agentId,
      scope: token.scope,
      categories: request.permissions.map((p) => p.category),
    });

    return ok(token);
  }

  /**
   * Delegate a capability to another agent.
   */
  delegate(
    tokenId: string,
    toAgentId: string,
    permissions?: Permission[],
    durationMs?: number
  ): Result<CapabilityToken, PermissionError> {
    const parentToken = this.tokens.get(tokenId);

    if (!parentToken) {
      return err(new PermissionError("Token not found", "NOT_FOUND", tokenId));
    }
    if (!parentToken.delegatable) {
      return err(new PermissionError("Token is not delegatable", "NOT_DELEGATABLE", tokenId));
    }
    if (this.isExpired(parentToken)) {
      return err(new PermissionError("Token has expired", "EXPIRED", tokenId));
    }

    // Delegated permissions must be subset of parent
    const delegatedPermissions = permissions ?? parentToken.permissions;
    if (!this.isSubset(delegatedPermissions, parentToken.permissions)) {
      return err(
        new PermissionError(
          "Delegated permissions exceed parent scope",
          "INSUFFICIENT_PERMISSIONS",
          tokenId
        )
      );
    }

    // Delegated token cannot outlive parent
    const maxExpiry = parentToken.expiresAt.getTime() - Date.now();
    const actualDuration = Math.min(durationMs ?? maxExpiry, maxExpiry);

    const request: CapabilityRequest = {
      agentId: toAgentId,
      permissions: delegatedPermissions,
      purpose: `Delegated from ${parentToken.agentId}`,
      durationMs: actualDuration,
      delegatable: false, // Delegated tokens cannot be further delegated
    };

    const grantResult = this.grant(request, parentToken.agentId);
    if (!grantResult.ok) return grantResult;

    const token = grantResult.value;
    // Add parent token reference
    const updatedToken = { ...token, parentTokenId: tokenId };
    this.tokens.set(token.id, updatedToken);

    this.log.info("Capability delegated", {
      parentTokenId: tokenId,
      childTokenId: token.id,
      fromAgentId: parentToken.agentId,
      toAgentId,
    });

    return ok(updatedToken);
  }

  /**
   * Check if an agent has a specific permission.
   */
  check(
    agentId: string,
    category: PermissionCategory,
    action: PermissionAction,
    resource?: string
  ): PermissionCheckResult {
    const agentTokenIds = this.agentTokens.get(agentId);

    if (!agentTokenIds || agentTokenIds.size === 0) {
      this.logAudit({
        action: "check_denied",
        agentId,
        permissions: [{ category, actions: [action], resource }],
        timestamp: new Date(),
      });
      return { allowed: false, reason: "No capabilities granted" };
    }

    for (const tokenId of agentTokenIds) {
      const token = this.tokens.get(tokenId);

      if (!token) continue;
      if (this.isExpired(token)) {
        this.revoke(tokenId);
        continue;
      }
      if (!this.verifySignature(token)) {
        this.log.warn("Invalid token signature detected", { tokenId, agentId });
        continue;
      }

      // Check if token grants the requested permission
      for (const perm of token.permissions) {
        if (perm.category !== category) continue;
        if (!perm.actions.includes(action)) continue;

        // Check resource pattern if specified
        if (perm.resource && resource) {
          if (!this.matchesPattern(resource, perm.resource)) continue;
        }

        // Permission granted
        this.logAudit({
          action: "check_allowed",
          tokenId,
          agentId,
          permissions: [{ category, actions: [action], resource }],
          timestamp: new Date(),
        });

        return { allowed: true, matchedToken: token };
      }
    }

    this.logAudit({
      action: "check_denied",
      agentId,
      permissions: [{ category, actions: [action], resource }],
      timestamp: new Date(),
    });

    return { allowed: false, reason: "No matching capability" };
  }

  /**
   * Revoke a capability token.
   */
  revoke(tokenId: string): Result<void, PermissionError> {
    const token = this.tokens.get(tokenId);
    if (!token) {
      return err(new PermissionError("Token not found", "NOT_FOUND", tokenId));
    }

    this.tokens.delete(tokenId);
    this.agentTokens.get(token.agentId)?.delete(tokenId);

    this.logAudit({
      action: "revoke",
      tokenId,
      agentId: token.agentId,
      timestamp: new Date(),
    });

    this.log.info("Capability revoked", { tokenId, agentId: token.agentId });

    return ok(undefined);
  }

  /**
   * Revoke all capabilities for an agent.
   */
  revokeAll(agentId: string): number {
    const tokenIds = this.agentTokens.get(agentId);
    if (!tokenIds) return 0;

    let count = 0;
    for (const tokenId of [...tokenIds]) {
      const result = this.revoke(tokenId);
      if (result.ok) count++;
    }

    this.log.info("All capabilities revoked", { agentId, count });
    return count;
  }

  /**
   * List all active tokens for an agent.
   */
  listTokens(agentId: string): CapabilityToken[] {
    const tokenIds = this.agentTokens.get(agentId);
    if (!tokenIds) return [];

    const tokens: CapabilityToken[] = [];
    for (const tokenId of tokenIds) {
      const token = this.tokens.get(tokenId);
      if (token && !this.isExpired(token)) {
        tokens.push(token);
      }
    }

    return tokens;
  }

  /**
   * Get a specific token by ID.
   */
  getToken(tokenId: string): Result<CapabilityToken, PermissionError> {
    const token = this.tokens.get(tokenId);
    if (!token) {
      return err(new PermissionError("Token not found", "NOT_FOUND", tokenId));
    }
    if (this.isExpired(token)) {
      return err(new PermissionError("Token has expired", "EXPIRED", tokenId));
    }
    return ok(token);
  }

  /**
   * Get audit log entries.
   */
  getAuditLog(options?: {
    agentId?: string;
    action?: CapabilityAuditEntry["action"];
    since?: Date;
    limit?: number;
  }): CapabilityAuditEntry[] {
    let entries = [...this.auditLog];

    if (options?.agentId) {
      entries = entries.filter((e) => e.agentId === options.agentId);
    }
    if (options?.action) {
      entries = entries.filter((e) => e.action === options.action);
    }
    if (options?.since) {
      entries = entries.filter((e) => e.timestamp >= options.since!);
    }

    // Sort by timestamp descending
    entries.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    if (options?.limit) {
      entries = entries.slice(0, options.limit);
    }

    return entries;
  }

  /**
   * Clean up expired tokens.
   */
  cleanup(): number {
    let count = 0;
    for (const [tokenId, token] of this.tokens) {
      if (this.isExpired(token)) {
        this.revoke(tokenId);
        count++;
      }
    }
    if (count > 0) {
      this.log.debug("Cleaned up expired tokens", { count });
    }
    return count;
  }

  /** Check if a token is expired */
  private isExpired(token: CapabilityToken): boolean {
    return token.expiresAt.getTime() < Date.now();
  }

  /** Sign a token */
  private signToken(token: CapabilityToken): string {
    const payload = JSON.stringify({
      id: token.id,
      agentId: token.agentId,
      permissions: token.permissions,
      expiresAt: token.expiresAt.toISOString(),
    });
    return createHmac("sha256", this.secret).update(payload).digest("hex");
  }

  /** Verify token signature using constant-time comparison */
  private verifySignature(token: CapabilityToken): boolean {
    const expectedSig = this.signToken({ ...token, signature: "" });
    const expectedBuf = Buffer.from(expectedSig, "hex");
    const actualBuf = Buffer.from(token.signature, "hex");
    if (expectedBuf.length !== actualBuf.length) {
      return false;
    }
    return timingSafeEqual(expectedBuf, actualBuf);
  }

  /** Check if permissions are a subset of another */
  private isSubset(subset: Permission[], superset: Permission[]): boolean {
    for (const perm of subset) {
      const match = superset.find(
        (p) =>
          p.category === perm.category &&
          perm.actions.every((a) => p.actions.includes(a))
      );
      if (!match) return false;
    }
    return true;
  }

  /** Match resource against pattern (simple glob) */
  private matchesPattern(resource: string, pattern: string): boolean {
    // Simple glob matching: * matches any segment, ** matches any path
    const regex = pattern
      .replace(/\*\*/g, ".*")
      .replace(/\*/g, "[^/]*")
      .replace(/\//g, "\\/");
    return new RegExp(`^${regex}$`).test(resource);
  }

  /** Infer scope from permissions */
  private inferScope(permissions: Permission[]): PermissionScope {
    if (permissions.some((p) => p.category === "admin")) return "system";
    if (permissions.some((p) => p.category === "secrets")) return "system";
    if (permissions.some((p) => p.category === "system")) return "system";
    if (permissions.some((p) => p.category === "shell")) return "system";
    if (permissions.some((p) => p.category === "agents")) return "agent";
    return "task";
  }

  /** Log an audit entry */
  private logAudit(entry: CapabilityAuditEntry): void {
    this.auditLog.push(entry);

    // Keep audit log bounded
    if (this.auditLog.length > this.maxAuditLogSize) {
      this.auditLog = this.auditLog.slice(-this.maxAuditLogSize);
    }
  }
}

/** Factory function to create a capability manager */
export function createCapabilityManager(options: CapabilityManagerOptions): CapabilityManager {
  return new CapabilityManager(options);
}

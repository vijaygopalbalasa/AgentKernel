// Capability-based Security — OWASP 2026 compliant
// Implements least privilege and least agency principles

import { randomUUID, createHash, createHmac } from "crypto";

/** Permission scope levels */
export type PermissionScope = "system" | "user" | "agent" | "task";

/** Standard permission categories */
export type PermissionCategory =
  | "memory"      // Read/write agent memory
  | "tools"       // Use MCP tools
  | "network"     // Make network requests
  | "filesystem"  // Access files
  | "agents"      // Communicate with other agents
  | "llm"         // Make LLM API calls
  | "secrets"     // Access secrets/credentials
  | "admin";      // Administrative operations

/** Permission action types */
export type PermissionAction = "read" | "write" | "execute" | "delete" | "admin";

/** A specific permission */
export interface Permission {
  /** Permission category */
  category: PermissionCategory;
  /** Allowed actions */
  actions: PermissionAction[];
  /** Resource pattern (glob-style) */
  resource?: string;
  /** Additional constraints */
  constraints?: Record<string, unknown>;
}

/** Capability token — unforgeable permission grant */
export interface CapabilityToken {
  /** Unique token ID */
  id: string;
  /** Agent ID this capability is granted to */
  agentId: string;
  /** Permissions granted */
  permissions: Permission[];
  /** Scope level */
  scope: PermissionScope;
  /** When the token was issued */
  issuedAt: Date;
  /** When the token expires */
  expiresAt: Date;
  /** Issuer (system, user, or agent ID) */
  issuedBy: string;
  /** Purpose/reason for this grant */
  purpose?: string;
  /** Whether the token can be delegated */
  delegatable: boolean;
  /** Parent token ID (if delegated) */
  parentTokenId?: string;
  /** Cryptographic signature for verification */
  signature: string;
}

/** Request for a capability */
export interface CapabilityRequest {
  agentId: string;
  permissions: Permission[];
  purpose: string;
  durationMs?: number;
  delegatable?: boolean;
}

/** Result of a permission check */
export interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
  matchedToken?: CapabilityToken;
}

/** Secret used for signing tokens */
const DEFAULT_SECRET = "agent-os-capability-secret-change-in-production";

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

  constructor(secret: string = DEFAULT_SECRET) {
    this.secret = secret;
  }

  /**
   * Grant a capability to an agent.
   */
  grant(request: CapabilityRequest, issuedBy: string = "system"): CapabilityToken {
    const now = new Date();
    const durationMs = request.durationMs ?? 60 * 60 * 1000; // Default: 1 hour

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

    return token;
  }

  /**
   * Delegate a capability to another agent.
   */
  delegate(
    tokenId: string,
    toAgentId: string,
    permissions?: Permission[],
    durationMs?: number
  ): CapabilityToken | null {
    const parentToken = this.tokens.get(tokenId);

    if (!parentToken) return null;
    if (!parentToken.delegatable) return null;
    if (this.isExpired(parentToken)) return null;

    // Delegated permissions must be subset of parent
    const delegatedPermissions = permissions ?? parentToken.permissions;
    if (!this.isSubset(delegatedPermissions, parentToken.permissions)) {
      return null;
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

    const token = this.grant(request, parentToken.agentId);
    token.parentTokenId = tokenId;

    return token;
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
      return { allowed: false, reason: "No capabilities granted" };
    }

    for (const tokenId of agentTokenIds) {
      const token = this.tokens.get(tokenId);

      if (!token) continue;
      if (this.isExpired(token)) {
        this.revoke(tokenId);
        continue;
      }
      if (!this.verifySignature(token)) continue;

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
  revoke(tokenId: string): boolean {
    const token = this.tokens.get(tokenId);
    if (!token) return false;

    this.tokens.delete(tokenId);
    this.agentTokens.get(token.agentId)?.delete(tokenId);

    this.logAudit({
      action: "revoke",
      tokenId,
      agentId: token.agentId,
      timestamp: new Date(),
    });

    return true;
  }

  /**
   * Revoke all capabilities for an agent.
   */
  revokeAll(agentId: string): number {
    const tokenIds = this.agentTokens.get(agentId);
    if (!tokenIds) return 0;

    let count = 0;
    for (const tokenId of tokenIds) {
      if (this.revoke(tokenId)) count++;
    }

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

  /** Verify token signature */
  private verifySignature(token: CapabilityToken): boolean {
    const expectedSig = this.signToken({ ...token, signature: "" });
    return token.signature === expectedSig;
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
    if (permissions.some((p) => p.category === "agents")) return "agent";
    return "task";
  }

  /** Log an audit entry */
  private logAudit(entry: CapabilityAuditEntry): void {
    this.auditLog.push(entry);

    // Keep audit log bounded (last 10000 entries)
    if (this.auditLog.length > 10000) {
      this.auditLog = this.auditLog.slice(-10000);
    }
  }
}

/** Audit log entry */
export interface CapabilityAuditEntry {
  action: "grant" | "delegate" | "revoke" | "check_allowed" | "check_denied";
  tokenId?: string;
  agentId: string;
  permissions?: Permission[];
  issuedBy?: string;
  timestamp: Date;
}

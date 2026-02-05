// Sandbox — capability-based permission enforcement
// Implements OWASP 2026 agent security recommendations

import type { AgentId } from "./agent-context.js";
import { isProductionHardeningEnabled } from "./hardening.js";

/**
 * Permission capabilities that agents can request.
 * Based on Android-style capability model.
 */
export type Capability =
  | "llm:chat" // Can send chat requests
  | "llm:stream" // Can use streaming responses
  | "llm:embed" // Can generate embeddings
  | "memory:read" // Can read agent memory
  | "memory:write" // Can write to agent memory
  | "memory:delete" // Can delete from memory
  | "file:read" // Can read files
  | "file:write" // Can write files
  | "file:delete" // Can delete files
  | "network:http" // Can make HTTP requests
  | "network:websocket" // Can open WebSocket connections
  | "shell:execute" // Can execute shell commands
  | "agent:spawn" // Can spawn child agents
  | "agent:communicate" // Can communicate with other agents
  | "tool:mcp" // Can use MCP tools
  | "secret:read" // Can read secrets/credentials
  | "system:config" // Can modify system configuration
  | "system:audit"; // Can access audit logs

/** All available capabilities */
export const ALL_CAPABILITIES: readonly Capability[] = [
  "llm:chat",
  "llm:stream",
  "llm:embed",
  "memory:read",
  "memory:write",
  "memory:delete",
  "file:read",
  "file:write",
  "file:delete",
  "network:http",
  "network:websocket",
  "shell:execute",
  "agent:spawn",
  "agent:communicate",
  "tool:mcp",
  "secret:read",
  "system:config",
  "system:audit",
] as const;

/** Default capabilities for new agents (safe subset) */
export const DEFAULT_CAPABILITIES: readonly Capability[] = [
  "llm:chat",
  "llm:stream",
  "memory:read",
  "memory:write",
] as const;

/** Dangerous capabilities requiring explicit approval */
export const DANGEROUS_CAPABILITIES: readonly Capability[] = [
  "shell:execute",
  "file:delete",
  "memory:delete",
  "secret:read",
  "system:config",
  "agent:spawn",
] as const;

/** Permission grant with optional constraints */
export interface CapabilityGrant {
  /** The capability being granted */
  capability: Capability;
  /** Who granted this capability */
  grantedBy: AgentId | "system";
  /** When the grant was created */
  grantedAt: Date;
  /** When the grant expires (null = never) */
  expiresAt: Date | null;
  /** Additional constraints (e.g., rate limits, path restrictions) */
  constraints?: CapabilityConstraints;
}

/** Constraints on a capability grant */
export interface CapabilityConstraints {
  /** Max invocations per minute */
  maxPerMinute?: number;
  /** Max invocations per hour */
  maxPerHour?: number;
  /** Max invocations total */
  maxTotal?: number;
  /** Allowed paths for file operations */
  allowedPaths?: string[];
  /** Blocked paths for file operations */
  blockedPaths?: string[];
  /** Allowed hosts for network operations */
  allowedHosts?: string[];
  /** Blocked hosts for network operations */
  blockedHosts?: string[];
  /** Max data size in bytes */
  maxDataSizeBytes?: number;
  /** Require human approval for each use */
  requireApproval?: boolean;
}

/** Result of a permission check */
export interface PermissionCheckResult {
  /** Whether the operation is allowed */
  allowed: boolean;
  /** Reason if denied */
  reason?: string;
  /** The grant that allowed (if allowed) */
  grant?: CapabilityGrant;
  /** Remaining quota (if constrained) */
  remainingQuota?: {
    perMinute?: number;
    perHour?: number;
    total?: number;
  };
}

/** Capability usage tracking for rate limiting */
interface CapabilityUsage {
  /** Usage counts per minute (reset every minute) */
  minuteCount: number;
  /** Usage counts per hour (reset every hour) */
  hourCount: number;
  /** Total usage count */
  totalCount: number;
  /** Start of current minute window */
  minuteWindowStart: Date;
  /** Start of current hour window */
  hourWindowStart: Date;
}

/** Sandbox configuration */
export interface SandboxConfig {
  /** Whether to enforce permissions (false = permissive mode) */
  enforcePermissions: boolean;
  /** Default capabilities for all agents */
  defaultCapabilities: readonly Capability[];
  /** Whether dangerous capabilities require explicit approval */
  requireApprovalForDangerous: boolean;
  /** Audit all permission checks */
  auditPermissionChecks: boolean;
}

/** Default sandbox configuration */
export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  enforcePermissions: true,
  defaultCapabilities: DEFAULT_CAPABILITIES,
  requireApprovalForDangerous: true,
  auditPermissionChecks: true,
};

export function getSandboxHardeningIssues(config: SandboxConfig): string[] {
  const issues: string[] = [];

  if (!config.enforcePermissions) {
    issues.push("Sandbox must enforce permissions.");
  }

  if (!config.requireApprovalForDangerous) {
    issues.push("Sandbox must require approval for dangerous capabilities.");
  }

  if (!config.auditPermissionChecks) {
    issues.push("Sandbox must audit permission checks.");
  }

  const dangerousDefaults = config.defaultCapabilities.filter((cap) =>
    DANGEROUS_CAPABILITIES.includes(cap),
  );
  if (dangerousDefaults.length > 0) {
    issues.push(
      `Default capabilities must not include dangerous capabilities: ${dangerousDefaults.join(", ")}.`,
    );
  }

  return issues;
}

export function assertSandboxHardening(config: SandboxConfig): void {
  const issues = getSandboxHardeningIssues(config);
  if (issues.length === 0) return;
  throw new Error(
    [
      "Production hardening checks failed for sandbox:",
      ...issues.map((issue) => `- ${issue}`),
    ].join("\n"),
  );
}

/** Permission check audit entry */
export interface PermissionAuditEntry {
  agentId: AgentId;
  capability: Capability;
  allowed: boolean;
  reason?: string;
  timestamp: Date;
  context?: Record<string, unknown>;
}

/**
 * Sandbox for capability-based permission enforcement.
 * Each agent has its own sandbox instance.
 */
export class AgentSandbox {
  private readonly agentId: AgentId;
  private readonly config: SandboxConfig;
  private readonly grants: Map<Capability, CapabilityGrant> = new Map();
  private readonly usage: Map<Capability, CapabilityUsage> = new Map();
  private readonly auditLog: PermissionAuditEntry[] = [];
  private readonly maxAuditLogSize: number = 10000;

  constructor(agentId: AgentId, config: Partial<SandboxConfig> = {}) {
    this.agentId = agentId;
    this.config = { ...DEFAULT_SANDBOX_CONFIG, ...config };
    if (isProductionHardeningEnabled()) {
      assertSandboxHardening(this.config);
    }

    // Grant default capabilities
    for (const cap of this.config.defaultCapabilities) {
      this.grant(cap, "system");
    }
  }

  /** Grant a capability to this agent */
  grant(
    capability: Capability,
    grantedBy: AgentId | "system",
    options: {
      expiresAt?: Date | null;
      constraints?: CapabilityConstraints;
    } = {},
  ): void {
    const grant: CapabilityGrant = {
      capability,
      grantedBy,
      grantedAt: new Date(),
      expiresAt: options.expiresAt ?? null,
      constraints: options.constraints,
    };

    this.grants.set(capability, grant);

    // Initialize usage tracking
    const now = new Date();
    this.usage.set(capability, {
      minuteCount: 0,
      hourCount: 0,
      totalCount: 0,
      minuteWindowStart: now,
      hourWindowStart: now,
    });
  }

  /** Revoke a capability from this agent */
  revoke(capability: Capability): boolean {
    const existed = this.grants.has(capability);
    this.grants.delete(capability);
    this.usage.delete(capability);
    return existed;
  }

  /** Check if agent has a capability (without using it) */
  has(capability: Capability): boolean {
    const grant = this.grants.get(capability);
    if (!grant) return false;

    // Check expiration
    if (grant.expiresAt && grant.expiresAt < new Date()) {
      this.revoke(capability);
      return false;
    }

    return true;
  }

  /**
   * Check if an operation is permitted and record usage.
   * This is the main permission enforcement point.
   */
  check(capability: Capability, context?: Record<string, unknown>): PermissionCheckResult {
    const now = new Date();

    // Permissive mode - allow everything
    if (!this.config.enforcePermissions) {
      const result: PermissionCheckResult = { allowed: true };
      this.recordAudit(capability, result, context);
      return result;
    }

    // Check if capability is granted
    const grant = this.grants.get(capability);
    if (!grant) {
      const result: PermissionCheckResult = {
        allowed: false,
        reason: `Capability "${capability}" not granted`,
      };
      this.recordAudit(capability, result, context);
      return result;
    }

    // Check expiration
    if (grant.expiresAt && grant.expiresAt < now) {
      this.revoke(capability);
      const result: PermissionCheckResult = {
        allowed: false,
        reason: `Capability "${capability}" has expired`,
      };
      this.recordAudit(capability, result, context);
      return result;
    }

    // Check dangerous capability approval
    if (
      this.config.requireApprovalForDangerous &&
      DANGEROUS_CAPABILITIES.includes(capability) &&
      grant.constraints?.requireApproval
    ) {
      const result: PermissionCheckResult = {
        allowed: false,
        reason: `Capability "${capability}" requires human approval`,
      };
      this.recordAudit(capability, result, context);
      return result;
    }

    // Check constraints
    const constraintCheck = this.checkConstraints(capability, grant, context);
    if (!constraintCheck.allowed) {
      this.recordAudit(capability, constraintCheck, context);
      return constraintCheck;
    }

    // Update usage
    this.recordUsage(capability);

    // Calculate remaining quota
    const usage = this.usage.get(capability);
    const constraints = grant.constraints;
    const remainingQuota: PermissionCheckResult["remainingQuota"] = {};

    if (usage && constraints) {
      if (constraints.maxPerMinute !== undefined) {
        remainingQuota.perMinute = constraints.maxPerMinute - usage.minuteCount;
      }
      if (constraints.maxPerHour !== undefined) {
        remainingQuota.perHour = constraints.maxPerHour - usage.hourCount;
      }
      if (constraints.maxTotal !== undefined) {
        remainingQuota.total = constraints.maxTotal - usage.totalCount;
      }
    }

    const result: PermissionCheckResult = {
      allowed: true,
      grant,
      remainingQuota: Object.keys(remainingQuota).length > 0 ? remainingQuota : undefined,
    };

    this.recordAudit(capability, result, context);
    return result;
  }

  /** Check path-based constraints */
  checkPathConstraint(capability: Capability, path: string): PermissionCheckResult {
    const grant = this.grants.get(capability);
    if (!grant) {
      return {
        allowed: false,
        reason: `Capability "${capability}" not granted`,
      };
    }

    const constraints = grant.constraints;
    if (!constraints) {
      return { allowed: true, grant };
    }

    // Check blocked paths first
    if (constraints.blockedPaths) {
      for (const blocked of constraints.blockedPaths) {
        if (path.startsWith(blocked)) {
          return {
            allowed: false,
            reason: `Path "${path}" is blocked`,
          };
        }
      }
    }

    // Check allowed paths
    if (constraints.allowedPaths) {
      let allowed = false;
      for (const allowedPath of constraints.allowedPaths) {
        if (path.startsWith(allowedPath)) {
          allowed = true;
          break;
        }
      }
      if (!allowed) {
        return {
          allowed: false,
          reason: `Path "${path}" is not in allowed paths`,
        };
      }
    }

    return { allowed: true, grant };
  }

  /** Check host-based constraints */
  checkHostConstraint(capability: Capability, host: string): PermissionCheckResult {
    const grant = this.grants.get(capability);
    if (!grant) {
      return {
        allowed: false,
        reason: `Capability "${capability}" not granted`,
      };
    }

    const constraints = grant.constraints;
    if (!constraints) {
      return { allowed: true, grant };
    }

    // Check blocked hosts first
    if (constraints.blockedHosts) {
      for (const blocked of constraints.blockedHosts) {
        if (host === blocked || host.endsWith(`.${blocked}`)) {
          return {
            allowed: false,
            reason: `Host "${host}" is blocked`,
          };
        }
      }
    }

    // Check allowed hosts
    if (constraints.allowedHosts) {
      let allowed = false;
      for (const allowedHost of constraints.allowedHosts) {
        if (host === allowedHost || host.endsWith(`.${allowedHost}`)) {
          allowed = true;
          break;
        }
      }
      if (!allowed) {
        return {
          allowed: false,
          reason: `Host "${host}" is not in allowed hosts`,
        };
      }
    }

    return { allowed: true, grant };
  }

  /** Get all granted capabilities */
  getCapabilities(): Capability[] {
    return Array.from(this.grants.keys());
  }

  /** Get all grants with details */
  getGrants(): CapabilityGrant[] {
    return Array.from(this.grants.values());
  }

  /** Get audit log */
  getAuditLog(limit?: number): PermissionAuditEntry[] {
    return this.auditLog.slice(-(limit ?? this.auditLog.length));
  }

  /** Clear audit log */
  clearAuditLog(): void {
    this.auditLog.length = 0;
  }

  /** Get usage stats for a capability */
  getUsage(capability: Capability): CapabilityUsage | undefined {
    return this.usage.get(capability);
  }

  /** Serialize sandbox state */
  toJSON(): {
    agentId: AgentId;
    grants: Array<{ capability: Capability; grant: CapabilityGrant }>;
    usage: Array<{ capability: Capability; usage: CapabilityUsage }>;
  } {
    return {
      agentId: this.agentId,
      grants: Array.from(this.grants.entries()).map(([capability, grant]) => ({
        capability,
        grant,
      })),
      usage: Array.from(this.usage.entries()).map(([capability, usage]) => ({
        capability,
        usage,
      })),
    };
  }

  /** Restore sandbox from serialized state */
  static fromJSON(
    data: ReturnType<AgentSandbox["toJSON"]>,
    config?: Partial<SandboxConfig>,
  ): AgentSandbox {
    const sandbox = new AgentSandbox(data.agentId, {
      ...config,
      defaultCapabilities: [], // Don't add defaults when restoring
    });

    for (const { capability, grant } of data.grants) {
      sandbox.grants.set(capability, grant);
    }

    for (const { capability, usage } of data.usage) {
      sandbox.usage.set(capability, usage);
    }

    return sandbox;
  }

  /** Check rate limit constraints */
  private checkConstraints(
    capability: Capability,
    grant: CapabilityGrant,
    _context?: Record<string, unknown>,
  ): PermissionCheckResult {
    const constraints = grant.constraints;
    if (!constraints) {
      return { allowed: true, grant };
    }

    // Update usage windows
    const usage = this.usage.get(capability);
    if (usage) {
      const now = new Date();

      // Reset minute window if needed
      const minuteAge = now.getTime() - usage.minuteWindowStart.getTime();
      if (minuteAge > 60_000) {
        usage.minuteCount = 0;
        usage.minuteWindowStart = now;
      }

      // Reset hour window if needed
      const hourAge = now.getTime() - usage.hourWindowStart.getTime();
      if (hourAge > 3_600_000) {
        usage.hourCount = 0;
        usage.hourWindowStart = now;
      }

      // Check rate limits
      if (constraints.maxPerMinute !== undefined && usage.minuteCount >= constraints.maxPerMinute) {
        return {
          allowed: false,
          reason: `Rate limit exceeded: ${usage.minuteCount}/${constraints.maxPerMinute} per minute`,
        };
      }

      if (constraints.maxPerHour !== undefined && usage.hourCount >= constraints.maxPerHour) {
        return {
          allowed: false,
          reason: `Rate limit exceeded: ${usage.hourCount}/${constraints.maxPerHour} per hour`,
        };
      }

      if (constraints.maxTotal !== undefined && usage.totalCount >= constraints.maxTotal) {
        return {
          allowed: false,
          reason: `Total usage limit exceeded: ${usage.totalCount}/${constraints.maxTotal}`,
        };
      }
    }

    return { allowed: true, grant };
  }

  /** Record capability usage */
  private recordUsage(capability: Capability): void {
    const usage = this.usage.get(capability);
    if (usage) {
      usage.minuteCount++;
      usage.hourCount++;
      usage.totalCount++;
    }
  }

  /** Record audit entry */
  private recordAudit(
    capability: Capability,
    result: PermissionCheckResult,
    context?: Record<string, unknown>,
  ): void {
    if (!this.config.auditPermissionChecks) return;

    this.auditLog.push({
      agentId: this.agentId,
      capability,
      allowed: result.allowed,
      reason: result.reason,
      timestamp: new Date(),
      context,
    });

    // Trim audit log
    while (this.auditLog.length > this.maxAuditLogSize) {
      this.auditLog.shift();
    }
  }
}

/**
 * Sandbox registry managing sandboxes for all agents.
 */
export class SandboxRegistry {
  private readonly sandboxes: Map<AgentId, AgentSandbox> = new Map();
  private readonly config: SandboxConfig;

  constructor(config: Partial<SandboxConfig> = {}) {
    this.config = { ...DEFAULT_SANDBOX_CONFIG, ...config };
  }

  /** Create a sandbox for an agent */
  create(agentId: AgentId, config?: Partial<SandboxConfig>): AgentSandbox {
    const sandbox = new AgentSandbox(agentId, { ...this.config, ...config });
    this.sandboxes.set(agentId, sandbox);
    return sandbox;
  }

  /** Get sandbox for an agent */
  get(agentId: AgentId): AgentSandbox | undefined {
    return this.sandboxes.get(agentId);
  }

  /** Remove sandbox for an agent */
  remove(agentId: AgentId): boolean {
    return this.sandboxes.delete(agentId);
  }

  /** Check permission across all agents */
  checkGlobal(capability: Capability): Map<AgentId, PermissionCheckResult> {
    const results = new Map<AgentId, PermissionCheckResult>();
    for (const [agentId, sandbox] of this.sandboxes) {
      results.set(agentId, sandbox.check(capability));
    }
    return results;
  }

  /** Get all audit logs */
  getAllAuditLogs(limit?: number): Map<AgentId, PermissionAuditEntry[]> {
    const logs = new Map<AgentId, PermissionAuditEntry[]>();
    for (const [agentId, sandbox] of this.sandboxes) {
      logs.set(agentId, sandbox.getAuditLog(limit));
    }
    return logs;
  }
}

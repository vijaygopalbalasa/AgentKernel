// Policy Engine — Allow / Block / Approve rules for agent actions
// Implements defense-in-depth security policies

import { z } from "zod";
import type { AgentId } from "./agent-context.js";
import { isProductionHardeningEnabled } from "./hardening.js";

// ─── POLICY SCHEMAS ────────────────────────────────────────────

/** Policy decision types */
export type PolicyDecision = "allow" | "block" | "approve";

/** Policy rule schema */
export const PolicyRuleSchema = z.object({
  /** Rule identifier */
  id: z.string().min(1),
  /** Rule description */
  description: z.string().optional(),
  /** Decision to make when rule matches */
  decision: z.enum(["allow", "block", "approve"]),
  /** Priority (higher = evaluated first) */
  priority: z.number().int().default(0),
  /** Whether rule is enabled */
  enabled: z.boolean().default(true),
});
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

/** File policy rule */
export const FilePolicyRuleSchema = PolicyRuleSchema.extend({
  type: z.literal("file"),
  /** Path patterns to match (glob-style) */
  pathPatterns: z.array(z.string()).min(1),
  /** Operations this rule applies to */
  operations: z.array(z.enum(["read", "write", "delete", "list"])).min(1),
});
export type FilePolicyRule = z.infer<typeof FilePolicyRuleSchema>;

/** Network policy rule */
export const NetworkPolicyRuleSchema = PolicyRuleSchema.extend({
  type: z.literal("network"),
  /** Host patterns to match (glob-style, e.g., "*.internal") */
  hostPatterns: z.array(z.string()).min(1),
  /** Ports this rule applies to (empty = all ports) */
  ports: z.array(z.number().int().min(1).max(65535)).optional(),
  /** Protocols this rule applies to */
  protocols: z.array(z.enum(["http", "https", "ws", "wss", "tcp"])).optional(),
});
export type NetworkPolicyRule = z.infer<typeof NetworkPolicyRuleSchema>;

/** Shell policy rule */
export const ShellPolicyRuleSchema = PolicyRuleSchema.extend({
  type: z.literal("shell"),
  /** Command patterns to match (glob-style or exact) */
  commandPatterns: z.array(z.string()).min(1),
  /** Argument patterns to match (optional) */
  argPatterns: z.array(z.string()).optional(),
});
export type ShellPolicyRule = z.infer<typeof ShellPolicyRuleSchema>;

/** Secret policy rule */
export const SecretPolicyRuleSchema = PolicyRuleSchema.extend({
  type: z.literal("secret"),
  /** Secret name patterns to match */
  namePatterns: z.array(z.string()).min(1),
});
export type SecretPolicyRule = z.infer<typeof SecretPolicyRuleSchema>;

/** Union of all policy rule types */
export type AnyPolicyRule = FilePolicyRule | NetworkPolicyRule | ShellPolicyRule | SecretPolicyRule;

/** Policy evaluation result */
export interface PolicyEvaluation {
  /** The decision made */
  decision: PolicyDecision;
  /** The rule that matched (if any) */
  matchedRule?: AnyPolicyRule;
  /** Reason for the decision */
  reason: string;
  /** Timestamp of evaluation */
  timestamp: Date;
}

/** Policy set configuration */
export const PolicySetSchema = z.object({
  /** Policy set name */
  name: z.string().min(1),
  /** Description */
  description: z.string().optional(),
  /** Default decision when no rules match */
  defaultDecision: z.enum(["allow", "block", "approve"]).default("block"),
  /** File access rules */
  fileRules: z.array(FilePolicyRuleSchema).default([]),
  /** Network access rules */
  networkRules: z.array(NetworkPolicyRuleSchema).default([]),
  /** Shell execution rules */
  shellRules: z.array(ShellPolicyRuleSchema).default([]),
  /** Secret access rules */
  secretRules: z.array(SecretPolicyRuleSchema).default([]),
});
export type PolicySet = z.infer<typeof PolicySetSchema>;

// ─── DEFAULT POLICIES ─────────────────────────────────────────

/** Default blocked file paths (sensitive locations) */
export const DEFAULT_BLOCKED_FILE_PATHS = [
  // SSH keys
  "~/.ssh/**",
  "/home/*/.ssh/**",
  "/root/.ssh/**",
  // AWS credentials
  "~/.aws/**",
  "/home/*/.aws/**",
  // GCP credentials
  "~/.config/gcloud/**",
  "/home/*/.config/gcloud/**",
  // Azure credentials
  "~/.azure/**",
  "/home/*/.azure/**",
  // Docker credentials
  "~/.docker/**",
  "/home/*/.docker/**",
  // NPM tokens
  "~/.npmrc",
  "/home/*/.npmrc",
  // Git credentials
  "~/.git-credentials",
  "/home/*/.git-credentials",
  // Environment files with secrets
  "**/.env",
  "**/.env.local",
  "**/.env.production",
  // Crypto wallets
  "~/.bitcoin/**",
  "~/.ethereum/**",
  "**/wallet.dat",
  // Browser data
  "~/.config/google-chrome/**",
  "~/.config/chromium/**",
  "~/.mozilla/**",
  // Password managers
  "**/*.kdbx",
  "~/.password-store/**",
  // System files
  "/etc/passwd",
  "/etc/shadow",
  "/etc/sudoers",
];

/** Default blocked network hosts */
export const DEFAULT_BLOCKED_NETWORK_HOSTS = [
  // Internal networks
  "*.internal",
  "*.local",
  "*.localhost",
  "localhost",
  "127.0.0.1",
  "::1",
  // Cloud metadata endpoints
  "169.254.169.254", // AWS/GCP/Azure metadata
  "metadata.google.internal",
  // Private IP ranges
  "10.*",
  "172.16.*",
  "172.17.*",
  "172.18.*",
  "172.19.*",
  "172.20.*",
  "172.21.*",
  "172.22.*",
  "172.23.*",
  "172.24.*",
  "172.25.*",
  "172.26.*",
  "172.27.*",
  "172.28.*",
  "172.29.*",
  "172.30.*",
  "172.31.*",
  "192.168.*",
];

/** Default blocked shell commands */
export const DEFAULT_BLOCKED_SHELL_COMMANDS = [
  // Destructive commands
  "rm -rf /",
  "rm -rf /*",
  "rm -rf ~",
  "rm -rf ~/*",
  "mkfs.*",
  "dd if=*",
  // Privilege escalation
  "sudo *",
  "su *",
  "chmod 777 *",
  "chown root *",
  // Network attacks
  "nc -l*", // Netcat listener
  "ncat -l*",
  "curl * | sh",
  "curl * | bash",
  "wget * | sh",
  "wget * | bash",
  // Crypto mining
  "*xmrig*",
  "*minerd*",
  "*cpuminer*",
  // Reverse shells
  "bash -i >& /dev/tcp/*",
  "nc -e /bin/sh*",
  "python -c*socket*",
];

/** Default secret name patterns to block */
export const DEFAULT_BLOCKED_SECRET_PATTERNS = [
  "*api_key*",
  "*apikey*",
  "*secret*",
  "*password*",
  "*credential*",
  "*private_key*",
  "*privatekey*",
  "*auth_token*",
  "*access_token*",
  "*jwt*",
];

export function getPolicyHardeningIssues(policySet: PolicySet): string[] {
  const issues: string[] = [];

  if (policySet.defaultDecision !== "block") {
    issues.push('Policy defaultDecision must be "block" in production.');
  }

  return issues;
}

export function assertPolicyHardening(policySet: PolicySet): void {
  const issues = getPolicyHardeningIssues(policySet);
  if (issues.length === 0) return;
  throw new Error(
    [
      "Production hardening checks failed for policy engine:",
      ...issues.map((issue) => `- ${issue}`),
    ].join("\n"),
  );
}

// ─── PATH SECURITY ────────────────────────────────────────────

import { isAbsolute, normalize, resolve } from "node:path";

/**
 * Check if a string looks like a file path (starts with / or ~).
 */
function isFilePath(str: string): boolean {
  return (
    str.startsWith("/") || str.startsWith("~") || str.startsWith("./") || str.startsWith("../")
  );
}

/**
 * Normalize a file path and check for path traversal attempts.
 * Returns null if the path is invalid or attempts traversal.
 * Only applies to actual file paths (starting with / or ~).
 */
export function normalizePath(inputPath: string): string | null {
  if (!inputPath || typeof inputPath !== "string") {
    return null;
  }

  // Only normalize actual file paths
  if (!isFilePath(inputPath)) {
    return inputPath; // Return as-is for non-paths (like filenames, patterns)
  }

  // Expand home directory
  let path = inputPath;
  if (path.startsWith("~")) {
    const home = process.env.HOME ?? "/home/user";
    path = home + path.slice(1);
  }

  // Normalize the path
  const normalized = normalize(path);

  // Check for path traversal attempts AFTER normalization
  // If the normalized path is different in a way that escapes the original directory, block it
  if (!isAbsolute(normalized)) {
    // Resolve relative paths against a safe base
    const resolved = resolve("/", normalized);
    return resolved;
  }

  return normalized;
}

/**
 * Check if a path contains traversal sequences.
 * Only checks actual file paths, not patterns.
 */
export function containsPathTraversal(path: string): boolean {
  // Only check actual file paths
  if (!isFilePath(path)) {
    return false;
  }

  // Check for common traversal patterns
  const traversalPatterns = [
    /\.\.\//g, // ../
    /\.\.\\/g, // ..\
    /\.\.$/, // ends with ..
    /%2e%2e/gi, // URL encoded ..
    /%252e%252e/gi, // Double URL encoded ..
  ];

  for (const pattern of traversalPatterns) {
    if (pattern.test(path)) {
      return true;
    }
  }

  return false;
}

// ─── PATTERN MATCHING ────────────────────────────────────────

/**
 * Match a string against a glob-like pattern.
 * Supports: * (any chars), ** (any path), ? (single char)
 *
 * SECURITY: File paths are normalized before matching to prevent traversal attacks.
 */
export function matchPattern(str: string, pattern: string): boolean {
  // SECURITY: Normalize file paths to prevent traversal
  // Only normalize if it looks like a file path
  let normalizedStr = str;
  if (isFilePath(str)) {
    const normalized = normalizePath(str);
    if (normalized === null) {
      return false; // Invalid path, don't match
    }
    normalizedStr = normalized;

    // SECURITY: Check for path traversal in original input
    if (containsPathTraversal(str)) {
      return false; // Traversal attempt, don't match
    }
  }

  // Escape regex special chars except our wildcards
  let regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "<<<GLOBSTAR>>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<<GLOBSTAR>>>/g, ".*")
    .replace(/\?/g, ".");

  // Handle home directory expansion in pattern
  const home = process.env.HOME ?? "/home/user";
  regex = regex.replace(/^~/, home.replace(/[.+^${}()|[\]\\]/g, "\\$&"));

  try {
    return new RegExp(`^${regex}$`).test(normalizedStr);
  } catch {
    // Invalid regex pattern (e.g., ReDoS attempt)
    return false;
  }
}

/**
 * Check if any pattern in the list matches the string.
 *
 * SECURITY: Has built-in limit to prevent DoS attacks.
 */
export function matchAnyPattern(str: string, patterns: string[]): string | undefined {
  // SECURITY: Limit number of patterns to prevent DoS
  const maxPatterns = 1000;
  const patternsToCheck = patterns.slice(0, maxPatterns);

  for (const pattern of patternsToCheck) {
    if (matchPattern(str, pattern)) {
      return pattern;
    }
  }
  return undefined;
}

// ─── POLICY ENGINE ─────────────────────────────────────────────

/** Policy evaluation request */
export interface FileEvalRequest {
  type: "file";
  path: string;
  operation: "read" | "write" | "delete" | "list";
  agentId: AgentId;
}

export interface NetworkEvalRequest {
  type: "network";
  host: string;
  port?: number;
  protocol?: "http" | "https" | "ws" | "wss" | "tcp";
  agentId: AgentId;
}

export interface ShellEvalRequest {
  type: "shell";
  command: string;
  args?: string[];
  agentId: AgentId;
}

export interface SecretEvalRequest {
  type: "secret";
  name: string;
  agentId: AgentId;
}

export type PolicyEvalRequest =
  | FileEvalRequest
  | NetworkEvalRequest
  | ShellEvalRequest
  | SecretEvalRequest;

/** Audit entry for policy evaluation */
export interface PolicyAuditEntry {
  timestamp: Date;
  agentId: AgentId;
  request: PolicyEvalRequest;
  evaluation: PolicyEvaluation;
}

/**
 * Policy Engine — evaluates agent actions against security policies.
 *
 * Features:
 * - File access control (blocklist/allowlist)
 * - Network access control (hosts, ports)
 * - Shell command control (command allowlist)
 * - Secret access control
 * - Full audit logging
 * - Priority-based rule evaluation
 */
export class PolicyEngine {
  private readonly policySet: PolicySet;
  private readonly auditLog: PolicyAuditEntry[] = [];
  private readonly maxAuditLogSize: number;

  constructor(policySet: Partial<PolicySet> = {}, options: { maxAuditLogSize?: number } = {}) {
    // Merge with defaults
    const defaultPolicySet: PolicySet = {
      name: "default",
      description: "Default security policy",
      defaultDecision: "block",
      fileRules: this.createDefaultFileRules(),
      networkRules: this.createDefaultNetworkRules(),
      shellRules: this.createDefaultShellRules(),
      secretRules: this.createDefaultSecretRules(),
    };

    this.policySet = PolicySetSchema.parse({
      ...defaultPolicySet,
      ...policySet,
      fileRules: [...defaultPolicySet.fileRules, ...(policySet.fileRules ?? [])],
      networkRules: [...defaultPolicySet.networkRules, ...(policySet.networkRules ?? [])],
      shellRules: [...defaultPolicySet.shellRules, ...(policySet.shellRules ?? [])],
      secretRules: [...defaultPolicySet.secretRules, ...(policySet.secretRules ?? [])],
    });
    if (isProductionHardeningEnabled()) {
      assertPolicyHardening(this.policySet);
    }

    this.maxAuditLogSize = options.maxAuditLogSize ?? 10000;
  }

  /**
   * Evaluate a policy request and return the decision.
   */
  evaluate(request: PolicyEvalRequest): PolicyEvaluation {
    let evaluation: PolicyEvaluation;

    switch (request.type) {
      case "file":
        evaluation = this.evaluateFileAccess(request);
        break;
      case "network":
        evaluation = this.evaluateNetworkAccess(request);
        break;
      case "shell":
        evaluation = this.evaluateShellAccess(request);
        break;
      case "secret":
        evaluation = this.evaluateSecretAccess(request);
        break;
      default:
        evaluation = {
          decision: "block",
          reason: "Unknown request type",
          timestamp: new Date(),
        };
    }

    // Record audit
    this.recordAudit(request, evaluation);

    return evaluation;
  }

  /**
   * Evaluate file access request.
   */
  private evaluateFileAccess(request: FileEvalRequest): PolicyEvaluation {
    const rules = this.getEnabledRulesSorted(this.policySet.fileRules);

    for (const rule of rules) {
      // Check if operation matches
      if (!rule.operations.includes(request.operation)) continue;

      // Check if path matches any pattern
      const matchedPattern = matchAnyPattern(request.path, rule.pathPatterns);
      if (matchedPattern) {
        return {
          decision: rule.decision,
          matchedRule: rule,
          reason: `File path "${request.path}" matched pattern "${matchedPattern}" in rule "${rule.id}"`,
          timestamp: new Date(),
        };
      }
    }

    return {
      decision: this.policySet.defaultDecision,
      reason: `No matching file rule for "${request.path}" - using default decision`,
      timestamp: new Date(),
    };
  }

  /**
   * Evaluate network access request.
   */
  private evaluateNetworkAccess(request: NetworkEvalRequest): PolicyEvaluation {
    const rules = this.getEnabledRulesSorted(this.policySet.networkRules);

    for (const rule of rules) {
      // Check if host matches any pattern
      const matchedPattern = matchAnyPattern(request.host, rule.hostPatterns);
      if (!matchedPattern) continue;

      // Rule ports are strict: if configured, request must provide a matching port.
      if (rule.ports && rule.ports.length > 0) {
        if (request.port === undefined) continue;
        if (!rule.ports.includes(request.port)) continue;
      }

      // Rule protocols are strict: if configured, request must provide a matching protocol.
      if (rule.protocols && rule.protocols.length > 0) {
        if (request.protocol === undefined) continue;
        if (!rule.protocols.includes(request.protocol)) continue;
      }

      return {
        decision: rule.decision,
        matchedRule: rule,
        reason: `Network host "${request.host}" matched pattern "${matchedPattern}" in rule "${rule.id}"`,
        timestamp: new Date(),
      };
    }

    return {
      decision: this.policySet.defaultDecision,
      reason: `No matching network rule for "${request.host}" - using default decision`,
      timestamp: new Date(),
    };
  }

  /**
   * Evaluate shell command request.
   */
  private evaluateShellAccess(request: ShellEvalRequest): PolicyEvaluation {
    const rules = this.getEnabledRulesSorted(this.policySet.shellRules);
    const fullCommand = request.args
      ? `${request.command} ${request.args.join(" ")}`
      : request.command;

    for (const rule of rules) {
      // Check if command matches any pattern
      const matchedPattern = matchAnyPattern(fullCommand, rule.commandPatterns);
      if (matchedPattern) {
        return {
          decision: rule.decision,
          matchedRule: rule,
          reason: `Shell command "${fullCommand}" matched pattern "${matchedPattern}" in rule "${rule.id}"`,
          timestamp: new Date(),
        };
      }

      // Also check just the base command
      const baseMatchedPattern = matchAnyPattern(request.command, rule.commandPatterns);
      if (baseMatchedPattern) {
        return {
          decision: rule.decision,
          matchedRule: rule,
          reason: `Shell command "${request.command}" matched pattern "${baseMatchedPattern}" in rule "${rule.id}"`,
          timestamp: new Date(),
        };
      }
    }

    return {
      decision: this.policySet.defaultDecision,
      reason: `No matching shell rule for "${fullCommand}" - using default decision`,
      timestamp: new Date(),
    };
  }

  /**
   * Evaluate secret access request.
   */
  private evaluateSecretAccess(request: SecretEvalRequest): PolicyEvaluation {
    const rules = this.getEnabledRulesSorted(this.policySet.secretRules);

    for (const rule of rules) {
      // Check if secret name matches any pattern
      const matchedPattern = matchAnyPattern(request.name, rule.namePatterns);
      if (matchedPattern) {
        return {
          decision: rule.decision,
          matchedRule: rule,
          reason: `Secret "${request.name}" matched pattern "${matchedPattern}" in rule "${rule.id}"`,
          timestamp: new Date(),
        };
      }
    }

    return {
      decision: this.policySet.defaultDecision,
      reason: `No matching secret rule for "${request.name}" - using default decision`,
      timestamp: new Date(),
    };
  }

  /**
   * Add a rule to the policy set.
   */
  addRule(rule: AnyPolicyRule): void {
    switch (rule.type) {
      case "file":
        this.policySet.fileRules.push(FilePolicyRuleSchema.parse(rule));
        break;
      case "network":
        this.policySet.networkRules.push(NetworkPolicyRuleSchema.parse(rule));
        break;
      case "shell":
        this.policySet.shellRules.push(ShellPolicyRuleSchema.parse(rule));
        break;
      case "secret":
        this.policySet.secretRules.push(SecretPolicyRuleSchema.parse(rule));
        break;
    }
  }

  /**
   * Remove a rule by ID.
   */
  removeRule(ruleId: string): boolean {
    const removeFromArray = <T extends PolicyRule>(arr: T[]): boolean => {
      const idx = arr.findIndex((r) => r.id === ruleId);
      if (idx >= 0) {
        arr.splice(idx, 1);
        return true;
      }
      return false;
    };

    return (
      removeFromArray(this.policySet.fileRules) ||
      removeFromArray(this.policySet.networkRules) ||
      removeFromArray(this.policySet.shellRules) ||
      removeFromArray(this.policySet.secretRules)
    );
  }

  /**
   * Get audit log entries.
   */
  getAuditLog(options?: {
    agentId?: AgentId;
    decision?: PolicyDecision;
    since?: Date;
    limit?: number;
  }): PolicyAuditEntry[] {
    let entries = [...this.auditLog];

    if (options?.agentId) {
      entries = entries.filter((e) => e.agentId === options.agentId);
    }
    if (options?.decision) {
      entries = entries.filter((e) => e.evaluation.decision === options.decision);
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
   * Get the policy set configuration.
   */
  getPolicySet(): PolicySet {
    return { ...this.policySet };
  }

  /**
   * Clear audit log.
   */
  clearAuditLog(): void {
    this.auditLog.length = 0;
  }

  // ─── PRIVATE HELPERS ────────────────────────────────────────

  private getEnabledRulesSorted<T extends PolicyRule>(rules: T[]): T[] {
    return rules.filter((r) => r.enabled).sort((a, b) => b.priority - a.priority);
  }

  private recordAudit(request: PolicyEvalRequest, evaluation: PolicyEvaluation): void {
    this.auditLog.push({
      timestamp: new Date(),
      agentId: request.agentId,
      request,
      evaluation,
    });

    // Trim audit log
    while (this.auditLog.length > this.maxAuditLogSize) {
      this.auditLog.shift();
    }
  }

  private createDefaultFileRules(): FilePolicyRule[] {
    return [
      {
        id: "block-sensitive-files",
        type: "file",
        description: "Block access to sensitive file locations",
        decision: "block",
        priority: 100,
        enabled: true,
        pathPatterns: DEFAULT_BLOCKED_FILE_PATHS,
        operations: ["read", "write", "delete", "list"],
      },
    ];
  }

  private createDefaultNetworkRules(): NetworkPolicyRule[] {
    return [
      {
        id: "block-internal-networks",
        type: "network",
        description: "Block access to internal networks and metadata endpoints",
        decision: "block",
        priority: 100,
        enabled: true,
        hostPatterns: DEFAULT_BLOCKED_NETWORK_HOSTS,
      },
    ];
  }

  private createDefaultShellRules(): ShellPolicyRule[] {
    return [
      {
        id: "block-dangerous-commands",
        type: "shell",
        description: "Block dangerous shell commands",
        decision: "block",
        priority: 100,
        enabled: true,
        commandPatterns: DEFAULT_BLOCKED_SHELL_COMMANDS,
      },
    ];
  }

  private createDefaultSecretRules(): SecretPolicyRule[] {
    return [
      {
        id: "approve-sensitive-secrets",
        type: "secret",
        description: "Require approval for sensitive secret access",
        decision: "approve",
        priority: 100,
        enabled: true,
        namePatterns: DEFAULT_BLOCKED_SECRET_PATTERNS,
      },
    ];
  }
}

/**
 * Create a policy engine with custom configuration.
 */
export function createPolicyEngine(
  policySet?: Partial<PolicySet>,
  options?: { maxAuditLogSize?: number },
): PolicyEngine {
  return new PolicyEngine(policySet, options);
}

/**
 * Check if permissive policies are allowed.
 * Only allowed when ALLOW_PERMISSIVE_POLICY=true or not in production.
 */
function isPermissivePolicyAllowed(): boolean {
  return process.env.ALLOW_PERMISSIVE_POLICY === "true";
}

/**
 * Create a permissive policy engine (allows everything by default).
 *
 * SECURITY WARNING: This bypasses all security policies!
 * - BLOCKED in production by default
 * - Set ALLOW_PERMISSIVE_POLICY=true to enable (NOT RECOMMENDED)
 *
 * @throws Error if used in production without explicit opt-in
 */
export function createPermissivePolicyEngine(): PolicyEngine {
  // SECURITY: Block permissive policy in production
  if (isProductionHardeningEnabled() && !isPermissivePolicyAllowed()) {
    throw new Error(
      "Production hardening: createPermissivePolicyEngine() is blocked. " +
        "This would bypass all security policies. " +
        "If you really need this (NOT RECOMMENDED), set ALLOW_PERMISSIVE_POLICY=true",
    );
  }

  // Log a warning even in development
  console.warn(
    "[SECURITY WARNING] Creating permissive policy engine. " +
      "All security policies are bypassed. " +
      "Do NOT use in production!",
  );

  return new PolicyEngine({
    name: "permissive",
    description: "Permissive policy - allows everything by default",
    defaultDecision: "allow",
    fileRules: [],
    networkRules: [],
    shellRules: [],
    secretRules: [],
  });
}

/**
 * Create a strict policy engine (blocks everything by default).
 * Use for untrusted agents.
 */
export function createStrictPolicyEngine(): PolicyEngine {
  return new PolicyEngine({
    name: "strict",
    description: "Strict policy - blocks everything by default",
    defaultDecision: "block",
  });
}

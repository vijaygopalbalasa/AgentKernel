// Policy Configuration — Load and manage security policy files
// Supports YAML/JSON, environment variable expansion, and file merging

import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  type FilePolicyRule,
  type NetworkPolicyRule,
  type PolicySet,
  PolicySetSchema,
  type SecretPolicyRule,
  type ShellPolicyRule,
} from "./policy-engine.js";

// ─── TYPES ─────────────────────────────────────────────────────────────────

/** Options for loading policy configuration */
export interface PolicyConfigOptions {
  /** Expand environment variables in YAML content (default: true) */
  expandEnvVars?: boolean;
  /** Base directory for resolving relative file paths in includes */
  baseDir?: string;
  /** Process includes in policy files (default: true) */
  processIncludes?: boolean;
  /** Maximum include depth to prevent circular includes (default: 10) */
  maxIncludeDepth?: number;
}

/** Error thrown when policy configuration is invalid */
export class PolicyConfigError extends Error {
  public readonly filePath?: string;

  constructor(message: string, filePath?: string, cause?: Error) {
    super(message, { cause });
    this.name = "PolicyConfigError";
    this.filePath = filePath;
  }
}

// ─── ENVIRONMENT VARIABLE EXPANSION ────────────────────────────────────────

/**
 * Expand environment variables in a string.
 *
 * Supports two syntaxes:
 * - `${VAR_NAME}` — Replaces with the value of VAR_NAME, or empty string if undefined
 * - `${VAR_NAME:-default}` — Replaces with the value of VAR_NAME, or "default" if undefined
 *
 * @param content - The string containing environment variable placeholders
 * @param env - Environment object to use (defaults to process.env)
 * @returns The string with all environment variables expanded
 *
 * @example
 * ```typescript
 * // Given: process.env.API_HOST = "api.example.com"
 * expandEnvVars("https://${API_HOST}/v1"); // "https://api.example.com/v1"
 * expandEnvVars("${MISSING:-fallback}");   // "fallback"
 * expandEnvVars("${MISSING}");             // ""
 * ```
 */
export function expandEnvVars(content: string, env: NodeJS.ProcessEnv = process.env): string {
  // Pattern: ${VAR_NAME} or ${VAR_NAME:-default_value}
  // VAR_NAME can contain letters, numbers, and underscores
  // default_value can contain anything except }
  const pattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

  return content.replace(pattern, (_match, varName: string, defaultValue?: string) => {
    const value = env[varName];
    if (value !== undefined) {
      return value;
    }
    return defaultValue ?? "";
  });
}

/**
 * Recursively expand environment variables in an object.
 * Only expands variables in string values.
 *
 * @param obj - The object to process
 * @param env - Environment object to use
 * @returns A new object with environment variables expanded in all string values
 */
export function expandEnvVarsInObject<T>(obj: T, env: NodeJS.ProcessEnv = process.env): T {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === "string") {
    return expandEnvVars(obj, env) as T;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => expandEnvVarsInObject(item, env)) as T;
  }

  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = expandEnvVarsInObject(value, env);
    }
    return result as T;
  }

  return obj;
}

// ─── FILE LOADING ──────────────────────────────────────────────────────────

/**
 * Parse a policy file (YAML or JSON) from content string.
 *
 * @param content - The file content as a string
 * @param filePath - The file path (used to determine format)
 * @returns The parsed content as unknown
 */
function parseFileContent(content: string, filePath: string): unknown {
  const ext = extname(filePath).toLowerCase();

  if (ext === ".yaml" || ext === ".yml") {
    return parseYaml(content);
  }

  if (ext === ".json") {
    return JSON.parse(content);
  }

  // Try YAML first, then JSON
  try {
    return parseYaml(content);
  } catch {
    return JSON.parse(content);
  }
}

/**
 * Load a policy set from a file.
 *
 * @param filePath - Path to the policy file (YAML or JSON)
 * @param options - Configuration options
 * @returns The loaded and validated PolicySet
 * @throws PolicyConfigError if the file is invalid or cannot be read
 *
 * @example
 * ```typescript
 * const policy = loadPolicySetFromFile("./policies/production.yaml");
 * const engine = createPolicyEngine(policy);
 * ```
 */
export function loadPolicySetFromFile(
  filePath: string,
  options: PolicyConfigOptions = {},
): Partial<PolicySet> {
  const {
    expandEnvVars: shouldExpand = true,
    processIncludes = true,
    baseDir,
    maxIncludeDepth = 10,
  } = options;

  const resolvedPath = resolve(baseDir ?? process.cwd(), filePath);

  if (!existsSync(resolvedPath)) {
    throw new PolicyConfigError(`Policy file not found: ${resolvedPath}`, resolvedPath);
  }

  let content: string;
  try {
    content = readFileSync(resolvedPath, "utf-8");
  } catch (error) {
    throw new PolicyConfigError(
      `Failed to read policy file: ${resolvedPath}`,
      resolvedPath,
      error instanceof Error ? error : undefined,
    );
  }

  // Expand environment variables in the raw content
  if (shouldExpand) {
    content = expandEnvVars(content);
  }

  let parsed: unknown;
  try {
    parsed = parseFileContent(content, resolvedPath);
  } catch (error) {
    throw new PolicyConfigError(
      `Failed to parse policy file: ${resolvedPath}`,
      resolvedPath,
      error instanceof Error ? error : undefined,
    );
  }

  // Process includes if enabled
  if (processIncludes && parsed && typeof parsed === "object" && "includes" in parsed) {
    const parsedObj = parsed as Record<string, unknown>;
    const includes = parsedObj.includes;

    if (Array.isArray(includes) && maxIncludeDepth > 0) {
      // Remove includes from the object before merging
      parsedObj.includes = undefined;

      // Load and merge included files
      const currentDir = dirname(resolvedPath);
      const includedPolicies: Partial<PolicySet>[] = [];

      for (const includePath of includes) {
        if (typeof includePath === "string") {
          const included = loadPolicySetFromFile(includePath, {
            ...options,
            baseDir: currentDir,
            maxIncludeDepth: maxIncludeDepth - 1,
          });
          includedPolicies.push(included);
        }
      }

      // Merge: base includes first, then current file
      if (includedPolicies.length > 0) {
        const merged = mergePolicySets(...includedPolicies);
        parsed = mergePolicySets(merged, parsedObj as Partial<PolicySet>) as unknown;
      }
    }
  }

  // Validate against schema
  const result = PolicySetSchema.partial().safeParse(parsed);
  if (!result.success) {
    throw new PolicyConfigError(
      `Invalid policy file format: ${result.error.message}`,
      resolvedPath,
    );
  }

  return result.data;
}

/**
 * Load and merge multiple policy files.
 * Later files override earlier files (rules are merged by ID).
 *
 * @param filePaths - Array of paths to policy files
 * @param options - Configuration options
 * @returns The merged PolicySet
 *
 * @example
 * ```typescript
 * const policy = loadPolicySetFromFiles([
 *   "./policies/base.yaml",      // Base rules
 *   "./policies/production.yaml" // Production overrides
 * ]);
 * ```
 */
export function loadPolicySetFromFiles(
  filePaths: string[],
  options: PolicyConfigOptions = {},
): Partial<PolicySet> {
  if (filePaths.length === 0) {
    return {};
  }

  const policies = filePaths.map((path) => loadPolicySetFromFile(path, options));
  return mergePolicySets(...policies);
}

// ─── POLICY MERGING ────────────────────────────────────────────────────────

/**
 * Merge multiple policy sets together.
 * Later policy sets override earlier ones.
 * Rules with the same ID are replaced, not merged.
 *
 * @param policies - Policy sets to merge (in order of precedence, last wins)
 * @returns The merged PolicySet
 */
export function mergePolicySets(...policies: Partial<PolicySet>[]): Partial<PolicySet> {
  if (policies.length === 0) {
    return {};
  }

  if (policies.length === 1) {
    return policies[0]!;
  }

  const result: Partial<PolicySet> = {};

  for (const policy of policies) {
    // Merge simple fields (later overwrites earlier)
    if (policy.name !== undefined) result.name = policy.name;
    if (policy.description !== undefined) result.description = policy.description;
    if (policy.defaultDecision !== undefined) result.defaultDecision = policy.defaultDecision;

    // Merge rule arrays (by ID)
    if (policy.fileRules) {
      result.fileRules = mergeRulesById(result.fileRules ?? [], policy.fileRules);
    }
    if (policy.networkRules) {
      result.networkRules = mergeRulesById(result.networkRules ?? [], policy.networkRules);
    }
    if (policy.shellRules) {
      result.shellRules = mergeRulesById(result.shellRules ?? [], policy.shellRules);
    }
    if (policy.secretRules) {
      result.secretRules = mergeRulesById(result.secretRules ?? [], policy.secretRules);
    }
  }

  return result;
}

/**
 * Merge rule arrays by ID.
 * Rules with the same ID are replaced by the later one.
 */
function mergeRulesById<T extends { id: string }>(base: T[], override: T[]): T[] {
  const rulesById = new Map<string, T>();

  // Add base rules
  for (const rule of base) {
    rulesById.set(rule.id, rule);
  }

  // Override with new rules
  for (const rule of override) {
    rulesById.set(rule.id, rule);
  }

  return Array.from(rulesById.values());
}

// ─── POLICY VALIDATION ─────────────────────────────────────────────────────

/** Validation issue found in a policy set */
export interface PolicyValidationIssue {
  /** Issue severity */
  severity: "error" | "warning";
  /** Issue message */
  message: string;
  /** Related rule ID if applicable */
  ruleId?: string;
  /** Issue location in the policy */
  path?: string;
}

/**
 * Validate a policy set for common issues.
 *
 * @param policy - The policy set to validate
 * @returns Array of validation issues (empty if valid)
 */
export function validatePolicySet(policy: Partial<PolicySet>): PolicyValidationIssue[] {
  const issues: PolicyValidationIssue[] = [];

  // Check for duplicate rule IDs within categories
  const checkDuplicateIds = (rules: { id: string }[] | undefined, category: string) => {
    if (!rules) return;

    const ids = new Set<string>();
    for (const rule of rules) {
      if (ids.has(rule.id)) {
        issues.push({
          severity: "error",
          message: `Duplicate rule ID "${rule.id}" in ${category}Rules`,
          ruleId: rule.id,
          path: `${category}Rules`,
        });
      }
      ids.add(rule.id);
    }
  };

  checkDuplicateIds(policy.fileRules, "file");
  checkDuplicateIds(policy.networkRules, "network");
  checkDuplicateIds(policy.shellRules, "shell");
  checkDuplicateIds(policy.secretRules, "secret");

  // Check for conflicting rules (same pattern, different decisions)
  const checkConflictingRules = (
    rules: { id: string; decision: string; priority: number }[] | undefined,
    category: string,
  ) => {
    if (!rules) return;

    // Group rules by priority
    const byPriority = new Map<number, typeof rules>();
    for (const rule of rules) {
      const group = byPriority.get(rule.priority) ?? [];
      group.push(rule);
      byPriority.set(rule.priority, group);
    }

    // Check for mixed decisions at same priority
    for (const [priority, group] of byPriority) {
      const decisions = new Set(group.map((r) => r.decision));
      if (decisions.size > 1) {
        issues.push({
          severity: "warning",
          message: `Multiple ${category}Rules at priority ${priority} have different decisions (${Array.from(decisions).join(", ")})`,
          path: `${category}Rules`,
        });
      }
    }
  };

  checkConflictingRules(policy.fileRules, "file");
  checkConflictingRules(policy.networkRules, "network");
  checkConflictingRules(policy.shellRules, "shell");
  checkConflictingRules(policy.secretRules, "secret");

  // Check for permissive default with no blocking rules
  if (policy.defaultDecision === "allow") {
    const hasBlockingRules =
      policy.fileRules?.some((r) => r.decision === "block") ||
      policy.networkRules?.some((r) => r.decision === "block") ||
      policy.shellRules?.some((r) => r.decision === "block") ||
      policy.secretRules?.some((r) => r.decision === "block");

    if (!hasBlockingRules) {
      issues.push({
        severity: "warning",
        message:
          "Policy has defaultDecision='allow' with no blocking rules - this is very permissive",
        path: "defaultDecision",
      });
    }
  }

  return issues;
}

// ─── POLICY GENERATION HELPERS ─────────────────────────────────────────────

/**
 * Create a basic file rule.
 */
export function createFileRule(
  id: string,
  decision: "allow" | "block" | "approve",
  pathPatterns: string[],
  options: {
    operations?: Array<"read" | "write" | "delete" | "list">;
    priority?: number;
    description?: string;
    enabled?: boolean;
  } = {},
): FilePolicyRule {
  return {
    id,
    type: "file",
    decision,
    priority: options.priority ?? 50,
    enabled: options.enabled ?? true,
    description: options.description,
    pathPatterns,
    operations: options.operations ?? ["read", "write", "delete", "list"],
  };
}

/**
 * Create a basic network rule.
 */
export function createNetworkRule(
  id: string,
  decision: "allow" | "block" | "approve",
  hostPatterns: string[],
  options: {
    ports?: number[];
    protocols?: Array<"http" | "https" | "ws" | "wss">;
    priority?: number;
    description?: string;
    enabled?: boolean;
  } = {},
): NetworkPolicyRule {
  return {
    id,
    type: "network",
    decision,
    priority: options.priority ?? 50,
    enabled: options.enabled ?? true,
    description: options.description,
    hostPatterns,
    ports: options.ports,
    protocols: options.protocols,
  };
}

/**
 * Create a basic shell rule.
 */
export function createShellRule(
  id: string,
  decision: "allow" | "block" | "approve",
  commandPatterns: string[],
  options: {
    argPatterns?: string[];
    priority?: number;
    description?: string;
    enabled?: boolean;
  } = {},
): ShellPolicyRule {
  return {
    id,
    type: "shell",
    decision,
    priority: options.priority ?? 50,
    enabled: options.enabled ?? true,
    description: options.description,
    commandPatterns,
    argPatterns: options.argPatterns,
  };
}

/**
 * Create a basic secret rule.
 */
export function createSecretRule(
  id: string,
  decision: "allow" | "block" | "approve",
  namePatterns: string[],
  options: {
    priority?: number;
    description?: string;
    enabled?: boolean;
  } = {},
): SecretPolicyRule {
  return {
    id,
    type: "secret",
    decision,
    priority: options.priority ?? 50,
    enabled: options.enabled ?? true,
    description: options.description,
    namePatterns,
  };
}

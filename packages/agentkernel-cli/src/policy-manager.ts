// Policy Manager — User-friendly policy management for non-technical users
// Provides natural language target resolution, simplified YAML I/O,
// template generation, and human-readable policy summaries.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  FilePolicyRule,
  NetworkPolicyRule,
  PolicySet,
  SecretPolicyRule,
  ShellPolicyRule,
} from "@agentkernel/runtime";
import {
  APPROVAL_REQUIRED_COMMANDS,
  CLOUD_METADATA_HOSTS,
  DANGEROUS_SHELL_PATTERNS,
  MALICIOUS_EXFIL_DOMAINS,
  SENSITIVE_FILE_PATTERNS,
} from "./default-policy.js";

// ─── TYPES ─────────────────────────────────────────────────────

export type PolicyTemplate = "strict" | "balanced" | "permissive";
export type PolicyDecision = "allow" | "block" | "approve";
export type TargetType = "domain" | "file" | "command" | "secret";

export interface ResolvedTarget {
  type: TargetType;
  label: string;
  patterns: string[];
  reason: string;
  knownMalicious: boolean;
}

export interface SimplifiedRule {
  pattern?: string;
  host?: string;
  command?: string;
  name?: string;
  decision: PolicyDecision;
  reason?: string;
}

export interface SimplifiedSection {
  default?: PolicyDecision;
  rules?: SimplifiedRule[];
}

export interface SimplifiedPolicyYaml {
  template?: string;
  file?: SimplifiedSection;
  network?: SimplifiedSection;
  shell?: SimplifiedSection;
  secret?: SimplifiedSection;
}

export interface RuleAddResult {
  success: boolean;
  description: string;
  alreadyExists: boolean;
}

export interface RuleRemoveResult {
  removed: number;
  descriptions: string[];
  warnings: string[];
}

export interface PolicySummarySection {
  label: string;
  patterns: string[];
}

export interface PolicySummary {
  templateName: string;
  defaultDecision: string;
  blockedFiles: PolicySummarySection[];
  allowedFiles: PolicySummarySection[];
  blockedDomains: PolicySummarySection[];
  allowedDomains: PolicySummarySection[];
  blockedCommands: PolicySummarySection[];
  allowedCommands: PolicySummarySection[];
  blockedSecrets: PolicySummarySection[];
  allowedSecrets: PolicySummarySection[];
}

export interface TestResult {
  decision: PolicyDecision;
  reason: string;
  matchedRule?: string;
}

export interface InitOptions {
  template: PolicyTemplate;
  projectFolder?: string;
  allowDevTools?: boolean;
}

// ─── KNOWN TARGETS MAP ─────────────────────────────────────────

interface KnownTarget {
  type: TargetType;
  label: string;
  patterns: string[];
  reason: string;
  malicious: boolean;
}

const KNOWN_TARGETS: Record<string, KnownTarget> = {
  // ── Malicious network targets ──
  telegram: {
    type: "domain",
    label: "Telegram",
    patterns: ["api.telegram.org", "*.telegram.org"],
    reason: "Data exfiltration channel",
    malicious: true,
  },
  discord: {
    type: "domain",
    label: "Discord",
    patterns: ["discord.com", "discordapp.com"],
    reason: "Data exfiltration channel",
    malicious: true,
  },
  pastebin: {
    type: "domain",
    label: "Pastebin",
    patterns: ["pastebin.com"],
    reason: "Data exfiltration",
    malicious: true,
  },
  ngrok: {
    type: "domain",
    label: "Ngrok",
    patterns: ["*.ngrok.io", "*.ngrok-free.app"],
    reason: "Reverse tunnel",
    malicious: true,
  },
  "cloud metadata": {
    type: "domain",
    label: "Cloud Metadata",
    patterns: [...CLOUD_METADATA_HOSTS],
    reason: "SSRF target",
    malicious: true,
  },
  "paste sites": {
    type: "domain",
    label: "Paste Sites",
    patterns: ["pastebin.com", "hastebin.com", "paste.ee", "ghostbin.com", "dpaste.org"],
    reason: "Data exfiltration",
    malicious: true,
  },
  // ── Safe network targets ──
  github: {
    type: "domain",
    label: "GitHub",
    patterns: ["*.github.com", "api.github.com", "raw.githubusercontent.com"],
    reason: "Code hosting",
    malicious: false,
  },
  npm: {
    type: "domain",
    label: "NPM Registry",
    patterns: ["*.npmjs.org", "registry.npmjs.org"],
    reason: "Package registry",
    malicious: false,
  },
  pypi: {
    type: "domain",
    label: "PyPI",
    patterns: ["*.pypi.org", "pypi.org"],
    reason: "Package registry",
    malicious: false,
  },
  openai: {
    type: "domain",
    label: "OpenAI API",
    patterns: ["*.openai.com"],
    reason: "AI API",
    malicious: false,
  },
  anthropic: {
    type: "domain",
    label: "Anthropic API",
    patterns: ["*.anthropic.com"],
    reason: "AI API",
    malicious: false,
  },
  google: {
    type: "domain",
    label: "Google APIs",
    patterns: ["*.googleapis.com"],
    reason: "Cloud API",
    malicious: false,
  },
  docker: {
    type: "domain",
    label: "Docker",
    patterns: ["*.docker.io", "*.docker.com"],
    reason: "Container registry",
    malicious: false,
  },
  stackoverflow: {
    type: "domain",
    label: "Stack Overflow",
    patterns: ["*.stackoverflow.com", "*.stackexchange.com"],
    reason: "Q&A site",
    malicious: false,
  },
  // ── File targets ──
  "ssh keys": {
    type: "file",
    label: "SSH Keys",
    patterns: ["**/.ssh/**"],
    reason: "SSH credentials",
    malicious: true,
  },
  "aws credentials": {
    type: "file",
    label: "AWS Credentials",
    patterns: ["**/.aws/**"],
    reason: "Cloud credentials",
    malicious: true,
  },
  "env files": {
    type: "file",
    label: "Environment Files",
    patterns: ["**/.env", "**/.env.*"],
    reason: "Environment secrets",
    malicious: true,
  },
  "crypto wallets": {
    type: "file",
    label: "Crypto Wallets",
    patterns: ["**/Library/Application Support/Exodus/**", "**/.electrum/**", "**/.bitcoin/**"],
    reason: "Cryptocurrency wallets",
    malicious: true,
  },
  "browser data": {
    type: "file",
    label: "Browser Data",
    patterns: ["**/Login Data", "**/Cookies", "**/logins.json"],
    reason: "Browser credentials",
    malicious: true,
  },
  keychain: {
    type: "file",
    label: "macOS Keychain",
    patterns: ["**/Library/Keychains/**"],
    reason: "System keychain",
    malicious: true,
  },
  // ── Shell command targets ──
  "reverse shells": {
    type: "command",
    label: "Reverse Shells",
    patterns: ["bash -i", "nc -e", "python*pty.spawn"],
    reason: "Reverse shell access",
    malicious: true,
  },
  "download execute": {
    type: "command",
    label: "Download & Execute",
    patterns: ["curl*|*sh", "curl*|*bash", "wget*|*sh", "wget*|*bash"],
    reason: "Malware installation",
    malicious: true,
  },
};

// ─── TARGET RESOLUTION ─────────────────────────────────────────

/**
 * Resolve a natural language input to a policy target.
 * Tries: exact match → substring match → heuristic detection.
 */
export function resolveTarget(input: string): ResolvedTarget | null {
  if (!input || !input.trim()) return null;

  const normalized = input.trim().toLowerCase();

  // 1. Exact match
  if (KNOWN_TARGETS[normalized]) {
    const t = KNOWN_TARGETS[normalized]!;
    return {
      type: t.type,
      label: t.label,
      patterns: [...t.patterns],
      reason: t.reason,
      knownMalicious: t.malicious,
    };
  }

  // 2. Substring match (first match wins)
  for (const [key, t] of Object.entries(KNOWN_TARGETS)) {
    if (key.includes(normalized) || normalized.includes(key)) {
      return {
        type: t.type,
        label: t.label,
        patterns: [...t.patterns],
        reason: t.reason,
        knownMalicious: t.malicious,
      };
    }
  }

  // 3. Heuristic: detect type from input format
  return resolveByHeuristic(input.trim());
}

/**
 * Resolve with an explicit type override (for --domain, --file, --command flags).
 */
export function resolveTypedTarget(input: string, type: TargetType): ResolvedTarget {
  let pattern = input.trim();

  if (type === "file") {
    // Auto-append /** for directory-like paths without glob
    if (!pattern.includes("*") && !pattern.match(/\.[a-z]+$/i)) {
      pattern = pattern.endsWith("/") ? `${pattern}**` : `${pattern}/**`;
    }
  }

  return {
    type,
    label: pattern,
    patterns: [pattern],
    reason: `User-defined ${type} rule`,
    knownMalicious: false,
  };
}

function resolveByHeuristic(input: string): ResolvedTarget | null {
  // File path: starts with /, ~, or ./
  if (input.startsWith("/") || input.startsWith("~") || input.startsWith("./")) {
    let pattern = input;
    if (!pattern.includes("*") && !pattern.match(/\.[a-z]+$/i)) {
      pattern = pattern.endsWith("/") ? `${pattern}**` : `${pattern}/**`;
    }
    return {
      type: "file",
      label: input,
      patterns: [pattern],
      reason: "User-defined file rule",
      knownMalicious: false,
    };
  }

  // Domain: contains a dot and no spaces
  if (input.includes(".") && !input.includes(" ")) {
    return {
      type: "domain",
      label: input,
      patterns: [input],
      reason: "User-defined domain rule",
      knownMalicious: false,
    };
  }

  // Everything else: treat as shell command
  if (input.length > 0) {
    return {
      type: "command",
      label: input,
      patterns: [input],
      reason: "User-defined command rule",
      knownMalicious: false,
    };
  }

  return null;
}

// ─── POLICY YAML I/O ──────────────────────────────────────────

/**
 * Load simplified policy YAML from file.
 * Returns empty structure if file doesn't exist.
 */
export function loadSimplifiedPolicy(policyPath: string): SimplifiedPolicyYaml {
  if (!existsSync(policyPath)) {
    return {};
  }

  const content = readFileSync(policyPath, "utf-8");
  // Simple YAML parser for our known structure
  return parseSimplifiedYaml(content);
}

/**
 * Save simplified policy to YAML file.
 * Creates parent directories if needed.
 */
export function saveSimplifiedPolicy(policyPath: string, policy: SimplifiedPolicyYaml): void {
  const dir = dirname(policyPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const yaml = stringifySimplifiedYaml(policy);
  writeFileSync(policyPath, yaml, "utf-8");
}

/**
 * Convert simplified YAML format to runtime PolicySet format.
 * This bridges the user-friendly YAML keys to the PolicyEngine's expected structure.
 */
export function simplifiedToRuntimeFormat(yaml: SimplifiedPolicyYaml): Partial<PolicySet> {
  const result: Partial<PolicySet> = {
    name: yaml.template ?? "custom",
    defaultDecision: "block",
  };

  let ruleId = 0;
  const nextId = (prefix: string) => `${prefix}-${++ruleId}`;

  // File rules
  if (yaml.file?.rules) {
    result.fileRules = yaml.file.rules
      .filter((r) => r.pattern)
      .map((r) => ({
        id: nextId("file"),
        type: "file" as const,
        description: r.reason,
        decision: r.decision,
        priority: r.decision === "block" ? 100 : 50,
        enabled: true,
        pathPatterns: [r.pattern!],
        operations: ["read", "write", "delete", "list"] as const,
      }));
  }

  // Network rules
  if (yaml.network?.rules) {
    result.networkRules = yaml.network.rules
      .filter((r) => r.host)
      .map((r) => ({
        id: nextId("network"),
        type: "network" as const,
        description: r.reason,
        decision: r.decision,
        priority: r.decision === "block" ? 100 : 50,
        enabled: true,
        hostPatterns: [r.host!],
      }));
  }

  // Shell rules
  if (yaml.shell?.rules) {
    result.shellRules = yaml.shell.rules
      .filter((r) => r.command)
      .map((r) => ({
        id: nextId("shell"),
        type: "shell" as const,
        description: r.reason,
        decision: r.decision,
        priority: r.decision === "block" ? 100 : r.decision === "approve" ? 90 : 50,
        enabled: true,
        commandPatterns: [r.command!],
      }));
  }

  // Secret rules
  if (yaml.secret?.rules) {
    result.secretRules = yaml.secret.rules
      .filter((r) => r.name)
      .map((r) => ({
        id: nextId("secret"),
        type: "secret" as const,
        description: r.reason,
        decision: r.decision,
        priority: r.decision === "allow" ? 100 : 90,
        enabled: true,
        namePatterns: [r.name!],
      }));
  }

  return result;
}

// ─── RULE MANAGEMENT ──────────────────────────────────────────

/**
 * Add an allow rule to the policy file.
 */
export function addAllowRule(policyPath: string, target: ResolvedTarget): RuleAddResult {
  return addRule(policyPath, target, "allow");
}

/**
 * Add a block rule to the policy file.
 */
export function addBlockRule(policyPath: string, target: ResolvedTarget): RuleAddResult {
  return addRule(policyPath, target, "block");
}

function addRule(
  policyPath: string,
  target: ResolvedTarget,
  decision: PolicyDecision,
): RuleAddResult {
  const policy = loadSimplifiedPolicy(policyPath);

  const section = getSectionForType(policy, target.type);
  if (!section.rules) {
    section.rules = [];
  }

  // Check for duplicates
  for (const pattern of target.patterns) {
    const exists = section.rules.some(
      (r) => getRulePattern(r, target.type) === pattern && r.decision === decision,
    );
    if (exists) {
      return {
        success: true,
        description: `${decision === "allow" ? "Allow" : "Block"} rule for ${target.label} already exists`,
        alreadyExists: true,
      };
    }
  }

  // Add rules for each pattern
  for (const pattern of target.patterns) {
    const rule = createRuleForType(target.type, pattern, decision, target.reason);
    section.rules.push(rule);
  }

  saveSimplifiedPolicy(policyPath, policy);

  return {
    success: true,
    description: `${decision === "allow" ? "Allow" : "Block"} ${target.type} access: ${target.label} (${target.patterns.join(", ")})`,
    alreadyExists: false,
  };
}

/**
 * Remove rules matching a target from the policy file.
 */
export function removeRules(policyPath: string, target: ResolvedTarget): RuleRemoveResult {
  const policy = loadSimplifiedPolicy(policyPath);
  const section = getSectionForType(policy, target.type);

  if (!section.rules || section.rules.length === 0) {
    return { removed: 0, descriptions: [], warnings: [] };
  }

  const before = section.rules.length;
  const removed: string[] = [];

  section.rules = section.rules.filter((r) => {
    const val = getRulePattern(r, target.type);
    if (val && target.patterns.includes(val)) {
      removed.push(`${r.decision} rule for ${val}`);
      return false;
    }
    return true;
  });

  const warnings: string[] = [];
  if (target.knownMalicious && removed.length > 0) {
    warnings.push(
      `WARNING: ${target.label} was blocked because it is ${target.reason.toLowerCase()}. ` +
        `Run 'agentkernel block ${target.label.toLowerCase()}' to re-block.`,
    );
  }

  if (removed.length > 0) {
    saveSimplifiedPolicy(policyPath, policy);
  }

  return {
    removed: before - section.rules.length,
    descriptions: removed,
    warnings,
  };
}

function getSectionForType(policy: SimplifiedPolicyYaml, type: TargetType): SimplifiedSection {
  switch (type) {
    case "file":
      if (!policy.file) policy.file = { rules: [] };
      return policy.file;
    case "domain":
      if (!policy.network) policy.network = { rules: [] };
      return policy.network;
    case "command":
      if (!policy.shell) policy.shell = { rules: [] };
      return policy.shell;
    case "secret":
      if (!policy.secret) policy.secret = { rules: [] };
      return policy.secret;
  }
}

function getRulePattern(rule: SimplifiedRule, type: TargetType): string | undefined {
  switch (type) {
    case "file":
      return rule.pattern;
    case "domain":
      return rule.host;
    case "command":
      return rule.command;
    case "secret":
      return rule.name;
  }
}

function createRuleForType(
  type: TargetType,
  pattern: string,
  decision: PolicyDecision,
  reason: string,
): SimplifiedRule {
  const base: SimplifiedRule = { decision, reason };
  switch (type) {
    case "file":
      return { ...base, pattern };
    case "domain":
      return { ...base, host: pattern };
    case "command":
      return { ...base, command: pattern };
    case "secret":
      return { ...base, name: pattern };
  }
}

// ─── POLICY SUMMARY ──────────────────────────────────────────

/**
 * Generate a human-readable summary of the current policy.
 */
export function summarizePolicy(policyPath: string): PolicySummary {
  const policy = loadSimplifiedPolicy(policyPath);

  const summary: PolicySummary = {
    templateName: policy.template ?? "custom",
    defaultDecision: inferDefaultDecision(policy),
    blockedFiles: [],
    allowedFiles: [],
    blockedDomains: [],
    allowedDomains: [],
    blockedCommands: [],
    allowedCommands: [],
    blockedSecrets: [],
    allowedSecrets: [],
  };

  // File rules
  for (const rule of policy.file?.rules ?? []) {
    if (!rule.pattern) continue;
    const entry = { label: rule.reason ?? rule.pattern, patterns: [rule.pattern] };
    if (rule.decision === "block") summary.blockedFiles.push(entry);
    else if (rule.decision === "allow") summary.allowedFiles.push(entry);
  }

  // Network rules
  for (const rule of policy.network?.rules ?? []) {
    if (!rule.host) continue;
    const entry = { label: rule.reason ?? rule.host, patterns: [rule.host] };
    if (rule.decision === "block") summary.blockedDomains.push(entry);
    else if (rule.decision === "allow") summary.allowedDomains.push(entry);
  }

  // Shell rules
  for (const rule of policy.shell?.rules ?? []) {
    if (!rule.command) continue;
    const entry = { label: rule.reason ?? rule.command, patterns: [rule.command] };
    if (rule.decision === "block" || rule.decision === "approve")
      summary.blockedCommands.push(entry);
    else if (rule.decision === "allow") summary.allowedCommands.push(entry);
  }

  // Secret rules
  for (const rule of policy.secret?.rules ?? []) {
    if (!rule.name) continue;
    const entry = { label: rule.reason ?? rule.name, patterns: [rule.name] };
    if (rule.decision === "block") summary.blockedSecrets.push(entry);
    else if (rule.decision === "allow") summary.allowedSecrets.push(entry);
  }

  return summary;
}

function inferDefaultDecision(policy: SimplifiedPolicyYaml): string {
  // Check if majority of sections use block
  const defaults = [
    policy.file?.default,
    policy.network?.default,
    policy.shell?.default,
    policy.secret?.default,
  ].filter(Boolean);

  if (defaults.length === 0) return "block";
  const blockCount = defaults.filter((d) => d === "block").length;
  return blockCount >= defaults.length / 2 ? "block" : "allow";
}

// ─── POLICY TESTING ──────────────────────────────────────────

/**
 * Test what the policy would do for a given action.
 * Uses PolicyEngine.evaluate() under the hood.
 */
export async function testPolicy(
  policyPath: string,
  request: { file?: string; domain?: string; command?: string },
): Promise<TestResult> {
  const { PolicyEngine } = await import("@agentkernel/runtime");
  const { mergeWithDefaultPolicy } = await import("./default-policy.js");

  const simplified = loadSimplifiedPolicy(policyPath);
  const partial = simplifiedToRuntimeFormat(simplified);
  const policySet = mergeWithDefaultPolicy(partial);

  const engine = new PolicyEngine(policySet);

  if (request.file) {
    const result = engine.evaluate({
      type: "file",
      path: request.file,
      operation: "read",
      agentId: "test",
    });
    return {
      decision: result.decision,
      reason: result.reason,
      matchedRule: result.matchedRule?.id,
    };
  }

  if (request.domain) {
    const result = engine.evaluate({
      type: "network",
      host: request.domain,
      agentId: "test",
    });
    return {
      decision: result.decision,
      reason: result.reason,
      matchedRule: result.matchedRule?.id,
    };
  }

  if (request.command) {
    const result = engine.evaluate({
      type: "shell",
      command: request.command,
      agentId: "test",
    });
    return {
      decision: result.decision,
      reason: result.reason,
      matchedRule: result.matchedRule?.id,
    };
  }

  return { decision: "block", reason: "No test target specified" };
}

// ─── TEMPLATE GENERATION ─────────────────────────────────────

/**
 * Generate a policy YAML string from a template.
 */
export function generatePolicyFromTemplate(options: InitOptions): string {
  const { template, projectFolder, allowDevTools = true } = options;

  const policy: SimplifiedPolicyYaml = { template };

  // ─── File rules ───
  const fileRules: SimplifiedRule[] = [];

  // All templates block sensitive files
  const sensitiveGroups: Array<{ patterns: string[]; reason: string }> = [
    { patterns: ["**/.ssh/**"], reason: "SSH credentials" },
    { patterns: ["**/.aws/**"], reason: "AWS credentials" },
    { patterns: ["**/.env", "**/.env.*"], reason: "Environment secrets" },
    {
      patterns: ["**/Library/Application Support/Exodus/**", "**/.electrum/**", "**/.bitcoin/**"],
      reason: "Crypto wallets",
    },
    { patterns: ["**/Library/Keychains/**"], reason: "macOS Keychain" },
    {
      patterns: ["**/.config/gcloud/**", "**/.azure/**", "**/.kube/config"],
      reason: "Cloud credentials",
    },
    { patterns: ["**/Login Data", "**/Cookies", "**/logins.json"], reason: "Browser data" },
    {
      patterns: ["**/.npmrc", "**/.pypirc", "**/.git-credentials", "**/.netrc"],
      reason: "API tokens",
    },
  ];

  for (const group of sensitiveGroups) {
    for (const pattern of group.patterns) {
      fileRules.push({ pattern, decision: "block", reason: group.reason });
    }
  }

  // Allow project folder
  if (projectFolder) {
    let pattern = projectFolder;
    if (!pattern.includes("*")) {
      pattern = pattern.endsWith("/") ? `${pattern}**` : `${pattern}/**`;
    }
    fileRules.push({ pattern, decision: "allow", reason: "Your project folder" });
  }

  // Allow temp and cwd
  fileRules.push({ pattern: "/tmp/**", decision: "allow", reason: "Temp files" });
  fileRules.push({ pattern: "./**", decision: "allow", reason: "Current directory" });

  policy.file = {
    default: template === "permissive" ? "allow" : "block",
    rules: fileRules,
  };

  // ─── Network rules ───
  const networkRules: SimplifiedRule[] = [];

  // All templates block exfil domains
  const exfilGroups: Array<{ hosts: string[]; reason: string }> = [
    { hosts: ["api.telegram.org", "*.telegram.org"], reason: "Telegram - exfil channel" },
    { hosts: ["discord.com", "discordapp.com"], reason: "Discord - exfil channel" },
    { hosts: ["pastebin.com", "hastebin.com", "paste.ee"], reason: "Paste sites" },
    { hosts: ["*.ngrok.io", "*.ngrok-free.app", "*.trycloudflare.com"], reason: "Reverse tunnels" },
    { hosts: ["transfer.sh", "file.io", "0x0.st"], reason: "File sharing" },
  ];

  for (const group of exfilGroups) {
    for (const host of group.hosts) {
      networkRules.push({ host, decision: "block", reason: group.reason });
    }
  }

  // Block SSRF targets
  for (const host of CLOUD_METADATA_HOSTS) {
    networkRules.push({ host, decision: "block", reason: "Cloud metadata (SSRF)" });
  }
  networkRules.push({ host: "10.*", decision: "block", reason: "Internal network" });
  networkRules.push({ host: "192.168.*", decision: "block", reason: "Internal network" });
  networkRules.push({ host: "172.16.*", decision: "block", reason: "Internal network" });
  networkRules.push({ host: "127.*", decision: "block", reason: "Loopback" });
  networkRules.push({ host: "localhost", decision: "block", reason: "Loopback" });

  // Allow dev tools (balanced + permissive, or strict if opted in)
  if (template !== "strict" || allowDevTools) {
    const devHosts = [
      { host: "*.npmjs.org", reason: "NPM Registry" },
      { host: "registry.npmjs.org", reason: "NPM Registry" },
      { host: "*.github.com", reason: "GitHub" },
      { host: "api.github.com", reason: "GitHub API" },
      { host: "raw.githubusercontent.com", reason: "GitHub Raw" },
      { host: "*.pypi.org", reason: "PyPI" },
      { host: "*.anthropic.com", reason: "Anthropic API" },
      { host: "*.openai.com", reason: "OpenAI API" },
      { host: "*.googleapis.com", reason: "Google APIs" },
      { host: "*.docker.io", reason: "Docker Hub" },
    ];
    for (const { host, reason } of devHosts) {
      networkRules.push({ host, decision: "allow", reason });
    }
  }

  policy.network = {
    default: template === "permissive" ? "allow" : "block",
    rules: networkRules,
  };

  // ─── Shell rules ───
  const shellRules: SimplifiedRule[] = [];

  // Block dangerous commands (all templates)
  const dangerousGroups: Array<{ commands: string[]; reason: string }> = [
    {
      commands: ["curl*|*sh", "curl*|*bash", "wget*|*sh", "wget*|*bash"],
      reason: "Download & execute",
    },
    { commands: ["bash -i", "nc -e", "python*pty.spawn"], reason: "Reverse shell" },
    { commands: ["chmod*+s", "setuid"], reason: "Privilege escalation" },
    { commands: ["rm*-rf*/var/log", "history*-c", "unset*HISTFILE"], reason: "Anti-forensics" },
    { commands: ["base64*-d*|*sh"], reason: "Obfuscated execution" },
  ];

  for (const group of dangerousGroups) {
    for (const command of group.commands) {
      shellRules.push({ command, decision: "block", reason: group.reason });
    }
  }

  // Approval-required commands (balanced uses approve, strict uses block)
  const approvalDecision: PolicyDecision = template === "balanced" ? "approve" : "block";
  const approvalGroups: Array<{ commands: string[]; reason: string }> = [
    { commands: ["rm -rf*", "rm -r*"], reason: "Destructive operation" },
    {
      commands: ["git push --force*", "git push -f*", "git reset --hard*"],
      reason: "Dangerous git operation",
    },
    { commands: ["npm publish*", "pip upload*"], reason: "Package publish" },
    { commands: ["sudo*"], reason: "Elevated privileges" },
  ];

  if (template !== "permissive") {
    for (const group of approvalGroups) {
      for (const command of group.commands) {
        shellRules.push({ command, decision: approvalDecision, reason: group.reason });
      }
    }
  }

  // Allow safe commands
  const safeCommands = [
    "git",
    "npm",
    "pnpm",
    "node",
    "python",
    "ls",
    "cat",
    "grep",
    "find",
    "pwd",
    "echo",
  ];
  for (const command of safeCommands) {
    shellRules.push({ command, decision: "allow", reason: "Safe dev tool" });
  }

  policy.shell = {
    default: template === "permissive" ? "allow" : "block",
    rules: shellRules,
  };

  // ─── Secret rules ───
  const secretRules: SimplifiedRule[] = [];

  // Allow safe env vars
  const safeVars = ["PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "NODE_ENV", "PWD"];
  for (const name of safeVars) {
    secretRules.push({ name, decision: "allow", reason: "Safe environment variable" });
  }

  // Block sensitive secrets
  const blockedSecrets = [
    "*_API_KEY",
    "*_SECRET",
    "*_TOKEN",
    "*_PASSWORD",
    "ANTHROPIC_*",
    "OPENAI_*",
    "AWS_*",
    "DATABASE_*",
  ];
  for (const name of blockedSecrets) {
    secretRules.push({ name, decision: "block", reason: "Sensitive credential" });
  }

  policy.secret = { default: "block", rules: secretRules };

  return stringifySimplifiedYaml(policy);
}

// ─── YAML SERIALIZATION ──────────────────────────────────────
// Simple YAML parser/writer for our known structure. Avoids external dependency.

function parseSimplifiedYaml(content: string): SimplifiedPolicyYaml {
  const result: SimplifiedPolicyYaml = {};
  const lines = content.split("\n");

  let currentSection: "file" | "network" | "shell" | "secret" | null = null;
  let inRules = false;
  let currentRule: SimplifiedRule | null = null;

  for (const rawLine of lines) {
    const line = rawLine;
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Top-level keys (must be at column 0, no indentation)
    if (
      rawLine[0] !== " " &&
      rawLine[0] !== "\t" &&
      !trimmed.startsWith("-") &&
      trimmed.endsWith(":")
    ) {
      const key = trimmed.slice(0, -1);
      if (key === "file" || key === "network" || key === "shell" || key === "secret") {
        // Push pending rule before switching sections
        if (currentRule && currentSection) {
          result[currentSection]!.rules!.push(currentRule);
        }
        currentSection = key;
        if (!result[currentSection]) result[currentSection] = {};
        inRules = false;
        currentRule = null;
      } else if (key === "template") {
        // handled as key: value below
      }
      continue;
    }

    // template: value
    if (trimmed.startsWith("template:")) {
      result.template = trimmed.split(":")[1]?.trim().replace(/['"]/g, "");
      continue;
    }

    if (!currentSection) continue;

    // default: value
    if (trimmed.startsWith("default:")) {
      const val = trimmed.split(":")[1]?.trim().replace(/['"]/g, "") as PolicyDecision;
      result[currentSection]!.default = val;
      continue;
    }

    // rules:
    if (trimmed === "rules:") {
      inRules = true;
      if (!result[currentSection]!.rules) result[currentSection]!.rules = [];
      continue;
    }

    if (!inRules) continue;

    // New rule item (starts with -)
    if (trimmed.startsWith("- ")) {
      if (currentRule) {
        result[currentSection]!.rules!.push(currentRule);
      }
      currentRule = {} as SimplifiedRule;
      const kvPart = trimmed.slice(2).trim();
      parseRuleKv(currentRule, kvPart);
      continue;
    }

    // Continuation of current rule (indented key: value)
    if (currentRule && (trimmed.includes(":") || rawLine.startsWith("      "))) {
      parseRuleKv(currentRule, trimmed);
    }
  }

  // Push last rule
  if (currentRule && currentSection) {
    result[currentSection]!.rules!.push(currentRule);
  }

  return result;
}

function parseRuleKv(rule: SimplifiedRule, kv: string): void {
  const colonIdx = kv.indexOf(":");
  if (colonIdx < 0) return;

  const key = kv.slice(0, colonIdx).trim();
  const value = kv
    .slice(colonIdx + 1)
    .trim()
    .replace(/^["']|["']$/g, "");

  switch (key) {
    case "pattern":
      rule.pattern = value;
      break;
    case "host":
      rule.host = value;
      break;
    case "command":
      rule.command = value;
      break;
    case "name":
      rule.name = value;
      break;
    case "decision":
      rule.decision = value as PolicyDecision;
      break;
    case "reason":
      rule.reason = value;
      break;
  }
}

function stringifySimplifiedYaml(policy: SimplifiedPolicyYaml): string {
  const lines: string[] = [
    "# AgentKernel Security Policy",
    "# Documentation: https://github.com/vijaygopalbalasa/AgentKernel",
    "",
  ];

  if (policy.template) {
    lines.push(`template: ${policy.template}`, "");
  }

  if (policy.file) {
    lines.push("file:");
    if (policy.file.default) lines.push(`  default: ${policy.file.default}`);
    lines.push("  rules:");
    for (const rule of policy.file.rules ?? []) {
      lines.push(`    - pattern: "${rule.pattern}"`);
      lines.push(`      decision: ${rule.decision}`);
      if (rule.reason) lines.push(`      reason: "${rule.reason}"`);
    }
    lines.push("");
  }

  if (policy.network) {
    lines.push("network:");
    if (policy.network.default) lines.push(`  default: ${policy.network.default}`);
    lines.push("  rules:");
    for (const rule of policy.network.rules ?? []) {
      lines.push(`    - host: "${rule.host}"`);
      lines.push(`      decision: ${rule.decision}`);
      if (rule.reason) lines.push(`      reason: "${rule.reason}"`);
    }
    lines.push("");
  }

  if (policy.shell) {
    lines.push("shell:");
    if (policy.shell.default) lines.push(`  default: ${policy.shell.default}`);
    lines.push("  rules:");
    for (const rule of policy.shell.rules ?? []) {
      lines.push(`    - command: "${rule.command}"`);
      lines.push(`      decision: ${rule.decision}`);
      if (rule.reason) lines.push(`      reason: "${rule.reason}"`);
    }
    lines.push("");
  }

  if (policy.secret) {
    lines.push("secret:");
    if (policy.secret.default) lines.push(`  default: ${policy.secret.default}`);
    lines.push("  rules:");
    for (const rule of policy.secret.rules ?? []) {
      lines.push(`    - name: "${rule.name}"`);
      lines.push(`      decision: ${rule.decision}`);
      if (rule.reason) lines.push(`      reason: "${rule.reason}"`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

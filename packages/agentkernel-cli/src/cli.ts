#!/usr/bin/env node
// AgentKernel CLI — Security runtime for AI agents

import { parseArgs } from "node:util";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createOpenClawProxy, type OpenClawProxyConfig } from "./proxy.js";
import { loadOpenClawProxyConfigFromEnv } from "./config.js";
import { getDefaultOpenClawPolicy, mergeWithDefaultPolicy } from "./default-policy.js";
import { ConsoleOpenClawAuditSink, FileOpenClawAuditSink, type OpenClawAuditSink } from "./audit.js";

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
    ║                     v0.1.0                                ║
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
  start           Start the security proxy
  init            Initialize security policy in ~/.agentkernel/
  status          Show proxy status and statistics
  audit           View audit logs
  config          Show current configuration

${colors.bold}Start Options:${colors.reset}
  --port <number>         Proxy listen port (default: 18788)
  --gateway <url>         Agent gateway URL (default: ws://127.0.0.1:18789)
  --policy <file>         Custom policy YAML file
  --log-file <file>       Audit log file path

${colors.bold}Audit Options:${colors.reset}
  --since <duration>      Show logs since (e.g., 1h, 30m, 1d)
  --blocked-only          Show only blocked operations
  --tool <name>           Filter by tool name
  --limit <number>        Limit number of entries (default: 100)

${colors.bold}Examples:${colors.reset}
  # Quick start (2 steps)
  npm install -g agentkernel
  agentkernel start

  # Initialize with custom policy
  agentkernel init
  agentkernel start --policy ~/.agentkernel/policy.yaml

  # View blocked operations
  agentkernel audit --blocked-only --since 1h

${colors.bold}Environment Variables:${colors.reset}
  AGENTKERNEL_PORT           Proxy listen port
  AGENTKERNEL_GATEWAY_URL    Agent gateway URL
  AGENTKERNEL_POLICY_FILE    Custom policy file path

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

async function initCommand(): Promise<void> {
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
  if (existsSync(policyFile)) {
    log(`  Policy file already exists: ${policyFile}`, "yellow");
    log("  Use --force to overwrite", "yellow");
    return;
  }

  // Write default policy
  const policyYaml = `# AgentKernel Security Policy
# Protects against credential theft, data exfiltration, and malware
# Documentation: https://github.com/vijaygopalbalasa/AgentKernel

# File access rules
file:
  default: allow
  rules:
    # Block sensitive credentials
    - pattern: "**/.ssh/**"
      decision: block
      reason: "SSH credentials"
    - pattern: "**/.aws/**"
      decision: block
      reason: "AWS credentials"
    - pattern: "**/.env"
      decision: block
      reason: "Environment secrets"
    - pattern: "**/.env.*"
      decision: block
      reason: "Environment secrets"
    - pattern: "**/credentials*"
      decision: block
      reason: "Credentials file"

    # Block crypto wallets
    - pattern: "**/Library/Application Support/Exodus/**"
      decision: block
      reason: "Crypto wallet"
    - pattern: "**/.electrum/**"
      decision: block
      reason: "Crypto wallet"

    # Allow working directories
    - pattern: "~/workspace/**"
      decision: allow
    - pattern: "/tmp/**"
      decision: allow

# Network access rules
network:
  default: allow
  rules:
    # Block data exfiltration channels
    - host: "api.telegram.org"
      decision: block
      reason: "Telegram - common exfil channel"
    - host: "discord.com"
      decision: block
      reason: "Discord webhooks"
    - host: "pastebin.com"
      decision: block
      reason: "Paste site - data exfil"
    - host: "*.ngrok.io"
      decision: block
      reason: "Reverse tunnel"

    # Block cloud metadata (SSRF)
    - host: "169.254.169.254"
      decision: block
      reason: "Cloud metadata endpoint"
    - host: "metadata.google.internal"
      decision: block
      reason: "GCP metadata"

    # Block internal networks
    - host: "10.*"
      decision: block
      reason: "Internal network"
    - host: "192.168.*"
      decision: block
      reason: "Internal network"

# Shell command rules
shell:
  default: allow
  rules:
    # Block dangerous patterns
    - command: "curl*|*sh"
      decision: block
      reason: "Download and execute"
    - command: "curl*|*bash"
      decision: block
      reason: "Download and execute"
    - command: "wget*|*sh"
      decision: block
      reason: "Download and execute"
    - command: "bash -i"
      decision: block
      reason: "Reverse shell"
    - command: "nc -e"
      decision: block
      reason: "Netcat reverse shell"

    # Require approval for destructive ops
    - command: "rm -rf*"
      decision: approve
      reason: "Destructive operation"
    - command: "git push --force*"
      decision: approve
      reason: "Force push"
    - command: "npm publish*"
      decision: approve
      reason: "Package publish"

    # Allow common safe tools
    - command: "git"
      decision: allow
    - command: "npm"
      decision: allow
    - command: "node"
      decision: allow
    - command: "python"
      decision: allow

# Secret/environment variable rules
secret:
  default: block
  rules:
    # Allow safe environment variables
    - name: "PATH"
      decision: allow
    - name: "HOME"
      decision: allow
    - name: "USER"
      decision: allow
    - name: "NODE_ENV"
      decision: allow
    - name: "PWD"
      decision: allow

    # Block API keys and secrets
    - name: "*_API_KEY"
      decision: block
    - name: "*_TOKEN"
      decision: block
    - name: "*_SECRET"
      decision: block
    - name: "ANTHROPIC_*"
      decision: block
    - name: "OPENAI_*"
      decision: block
`;

  writeFileSync(policyFile, policyYaml, "utf-8");
  log(`  Created security policy: ${policyFile}`, "green");

  log(`
${colors.green}${colors.bold}Setup complete!${colors.reset}

${colors.bold}Next steps:${colors.reset}
  1. Start the security proxy:
     ${colors.cyan}agentkernel start${colors.reset}

  2. Configure your AI agent to use the proxy:
     Gateway URL: ${colors.cyan}ws://localhost:18788${colors.reset}

  3. (Optional) Customize the policy:
     ${colors.cyan}${policyFile}${colors.reset}
`);
}

// ─── START COMMAND ────────────────────────────────────────────────

async function startCommand(args: {
  port?: number;
  gateway?: string;
  policy?: string;
  logFile?: string;
}): Promise<void> {
  printBanner();

  // Load config from environment
  const envConfig = loadOpenClawProxyConfigFromEnv();

  // Merge with CLI args
  const config: OpenClawProxyConfig = {
    ...envConfig,
    listenPort: args.port ?? envConfig.listenPort ?? 18788,
    gatewayUrl: args.gateway ?? envConfig.gatewayUrl ?? "ws://127.0.0.1:18789",
    skipSsrfValidation: true, // Allow localhost gateway
  };

  // Load policy
  let policySet = getDefaultOpenClawPolicy();

  if (args.policy) {
    log(`Loading policy from ${args.policy}...`, "cyan");
    const { loadPolicySetFromFile } = await import("@agentkernel/runtime");
    const customPolicy = loadPolicySetFromFile(args.policy);
    policySet = mergeWithDefaultPolicy(customPolicy);
  } else {
    // Check for default policy file
    const defaultPolicyFile = getPolicyFile();
    if (existsSync(defaultPolicyFile)) {
      log(`Loading policy from ${defaultPolicyFile}...`, "cyan");
      const { loadPolicySetFromFile } = await import("@agentkernel/runtime");
      const customPolicy = loadPolicySetFromFile(defaultPolicyFile);
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

  // Approval callback
  config.onApprovalRequest = async (call) => {
    log(`\n  [APPROVAL REQUIRED] ${call.tool}`, "yellow");
    log(`  Args: ${JSON.stringify(call.args)}`, "yellow");
    log("  Approve? (y/n): ", "yellow");
    return false; // Non-interactive mode
  };

  log(`\nStarting AgentKernel security proxy...`, "cyan");
  log(`  Listen port: ${config.listenPort}`, "blue");
  log(`  Gateway URL: ${config.gatewayUrl}`, "blue");
  log(`  Audit log: ${logFile}`, "blue");

  try {
    const proxy = await createOpenClawProxy(config);

    log(`
${colors.green}${colors.bold}AgentKernel is running!${colors.reset}

Your AI agents are now protected against:
  ${colors.green}✓${colors.reset} Credential theft (API keys, tokens, SSH keys)
  ${colors.green}✓${colors.reset} Data exfiltration (Telegram, Discord, paste sites)
  ${colors.green}✓${colors.reset} Malware (reverse shells, download & execute)
  ${colors.green}✓${colors.reset} SSRF attacks (cloud metadata, internal networks)

${colors.bold}Configure your agent gateway:${colors.reset}
  ws://localhost:${config.listenPort}

Press Ctrl+C to stop
`);

    // Handle shutdown
    const shutdown = async (signal: string) => {
      log(`\nReceived ${signal}, shutting down...`, "yellow");
      await proxy.stop();

      const stats = proxy.getStats();
      log(`
${colors.cyan}Session Statistics:${colors.reset}
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
    log(`  Config dir: Not initialized`, "yellow");
    log(`  Run 'agentkernel init' to set up`, "yellow");
  }

  // Check policy file
  if (existsSync(policyFile)) {
    log(`  Policy file: ${policyFile}`, "green");
  } else {
    log(`  Policy file: Using defaults`, "yellow");
  }

  log("\n  Run 'agentkernel start' to start the security proxy");
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
  const { readdirSync } = await import("fs");
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
    case "s": return value * 1000;
    case "m": return value * 60 * 1000;
    case "h": return value * 60 * 60 * 1000;
    case "d": return value * 24 * 60 * 60 * 1000;
    default: return 3600000;
  }
}

// ─── CONFIG COMMAND ───────────────────────────────────────────────

async function configCommand(): Promise<void> {
  log("\nAgentKernel Configuration", "cyan");
  log("─".repeat(40));

  const envConfig = loadOpenClawProxyConfigFromEnv();

  log(`  Listen port:  ${envConfig.listenPort ?? 18788}`, "blue");
  log(`  Gateway URL:  ${envConfig.gatewayUrl ?? "ws://127.0.0.1:18789"}`, "blue");
  log(`  Config dir:   ${getConfigDir()}`, "blue");

  const policyFile = getPolicyFile();
  if (existsSync(policyFile)) {
    log(`  Policy file:  ${policyFile}`, "green");
  } else {
    log(`  Policy file:  Using defaults`, "yellow");
  }

  log(`
${colors.bold}Environment Variables:${colors.reset}
  AGENTKERNEL_PORT           Proxy listen port
  AGENTKERNEL_GATEWAY_URL    Agent gateway URL
  AGENTKERNEL_POLICY_FILE    Custom policy file path
`);
}

// ─── MAIN ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      port: { type: "string" },
      gateway: { type: "string" },
      policy: { type: "string" },
      "log-file": { type: "string" },
      since: { type: "string" },
      "blocked-only": { type: "boolean" },
      tool: { type: "string" },
      limit: { type: "string" },
      force: { type: "boolean" },
    },
  });

  if (values.version) {
    console.log("agentkernel v0.1.0");
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
        port: values.port ? Number.parseInt(values.port, 10) : undefined,
        gateway: values.gateway,
        policy: values.policy,
        logFile: values["log-file"],
      });
      break;

    case "init":
      await initCommand();
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

// Default Security Policy for OpenClaw
// Based on analysis of 341+ malicious ClawHub skills
// Blocks AMOS Stealer, reverse shells, credential theft, and data exfiltration

import type {
  PolicySet,
  FilePolicyRule,
  NetworkPolicyRule,
  ShellPolicyRule,
  SecretPolicyRule,
} from "@agentkernel/runtime";

// ─── KNOWN MALICIOUS PATTERNS ─────────────────────────────────────

/**
 * Known malicious domains used for data exfiltration.
 * Based on analysis of malicious ClawHub skills.
 */
export const MALICIOUS_EXFIL_DOMAINS = [
  // Telegram bots (most common exfil channel)
  "api.telegram.org",
  "*.telegram.org",

  // Discord webhooks
  "discord.com",
  "discordapp.com",

  // Paste sites (data exfil)
  "pastebin.com",
  "hastebin.com",
  "paste.ee",
  "ghostbin.com",
  "dpaste.org",
  "privatebin.net",

  // File sharing (malware download/exfil)
  "transfer.sh",
  "file.io",
  "0x0.st",
  "tmpfiles.org",

  // Ngrok and similar (reverse tunnels)
  "*.ngrok.io",
  "*.ngrok-free.app",
  "*.trycloudflare.com",
  "*.loca.lt",
  "*.localtunnel.me",

  // Known C2 infrastructure
  "*.onion",
];

/**
 * Cloud metadata endpoints (SSRF targets).
 */
export const CLOUD_METADATA_HOSTS = [
  "169.254.169.254",           // AWS/GCP/Azure metadata
  "metadata.google.internal",   // GCP
  "metadata.goog",             // GCP
  "169.254.170.2",             // AWS ECS
];

/**
 * Sensitive file paths that should never be accessed.
 * Targets of AMOS Stealer and similar malware.
 */
export const SENSITIVE_FILE_PATTERNS = [
  // SSH credentials
  "**/.ssh/id_*",
  "**/.ssh/known_hosts",
  "**/.ssh/authorized_keys",
  "**/.ssh/config",

  // Cloud credentials
  "**/.aws/credentials",
  "**/.aws/config",
  "**/.config/gcloud/**",
  "**/.azure/**",
  "**/.kube/config",

  // Environment files with secrets
  "**/.env",
  "**/.env.*",
  "**/env.local",
  "**/.envrc",

  // Browser data (credential theft)
  "**/Library/Application Support/Google/Chrome/Default/Login Data",
  "**/Library/Application Support/Google/Chrome/Default/Cookies",
  "**/Library/Application Support/Firefox/Profiles/*/logins.json",
  "**/Library/Application Support/Firefox/Profiles/*/cookies.sqlite",
  "**/.config/google-chrome/Default/Login Data",
  "**/.mozilla/firefox/*/logins.json",

  // macOS Keychain
  "**/Library/Keychains/**",

  // API tokens and credentials
  "**/.npmrc",
  "**/.pypirc",
  "**/.docker/config.json",
  "**/.git-credentials",
  "**/.netrc",
  "**/credentials.json",
  "**/service-account.json",

  // Crypto wallets (AMOS Stealer targets)
  "**/Library/Application Support/Exodus/**",
  "**/Library/Application Support/Atomic/**",
  "**/Library/Application Support/Electrum/**",
  "**/Library/Application Support/Bitcoin/**",
  "**/.config/Exodus/**",
  "**/.electrum/**",
  "**/.bitcoin/**",

  // Browser extension data (Metamask, Phantom, etc.)
  "**/Library/Application Support/Google/Chrome/Default/Local Extension Settings/**",
  "**/Library/Application Support/BraveSoftware/Brave-Browser/Default/Local Extension Settings/**",
  "**/.config/google-chrome/Default/Local Extension Settings/**",

  // Password managers
  "**/.password-store/**",
  "**/Library/Application Support/1Password/**",
  "**/Library/Application Support/Bitwarden/**",
];

/**
 * Dangerous shell commands that indicate malicious activity.
 */
export const DANGEROUS_SHELL_PATTERNS = [
  // Download and execute (common malware pattern)
  "curl*|*sh",
  "curl*|*bash",
  "wget*|*sh",
  "wget*|*bash",
  "curl*-o*/tmp/*&&*sh",
  "curl*-o*/tmp/*&&*bash",

  // Reverse shells
  "bash -i",
  "bash*>&*/dev/tcp",
  "nc -e",
  "nc*-c*/bin/sh",
  "nc*-c*/bin/bash",
  "python*pty.spawn",
  "python*socket*subprocess",
  "perl*socket",
  "ruby*TCPSocket",
  "php*fsockopen",

  // Privilege escalation
  "chmod*+s",
  "chmod*4755",
  "chmod*u+s",
  "setuid",

  // Process injection
  "ptrace",
  "LD_PRELOAD",
  "DYLD_INSERT_LIBRARIES",

  // Anti-forensics
  "rm*-rf*/var/log",
  "rm*-rf*~/.bash_history",
  "history*-c",
  "unset*HISTFILE",

  // Keylogging
  "xinput*",
  "xdotool*",
  "logkeys",

  // Screen capture
  "screencapture",
  "import*-window*root",
  "scrot",

  // Clipboard theft
  "pbpaste",
  "xclip",
  "xsel",

  // Base64 obfuscation (used to hide malicious commands)
  "base64*-d*|*sh",
  "base64*-d*|*bash",
  "echo*|*base64*-d*|*sh",
];

/**
 * Shell commands that require human approval.
 */
export const APPROVAL_REQUIRED_COMMANDS = [
  // Destructive operations
  "rm -rf*",
  "rm -r*",
  "rmdir*",

  // Git dangerous operations
  "git push --force*",
  "git push -f*",
  "git reset --hard*",
  "git clean -fd*",

  // Package publishing
  "npm publish*",
  "pnpm publish*",
  "yarn publish*",
  "pip upload*",
  "twine upload*",

  // System modification
  "sudo*",
  "su -*",
  "doas*",

  // Service management
  "systemctl*",
  "launchctl*",

  // Disk operations
  "dd if=*",
  "mkfs*",
  "fdisk*",
];

// ─── DEFAULT POLICY RULES ─────────────────────────────────────────

/** Generate unique rule IDs */
let ruleCounter = 0;
function nextRuleId(prefix: string): string {
  return `${prefix}-${++ruleCounter}`;
}

/**
 * Default file rules for OpenClaw security.
 */
function createDefaultFileRules(): FilePolicyRule[] {
  const rules: FilePolicyRule[] = [];

  // Block sensitive file patterns
  for (const pattern of SENSITIVE_FILE_PATTERNS) {
    rules.push({
      id: nextRuleId("file-block"),
      type: "file",
      description: `Block sensitive file: ${pattern}`,
      decision: "block",
      priority: 100,
      enabled: true,
      pathPatterns: [pattern],
      operations: ["read", "write", "delete", "list"],
    });
  }

  // Allow common working directories
  rules.push({
    id: nextRuleId("file-allow"),
    type: "file",
    description: "Allow /tmp directory",
    decision: "allow",
    priority: 50,
    enabled: true,
    pathPatterns: ["/tmp/**"],
    operations: ["read", "write", "delete", "list"],
  });

  rules.push({
    id: nextRuleId("file-allow"),
    type: "file",
    description: "Allow workspace directory",
    decision: "allow",
    priority: 50,
    enabled: true,
    pathPatterns: ["~/workspace/**", "~/projects/**"],
    operations: ["read", "write", "delete", "list"],
  });

  // Allow current working directory (essential for agents to work)
  rules.push({
    id: nextRuleId("file-allow"),
    type: "file",
    description: "Allow current working directory",
    decision: "allow",
    priority: 50,
    enabled: true,
    pathPatterns: ["./**", "${CWD}/**"],
    operations: ["read", "write", "delete", "list"],
  });

  // Allow common read-only paths
  rules.push({
    id: nextRuleId("file-allow"),
    type: "file",
    description: "Allow reading node_modules",
    decision: "allow",
    priority: 50,
    enabled: true,
    pathPatterns: ["**/node_modules/**"],
    operations: ["read", "list"],
  });

  return rules;
}

/**
 * Default network rules for OpenClaw security.
 */
function createDefaultNetworkRules(): NetworkPolicyRule[] {
  const rules: NetworkPolicyRule[] = [];

  // Block malicious exfiltration domains
  for (const host of MALICIOUS_EXFIL_DOMAINS) {
    rules.push({
      id: nextRuleId("network-block"),
      type: "network",
      description: `Block exfil domain: ${host}`,
      decision: "block",
      priority: 100,
      enabled: true,
      hostPatterns: [host],
    });
  }

  // Block cloud metadata endpoints
  for (const host of CLOUD_METADATA_HOSTS) {
    rules.push({
      id: nextRuleId("network-block"),
      type: "network",
      description: `Block cloud metadata: ${host}`,
      decision: "block",
      priority: 100,
      enabled: true,
      hostPatterns: [host],
    });
  }

  // Block internal network ranges
  rules.push({
    id: nextRuleId("network-block"),
    type: "network",
    description: "Block internal network (10.x.x.x)",
    decision: "block",
    priority: 100,
    enabled: true,
    hostPatterns: ["10.*"],
  });

  rules.push({
    id: nextRuleId("network-block"),
    type: "network",
    description: "Block internal network (172.16-31.x.x)",
    decision: "block",
    priority: 100,
    enabled: true,
    hostPatterns: ["172.16.*", "172.17.*", "172.18.*", "172.19.*", "172.2*.*", "172.30.*", "172.31.*"],
  });

  rules.push({
    id: nextRuleId("network-block"),
    type: "network",
    description: "Block internal network (192.168.x.x)",
    decision: "block",
    priority: 100,
    enabled: true,
    hostPatterns: ["192.168.*"],
  });

  rules.push({
    id: nextRuleId("network-block"),
    type: "network",
    description: "Block loopback",
    decision: "block",
    priority: 100,
    enabled: true,
    hostPatterns: ["127.*", "localhost"],
  });

  // Allow common public APIs (needed since default is now "block")
  const allowedHosts = [
    "*.npmjs.org", "registry.npmjs.org",  // npm
    "*.github.com", "api.github.com", "raw.githubusercontent.com",  // GitHub
    "*.pypi.org", "pypi.org",  // PyPI
    "*.googleapis.com",  // Google APIs
    "*.anthropic.com",  // Anthropic API
    "*.openai.com",  // OpenAI API
    "*.jsdelivr.net", "*.cdnjs.cloudflare.com",  // CDNs
    "*.stackexchange.com", "*.stackoverflow.com",  // Stack Overflow
    "*.docker.io", "*.docker.com",  // Docker
  ];

  for (const host of allowedHosts) {
    rules.push({
      id: nextRuleId("network-allow"),
      type: "network",
      description: `Allow public API: ${host}`,
      decision: "allow",
      priority: 50,
      enabled: true,
      hostPatterns: [host],
    });
  }

  return rules;
}

/**
 * Default shell rules for OpenClaw security.
 */
function createDefaultShellRules(): ShellPolicyRule[] {
  const rules: ShellPolicyRule[] = [];

  // Block dangerous shell patterns
  for (const pattern of DANGEROUS_SHELL_PATTERNS) {
    rules.push({
      id: nextRuleId("shell-block"),
      type: "shell",
      description: `Block dangerous command: ${pattern}`,
      decision: "block",
      priority: 100,
      enabled: true,
      commandPatterns: [pattern],
    });
  }

  // Block sensitive commands (approval requires interactive mode)
  // NOTE: In daemon/non-interactive mode, these are blocked by default.
  // Use a custom policy file to allow specific commands if needed.
  for (const command of APPROVAL_REQUIRED_COMMANDS) {
    rules.push({
      id: nextRuleId("shell-block-sensitive"),
      type: "shell",
      description: `Block sensitive command: ${command}`,
      decision: "block",
      priority: 90,
      enabled: true,
      commandPatterns: [command],
    });
  }

  // Allow common safe commands
  const safeCommands = ["git", "npm", "pnpm", "node", "python", "ls", "cat", "grep", "find", "pwd", "echo"];
  for (const cmd of safeCommands) {
    rules.push({
      id: nextRuleId("shell-allow"),
      type: "shell",
      description: `Allow safe command: ${cmd}`,
      decision: "allow",
      priority: 50,
      enabled: true,
      commandPatterns: [cmd],
    });
  }

  return rules;
}

/**
 * Default secret rules for OpenClaw security.
 */
function createDefaultSecretRules(): SecretPolicyRule[] {
  const rules: SecretPolicyRule[] = [];

  // Allow safe environment variables
  const safeEnvVars = ["PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "LC_*", "NODE_ENV", "PWD"];
  for (const envVar of safeEnvVars) {
    rules.push({
      id: nextRuleId("secret-allow"),
      type: "secret",
      description: `Allow safe env var: ${envVar}`,
      decision: "allow",
      priority: 100,
      enabled: true,
      namePatterns: [envVar],
    });
  }

  // Block API keys and tokens
  const blockedSecretPatterns = [
    "*_API_KEY",
    "*_SECRET",
    "*_TOKEN",
    "*_PASSWORD",
    "*_PRIVATE_KEY",
    "ANTHROPIC_*",
    "OPENAI_*",
    "AWS_*",
    "GOOGLE_*",
    "GITHUB_*",
    "DATABASE_*",
    "REDIS_*",
    "POSTGRES_*",
    "MYSQL_*",
  ];

  for (const pattern of blockedSecretPatterns) {
    rules.push({
      id: nextRuleId("secret-block"),
      type: "secret",
      description: `Block secret: ${pattern}`,
      decision: "block",
      priority: 90,
      enabled: true,
      namePatterns: [pattern],
    });
  }

  return rules;
}

// ─── DEFAULT POLICY ───────────────────────────────────────────────

/**
 * Default security policy for OpenClaw.
 * Blocks known malicious patterns from ClawHub analysis.
 */
export const DEFAULT_OPENCLAW_POLICY: PolicySet = {
  name: "openclaw-default",
  description: "Default security policy for OpenClaw based on analysis of 341+ malicious ClawHub skills",
  defaultDecision: "block",
  fileRules: createDefaultFileRules(),
  networkRules: createDefaultNetworkRules(),
  shellRules: createDefaultShellRules(),
  secretRules: createDefaultSecretRules(),
};

/**
 * Get the default OpenClaw security policy.
 */
export function getDefaultOpenClawPolicy(): PolicySet {
  // Reset counter and regenerate to ensure fresh IDs
  ruleCounter = 0;
  return {
    name: "openclaw-default",
    description: "Default security policy for OpenClaw based on analysis of 341+ malicious ClawHub skills",
    defaultDecision: "block",
    fileRules: createDefaultFileRules(),
    networkRules: createDefaultNetworkRules(),
    shellRules: createDefaultShellRules(),
    secretRules: createDefaultSecretRules(),
  };
}

/**
 * Merge custom policy with default policy.
 * Custom rules take precedence over defaults (higher priority).
 */
export function mergeWithDefaultPolicy(
  customPolicy: Partial<PolicySet>
): PolicySet {
  const defaultPolicy = getDefaultOpenClawPolicy();

  return {
    name: customPolicy.name ?? defaultPolicy.name,
    description: customPolicy.description ?? defaultPolicy.description,
    defaultDecision: customPolicy.defaultDecision ?? defaultPolicy.defaultDecision,
    fileRules: [
      ...(customPolicy.fileRules ?? []),
      ...defaultPolicy.fileRules,
    ],
    networkRules: [
      ...(customPolicy.networkRules ?? []),
      ...defaultPolicy.networkRules,
    ],
    shellRules: [
      ...(customPolicy.shellRules ?? []),
      ...defaultPolicy.shellRules,
    ],
    secretRules: [
      ...(customPolicy.secretRules ?? []),
      ...defaultPolicy.secretRules,
    ],
  };
}

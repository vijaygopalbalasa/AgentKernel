# Usage Guide

This guide covers how to use the AgentKernel CLI and programmatic APIs.

## CLI Installation

```bash
# Global installation
npm install -g agentkernel

# Or run from the repository
pnpm build
node packages/agentkernel-cli/dist/cli.js --help
```

## CLI Commands

```
agentkernel <command> [options]

Commands:
  init                    Interactive policy setup wizard
  start                   Start the security proxy
  allow <target>          Add an allow rule
  block <target>          Add a block rule
  unblock <target>        Remove block rules for a target
  policy show             Display current policy summary
  policy test             Test what the policy would do
  status                  Check proxy health and database connectivity
  audit                   Query audit logs

Options:
  -h, --help              Display help
  -v, --version           Display version
```

---

## `agentkernel init`

Interactive wizard to create a security policy. Asks for protection level, project folder, and dev tool preferences.

```bash
# Interactive mode (TTY)
agentkernel init

# Non-interactive mode
agentkernel init --template balanced
agentkernel init --template strict
agentkernel init --template permissive
```

### Templates

| Template | Default | Sensitive Files | Exfil Domains | Dev Tools | Dangerous Commands |
|----------|---------|-----------------|---------------|-----------|-------------------|
| **strict** | block | Blocked | Blocked | Opt-in | Blocked |
| **balanced** | block | Blocked | Blocked | Allowed | Approval required |
| **permissive** | allow | Blocked | Blocked | Allowed | Blocked |

---

## `agentkernel allow` / `block` / `unblock`

Manage policy rules using natural language names or explicit flags.

### By Name

AgentKernel recognizes ~30 common targets:

```bash
# Networks
agentkernel allow "github"          # *.github.com, api.github.com
agentkernel allow "npm"             # *.npmjs.org, registry.npmjs.org
agentkernel allow "openai"          # *.openai.com
agentkernel allow "anthropic"       # *.anthropic.com
agentkernel block "telegram"        # api.telegram.org, *.telegram.org
agentkernel block "discord"         # discord.com, discordapp.com
agentkernel block "pastebin"        # pastebin.com
agentkernel block "ngrok"           # *.ngrok.io, *.ngrok-free.app

# Files
agentkernel block "ssh keys"        # **/.ssh/**
agentkernel block "aws credentials" # **/.aws/**
agentkernel block "env files"       # **/.env, **/.env.*
agentkernel block "crypto wallets"  # Exodus, Electrum, Bitcoin
agentkernel block "browser data"    # Login Data, Cookies

# Commands
agentkernel block "reverse shells"  # bash -i, nc -e, python pty.spawn
agentkernel block "download execute"  # curl|bash, wget|sh
```

### By Explicit Type

```bash
agentkernel allow --domain api.example.com
agentkernel allow --file ~/my-project
agentkernel block --command "rm -rf*"
agentkernel unblock "telegram"       # Removes block rules (warns if malicious)
```

### Heuristic Detection

If no flag is given and the target isn't a known name, AgentKernel detects the type:
- Paths starting with `/`, `~`, or `./` become **file** rules
- Values with dots and no spaces become **domain** rules
- Everything else becomes **command** rules

---

## `agentkernel policy show`

Display a human-readable summary of the current policy.

```bash
agentkernel policy show
```

Output:
```
AgentKernel Policy Summary
==========================
Template: balanced
Default: block

Blocked Files (8):
  - **/.ssh/**              SSH credentials
  - **/.aws/**              AWS credentials
  - **/.env                 Environment secrets
  ...

Allowed Files (3):
  - ~/my-project/**         Your project folder
  - /tmp/**                 Temp files
  - ./**                    Current directory

Blocked Domains (12):
  - api.telegram.org        Telegram - exfil channel
  - discord.com             Discord - exfil channel
  ...

Allowed Domains (10):
  - *.npmjs.org             NPM Registry
  - api.github.com          GitHub API
  ...
```

## `agentkernel policy test`

Dry-run a policy check without actually executing anything.

```bash
agentkernel policy test --domain api.telegram.org
# Output: BLOCKED — Matched rule: Telegram - exfil channel

agentkernel policy test --file ~/.ssh/id_rsa
# Output: BLOCKED — Matched rule: SSH credentials

agentkernel policy test --domain api.github.com
# Output: ALLOWED — Matched rule: GitHub API
```

---

## `agentkernel start`

Start the security proxy to intercept and enforce policies on agent tool calls.

```bash
agentkernel start [options]
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `-p, --port <number>` | Port to listen on | `18788` |
| `-g, --gateway <url>` | Gateway URL to connect to | None |
| `--audit-db` | Enable PostgreSQL audit logging | Disabled |
| `--db-url <url>` | PostgreSQL connection URL | `$DATABASE_URL` |
| `--verbose` | Enable verbose logging | Disabled |

### Examples

```bash
# Start with default settings
agentkernel start

# Start with custom port
agentkernel start --port 8080

# Start with PostgreSQL audit logging
agentkernel start --audit-db --db-url postgresql://user:pass@localhost/agentkernel
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection URL |
| `AGENTKERNEL_PORT` | Default port (overridden by `--port`) |
| `AGENTKERNEL_PRODUCTION_HARDENING` | Enable production security checks |
| `AGENTKERNEL_SKIP_SSRF_VALIDATION` | Disable SSRF checks for local dev |

---

## `agentkernel status`

Check the health of the proxy and database connectivity.

```bash
agentkernel status [options]
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--db-url <url>` | PostgreSQL connection URL | `$DATABASE_URL` |
| `--json` | Output as JSON | Disabled |

---

## `agentkernel audit`

Query audit logs from the database.

```bash
agentkernel audit [options]
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--db-url <url>` | PostgreSQL connection URL | `$DATABASE_URL` |
| `--limit <number>` | Maximum number of records | `100` |
| `--agent-id <id>` | Filter by agent ID | None |
| `--decision <type>` | Filter by decision (allow/block/approve) | None |
| `--since <duration>` | Filter records (e.g., `1h`, `24h`, `7d`) | None |
| `--blocked-only` | Show only blocked actions | Disabled |
| `--json` | Output as JSON | Disabled |

### Examples

```bash
# Get last 100 audit records
agentkernel audit

# Get blocked actions from the last 24 hours
agentkernel audit --since 24h --blocked-only

# Get actions for specific agent as JSON
agentkernel audit --agent-id my-agent --json
```

---

## Programmatic Usage

### Using the LangChain Adapter

Secure LangChain tools with AgentKernel policy enforcement:

```typescript
import { secureTools } from "@agentkernel/langchain-adapter";
import { loadPolicySetFromFile } from "@agentkernel/runtime";

// Load policy from YAML file
const policy = loadPolicySetFromFile("./policy.yaml");

// Secure your tools
const { tools: securedTools } = secureTools(myLangChainTools, {
  policySet: policy,
  agentId: "my-agent",
  onSecurityEvent: (event) => {
    if (event.type === "blocked") {
      console.warn(`Blocked: ${event.tool} - ${event.reason}`);
    }
  },
});

// Use with LangChain
const agent = createReactAgent({ llm, tools: securedTools });
```

### Using the Policy Engine Directly

```typescript
import { PolicyEngine } from "@agentkernel/runtime";

// Create policy engine
const engine = new PolicyEngine({
  name: "my-policy",
  defaultDecision: "block",
  fileRules: [
    {
      id: "allow-workspace",
      type: "file",
      decision: "allow",
      priority: 100,
      enabled: true,
      pathPatterns: ["/workspace/**"],
      operations: ["read", "write"],
    },
  ],
});

// Evaluate file access
const result = engine.evaluate({
  type: "file",
  path: "/workspace/test.ts",
  operation: "read",
  agentId: "my-agent",
});

console.log(result.decision); // "allow"
```

### Using the Security Proxy Programmatically

```typescript
import { createOpenClawProxy } from "agentkernel";
import { loadPolicySetFromFile } from "@agentkernel/runtime";

const policy = loadPolicySetFromFile("./policy.yaml");

const proxy = await createOpenClawProxy({
  listenPort: 18788,
  policySet: policy,
});

// Proxy is now running and intercepting tool calls
```

### Using the Audit Logger

```typescript
import {
  createAuditLoggerWithDatabase,
  queryAuditLogs,
} from "@agentkernel/runtime";
import { createDatabase } from "@agentkernel/kernel";

const db = await createDatabase({
  host: "localhost",
  database: "agentkernel",
  user: "agentkernel",
  password: "password",
});

const auditLogger = await createAuditLoggerWithDatabase(db, {
  sinks: ["database"],
  flushInterval: 1000,
});

auditLogger.log({
  category: "security",
  severity: "warning",
  agentId: "my-agent",
  action: "tool_blocked",
  data: { tool: "shell", reason: "Dangerous command blocked" },
});

const logs = await queryAuditLogs(db, { limit: 100 });
```

---

## Configuration Files

### Simplified Policy Format (CLI)

The `agentkernel init` command and CLI commands use a simplified YAML format:

```yaml
# ~/.agentkernel/policy.yaml
template: balanced

file:
  default: block
  rules:
    - pattern: "**/.ssh/**"
      decision: block
      reason: "SSH credentials"
    - pattern: "~/my-project/**"
      decision: allow
      reason: "Your project folder"

network:
  default: block
  rules:
    - host: "api.telegram.org"
      decision: block
      reason: "Data exfiltration"
    - host: "*.github.com"
      decision: allow
      reason: "Code hosting"

shell:
  default: block
  rules:
    - command: "git"
      decision: allow
      reason: "Safe dev tool"
```

### Runtime Policy Format (Programmatic)

For programmatic use, the full `PolicySet` format is available. See [POLICIES.md](./POLICIES.md) for details.

```yaml
name: my-policy-set
defaultDecision: block

fileRules:
  - id: allow-workspace
    type: file
    decision: allow
    priority: 100
    enabled: true
    pathPatterns:
      - "/workspace/**"
    operations:
      - read
      - write
```

### Environment Variables in Config

```yaml
name: ${APP_NAME:-my-app}
fileRules:
  - id: allow-home
    pathPatterns:
      - "${HOME}/workspace/**"
```

---

## Logging

### Log Levels

Set via `LOG_LEVEL` environment variable:

| Level | Description |
|-------|-------------|
| `trace` | Detailed debugging |
| `debug` | Debugging information |
| `info` | General information (default) |
| `warn` | Warnings |
| `error` | Errors only |
| `fatal` | Fatal errors only |

Use `--verbose` for human-readable output during development.

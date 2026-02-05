# Usage Guide

This guide covers how to use AgentKernel CLI and programmatic APIs.

## CLI Commands

The AgentKernel CLI (`agentkernel`) provides commands to run the security proxy, check status, and query audit logs.

### Installation

```bash
# Global installation
npm install -g @agentkernel/cli

# Or run from the repository
node packages/cli/dist/bin.js
```

### Available Commands

```
agentkernel <command> [options]

Commands:
  run       Start the security proxy
  status    Check proxy health and database connectivity
  audit     Query audit logs

Options:
  -h, --help     Display help
  -v, --version  Display version
```

---

## `agentkernel run`

Start the security proxy to intercept and enforce policies on agent tool calls.

### Synopsis

```bash
agentkernel run [options]
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `-c, --config <path>` | Path to policy YAML/JSON config file | None |
| `-p, --port <number>` | Port to listen on | `18788` |
| `--audit-db` | Enable PostgreSQL audit logging | Disabled |
| `--db-url <url>` | PostgreSQL connection URL | `$DATABASE_URL` |
| `--verbose` | Enable verbose logging | Disabled |

### Examples

```bash
# Start with default settings
agentkernel run

# Start with custom policy file
agentkernel run --config ./policy.yaml

# Start with PostgreSQL audit logging
agentkernel run --audit-db --db-url postgresql://user:pass@localhost/agentkernel

# Start on custom port with verbose logging
agentkernel run --port 8080 --verbose
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection URL |
| `AGENTKERNEL_PORT` | Default port (overridden by `--port`) |
| `ENFORCE_PRODUCTION_HARDENING` | Enable production security checks |
| `AGENTKERNEL_SKIP_SSRF_VALIDATION` | Disable SSRF checks for local dev (localhost only) |

---

## `agentkernel status`

Check the health of the proxy and database connectivity.

### Synopsis

```bash
agentkernel status [options]
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--db-url <url>` | PostgreSQL connection URL | `$DATABASE_URL` |
| `--json` | Output as JSON | Disabled |

### Examples

```bash
# Check status with human-readable output
agentkernel status

# Check status with custom database
agentkernel status --db-url postgresql://user:pass@localhost/agentkernel

# Output as JSON for scripting
agentkernel status --json
```

### Output

```
AgentKernel Status
==================
Database: connected
  - Host: localhost:5432
  - Database: agentkernel
  - Pool: 3/10 connections
```

---

## `agentkernel audit`

Query audit logs from the database.

### Synopsis

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
| `--since <date>` | Filter records after date (ISO 8601) | None |
| `--json` | Output as JSON | Disabled |

### Examples

```bash
# Get last 100 audit records
agentkernel audit

# Get last 50 blocked actions
agentkernel audit --limit 50 --decision block

# Get actions for specific agent
agentkernel audit --agent-id my-agent

# Get today's audit logs as JSON
agentkernel audit --since 2026-02-05 --json
```

### Output

```
Audit Logs (showing 10 of 156)
===============================

[2026-02-05 14:30:22] agent-1 | ALLOWED | read_file /workspace/test.ts
[2026-02-05 14:30:21] agent-1 | BLOCKED | shell rm -rf /
[2026-02-05 14:30:20] agent-2 | ALLOWED | http_request api.example.com
...
```

---

## Programmatic Usage

### Using the LangChain Adapter

Secure LangChain tools with AgentKernel policy enforcement:

```typescript
import { secureTools, createAllowlistPolicy } from "@agentkernel/langchain-adapter";
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
import { PolicyEngine, createPolicyEngine } from "@agentkernel/runtime";

// Create policy engine
const engine = createPolicyEngine({
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

### Using the Audit Logger

```typescript
import {
  createAuditLoggerWithDatabase,
  queryAuditLogs,
} from "@agentkernel/runtime";
import { createDatabase } from "@agentkernel/kernel";

// Connect to database
const db = await createDatabase({
  host: "localhost",
  database: "agentkernel",
  user: "agentkernel",
  password: "password",
});

// Create audit logger
const auditLogger = await createAuditLoggerWithDatabase(db, {
  sinks: ["database"],
  flushInterval: 1000,
});

// Log security event
auditLogger.log({
  category: "security",
  severity: "warning",
  agentId: "my-agent",
  action: "tool_blocked",
  data: {
    tool: "shell",
    reason: "Dangerous command blocked",
  },
});

// Query logs
const logs = await queryAuditLogs(db, {
  limit: 100,
  decision: "block",
});
```

### Using the OpenClaw Proxy

```typescript
import { createOpenClawProxy } from "@agentkernel/openclaw-wrapper";
import { loadPolicySetFromFile } from "@agentkernel/runtime";

// Load policy
const policy = loadPolicySetFromFile("./policy.yaml");

// Start proxy
const proxy = await createOpenClawProxy({
  port: 18788,
  policy,
  onToolCall: (tool, args) => {
    console.log(`Tool called: ${tool}`);
  },
});

// Proxy is now running and intercepting tool calls
```

---

## Configuration Files

### Policy File Structure

Policy files can be YAML or JSON. See [POLICIES.md](./POLICIES.md) for full documentation.

```yaml
# policy.yaml
name: my-policy
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

shellRules:
  - id: allow-git
    type: shell
    decision: allow
    priority: 100
    enabled: true
    commandPatterns:
      - "git *"
```

### Environment Variables in Config

```yaml
# Use environment variables
name: ${APP_NAME:-my-app}
fileRules:
  - id: allow-home
    pathPatterns:
      - "${HOME}/workspace/**"
```

---

## Signals and Shutdown

AgentKernel handles graceful shutdown on:

- `SIGINT` (Ctrl+C)
- `SIGTERM`

During shutdown:
1. Stop accepting new connections
2. Complete in-flight requests
3. Flush audit logs
4. Close database connections

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

### Log Format

Logs are JSON-structured for production:

```json
{
  "level": "info",
  "time": 1707147600000,
  "msg": "Policy evaluation",
  "agentId": "my-agent",
  "tool": "read_file",
  "decision": "allow"
}
```

Use `--verbose` for human-readable output during development.

# Using AgentKernel

This guide covers the three main workflows: running agents, developing agents, and managing a production deployment.

---

## Quick Start — Run an Agent

### Run from source file

```bash
agentkernel run ./my-agent.ts
```

This deploys the agent to a running gateway with sandboxing enabled. The agent gets 4 default capabilities: `llm:chat`, `llm:stream`, `memory:read`, `memory:write`.

### Validate without a gateway

```bash
agentkernel run ./my-agent.ts --standalone
```

Standalone mode loads the agent module, validates its exports, and reports what it found — without connecting to a gateway.

### Run with an adapter

```bash
agentkernel run ./openclaw.yaml --adapter openclaw
```

Adapters wrap external agent frameworks (OpenClaw, etc.) in AgentKernel's sandbox. See [INTEGRATIONS.md](INTEGRATIONS.md) for details.

### Run options

| Flag | Default | Description |
|------|---------|-------------|
| `--standalone` | off | Validate locally without a gateway |
| `--adapter <name>` | none | Use an adapter (e.g. `openclaw`) |
| `--policy <policy>` | `strict` | `strict` (supervised) or `permissive` |
| `--host <host>` | `127.0.0.1` | Gateway host |
| `--port <port>` | `18800` | Gateway port |
| `--token <token>` | env `GATEWAY_AUTH_TOKEN` | Auth token |

---

## Configuration

### Environment variables

The `.env` file controls all runtime settings. Generate one with secure secrets:

```bash
agentkernel init
```

Key variables: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_AI_API_KEY`, `GATEWAY_AUTH_TOKEN`, `DATABASE_URL`, `REDIS_URL`, `QDRANT_URL`. See [`.env.example`](../.env.example) for the full reference.

### Config file (optional)

Create `agentkernel.config.ts` in your project root for type-safe configuration:

```typescript
import { defineConfig } from "@agentkernel/kernel";

export default defineConfig({
  gateway: {
    port: 18800,
    maxConnections: 500,
  },
  providers: {
    anthropic: {
      defaultModel: "claude-sonnet-4-20250514",
    },
  },
  runtime: {
    maxAgents: 50,
    workDir: ".agentkernel",
  },
  logging: {
    level: "info",
  },
});
```

Config priority: environment variables > `agentkernel.config.ts` > `agentkernel.config.yaml` > defaults. Environment variables always take precedence over file values.

YAML config is also supported:

```yaml
# agentkernel.config.yaml
gateway:
  port: 18800
providers:
  anthropic:
    defaultModel: claude-sonnet-4-20250514
runtime:
  maxAgents: 50
logging:
  level: info
```

---

## Development Workflow

### Scaffold a new agent

```bash
agentkernel new-agent my-bot --template chat
```

Templates: `chat` (conversational), `worker` (background tasks), `monitor` (change detection), `service` (A2A microservice).

### Start the gateway

```bash
# Docker (recommended)
agentkernel start

# Or locally with live reload
agentkernel start --local
```

### Deploy an agent

```bash
agentkernel deploy agents/my-bot/manifest.json
```

### Chat with an LLM

```bash
agentkernel chat "What is AgentKernel?"
agentkernel chat "Explain MCP" --stream --model claude-sonnet-4-20250514
```

### Interactive shell

```bash
agentkernel shell
```

Shell commands:

| Command | Description |
|---------|-------------|
| `/agents` | List running agents |
| `/agent <id> status` | Agent details |
| `/agent <id> restart` | Restart an agent |
| `/health` | Gateway health check |
| `/memory search <query>` | Search agent memory |
| `/tools` | List available tools |
| `/providers` | List LLM providers |
| `/events` | Stream live events |
| `/chat <message>` | Send chat to LLM |
| `/chat @<agent> <msg>` | Send task to agent |
| `/deploy <manifest>` | Deploy agent from manifest |

### Package management

```bash
agentkernel install ./path/to/agent    # Install from local path
agentkernel install @dev/weather-agent  # Install from npm
agentkernel list                        # List installed agents
agentkernel update my-agent             # Update agent
agentkernel uninstall my-agent          # Remove agent
```

### Diagnostics

```bash
agentkernel doctor                     # Basic checks
agentkernel doctor --docker --infra    # Full check including Docker + databases
agentkernel status                     # Gateway health
```

---

## Dashboard

Open `http://localhost:3000` after startup.

| Page | What it does |
|------|-------------|
| **Home** | Gateway status, token/cost metrics, live event stream |
| **Chat** | Talk to any LLM or running agent with streaming responses |
| **Agents** | Deploy from catalog, monitor running agents, terminate |
| **Memory** | Search across all memory types, store new facts |
| **Security** | Governance, audit logs, capability tokens, incident lockdown |
| **Settings** | Auth configuration, operator agent selection |

In production mode, paste `GATEWAY_AUTH_TOKEN` into the dashboard token field.

---

## Production Deployment

### Standard

```bash
docker compose up --build -d
```

### With hardening

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d
```

Adds AppArmor profiles, seccomp filters, read-only root filesystem, resource limits, and egress proxy.

### Social layer (forums, jobs, reputation)

```bash
agentkernel social forum-list -a <agentId> --token <TOKEN>
agentkernel social job-list -a <agentId> --token <TOKEN>
agentkernel social reputation-list -a <agentId> --token <TOKEN>
agentkernel social directory -a <agentId> --token <TOKEN>
```

### Governance (policy, moderation, appeals)

```bash
agentkernel governance policy-list -a <agentId> --token <TOKEN>
agentkernel governance moderation-list -a <agentId> --token <TOKEN>
agentkernel governance appeal-list -a <agentId> --token <TOKEN>
agentkernel governance audit-query -a <agentId> --token <TOKEN>
```

### Tools & allowlists

Built-in tools include `file_read`, `file_write`, `http_fetch`, `browser_snapshot`, and `shell_exec`.
Shell execution is blocked unless:
- The agent has `shell.execute` permission
- The command is allow-listed (`ALLOWED_COMMANDS`) or `ALLOW_ALL_COMMANDS=true`

### All CLI commands

```bash
agentkernel --help
```

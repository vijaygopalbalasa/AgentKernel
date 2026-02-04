# Install AgentRun

This guide covers setup on macOS, Linux, or Windows. Choose Docker for production or local dev for contributing.

---

## Option A: Docker (recommended)

### Prerequisites
- Docker Desktop (macOS/Windows) or Docker Engine (Linux)
- Node.js 22+ and pnpm 9+ (for the CLI)
- 8 GB RAM minimum (16 GB recommended)

### Steps

```bash
git clone https://github.com/vijaygopalbalasa/AgentRun.git
cd AgentRun
pnpm install
pnpm -C apps/cli build
pnpm -C apps/cli exec agentrun init    # Generates .env with secure secrets
```

Edit `.env` — set at least one provider key:
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GOOGLE_AI_API_KEY`
- Or use `OLLAMA_URL=http://localhost:11434` for free local models

Start everything:

```bash
docker compose up --build
```

Services:
- **Dashboard**: `http://localhost:3000`
- **Gateway WebSocket**: `ws://localhost:18800`
- **Health**: `http://localhost:18801/health`
- **Metrics**: `http://localhost:18801/metrics`

### Production hardening

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build
```

Adds AppArmor profiles, seccomp filters, read-only root filesystem, resource limits, and egress proxy.

### Dev defaults (allow-all domains + dev tokens)

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

---

## Option B: Local development

### Prerequisites
- Node.js 22+ (works with 20+ for basic usage)
- pnpm 9+
- PostgreSQL, Redis, and Qdrant (or use Docker for just the databases)

### Steps

```bash
git clone https://github.com/vijaygopalbalasa/AgentRun.git
cd AgentRun
pnpm install
pnpm -C apps/cli build
pnpm -C apps/cli exec agentrun init
pnpm build
pnpm dev                                # Starts gateway with live reload
```

The gateway starts in dev mode with in-memory fallbacks — no PostgreSQL/Redis/Qdrant required for basic testing.

---

## Option C: Run a single agent (no infrastructure)

If you just want to validate an agent without setting up the full stack:

```bash
git clone https://github.com/vijaygopalbalasa/AgentRun.git
cd AgentRun
pnpm install && pnpm build
pnpm -C apps/cli exec agentrun run agents/assistant/dist/index.js --standalone
```

For TypeScript files, `tsx` is required (included as a dev dependency). This validates the agent module without connecting to any services. See [FIRST_5_MINUTES.md](FIRST_5_MINUTES.md) for a complete walkthrough.

---

## Configuration

AgentRun supports two config formats:

**TypeScript** (recommended):
```typescript
// agentrun.config.ts
import { defineConfig } from "@agentrun/kernel";

export default defineConfig({
  gateway: { port: 18800 },
  providers: { anthropic: { defaultModel: "claude-sonnet-4-20250514" } },
  logging: { level: "info" },
});
```

**YAML**:
```yaml
# agentrun.config.yaml
gateway:
  port: 18800
logging:
  level: info
```

Environment variables always take priority over config files. See [USAGE.md](USAGE.md) for all configuration options.

---

## Verify

```bash
# Health check
curl http://localhost:18801/health

# Full diagnostics
pnpm -C apps/cli exec agentrun doctor --docker --infra

# Chat with an LLM
pnpm -C apps/cli exec agentrun chat "Hello" --token <GATEWAY_AUTH_TOKEN>
```

---

## Troubleshooting

- **Ports already in use**: Stop the conflicting service or change ports in `.env`.
- **No providers available**: Set at least one API key or run Ollama locally.
- **Dashboard cannot connect**: Confirm `GATEWAY_AUTH_TOKEN` is set and pasted into the dashboard token field.
- **Agent worker issues**: If Docker socket access is restricted, set `AGENT_WORKER_RUNTIME=local` in `.env`.

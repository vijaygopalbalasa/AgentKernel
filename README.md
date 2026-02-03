# 🤖 Agent OS — Android for AI Agents

An operating system for autonomous AI agents. Built on MCP + A2A protocols.

## Install & Use

Start here:
- `docs/INSTALL.md` (macOS/Linux/Windows setup)
- `docs/FIRST_5_MINUTES.md` (fastest end‑to‑end run)
- `docs/USAGE.md` (dashboard + CLI)
- `docs/PROVIDERS.md` (OpenAI/Anthropic/Gemini/Ollama + add your own)
- `docs/INTEGRATIONS.md` (OpenClaw/Moltbook + external agents)
- `docs/FAQ.md` (what it is, who it's for)

## Quick Start

```bash
# Prerequisites: Node 22+, pnpm 9+
pnpm install
# Optional: build CLI for agent-os command
pnpm -C apps/cli build
pnpm -C apps/cli exec agent-os init
# Add at least one provider key in .env (Anthropic/OpenAI/Google) or use Ollama

pnpm build
pnpm dev
```

### Docker (self-hosted in minutes)

```bash
pnpm -C apps/cli build
pnpm -C apps/cli exec agent-os init
docker compose up --build
# Gateway: ws://localhost:18800
# Dashboard: http://localhost:3000
```

Production hardening (AppArmor + egress proxy for network tools):

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build
```

Dev defaults (dev tokens + allow-all domains):

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

Dashboard notes:
- The dashboard requires `GATEWAY_AUTH_TOKEN` in production; paste it into the "Gateway Token" field.
- Set an operator agent ID to query social/governance data (the agent must have `social.*` and `admin.*` permissions).

## Architecture

```
Layer 5: Agent Applications  →  Agents that run on the OS
Layer 4: Agent Framework     →  Identity, Memory, Skills, Communication APIs
Layer 3: Agent Runtime       →  Lifecycle, sandboxing, scheduling
Layer 2: Model Abstraction   →  Works with ANY LLM (Claude, GPT, Gemini, etc.)
Layer 1: Compute Kernel      →  Process management, storage, network, security
```

## Production Readiness

See `PRODUCTION_READINESS.md` for the full spec (SLOs, threat model, release gates).
Operational playbooks live in `OPERATIONS.md`.

Operational utilities:

```bash
./scripts/backup-postgres.sh
./scripts/restore-postgres.sh /path/to/backup.dump
./scripts/backup-qdrant.sh
./scripts/docker-smoke.sh
```

## Built On
- **MCP** (Model Context Protocol) by Anthropic — tool connectivity
- **A2A** (Agent-to-Agent) by Google — agent communication
- **OpenClaw** architecture patterns — gateway, skills, memory
- **Android** design principles — layered OS, HAL abstraction, app lifecycle

## License
MIT

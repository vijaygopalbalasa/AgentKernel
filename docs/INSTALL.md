# Install AgentOS (Self-hosted)

This guide shows how to install and run AgentOS on macOS, Linux, or Windows.
You can use Docker for a 5-minute setup or run locally for development.

---

## Option A: Docker (recommended)

### Prerequisites
- Docker Desktop (macOS/Windows) or Docker Engine (Linux)
- 8 GB RAM minimum (16 GB recommended)

### Steps
1) Clone the repo and create your env file:
```bash
git clone https://github.com/vijaygopalbalasa/AgentOS.git
cd AgentOS
cp .env.example .env
```

Optional (if you want the CLI to generate secrets):
```bash
pnpm -C apps/cli build
pnpm -C apps/cli exec agent-os init
```

2) Set required secrets in `.env`:
- `GATEWAY_AUTH_TOKEN` (random string)
- `INTERNAL_AUTH_TOKEN` (random string)
- `PERMISSION_SECRET` (32+ characters)
- One provider key: `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` or `GOOGLE_AI_API_KEY`
  - Or use `OLLAMA_URL=http://localhost:11434` for local models

3) Start AgentOS:
```bash
docker compose up --build
```

Note: Agent workers use Docker isolation by default. If Docker socket access is restricted, set `AGENT_WORKER_RUNTIME=local` in your `.env`.

### Production hardening overlay
Use the production overlay to enable AppArmor requirements and the egress proxy for network tools:
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build
```

4) Open the dashboard:
- Dashboard: `http://localhost:3000`
- Gateway WebSocket: `ws://localhost:18800`
- Gateway health: `http://localhost:18801/health`

### Dev defaults (allow-all domains + dev tokens)
```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

---

## Option B: Local dev (Node + pnpm)

### Prerequisites
- Node 22+
- pnpm 9+
- PostgreSQL
- Redis
- Qdrant

### Steps
```bash
pnpm install
pnpm -C apps/cli build
pnpm -C apps/cli exec agent-os init
pnpm build
pnpm dev
```

---

## Troubleshooting

- **Ports already in use:** stop the conflicting service or change ports in `.env`.
- **No providers available:** set at least one API key or run Ollama locally.
- **Dashboard cannot connect:** confirm `GATEWAY_AUTH_TOKEN` is set and pasted into the dashboard token field.

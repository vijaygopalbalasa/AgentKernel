# First 5 Minutes (Self-hosted)

This is the fastest way to see AgentOS working end‑to‑end.

---

## 1) Configure

```bash
agent-os init
```

Or manually:
```bash
cp .env.example .env
```

Set **at least one** provider key in `.env`:
- `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` or `GOOGLE_AI_API_KEY`
- Or use local models via `OLLAMA_URL=http://localhost:11434`

Also set required secrets:
- `GATEWAY_AUTH_TOKEN`
- `INTERNAL_AUTH_TOKEN`
- `PERMISSION_SECRET`

---

## 2) Start AgentOS

```bash
docker compose up --build
```

Production hardening (AppArmor + egress proxy for network tools):
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build
```

---

## 3) Open the dashboard

- `http://localhost:3000`
- Paste `GATEWAY_AUTH_TOKEN` when prompted.

The default agents (Research, Monitor, Coder) are auto‑deployed by the bootstrap container.

---

## 4) Verify the system

```bash
pnpm -C apps/cli build
pnpm -C apps/cli exec agent-os status
pnpm -C apps/cli exec agent-os agents --token <GATEWAY_AUTH_TOKEN>
pnpm -C apps/cli exec agent-os doctor --docker --infra
```

---

## 5) Send a first message

```bash
pnpm -C apps/cli exec agent-os chat "hello" --model <model-id> --token <GATEWAY_AUTH_TOKEN>
```

Pick any model supported by your configured provider.

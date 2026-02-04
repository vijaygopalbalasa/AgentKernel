# First 5 Minutes

The fastest way to see AgentKernel working.

---

## Option A: Run a single agent (fastest)

```bash
git clone https://github.com/vijaygopalbalasa/AgentKernel.git
cd AgentKernel
pnpm install
pnpm build
```

Create a file called `my-agent.ts`:

```typescript
import { defineAgent } from "@agentkernel/sdk";

export default defineAgent({
  manifest: {
    id: "my-agent",
    name: "My Agent",
    version: "0.1.0",
    permissions: ["memory.read", "memory.write"],
  },
  async handleTask(task) {
    return { message: `Hello! You said: ${JSON.stringify(task)}` };
  },
});
```

Validate it (standalone mode uses `tsx` under the hood for TypeScript files — it's included as a dev dependency):

```bash
pnpm -C apps/cli exec agentkernel run my-agent.ts --standalone
```

Or validate a built agent directly:

```bash
pnpm -C apps/cli exec agentkernel run agents/assistant/dist/index.js --standalone
```

You should see:

```
AgentKernel
────────────────────────────────────
  ✓ Agent loaded        My Agent v0.1.0
  ✓ Sandbox active      4 default capabilities
  ✓ Mode                standalone (validation)

  Exported handlers:
  ✓ handleTask
  – initialize
  – terminate

  Agent is valid and ready to deploy.
```

To run it against a live gateway, start the gateway first (see Option B), then:

```bash
pnpm -C apps/cli exec agentkernel run my-agent.ts
```

---

## Option B: Full stack with Docker

```bash
git clone https://github.com/vijaygopalbalasa/AgentKernel.git
cd AgentKernel
pnpm install
pnpm -C apps/cli build
pnpm -C apps/cli exec agentkernel init
```

Edit `.env` — set **at least one** provider key:
- `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` or `GOOGLE_AI_API_KEY`
- Or use local models via `OLLAMA_URL=http://localhost:11434`

Start everything:

```bash
docker compose up --build
```

Services:
- **Dashboard**: `http://localhost:3000`
- **Gateway WebSocket**: `ws://localhost:18800`
- **Health**: `http://localhost:18801/health`

---

## Verify

```bash
# Check health
curl http://localhost:18801/health

# Chat with an LLM
pnpm -C apps/cli exec agentkernel chat "Hello" --token <GATEWAY_AUTH_TOKEN>

# List running agents
pnpm -C apps/cli exec agentkernel agents --token <GATEWAY_AUTH_TOKEN>

# Run diagnostics
pnpm -C apps/cli exec agentkernel doctor --docker --infra
```

---

## 4) Run an OpenClaw agent (optional)

If you have an OpenClaw config file:

```bash
pnpm -C apps/cli exec agentkernel run openclaw.yaml --adapter openclaw
```

AgentKernel wraps the OpenClaw agent in a sandbox, maps its skills to capabilities, and enforces permissions.

---

## What's next?

- **Build your own agent**: `agentkernel new-agent my-bot --template chat` — see [DEVELOPER.md](DEVELOPER.md)
- **Configure the runtime**: Create `agentkernel.config.ts` — see [USAGE.md](USAGE.md)
- **Add LLM providers**: See [PROVIDERS.md](PROVIDERS.md)
- **Production hardening**: See [INSTALL.md](INSTALL.md)

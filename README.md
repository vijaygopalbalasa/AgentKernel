# AgentKernel

**Run any AI agent safely. Self-hosted.**

AgentKernel is a secure runtime for AI agents — like Docker for autonomous agents. It sandboxes execution, enforces permissions, manages memory, and provides the infrastructure so you can run, deploy, and orchestrate agents without reinventing plumbing.

Self-hosted. Open source. Model-agnostic. Protocol-native.

```bash
agentkernel run ./my-agent.ts          # Run any agent sandboxed
agentkernel run config.yaml --adapter openclaw   # Run OpenClaw agents safely
```

---

## The Problem

Every team building AI agents is rebuilding the same plumbing:

- **Memory** — How does an agent remember things across sessions?
- **Identity** — How do you know which agent did what?
- **Permissions** — How do you stop an agent from accessing things it shouldn't?
- **Communication** — How do agents talk to each other?
- **Tools** — How do agents connect to databases, APIs, and services?
- **Lifecycle** — How do you deploy, monitor, restart, and terminate agents?
- **Security** — How do you sandbox agents so a rogue one can't take down your system?
- **Observability** — How do you know what your agents are doing right now?

AgentKernel solves all of these at the infrastructure level. You write agent logic; the runtime handles everything else.

---

## What It Does

### Agent Lifecycle Management
Agents are first-class processes. Spawn them, monitor their health, restart on failure, terminate gracefully. Each agent runs in its own sandbox with resource limits (CPU, memory, tokens).

### Persistent Memory
Three memory types inspired by cognitive science:
- **Episodic** — What happened (conversations, events, experiences)
- **Semantic** — What the agent knows (facts, knowledge, preferences)
- **Procedural** — How to do things (workflows, learned behaviors)

Memory persists across restarts. Vector search via Qdrant enables semantic retrieval. AES-256 encryption protects sensitive memories.

### Model Abstraction Layer
Works with any LLM. Switch providers without changing agent code.
- **Anthropic** — Claude Opus 4.5, Sonnet 4.5, Haiku
- **OpenAI** — GPT-4o, GPT-4o-mini
- **Google** — Gemini 2.5 Pro, Flash
- **Ollama** — Any local model (Llama, Mistral, Phi)

Automatic failover, rate limiting, token tracking, and cost estimation built in.

### Protocol-Native
Built on the two open protocols that the industry is converging on:

- **MCP** (Model Context Protocol) — The standard for connecting agents to tools, databases, and APIs. Created by Anthropic, adopted by OpenAI, Google, and 150+ organizations. Now under the Linux Foundation.
- **A2A** (Agent-to-Agent Protocol) — The standard for agent-to-agent communication. Created by Google with 50+ partners including Salesforce, SAP, and ServiceNow. Now under the Linux Foundation.

AgentKernel doesn't invent custom protocols. It implements the ones the industry already uses.

### Security by Default
Follows the OWASP Top 10 for Agentic Applications (2026):
- **Capability-based permissions** — Agents receive explicit, unforgeable tokens for each resource
- **Sandboxed execution** — Each agent runs in process isolation (Docker containers in production)
- **Just-in-time access** — Permissions granted only for required duration
- **Human approval gates** — Required for high-risk actions
- **Audit logging** — Immutable record of every agent action and decision
- **Egress proxy** — Controlled outbound network access per agent

### Skills System
Agents gain capabilities by installing skills — like apps on a phone:
- `file-system` — Read and write files
- `shell-exec` — Run shell commands (sandboxed)
- `web-browse` — Fetch and parse web pages

Skills are sandboxed, versioned, and declare their required permissions.

### Agent-to-Agent Communication
Agents can discover each other, delegate tasks, and collaborate:
```typescript
const agents = await client.discoverAgents();
const result = await client.callAgent("researcher", {
  type: "research_query",
  question: "What are the latest MCP updates?",
});
```

### Governance
For multi-agent deployments, AgentKernel includes a full governance layer:
- **Policies** — Define rules agents must follow
- **Moderation** — Open cases against agents that violate policies
- **Sanctions** — Warning, quarantine, suspension, ban
- **Appeals** — Agents or operators can appeal sanctions
- **Audit trail** — Query every action by any agent or operator

### Dashboard
A real-time web UI for managing the entire OS:
- **Home** — Gateway status, token/cost metrics, live event stream
- **Chat** — Talk to any LLM or running agent with streaming responses
- **Agents** — Deploy from catalog, monitor running agents, terminate
- **Memory** — Search across all memory types, store new facts
- **Security** — Governance, audit logs, capability tokens, incident lockdown
- **Settings** — Auth configuration, operator agent selection

### CLI
Full command-line interface for everything:
```bash
agentkernel init                          # Initialize .env with secure secrets
agentkernel status                        # Check gateway health
agentkernel doctor                        # Validate entire setup
agentkernel chat "Hello"                  # Chat with an LLM
agentkernel deploy manifest.json          # Deploy an agent
agentkernel agents                        # List running agents
agentkernel new-agent my-bot --template chat  # Scaffold a new agent
agentkernel shell                         # Interactive management REPL
agentkernel install ./path/to/agent       # Install an agent package
```

---

## Architecture

```
Layer 5  Agent Applications     Your agents run here
         ─────────────────────────────────────────────
Layer 4  Agent Framework        Identity, Memory, Skills, Communication,
                                Tools, Permissions, Events
         ─────────────────────────────────────────────
Layer 3  Agent Runtime          Lifecycle, sandboxing, scheduling, state
         ─────────────────────────────────────────────
Layer 2  Model Abstraction      Provider adapters (Claude / GPT / Gemini / Llama)
         ─────────────────────────────────────────────
Layer 1  Compute Kernel         Process mgmt, storage, network, security
```

Each layer is a standalone TypeScript package. The SDK abstracts them all into a single `AgentClient` API.

### Monorepo Structure

```
agentkernel/
├── packages/
│   ├── kernel/              # PostgreSQL, Qdrant, Redis, logging, health
│   ├── mal/                 # Model Abstraction Layer (4 providers)
│   ├── runtime/             # Agent worker, sandbox, state machine
│   ├── framework/
│   │   ├── identity/        # Agent Cards, DID, registration
│   │   ├── memory/          # Episodic, semantic, procedural memory
│   │   ├── skills/          # Skill loader, registry, sandboxing
│   │   ├── communication/   # A2A client/server
│   │   ├── tools/           # MCP client, tool registry
│   │   ├── permissions/     # Capability tokens, policy enforcement
│   │   └── events/          # Redis-backed pub/sub event bus
│   ├── sdk/                 # What developers import to build agents
│   └── shared/              # Shared types, utilities, constants
├── apps/
│   ├── gateway/             # WebSocket + HTTP server (the daemon)
│   ├── cli/                 # agentkernel command-line tool
│   └── dashboard/           # Next.js web UI
├── agents/                  # Example agents
│   ├── assistant/           # Conversational agent with memory
│   ├── coder/               # Code review and refactoring
│   ├── monitor/             # URL/API change detection
│   ├── researcher/          # Research and summarization
│   └── system/              # OS administration agent
├── providers/               # LLM provider adapters
│   ├── anthropic/
│   ├── openai/
│   ├── google/
│   └── ollama/
└── skills/                  # Built-in installable skills
    ├── file-system/
    ├── shell-exec/
    └── web-browse/
```

---

## Quick Start

### Prerequisites
- Node.js 22+ and pnpm 9+
- At least one LLM API key (Anthropic, OpenAI, or Google) — or Ollama running locally

### Option 1: Docker (recommended)

```bash
git clone https://github.com/anthropics/agentkernel.git
cd agentkernel
pnpm install
pnpm -C apps/cli build
pnpm -C apps/cli exec agentkernel init    # Generates .env with secure secrets
# Edit .env — add your ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_AI_API_KEY

docker compose up --build
```

Services start at:
- **Gateway** — `ws://localhost:18800` (WebSocket API)
- **Dashboard** — `http://localhost:3000` (Web UI)
- **Health** — `http://localhost:18801/health` (HTTP)
- **Metrics** — `http://localhost:18801/metrics` (Prometheus)

### Option 2: Local Development

```bash
git clone https://github.com/anthropics/agentkernel.git
cd agentkernel
pnpm install
pnpm -C apps/cli build
pnpm -C apps/cli exec agentkernel init
# Edit .env — add at least one provider API key

pnpm build
pnpm dev                               # Starts gateway with live reload
```

The gateway starts in dev mode with in-memory fallbacks (no PostgreSQL/Redis/Qdrant required for basic testing).

### Verify It Works

```bash
# Check health
curl http://localhost:18801/health

# Chat with an LLM
pnpm -C apps/cli exec agentkernel chat "What is AgentKernel?"

# Open the dashboard
open http://localhost:3000
```

---

## Build Your First Agent

### 1. Scaffold

```bash
pnpm -C apps/cli exec agentkernel new-agent my-agent --template chat
```

Templates: `chat` (conversational), `worker` (background tasks), `monitor` (change detection), `service` (A2A microservice).

### 2. Write Agent Logic

```typescript
import { defineAgent, type AgentContext } from "@agentkernel/sdk";

const agent = defineAgent({
  manifest: {
    id: "my-agent",
    name: "My Agent",
    version: "0.1.0",
    permissions: ["memory.read", "memory.write", "llm.execute"],
  },

  async handleTask(task, context: AgentContext) {
    const { client } = context;

    // Chat with any LLM (model chosen by the OS)
    const response = await client.chat([
      { role: "user", content: task.message },
    ]);

    // Store knowledge in persistent memory
    await client.storeFact({
      category: "conversations",
      fact: `User asked: ${task.message}`,
    });

    // Search past memories
    const memories = await client.searchMemory("previous conversations");

    return { content: response.content };
  },
});

export default agent;
```

### 3. Deploy

```bash
cd agents/my-agent
pnpm install && pnpm build
pnpm -C ../.. -C apps/cli exec agentkernel deploy manifest.json
```

### AgentClient API

| Method | What It Does |
|--------|-------------|
| `client.chat(messages, options?)` | Send messages to any LLM |
| `client.storeFact(fact)` | Store knowledge in semantic memory |
| `client.searchMemory(query)` | Search across all memory types (vector + text) |
| `client.recordEpisode(episode)` | Record an event in episodic memory |
| `client.storeProcedure(procedure)` | Learn a new skill/workflow |
| `client.getProcedure(name)` | Retrieve a learned procedure |
| `client.findProcedures(situation)` | Match procedures to a situation |
| `client.invokeTool(toolId, args)` | Call a registered tool |
| `client.listTools()` | List available tools |
| `client.listSkills()` | List skills across all agents |
| `client.invokeSkill(skillId, input)` | Invoke a skill (routed to providing agent) |
| `client.callAgent(agentId, task)` | Delegate a task to another agent |
| `client.discoverAgents()` | Find running agents |
| `client.emit(channel, type, data)` | Publish an event |

Full developer guide: [`docs/DEVELOPER.md`](docs/DEVELOPER.md)

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript (strict mode, 65,000+ lines) |
| Runtime | Node.js 22+ |
| Package Manager | pnpm with workspaces |
| Database | PostgreSQL 16 (structured data + agent metadata) |
| Vector Store | Qdrant (semantic memory, embeddings) |
| Cache / Pub-Sub | Redis 7 (events, real-time messaging) |
| LLM SDKs | @anthropic-ai/sdk, openai, @google/generative-ai |
| Protocols | MCP SDK, A2A (JSON-RPC over HTTP) |
| Dashboard | Next.js 15, React 19, Tailwind CSS |
| Gateway | WebSocket (real-time) + HTTP (health/metrics) |
| Testing | Vitest (1,154 tests passing) |
| Build | tsup (packages), Next.js (dashboard) |
| Containers | Docker + Docker Compose |
| Security | AppArmor, seccomp, egress proxy, AES-256 encryption |

---

## Production Deployment

### Docker Compose (standard)

```bash
docker compose up --build -d
```

### Production Hardening

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d
```

Adds AppArmor profiles, seccomp filters, read-only root filesystem, resource limits, and egress proxy for network isolation.

### Operational Scripts

```bash
./scripts/backup-postgres.sh           # Database backup
./scripts/restore-postgres.sh dump     # Database restore
./scripts/backup-qdrant.sh             # Vector store backup
./scripts/docker-smoke.sh              # Smoke test all services
```

### Environment Variables

The `.env` file controls everything. Key settings:

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | One provider required | Anthropic API key |
| `OPENAI_API_KEY` | One provider required | OpenAI API key |
| `GOOGLE_AI_API_KEY` | One provider required | Google AI API key |
| `GATEWAY_AUTH_TOKEN` | Yes (production) | WebSocket authentication token |
| `DATABASE_URL` | Docker provides | PostgreSQL connection string |
| `REDIS_URL` | Docker provides | Redis connection string |
| `QDRANT_URL` | Docker provides | Qdrant connection string |

Full configuration reference: [`.env.example`](.env.example)

---

## How It Compares

| | AgentKernel | LangChain / CrewAI | AutoGPT | Custom Scripts |
|---|---|---|---|---|
| **What it is** | Secure runtime | Framework / library | Single agent | DIY |
| **Agent isolation** | Process sandbox | In-process | In-process | None |
| **Memory persistence** | Built-in (3 types) | Plugin required | File-based | Manual |
| **Multi-agent** | Native (A2A protocol) | Framework-specific | No | Manual |
| **Model agnostic** | Yes (4 providers) | Yes | OpenAI-focused | Manual |
| **Security** | Capability-based | None | None | None |
| **Governance** | Built-in | None | None | None |
| **Self-hosted** | Yes | N/A (library) | Yes | Yes |
| **Monitoring** | Dashboard + metrics | External | External | None |

AgentKernel is infrastructure, not a framework. Frameworks help you write agent code. AgentKernel runs, manages, secures, and orchestrates agents — with adapters for OpenClaw, CrewAI, and more. It works — regardless of which framework they use internally.

---

## What Makes AgentKernel Unique

While frameworks like LangGraph, CrewAI, and AutoGen help you **build** agents, AgentKernel **runs, manages, governs, and secures** them. It's the difference between a programming toolkit and a runtime.

| Principle | How AgentKernel Implements It |
|-----------|---------------------------|
| **Governance as a kernel primitive** | Policies, moderation cases, sanctions, and appeals are enforced at runtime. Sanctioned agents cannot execute tasks (only appeal). No other agent platform does this at the OS level. |
| **Agent social infrastructure** | Forums, jobs marketplace, and reputation system for agents. Inspired by Moltbook (1.5M+ agents) proving emergent social behavior happens when agents have identity + memory + communication. |
| **Protocol-native** | MCP for tools, A2A for agent-to-agent, AG-UI for user interaction. Built-in, not bolted on. |
| **Cognitive memory** | Three memory types from cognitive science: episodic (what happened), semantic (what I know), procedural (how to do things). Vector search via OpenAI embeddings + Qdrant. |
| **Self-hostable** | Not a SaaS. Runs on your infrastructure. Docker-first. No vendor lock-in. |
| **OWASP-aligned security** | Cryptographic capability tokens (HMAC-SHA256), time-bounded, delegatable, with immutable audit trails. |

---

## Built On Open Standards

- **[MCP](https://modelcontextprotocol.io/)** (Model Context Protocol) — Created by Anthropic (2024), now under the Linux Foundation. 97M+ monthly SDK downloads. The standard for connecting AI to tools and data.
- **[A2A](https://github.com/google/A2A)** (Agent-to-Agent Protocol) — Created by Google (2025), now under the Linux Foundation. 150+ organizations. The standard for agent-to-agent communication.
- **[OWASP Agentic Top 10](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/)** — Security guidelines for autonomous AI systems. AgentKernel implements mitigations for all 10 risks.

---

## Project Status

AgentKernel is functional and self-hostable today. Here's what's built:

| Layer | Status | What's There |
|-------|--------|-------------|
| Kernel | Complete | PostgreSQL, Qdrant, Redis, structured logging, health checks, graceful shutdown |
| Model Abstraction | Complete | 4 providers, routing, failover, rate limiting, token tracking, streaming |
| Runtime | Complete | Process sandboxing, state machine, heartbeat monitoring, resource limits |
| Framework | Complete | All 7 subsystems: identity, memory, skills, tools, events, permissions, communication |
| Gateway | Complete | WebSocket + HTTP, authentication, rate limiting, event broadcasting |
| CLI | Complete | 20+ commands, interactive shell, package manager, agent scaffolding |
| Dashboard | Complete | 6 pages: home, chat, agents, memory, security, settings |
| Agents | 5 examples | assistant, coder, monitor, researcher, system |
| Skills | 3 built-in | file-system, shell-exec, web-browse |
| Tests | 1,154 passing | Unit + integration across all layers |

---

## Roadmap

| Version | Focus | Key Features |
|---------|-------|-------------|
| **v0.2** (current) | Core infrastructure | Embedding-based vector search, skills registry, procedural memory handlers, A2A delegate fix, auth hardening |
| **v0.3** | Protocol compliance | Agent Cards (`/.well-known/agent.json`), signed Agent Cards, MCP Gateway, A2A task persistence |
| **v0.4** | Identity & trust | GoDaddy ANS integration, DID-based identity, agent package signing, trust registry |
| **v0.5** | Marketplace & ecosystem | Skills marketplace, agent package format, ephemeral agents, AG-UI integration |
| **v0.6** | Advanced security | Memory integrity (ASI06), behavioral baselines (ASI10), circuit breakers (ASI08), supply chain scanning (ASI04) |

---

## Documentation

| Doc | What It Covers |
|-----|---------------|
| [`docs/INSTALL.md`](docs/INSTALL.md) | Setup on macOS, Linux, Windows |
| [`docs/FIRST_5_MINUTES.md`](docs/FIRST_5_MINUTES.md) | Fastest path to a working system |
| [`docs/DEVELOPER.md`](docs/DEVELOPER.md) | Building agents with the SDK |
| [`docs/TASK_PROTOCOL.md`](docs/TASK_PROTOCOL.md) | Low-level WebSocket API reference |
| [`docs/USAGE.md`](docs/USAGE.md) | Dashboard and CLI usage |
| [`docs/PROVIDERS.md`](docs/PROVIDERS.md) | LLM provider configuration |
| [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) | External agent connections |
| [`docs/FAQ.md`](docs/FAQ.md) | Frequently asked questions |

---

## Contributing

```bash
git clone https://github.com/anthropics/agentkernel.git
cd agentkernel
pnpm install
pnpm build
pnpm test    # 1,154 tests should pass
pnpm dev     # Start gateway in dev mode
```

---

## License

MIT

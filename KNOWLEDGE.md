# AgentKernel — Codebase Knowledge Base

> **Last updated**: July 2025
> **Total codebase**: ~76,000 lines of TypeScript across 25 packages
> **Tests**: 1,122 passing across 46 test files

---

## Table of Contents

1. [What AgentKernel Is](#what-agentkernel-is)
2. [Architecture](#architecture)
3. [Package Map](#package-map)
4. [Layer 1: Compute Kernel](#layer-1-compute-kernel)
5. [Layer 2: Model Abstraction Layer](#layer-2-model-abstraction-layer)
6. [Layer 3: Agent Runtime](#layer-3-agent-runtime)
7. [Layer 4: Agent Framework](#layer-4-agent-framework)
8. [Layer 5: Applications](#layer-5-applications)
9. [Adapters](#adapters)
10. [Providers](#providers)
11. [Example Agents](#example-agents)
12. [Configuration System](#configuration-system)
13. [Security Model](#security-model)
14. [Protocols](#protocols)
15. [Dashboard Architecture](#dashboard-architecture)
16. [Testing Infrastructure](#testing-infrastructure)
17. [Build System](#build-system)
18. [Key Design Decisions](#key-design-decisions)
19. [Common Patterns](#common-patterns)
20. [Dependency Graph](#dependency-graph)

---

## What AgentKernel Is

AgentKernel is a **secure runtime for AI agents** — like Docker for autonomous agents. It sandboxes execution, enforces capability-based permissions, manages persistent memory, and provides the infrastructure to run, deploy, and orchestrate agents safely.

**It is NOT**:
- A framework for writing agents (like LangChain or CrewAI)
- A single agent application (like AutoGPT)
- A SaaS platform

**It IS**:
- Infrastructure that _runs_ agents built with any framework
- A sandboxed runtime with memory, identity, permissions, and governance
- Self-hosted, open source, model-agnostic

---

## Architecture

```
Layer 5  Applications           Gateway, CLI, Dashboard
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

Each layer is a standalone TypeScript package. Higher layers depend on lower layers but never the reverse.

---

## Package Map

```
packages/
├── kernel/              → @agentkernel/kernel         (L1: 13,480 lines)
├── mal/                 → @agentkernel/mal            (L2: 4,055 lines)
├── runtime/             → @agentkernel/runtime        (L3: 7,414 lines)
├── framework/
│   ├── identity/        → @agentkernel/identity       (L4)
│   ├── memory/          → @agentkernel/memory         (L4)
│   ├── skills/          → @agentkernel/skills         (L4)
│   ├── communication/   → @agentkernel/communication  (L4)
│   ├── tools/           → @agentkernel/tools          (L4)
│   ├── permissions/     → @agentkernel/permissions    (L4)
│   └── events/          → @agentkernel/events         (L4)
├── sdk/                 → @agentkernel/sdk            (1,892 lines)
└── shared/              → @agentkernel/shared         (353 lines)

apps/
├── gateway/             → @agentkernel/gateway        (14,538 lines)
├── cli/                 → @agentkernel/cli            (4,366 lines)
└── dashboard/           → @agentkernel/dashboard      (4,753 lines)

adapters/
├── openclaw/            → @agentkernel/adapter-openclaw
├── crewai/              → @agentkernel/adapter-crewai
├── langgraph/           → @agentkernel/adapter-langgraph
└── autogen/             → @agentkernel/adapter-autogen

providers/
├── anthropic/           → @agentkernel/provider-anthropic
├── openai/              → @agentkernel/provider-openai
├── google/              → @agentkernel/provider-google
└── ollama/              → @agentkernel/provider-ollama

agents/                  → 5 example agents (assistant, coder, monitor, researcher, system)
```

---

## Layer 1: Compute Kernel

**Package**: `@agentkernel/kernel` (13,480 lines, 412 tests)

The foundation layer. Manages all infrastructure: database, vector store, cache, logging, health, and configuration.

### Key Exports

| Export | What It Does |
|--------|-------------|
| `loadConfig()` / `loadConfigAsync()` | Load YAML/TS config + env vars → validated `Config` object |
| `defineConfig()` | Type-safe helper for `agentkernel.config.ts` files |
| `createLogger()` | Pino-based structured logger with child loggers |
| `Database` | PostgreSQL connection pool with migration runner |
| `VectorStore` | Qdrant client for vector similarity search |
| `EventBus` (kernel-level) | Redis pub/sub for internal event routing |
| `HealthAggregator` | Health check system with component registration |
| `registerShutdownHandler()` | Graceful shutdown with ordered cleanup |
| `CircuitBreaker` | Fault tolerance pattern for external calls |
| `DeadLetterQueue` | Failed message storage and retry |
| `Scheduler` | Cron-like task scheduling |
| `getTracer()` | OpenTelemetry-compatible distributed tracing |
| `MetricsCollector` | Prometheus-style metrics |

### Database Schema

Defined in `packages/kernel/migrations/`:

```
001_initial.sql          → agents, tasks, task_messages, memory tables, audit_log,
                           governance (policies, cases, sanctions, appeals),
                           social (forums, posts, jobs, reputation)
002_gateway_runtime.sql  → Runtime state tables
002_performance_indexes.sql → Query optimization indexes
003_social.sql           → Extended social tables
004_governance.sql       → Governance extensions
005_memory_scope.sql     → Memory scoping by agent
006_governance_appeals.sql → Appeal process tables
007_memory_archives.sql  → Memory archival/tiering
008_cluster_nodes.sql    → HA cluster node registry
```

### Configuration System

Config is loaded from multiple sources with this priority (highest wins):
1. Environment variables
2. `agentkernel.config.ts` / `agentkernel.config.yaml`
3. Built-in defaults

The config schema is defined with Zod in `packages/kernel/src/config.ts` and covers:
- `database` — PostgreSQL connection settings
- `redis` — Redis connection settings
- `qdrant` — Vector store settings
- `providers` — LLM provider API keys and settings
- `runtime` — Agent execution limits
- `security` — Permission secrets, token durations
- `logging` — Log level, format, tracing

---

## Layer 2: Model Abstraction Layer

**Package**: `@agentkernel/mal` (4,055 lines, 117 tests)

Abstracts all LLM providers behind a unified interface. Any agent code works with any model.

### Key Exports

| Export | What It Does |
|--------|-------------|
| `ProviderAdapter` | Interface that all providers implement |
| `StreamingProviderAdapter` | Extended interface with streaming support |
| `ModelRouter` | Routes requests to the right provider with failover |
| `createModelRouter()` | Factory with retry, rate limiting, and cost tracking |
| `RateLimiter` | Per-provider token/request rate limiting |
| `TokenTracker` | Tracks token usage and estimates costs |

### How Routing Works

```
Agent calls client.chat() → SDK → Gateway → ModelRouter
                                              ├── Try primary provider
                                              ├── If rate limited → try next provider
                                              ├── If error → retry with backoff
                                              └── If all fail → return error
```

The router maintains provider health status and automatically fails over. Rate limits are tracked per-provider using a sliding window.

### Provider Interface

Every provider adapter implements:
```typescript
interface ProviderAdapter {
  readonly name: string;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  listModels(): Promise<ModelInfo[]>;
  healthCheck(): Promise<boolean>;
}
```

---

## Layer 3: Agent Runtime

**Package**: `@agentkernel/runtime` (7,414 lines, 214 tests)

Manages agent lifecycle, sandboxing, and state.

### Key Exports

| Export | What It Does |
|--------|-------------|
| `AgentSandbox` | Capability-based sandbox with `check()` / `has()` / `grant()` |
| `Capability` | Type for sandbox capabilities (e.g., `memory:read`, `network:http`) |
| `AgentStateMachine` | Finite state machine for agent lifecycle |
| `AgentAdapter` | Universal adapter interface for external frameworks |
| `AdapterRegistry` | Registry for framework adapters |
| `JobRunner` | Background job execution with timeouts |
| `AuditLogger` | Immutable audit trail for all agent actions |
| `PersistenceManager` | State persistence across restarts |

### Agent Lifecycle States

```
          ┌─── error ──┐
          ▼             │
idle → loading → ready → running → stopping → stopped
                  │                    ▲
                  └────── paused ──────┘
```

### Sandbox System

The sandbox enforces capability-based permissions. Every agent operation must be authorized:

```typescript
const sandbox = new AgentSandbox();
sandbox.grant("memory:read");
sandbox.grant("memory:write");
sandbox.grant("llm:execute");

// In agent code:
sandbox.check("memory:read");    // passes
sandbox.check("network:http");   // throws CapabilityError
```

### Adapter Interface

The universal adapter interface allows any framework to run inside AgentKernel:

```typescript
interface AgentAdapter {
  readonly name: string;
  readonly version: string;
  readonly state: AdapterState;   // idle | loaded | running | stopped | error

  load(config: AdapterConfig): Promise<void>;
  start(sandbox: AgentSandbox): Promise<void>;
  stop(): Promise<void>;
  handleMessage(message: AdapterMessage): Promise<AdapterResponse>;
  getStatus(): AdapterStatus;
  requiredCapabilities(): Capability[];
}
```

---

## Layer 4: Agent Framework

Seven subsystems that provide high-level agent capabilities.

### Identity (`@agentkernel/identity`)

- **Agent Cards**: JSON metadata describing agent capabilities (follows A2A spec)
- **DID generation**: Decentralized identity for each agent
- **Identity Manager**: Registration, lookup, and verification

### Memory (`@agentkernel/memory`)

Three memory types inspired by cognitive science:

| Type | What It Stores | Backend |
|------|---------------|---------|
| **Episodic** | Events, conversations, experiences | PostgreSQL + Qdrant vectors |
| **Semantic** | Facts, knowledge, preferences | PostgreSQL + Qdrant vectors |
| **Procedural** | Skills, workflows, learned behaviors | PostgreSQL |

The `MemoryManager` provides a unified API:
```typescript
manager.storeEpisode(agentId, episode);
manager.storeFact(agentId, fact);
manager.storeProcedure(agentId, procedure);
manager.search(agentId, query, options);     // vector + text search
```

Memory features: time-decay scoring, importance weighting, AES-256 encryption at rest, archival/tiering, per-agent scoping.

### Permissions (`@agentkernel/permissions`)

Capability-based security with cryptographic tokens:

- **Capability Manager**: Creates, validates, and revokes capability tokens
- **Tokens**: HMAC-SHA256 signed, time-bounded, delegatable
- **Policy Enforcement**: Rules evaluated against agent actions
- **Categories**: `memory`, `llm`, `network`, `file`, `shell`, `social`, `admin`

### Skills (`@agentkernel/skills`)

Installable capabilities (like apps on a phone):

- **Skill Registry**: Discovers and manages installed skills
- **Skill Manager**: Loads, validates, and executes skills in sandbox
- **Built-in skills**: `file-system`, `shell-exec`, `web-browse`
- Skills declare their required permissions

### Tools (`@agentkernel/tools`)

MCP-based tool system:

- **Tool Registry**: Registers and looks up tools
- **MCP Client Manager**: Connects to external MCP servers
- **Built-in Tools**: 8 built-in tools (readFile, writeFile, shellExec, httpFetch, etc.)
- Tools are sandboxed through the capability system

### Communication (`@agentkernel/communication`)

Agent-to-agent communication via A2A protocol:

- **A2A Client**: Send tasks to other agents
- **A2A Server**: Receive tasks from other agents
- **Agent Registry**: Discover available agents and their capabilities
- Transport: JSON-RPC 2.0 over HTTP(S)

### Events (`@agentkernel/events`)

Redis-backed pub/sub event system:

- **EventBus**: Publish/subscribe with channels
- **Webhook Manager**: HTTP webhook delivery with retry
- **Event persistence**: Events stored for replay/audit
- **Typed events**: All events have typed payloads

---

## Layer 5: Applications

### Gateway (`@agentkernel/gateway`, 14,538 lines, 100 tests)

The main daemon process. Everything runs through the gateway.

**Architecture**:
```
WebSocket Server (port 18800)     HTTP Server (port 18801)
├── Authentication (token-based)  ├── GET /health
├── Message Handler               ├── GET /metrics
│   ├── chat.*                    └── GET /ready
│   ├── agent.*
│   ├── memory.*
│   ├── tool.*
│   ├── skill.*
│   ├── social.*
│   ├── governance.*
│   └── admin.*
├── Task Handler
├── Worker Manager
└── Event Broadcasting
```

**Key files**:
- `main.ts` — Entry point, wires everything together (~1,200 lines)
- `websocket.ts` — WebSocket server with auth and rate limiting
- `message-handler.ts` — Routes messages to handlers by type
- `task-handler.ts` — Manages agent task execution
- `agent-worker.ts` — Spawns and manages agent processes
- `worker-manager.ts` — Pool of agent workers
- `health.ts` — HTTP health/metrics endpoints
- `security-utils.ts` — Input sanitization, path/domain/command validation
- `db-operations.ts` — Database query functions
- `cluster.ts` — Multi-node coordination

### CLI (`@agentkernel/cli`, 4,366 lines, 29 tests)

Full command-line interface.

**Commands**:
| Command | What It Does |
|---------|-------------|
| `agentkernel run <agent>` | **Hero command** — Run an agent file with sandboxing |
| `agentkernel init` | Generate `.env` with secure random secrets |
| `agentkernel status` | Check gateway health |
| `agentkernel start` | Start the gateway |
| `agentkernel doctor` | Validate entire setup |
| `agentkernel chat <message>` | Chat with an LLM |
| `agentkernel deploy <manifest>` | Deploy an agent |
| `agentkernel agents` | List running agents |
| `agentkernel terminate <id>` | Stop an agent |
| `agentkernel new-agent <name>` | Scaffold a new agent |
| `agentkernel install <path>` | Install an agent package |
| `agentkernel shell` | Interactive management REPL |
| `agentkernel social ...` | Forum, jobs, reputation |
| `agentkernel governance ...` | Policies, moderation, sanctions |

**Hero command** (`run.ts`):
```bash
# Standalone mode — validates without a gateway
agentkernel run ./my-agent.ts --standalone

# Connected mode — deploys to running gateway
agentkernel run ./my-agent.ts

# With adapter — runs external framework agents
agentkernel run config.yaml --adapter openclaw
```

### Dashboard (`@agentkernel/dashboard`, 4,753 lines)

Next.js 15 + React 19 web UI with Catppuccin Mocha dark theme.

**Pages**: Home, Chat, Agents, Memory, Security, Settings

**Real-time**: All data flows via WebSocket from gateway → dashboard.

---

## Adapters

Adapters let AgentKernel run agents built with external frameworks. Each adapter implements the `AgentAdapter` interface and translates between the framework's API and AgentKernel's sandbox.

### Available Adapters

| Adapter | Framework | What It Adapts |
|---------|-----------|---------------|
| `@agentkernel/adapter-openclaw` | OpenClaw | Personality configs, skills → capabilities |
| `@agentkernel/adapter-crewai` | CrewAI | Crews, agents, tasks, tools → capabilities |
| `@agentkernel/adapter-langgraph` | LangGraph | Graphs, nodes, edges, state → capabilities |
| `@agentkernel/adapter-autogen` | AutoGen | Conversations, agents, functions → capabilities |

### How Adapters Work

1. User runs: `agentkernel run config.yaml --adapter crewai`
2. CLI loads the adapter from `AdapterRegistry`
3. Adapter parses the framework's config file
4. Adapter determines required capabilities (e.g., `llm:execute`, `network:http`)
5. AgentKernel creates a sandbox and grants allowed capabilities
6. Adapter translates messages between the framework and the sandbox

---

## Providers

LLM provider adapters. Each implements `ProviderAdapter` from `@agentkernel/mal`.

| Provider | Package | Models |
|----------|---------|--------|
| Anthropic | `@agentkernel/provider-anthropic` | Claude Opus 4.5, Sonnet 4.5, Haiku |
| OpenAI | `@agentkernel/provider-openai` | GPT-4o, GPT-4o-mini |
| Google | `@agentkernel/provider-google` | Gemini 2.5 Pro, Flash |
| Ollama | `@agentkernel/provider-ollama` | Any local model |

---

## Example Agents

| Agent | Purpose | Key Skills |
|-------|---------|-----------|
| `assistant` | Conversational agent with memory | chat, memory search/store |
| `coder` | Code review and refactoring | file read/write, shell |
| `monitor` | URL/API change detection | HTTP fetch, scheduling |
| `researcher` | Research and summarization | web browse, memory |
| `system` | OS administration | admin commands, health |

Each agent is a standalone package with a `manifest.json` and `src/index.ts`.

---

## Configuration System

### Priority Order (highest wins)

1. **Environment variables** — `ANTHROPIC_API_KEY`, `DATABASE_URL`, etc.
2. **Config file** — `agentkernel.config.ts` or `agentkernel.config.yaml`
3. **Built-in defaults**

### Config File Formats

**TypeScript** (recommended):
```typescript
import { defineConfig } from "@agentkernel/kernel";

export default defineConfig({
  database: { host: "localhost", port: 5432 },
  providers: { anthropic: { apiKey: process.env.ANTHROPIC_API_KEY } },
});
```

**YAML**:
```yaml
database:
  host: localhost
  port: 5432
providers:
  anthropic:
    apiKey: ${ANTHROPIC_API_KEY}
```

### Key Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | One provider | Anthropic API key |
| `OPENAI_API_KEY` | One provider | OpenAI API key |
| `GOOGLE_AI_API_KEY` | One provider | Google AI API key |
| `DATABASE_URL` | Docker provides | PostgreSQL connection |
| `REDIS_URL` | Docker provides | Redis connection |
| `QDRANT_URL` | Docker provides | Qdrant connection |
| `GATEWAY_AUTH_TOKEN` | Production | WebSocket auth token |
| `PERMISSION_SECRET` | Production | Capability token signing key |

---

## Security Model

### Capability-Based Permissions

Every agent operation requires an explicit capability token:

```
Category        Actions
─────────       ─────────────────────────────
memory          read, write, search, delete
llm             execute, stream
network         http, websocket
file            read, write, delete
shell           execute
social          forum.*, jobs.*, reputation.*
admin           agent.*, config.*, governance.*
```

Tokens are:
- **Cryptographic**: HMAC-SHA256 signed with `PERMISSION_SECRET`
- **Time-bounded**: Expire after `PERMISSION_TOKEN_DURATION_MS`
- **Delegatable**: An agent can delegate a subset of its capabilities
- **Audited**: Every token grant/check is logged

### Sandbox Enforcement

```
Agent Code → Sandbox.check(capability) → Granted? → Execute
                                       → Denied?  → CapabilityError
```

### Governance

For multi-agent deployments:
- **Policies**: Rules agents must follow
- **Moderation**: Open cases against policy violations
- **Sanctions**: Warning → quarantine → suspension → ban
- **Appeals**: Agents/operators can appeal sanctions
- **Audit trail**: Immutable log of every action

---

## Protocols

### MCP (Model Context Protocol)

- **What**: Standard for connecting agents to tools, databases, APIs
- **By**: Anthropic (2024), now Linux Foundation
- **Used for**: Tool registry, external tool invocation
- **Implementation**: `@agentkernel/tools` uses `@modelcontextprotocol/sdk`

### A2A (Agent-to-Agent Protocol)

- **What**: Standard for agent-to-agent communication
- **By**: Google (2025), now Linux Foundation
- **Used for**: Agent discovery, task delegation, skill invocation
- **Implementation**: `@agentkernel/communication` implements A2A client/server

---

## Dashboard Architecture

**Stack**: Next.js 15, React 19, Tailwind CSS, Catppuccin Mocha theme

```
src/
├── app/                    → Next.js App Router pages
│   ├── page.tsx            → Home (system monitor)
│   ├── chat/page.tsx       → Chat with LLMs/agents
│   ├── agents/page.tsx     → Agent management
│   ├── memory/page.tsx     → Memory search/store
│   ├── security/page.tsx   → Governance, audit, capabilities
│   └── settings/page.tsx   → Configuration
├── components/
│   ├── shell/              → DesktopShell, TopPanel, Dock, Window, SetupAssistant
│   ├── home/               → StatusCard, MetricBar, EventFeed
│   ├── chat/               → MessageList, ChatInput, ModelSelector
│   ├── agents/             → AgentCard, AgentCatalog, DeployModal
│   ├── memory/             → MemorySearchBar, MemoryResults, StoreForm
│   ├── security/           → AuditTable, PolicyList, GovernancePanel
│   └── shared/             → Panel, Tag, Modal, LoadingDots, EmptyState
├── hooks/                  → useWebSocket, useHealth, useChat, useAgents, etc.
├── providers/              → WebSocketProvider (context)
├── lib/                    → types, constants, ws-client, manifests
└── styles/                 → globals.css, catppuccin.css
```

All data flows via WebSocket: Dashboard ↔ Gateway.

---

## Testing Infrastructure

### Test Stack

- **Framework**: Vitest with V8 coverage
- **Total**: 1,122 tests across 46 files
- **Pattern**: Tests colocated with source (`foo.ts` → `foo.test.ts`)

### Running Tests

```bash
pnpm test                           # Run root workspace tests
pnpm -r test                        # Run ALL tests recursively
pnpm --filter @agentkernel/kernel test  # Run specific package
pnpm --filter '@agentkernel/adapter-*' test  # Run all adapters
```

### Test Infrastructure

```bash
# Start test databases
docker compose -f docker/docker-compose.test.yml up -d

# Run integration tests
pnpm --filter @agentkernel/kernel test -- --config vitest.integration.config.ts
```

### Test Distribution

| Package | Tests | Focus |
|---------|-------|-------|
| kernel | 412 | Config, DB, vector store, event bus, circuit breaker, scheduler |
| runtime | 214 | Sandbox, state machine, adapter, audit, persistence |
| mal | 117 | Router, retry, streaming, rate limiter, token tracker |
| gateway | 100 | WebSocket, message handling, security, health |
| communication | 51 | A2A client/server, agent registry |
| skills | 45 | Skill loading, registry, sandboxing |
| tools | 41 | Tool registry, MCP client, built-in tools |
| events | 34 | Event bus, webhooks, persistence |
| system agent | 35 | System admin agent |
| cli | 29 | Run command, package manager |
| assistant agent | 28 | Conversational agent |
| sdk | 26 | Client, manifest validation |
| identity | 26 | Agent cards, DID |
| permissions | 21 | Capabilities, tokens, policies |
| memory | 19 | Store, search, encryption |
| shared | 19 | Result types, utilities |
| adapters | 67 | OpenClaw (14), CrewAI (17), LangGraph (18), AutoGen (18) |
| providers | 48 | Anthropic (13), OpenAI (12), Google (12), Ollama (11) |

---

## Build System

### Tools

- **Package manager**: pnpm 9+ with workspaces
- **Build**: tsup (library packages), Next.js (dashboard)
- **Lint**: Biome (replaces ESLint + Prettier)
- **Types**: TypeScript 5.x strict mode

### Commands

```bash
pnpm install                  # Install all dependencies
pnpm build                    # Build all packages (respects dependency order)
pnpm -r build                 # Build recursively (explicit order)
pnpm test                     # Run tests
pnpm dev                      # Start gateway in dev mode with live reload
```

### Package Build Output

Each package builds to `dist/` with:
- `index.js` — ESM JavaScript
- `index.d.ts` — TypeScript declarations

---

## Key Design Decisions

### 1. Composition Over Inheritance
No class inheritance anywhere. All APIs use interfaces and factory functions.

### 2. Result Types Over Exceptions
Business logic uses `Result<T, E>` from `@agentkernel/shared`. Try/catch reserved for infrastructure boundaries.

### 3. Capability-Based Security
Inspired by Android's permission model. Agents request capabilities; the sandbox enforces them.

### 4. Protocol-Native
MCP for tools, A2A for communication. No custom protocols invented.

### 5. Adapter Pattern for Frameworks
Instead of requiring agents to be rewritten, adapters translate any framework's API to the sandbox model.

### 6. Cognitive Memory Model
Three memory types from cognitive science rather than a generic key-value store.

### 7. Static Export Dashboard
Dashboard uses `output: "export"` for maximum deployment flexibility (no Node server needed).

---

## Common Patterns

### Factory Functions

```typescript
// Preferred: factory function
export function createEventBus(config: EventBusConfig): EventBus { ... }

// NOT: class constructor
export class EventBus { constructor(config: EventBusConfig) { ... } }
```

### Barrel Exports

Every package has a single `index.ts` that re-exports all public APIs:
```typescript
export { createEventBus, type EventBus } from "./bus.js";
export { WebhookManager } from "./webhooks.js";
```

### Error Types

Each subsystem defines its own error class:
```typescript
export class SkillError extends Error { code: SkillErrorCode; }
export class ToolError extends Error { code: ToolErrorCode; }
export class CommunicationError extends Error { code: CommunicationErrorCode; }
```

### Zod Validation

All external inputs validated with Zod schemas:
```typescript
const ManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  permissions: z.array(z.string()),
});
```

---

## Dependency Graph

```
@agentkernel/shared ──────────────────────────────────────────┐
      │                                                        │
@agentkernel/kernel ──────────────────────────────────────┐    │
      │                                                    │    │
@agentkernel/mal ─────────────────────────────────────┐    │    │
      │                                                │    │    │
@agentkernel/runtime ─────────────────────────────┐    │    │    │
      │                                            │    │    │    │
@agentkernel/identity ────────────────────────┐    │    │    │    │
@agentkernel/memory ──────────────────────┐    │    │    │    │    │
@agentkernel/permissions ─────────────┐    │    │    │    │    │    │
@agentkernel/skills ──────────────┐    │    │    │    │    │    │    │
@agentkernel/tools ───────────┐    │    │    │    │    │    │    │    │
@agentkernel/communication ┐  │    │    │    │    │    │    │    │    │
@agentkernel/events ──────┐│  │    │    │    │    │    │    │    │    │
                          ││  │    │    │    │    │    │    │    │    │
@agentkernel/sdk ─────────┴┴──┴────┴────┴────┴────┴────┴────┴────┴───┘
      │
@agentkernel/gateway
@agentkernel/cli
@agentkernel/dashboard
```

Adapters depend on `@agentkernel/runtime` (for `AgentAdapter`, `AgentSandbox`).
Providers depend on `@agentkernel/mal` (for `ProviderAdapter`).

---

## File Naming Conventions

- Source: `kebab-case.ts` (e.g., `agent-worker.ts`, `dead-letter-queue.ts`)
- Tests: `kebab-case.test.ts` colocated with source
- Types: Defined in same file or dedicated `types.ts`
- Index: Every package has `src/index.ts` as barrel export
- Migrations: `NNN_description.sql` (e.g., `001_initial.sql`)

## Coding Conventions

- **No `any`** — ever
- **No default exports** — always named exports (except Next.js pages)
- **No class inheritance** — composition and interfaces
- **No console.log** — use structured logger from `@agentkernel/kernel`
- **Interface over type** — for public APIs
- **camelCase** — functions, variables
- **PascalCase** — types, interfaces, classes
- **SCREAMING_SNAKE** — constants
- **JSDoc** — on all public functions

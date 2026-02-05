# Architecture Guide

## System Overview

AgentKernel is a security layer that intercepts all AI agent operations and enforces policies before allowing them to execute. It works with any agent framework.

```
                    ┌─────────────────────────────┐
                    │        AI AGENT              │
                    │  (LangChain / OpenClaw /     │
                    │   AutoGPT / Custom)          │
                    └──────────────┬───────────────┘
                                   │
                    ┌──────────────▼───────────────┐
                    │      AGENTKERNEL PROXY       │
                    │                               │
                    │  ┌─────────────────────────┐  │
                    │  │   Message Normalizer    │  │
                    │  │  (OpenClaw/MCP/Simple)  │  │
                    │  └───────────┬─────────────┘  │
                    │              │                 │
                    │  ┌───────────▼─────────────┐  │
                    │  │   Tool Interceptor      │  │
                    │  │  Extract tool + args    │  │
                    │  └───────────┬─────────────┘  │
                    │              │                 │
                    │  ┌───────────▼─────────────┐  │
                    │  │   Policy Engine         │◄─┼── policy.yaml
                    │  │  file/network/shell     │  │
                    │  │  + cross-domain check   │  │
                    │  └───────────┬─────────────┘  │
                    │              │                 │
                    │        ┌─────┴─────┐          │
                    │        │           │          │
                    │   ┌────▼───┐  ┌────▼───┐     │
                    │   │ BLOCK  │  │ ALLOW  │     │
                    │   │ + log  │  │ + log  │     │
                    │   └────────┘  └────┬───┘     │
                    │                     │         │
                    └─────────────────────┼─────────┘
                                          │
                    ┌─────────────────────▼─────────┐
                    │      SYSTEM RESOURCES          │
                    │  Files / Network / Shell       │
                    └───────────────────────────────┘
```

## Package Architecture

```
agentkernel/
├── packages/
│   ├── kernel/                 # Core infrastructure
│   │   ├── config.ts           # Multi-source config loader (env, file, defaults)
│   │   ├── database.ts         # PostgreSQL connection pool + query builder
│   │   ├── event-bus.ts        # Redis pub/sub for inter-process events
│   │   ├── vector-store.ts     # Qdrant client for semantic memory
│   │   ├── logger.ts           # Structured logging (Pino)
│   │   ├── health.ts           # Health checks for all dependencies
│   │   └── query-circuit-breaker.ts  # Circuit breaker for database protection
│   │
│   ├── runtime/                # Security runtime
│   │   ├── policy-engine.ts    # Core policy evaluation engine
│   │   ├── policy-config.ts    # YAML policy loader with env var expansion
│   │   ├── process-sandbox.ts  # V8 isolate sandboxing via child_process
│   │   ├── audit.ts            # Multi-sink audit logging
│   │   ├── rate-limiter.ts     # Token bucket rate limiter per agent
│   │   ├── state-persistence.ts # PostgreSQL agent state storage
│   │   └── lifecycle.ts        # Agent lifecycle management
│   │
│   ├── framework/
│   │   └── permissions/        # HMAC capability tokens
│   │       ├── capability.ts   # Token creation, signing, verification
│   │       └── store.ts        # Token storage + expiry management
│   │
│   ├── agentkernel-cli/        # CLI binary (npm: @agentkernel/agent-kernel)
│   │   ├── cli.ts              # Command router + interactive wizard
│   │   ├── proxy.ts            # HTTP + WebSocket security proxy
│   │   ├── tool-interceptor.ts # Tool call evaluation pipeline
│   │   ├── message-normalizer.ts # Multi-format message parser
│   │   ├── policy-manager.ts   # Policy CRUD operations
│   │   ├── default-policy.ts   # 341+ built-in malicious pattern rules
│   │   ├── audit.ts            # Console + file + memory audit sinks
│   │   └── config.ts           # Environment variable loader
│   │
│   ├── langchain-adapter/      # LangChain integration
│   │   └── index.ts            # wrapToolWithPolicy() for any LangChain tool
│   │
│   └── shared/                 # Shared types
│       ├── types.ts            # Common type definitions
│       └── result.ts           # Result<T, E> monad
│
└── docker/
    └── docker-compose.test.yml # PostgreSQL, Redis, Qdrant for testing
```

## Security Layers

AgentKernel implements defense-in-depth with multiple independent security layers:

### Layer 1: Policy Engine

The policy engine evaluates every operation against YAML-defined rules:

```yaml
file:
  default: block
  rules:
    - pattern: "**/.ssh/**"
      decision: block
      reason: "SSH credentials"

network:
  default: block
  rules:
    - host: "api.telegram.org"
      decision: block
      reason: "Data exfiltration"

shell:
  default: block
  rules:
    - command: "git"
      decision: allow
```

Evaluation is type-safe with union types:

```typescript
engine.evaluate({
  type: "file",
  path: "/home/user/.ssh/id_rsa",
  operation: "read",
  agentId: "agent-1",
});
// → { decision: "block", reason: "SSH credentials", matchedRule: "**/.ssh/**" }
```

### Layer 2: Cross-Domain Shell-to-File Checking

Shell commands are parsed to extract file arguments. Even if `cat` is allowed as a shell command, `cat ~/.ssh/id_rsa` is blocked because the file argument matches a file block rule.

Supported commands: `cat`, `head`, `tail`, `less`, `more`, `cp`, `mv`, `rm`, `chmod`, `chown`, `vi`, `vim`, `nano`, `code`, `open`, `xdg-open`, `scp`, `rsync`, `tar`, `zip`, `unzip`, `gzip`, `gunzip`, `base64`.

### Layer 3: Capability Tokens

HMAC-signed tokens grant time-bounded permissions:

```
┌────────────────────────────────┐
│ Capability Token               │
│                                │
│ agentId: "agent-1"             │
│ permissions:                   │
│   - filesystem:read:/workspace │
│ issuedAt: 2026-02-06T10:00:00 │
│ expiresAt: 2026-02-06T11:00:00│
│ signature: hmac-sha256(...)    │
│                                │
│ Properties:                    │
│   - Unforgeable (HMAC signed)  │
│   - Time-bounded (auto-expire) │
│   - Constant-time verification │
│   - Revocable                  │
└────────────────────────────────┘
```

### Layer 4: Process Sandbox

Untrusted code runs in isolated V8 processes:

```
┌──────────────────────────┐
│ Main Process             │
│                          │
│  spawn ──► ┌────────────┐│
│            │ Sandbox    ││
│            │            ││
│            │ No fs      ││
│            │ No net     ││
│            │ No require ││
│            │ No process ││
│            │            ││
│            │ 64MB heap  ││
│            │ 30s timeout││
│            └────────────┘│
└──────────────────────────┘
```

### Layer 5: Rate Limiting

Token bucket algorithm per agent prevents abuse:

```
Bucket: 60 tokens/minute, burst of 10
├── Token available? → Allow + consume token
└── No tokens? → Rate limited (429)
    └── Tokens refill at configured rate
```

### Layer 6: Audit Trail

Every operation is logged to multiple sinks:

```
Operation ──► Console (real-time)
         ──► File (JSON lines)
         ──► PostgreSQL (queryable, HIPAA/SOC2)
         ──► Memory (recent entries via /audit API)
```

## Data Flow

### Standalone Mode (Default)

```
Client ──HTTP POST /evaluate──► AgentKernel Proxy
                                    │
                                    ├── Normalize message format
                                    ├── Extract tool + args
                                    ├── Rate limit check
                                    ├── Policy engine evaluate
                                    │   ├── File rules
                                    │   ├── Network rules
                                    │   ├── Shell rules
                                    │   └── Cross-domain check
                                    ├── Log to audit sinks
                                    └── Return decision
Client ◄──{"decision":"block"}──┘
```

### Proxy Mode

```
Agent ──WS──► AgentKernel Proxy ──WS──► Gateway
                    │
                    ├── Intercept tool calls
                    ├── Evaluate against policy
                    ├── Block dangerous calls
                    └── Forward safe calls
```

### WebSocket Message Formats

AgentKernel accepts three formats on the WebSocket:

```
OpenClaw:    {"type":"tool_invoke","id":"...","data":{"tool":"bash","args":{...}}}
MCP/JSON-RPC: {"jsonrpc":"2.0","id":"1","method":"tools/call","params":{"name":"bash","arguments":{...}}}
Simple:      {"tool":"bash","args":{"command":"git status"}}
```

Responses are sent back in the same format the client used.

## Production Hardening

When `AGENTKERNEL_PRODUCTION_HARDENING=true` or `NODE_ENV=production`:

| Check | Requirement |
|-------|-------------|
| PERMISSION_SECRET | Set, 32+ chars, not a placeholder |
| LOG_LEVEL | Not `debug` or `trace` |
| DATABASE_SSL | `true` when database is remote |
| REDIS_PASSWORD | Set when Redis is remote |
| Policy default | Must be `block` |
| Sandbox permissions | Dangerous defaults disallowed |

## Testing Architecture

```
1,170+ tests across all packages:

  kernel (445)          ── Config, database, event bus, vector store, logging, health
  runtime (437)         ── Policy engine, sandbox, audit, lifecycle, rate limiter
  agentkernel-cli (196) ── Proxy, interceptor, policy manager, normalizer, CLI
  langchain-adapter (52)── Tool wrapping, policy enforcement
  permissions (21)      ── HMAC tokens, capability management

Integration tests (47) ── Real PostgreSQL, Redis, Qdrant
```

## Key Design Decisions

1. **Defense in depth** — Multiple independent layers, not one point of failure
2. **Policy as data** — YAML rules, not hardcoded logic. Users own their policy
3. **Framework agnostic** — Works via HTTP API, WebSocket, or library import
4. **Capability-based security** — Unforgeable tokens, not ambient authority
5. **Cross-domain checking** — Shell commands cross-checked against file policies
6. **Constant-time crypto** — HMAC verification resistant to timing attacks
7. **Fail closed** — Default decision is `block`, not `allow`

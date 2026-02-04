# Changelog

## 0.1.0 (2026-02-03) — Initial Public Release

### Architecture
- 5-layer OS design: Kernel, Model Abstraction, Runtime, Framework, Applications
- Protocol-native: MCP for tools, A2A for agent-to-agent communication
- Model-agnostic: Anthropic, OpenAI, Google, Ollama adapters included

### Layer 1: Compute Kernel
- PostgreSQL connection pool with migrations
- Qdrant vector store client
- Redis pub/sub event bus
- Structured logging (pino)
- Health check aggregator with Prometheus metrics
- Graceful shutdown with connection draining
- Circuit breaker, retry with full jitter, rate limiting
- Scheduler with dead letter queue

### Layer 2: Model Abstraction Layer
- Provider routing with automatic failover
- Rate limiting per provider (tokens/minute)
- Token tracking and cost estimation
- Streaming support for all providers

### Layer 3: Agent Runtime
- Agent lifecycle management (state machine with persistence)
- Process sandboxing (Docker containers in production)
- Resource limits enforcement (memory, CPU, tokens)
- Health monitoring with watchdog
- Auto-checkpoint with consecutive failure detection

### Layer 4: Agent Framework
- **Identity**: Agent Cards, DID generation, registration
- **Memory**: Episodic, semantic, procedural memory with vector search
- **Permissions**: Capability-based security with HMAC-signed tokens
- **Communication**: A2A client/server with replay protection
- **Tools**: MCP client with built-in tools (file, shell, HTTP, calculator)
- **Skills**: Installable capabilities with manifest signing
- **Events**: Redis-backed pub/sub with persistence

### Layer 5: Applications
- **Gateway**: WebSocket server with auth, rate limiting, clustering
- **CLI**: `agentkernel init`, `status`, `agents`, `chat`, `doctor`
- **Dashboard**: Web UI for monitoring agents, memory, events

### Security
- Capability-based permissions (unforgeable HMAC tokens)
- Sandbox isolation (Docker per-agent)
- Path traversal protection with symlink resolution
- Shell command allowlisting
- Environment variable isolation for spawned processes
- Auth rate limiting (brute-force protection)
- Egress proxy for network tools
- Security headers on all HTTP endpoints

### Infrastructure
- Docker Compose with PostgreSQL, Qdrant, Redis, Gateway, Dashboard
- Kubernetes manifests (Deployment, Service, HPA, PDB, ServiceAccount)
- GitHub Actions CI (build, typecheck, unit tests, integration tests)
- Backup/restore scripts for PostgreSQL and Qdrant

### Testing
- 1,195 unit tests across all layers
- Integration test suite for gateway
- Zero `any` types, zero `Function()` eval, zero TODO/FIXME in production code

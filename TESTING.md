# AgentKernel — Real-Life Testing Guide

Test AgentKernel end-to-end before going public. This guide takes you from zero to a fully validated system.

---

## Prerequisites

| Requirement | Check |
|-------------|-------|
| Node.js 22+ | `node --version` |
| pnpm 9+ | `pnpm --version` |
| Docker + Docker Compose | `docker compose version` |
| At least one LLM API key | Anthropic, OpenAI, Google, or Ollama running locally |

---

## Phase 1: Local Build Validation

Verify the codebase builds and all tests pass from a clean state.

```bash
# 1. Fresh clone
git clone <your-repo-url>
cd AgentKernel

# 2. Install dependencies
pnpm install

# 3. Build all packages
pnpm build

# 4. Run all unit tests
pnpm -r test

# Expected: 1,122+ tests passing across 46+ test files
```

### What to look for

- ✅ `pnpm build` completes with zero errors
- ✅ All test files pass (no failures, no skipped tests)
- ✅ No TypeScript errors: `pnpm exec tsc --noEmit`

### Troubleshooting

| Problem | Fix |
|---------|-----|
| `ERR_MODULE_NOT_FOUND` | Run `pnpm install` then `pnpm build` again |
| Tests timeout | Increase timeout: `pnpm test -- --timeout 30000` |
| Type errors | `pnpm exec tsc --noEmit` to see full error list |

---

## Phase 2: Environment Setup

### Option A: Docker (recommended for full stack testing)

```bash
# 1. Generate secure .env
pnpm -C apps/cli build
pnpm -C apps/cli exec agentkernel init

# 2. Add your API keys to .env
# Edit .env and set at least one of:
#   ANTHROPIC_API_KEY=sk-ant-...
#   OPENAI_API_KEY=sk-...
#   GOOGLE_AI_API_KEY=...

# 3. Start all services
docker compose up --build -d

# 4. Wait for services to be healthy (30-60 seconds)
docker compose ps
```

### Option B: Local development (no Docker)

AgentKernel falls back to in-memory stores when infrastructure isn't available.

```bash
# 1. Generate .env
pnpm -C apps/cli exec agentkernel init

# 2. Add your API keys to .env

# 3. Start in dev mode
pnpm dev
```

### Verify infrastructure

```bash
# Health check (should return JSON with status "healthy")
curl http://localhost:18801/health

# Metrics (Prometheus format)
curl http://localhost:18801/metrics

# Doctor check (validates everything)
pnpm -C apps/cli exec agentkernel doctor --docker --infra
```

---

## Phase 3: Gateway Tests

The gateway is the core daemon. Test it thoroughly.

### 3.1 Health & Metrics

```bash
# Health endpoint
curl -s http://localhost:18801/health | jq .

# Expected response:
# {
#   "status": "healthy",
#   "uptime": 42,
#   "agents": 0,
#   "connections": 0,
#   "components": { ... }
# }

# Metrics endpoint
curl -s http://localhost:18801/metrics | head -20
```

### 3.2 WebSocket Connection

```bash
# Test WebSocket authentication
# Install wscat if needed: npm install -g wscat
wscat -c "ws://localhost:18800" \
  -H "Authorization: Bearer $(grep GATEWAY_AUTH_TOKEN .env | cut -d= -f2)"

# Once connected, send a ping:
# > {"type":"ping","id":"test-1"}
# Expected response: {"type":"pong","id":"test-1"}
```

### 3.3 Chat with LLM

```bash
# Via CLI
pnpm -C apps/cli exec agentkernel chat "What is 2+2?" \
  --token $(grep GATEWAY_AUTH_TOKEN .env | cut -d= -f2)

# Expected: A response from the LLM with the answer
```

### 3.4 Rate Limiting

```bash
# Send many messages quickly to test rate limiting
for i in $(seq 1 10); do
  pnpm -C apps/cli exec agentkernel chat "test $i" \
    --token $(grep GATEWAY_AUTH_TOKEN .env | cut -d= -f2) &
done
wait

# Should succeed for all (within rate limit)
# If rate limit is hit, you'll see rate limit error messages
```

---

## Phase 4: Agent Lifecycle Tests

### 4.1 Run an Agent Standalone

```bash
# Run the built-in assistant agent in validation mode
pnpm -C apps/cli exec agentkernel run agents/assistant/src/index.ts --standalone

# Expected output:
# AgentKernel
# ────────────────────────────────────
#   ✓ Agent loaded        Assistant v0.1.0
#   ✓ Sandbox active      X capabilities
#   ✓ Mode                standalone (validation)
#   ...
#   Agent is valid and ready to deploy.
```

### 4.2 Deploy an Agent

```bash
# Deploy the assistant agent
pnpm -C apps/cli exec agentkernel deploy agents/assistant/manifest.json \
  --token $(grep GATEWAY_AUTH_TOKEN .env | cut -d= -f2)

# List running agents
pnpm -C apps/cli exec agentkernel agents \
  --token $(grep GATEWAY_AUTH_TOKEN .env | cut -d= -f2)

# Expected: assistant agent shown with "running" state
```

### 4.3 Terminate an Agent

```bash
# Get the agent ID from the agents list, then:
pnpm -C apps/cli exec agentkernel terminate <agent-id> \
  --token $(grep GATEWAY_AUTH_TOKEN .env | cut -d= -f2)

# Verify it's gone
pnpm -C apps/cli exec agentkernel agents \
  --token $(grep GATEWAY_AUTH_TOKEN .env | cut -d= -f2)
```

### 4.4 Scaffold and Deploy a Custom Agent

```bash
# Create a new agent
pnpm -C apps/cli exec agentkernel new-agent test-agent --template chat

# Build it
cd agents/test-agent
pnpm install && pnpm build

# Validate
cd ../..
pnpm -C apps/cli exec agentkernel run agents/test-agent/src/index.ts --standalone

# Deploy
pnpm -C apps/cli exec agentkernel deploy agents/test-agent/manifest.json \
  --token $(grep GATEWAY_AUTH_TOKEN .env | cut -d= -f2)
```

---

## Phase 5: Memory Tests

### 5.1 Store and Search Memory

Using the CLI or WebSocket, test all three memory types:

```bash
# Via WebSocket (connect first with wscat):
# Store a semantic fact
> {"type":"memory.store","id":"m1","payload":{"agentId":"test","type":"semantic","data":{"category":"test","fact":"AgentKernel was created in 2025","importance":0.8}}}

# Search memory
> {"type":"memory.search","id":"m2","payload":{"agentId":"test","query":"when was AgentKernel created","limit":5}}

# Expected: Returns the stored fact with a relevance score
```

### 5.2 Memory Persistence

```bash
# 1. Store a fact (as above)
# 2. Restart the gateway
docker compose restart gateway
# 3. Search for the fact again — it should still be there
```

---

## Phase 6: Dashboard Tests

### 6.1 Access the Dashboard

```bash
# Open in browser
open http://localhost:3000
```

### 6.2 Dashboard Checklist

| Page | What to test |
|------|-------------|
| **Home** | Gateway status shows "healthy", metrics update, event feed populates |
| **Chat** | Send a message, get streaming response, model selector works |
| **Agents** | Deploy from catalog, see running agents, terminate an agent |
| **Memory** | Search returns results, store a new fact, pagination works |
| **Security** | Audit log shows entries, governance panel loads |
| **Settings** | Auth token field, operator agent selection |

### 6.3 Real-time Updates

1. Open the dashboard in a browser
2. In a separate terminal, deploy an agent via CLI
3. The agents page should update in real-time (no refresh needed)

---

## Phase 7: Adapter Tests

### 7.1 Run Adapter Unit Tests

```bash
# All adapters
pnpm --filter '@agentkernel/adapter-*' test

# Individual adapter
pnpm --filter @agentkernel/adapter-openclaw test
pnpm --filter @agentkernel/adapter-crewai test
pnpm --filter @agentkernel/adapter-langgraph test
pnpm --filter @agentkernel/adapter-autogen test
```

### 7.2 Test with Real Framework Config

If you have OpenClaw installed:

```bash
# Create an OpenClaw config
cat > test-openclaw.yaml << 'EOF'
name: Test Bot
personality: You are a helpful assistant.
skills:
  - file-system
  - web-browse
EOF

# Run through AgentKernel
pnpm -C apps/cli exec agentkernel run test-openclaw.yaml --adapter openclaw --standalone
```

---

## Phase 8: Security Tests

### 8.1 Authentication

```bash
# Test without token (should fail)
wscat -c "ws://localhost:18800"
# Expected: Connection rejected with 401

# Test with wrong token (should fail)
wscat -c "ws://localhost:18800" -H "Authorization: Bearer wrong-token"
# Expected: Connection rejected with 403

# Test with correct token (should succeed)
wscat -c "ws://localhost:18800" \
  -H "Authorization: Bearer $(grep GATEWAY_AUTH_TOKEN .env | cut -d= -f2)"
# Expected: Connection established
```

### 8.2 Sandbox Enforcement

```bash
# Run an agent that tries to access something it shouldn't
# The built-in agents have limited permissions — trying to use
# admin capabilities should fail with CapabilityError
```

### 8.3 Input Sanitization

```bash
# Send a path traversal attempt
> {"type":"tool.invoke","id":"sec1","payload":{"toolId":"readFile","args":{"path":"../../etc/passwd"}}}
# Expected: Rejected by path validation

# Send oversized payload
# Generate a 15MB payload and send via WebSocket
# Expected: Rejected by payload size limit
```

### 8.4 Rate Limiting

```bash
# Rapidly send messages to trigger rate limiting
for i in $(seq 1 700); do
  echo "{\"type\":\"ping\",\"id\":\"rate-$i\"}"
done | wscat -c "ws://localhost:18800" \
  -H "Authorization: Bearer $(grep GATEWAY_AUTH_TOKEN .env | cut -d= -f2)"

# Expected: After ~600 messages, should receive rate limit errors
```

---

## Phase 9: Production Readiness

### 9.1 Production Docker Build

```bash
# Build with production hardening
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d

# Verify all services are running
docker compose ps

# Run smoke test
./scripts/docker-smoke.sh
```

### 9.2 Backup & Restore

```bash
# Backup PostgreSQL
./scripts/backup-postgres.sh

# Backup Qdrant
./scripts/backup-qdrant.sh

# Restore (test on a separate instance!)
# ./scripts/restore-postgres.sh /path/to/backup.dump
```

### 9.3 Graceful Shutdown

```bash
# Send SIGTERM to the gateway
docker compose stop gateway

# Check logs — should show orderly shutdown:
docker compose logs gateway --tail 20
# Expected:
# Shutting down gracefully...
# Closing WebSocket connections...
# Stopping agent workers...
# Closing database pool...
# Shutdown complete.
```

### 9.4 Resource Limits

Monitor resource usage during load:

```bash
# Watch Docker resource usage
docker stats

# Key metrics to watch:
# - Memory: Each agent container < 512MB (default limit)
# - CPU: Gateway < 2 cores under normal load
# - Connections: WebSocket connections < GATEWAY_MAX_CONNECTIONS
```

---

## Phase 10: Load Testing

### 10.1 Basic Load Test

```bash
# Run the built-in load test script
node scripts/load-test.mjs --connections 50 --messages 100 \
  --url ws://localhost:18800 \
  --token $(grep GATEWAY_AUTH_TOKEN .env | cut -d= -f2)
```

### 10.2 Concurrent Agents

```bash
# Deploy multiple agents simultaneously
for i in $(seq 1 10); do
  pnpm -C apps/cli exec agentkernel deploy agents/assistant/manifest.json \
    --token $(grep GATEWAY_AUTH_TOKEN .env | cut -d= -f2) &
done
wait

# Check all are running
pnpm -C apps/cli exec agentkernel agents \
  --token $(grep GATEWAY_AUTH_TOKEN .env | cut -d= -f2)
```

---

## Phase 11: Integration Tests (with real databases)

```bash
# Start test infrastructure
docker compose -f docker/docker-compose.test.yml up -d

# Wait for health checks
sleep 10

# Run integration tests
pnpm --filter @agentkernel/kernel test -- --config vitest.integration.config.ts

# Cleanup
docker compose -f docker/docker-compose.test.yml down -v
```

---

## Validation Checklist

Use this checklist before public release:

### Core Functionality
- [ ] `pnpm build` — zero errors
- [ ] `pnpm -r test` — all 1,122+ tests pass
- [ ] `pnpm exec tsc --noEmit` — no type errors
- [ ] `agentkernel init` — generates valid .env
- [ ] `agentkernel doctor` — all checks pass

### Gateway
- [ ] Health endpoint returns "healthy"
- [ ] Metrics endpoint returns Prometheus data
- [ ] WebSocket authentication works (accept valid, reject invalid)
- [ ] Chat with LLM returns correct responses
- [ ] Rate limiting triggers at configured threshold
- [ ] Graceful shutdown completes without errors

### Agents
- [ ] `agentkernel run --standalone` validates agent correctly
- [ ] `agentkernel deploy` deploys agent successfully
- [ ] `agentkernel agents` lists running agents
- [ ] `agentkernel terminate` stops agent cleanly
- [ ] `agentkernel new-agent` scaffolds valid agent
- [ ] Custom agent builds and deploys successfully

### Memory
- [ ] Store and search semantic memory
- [ ] Store and search episodic memory
- [ ] Memory persists across restarts
- [ ] Vector search returns relevant results (if OpenAI key configured)

### Dashboard
- [ ] All 6 pages load without errors
- [ ] Chat works with streaming
- [ ] Real-time updates via WebSocket
- [ ] Agent deploy/terminate from UI

### Security
- [ ] Unauthenticated connections rejected
- [ ] Invalid tokens rejected
- [ ] Path traversal blocked
- [ ] Oversized payloads rejected
- [ ] Rate limiting enforced
- [ ] Sandbox blocks unauthorized capabilities

### Docker
- [ ] `docker compose up --build` starts all services
- [ ] Production hardening build works
- [ ] Backup scripts execute successfully
- [ ] Graceful shutdown works in Docker

### Adapters
- [ ] All 4 adapter test suites pass (67 tests)
- [ ] `--adapter openclaw` with YAML config works
- [ ] `--adapter crewai` with YAML config works

---

## Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| Gateway won't start | Missing `.env` | Run `agentkernel init` |
| "No providers configured" | No API keys in `.env` | Add at least one API key |
| Dashboard blank | Gateway not running | Start gateway first |
| WebSocket connection fails | Wrong auth token | Check `GATEWAY_AUTH_TOKEN` in `.env` |
| Memory search empty | No OpenAI key (embeddings) | Add `OPENAI_API_KEY` or use text search |
| Docker build fails | Missing Docker BuildKit | `DOCKER_BUILDKIT=1 docker compose build` |
| Tests timeout | Docker infra not running | Start test infra: `docker compose -f docker/docker-compose.test.yml up -d` |
| Agent deploy fails | Agent not built | `cd agents/<name> && pnpm build` first |
| Port 18800 in use | Another gateway running | `docker compose down` or kill the process |

---

## Monitoring During Tests

Keep these open in separate terminals during testing:

```bash
# Terminal 1: Gateway logs
docker compose logs -f gateway

# Terminal 2: Resource usage
docker stats

# Terminal 3: Health polling
watch -n 5 'curl -s http://localhost:18801/health | jq .status'
```

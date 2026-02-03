# AgentOS Continuation Plan (Production-Ready, Self-Hosted)

This file captures the current state, what has been completed, what remains, and how to continue without losing context. It is aligned to the **5-layer architecture** and the production-readiness roadmap.

---

## Current Status (as of 2026-02-03)
- **Codebase status:** Extensive production-hardening and social/governance features implemented (see Completed section below).
- **Infra status:** Docker test infra (postgres/redis/qdrant) can be started; qdrant healthcheck is “unhealthy” only because the container lacks `curl`. HTTP `/collections` works.
- **Blocking issue (local sandbox):** Integration tests that require Postgres/Qdrant/Redis fail when the gateway cannot connect to localhost (EPERM). This is a **sandbox/network restriction** and does not reproduce on a normal macOS host shell.
- **Impact:** Memory + social/governance tests fail because the gateway silently falls back to in‑memory stores when persistent infra is unreachable.

### Quick Fix (most likely)
1) Run the integration suite in a normal host shell (not sandboxed), OR
2) Use the dockerized test environment + run vitest on the host machine, OR
3) If ports conflict, stop `agent-os-gateway` container or move integration test ports.

### Recent Changes (2026-02-03)
- Added mock LLM providers for `NODE_ENV=test` to eliminate real API dependency.
- Fixed test fixture permissions to include `llm.execute`.
- Corrected audit log query ordering in tool execution test.
- Updated memory persistence test to use internal agent UUID for DB queries.
- Added fallback for `agent_status` parsing in test utils.
- Made integration tests require persistent storage (`REQUIRE_PERSISTENT_STORE=true`) and force mock providers.
- Switched test infra defaults to `127.0.0.1` to avoid IPv6/localhost quirks.
- Added CLI `init` (generate secrets) and `doctor` (environment checks) commands.
- `doctor --infra` now checks Postgres/Redis/Qdrant connectivity using kernel clients.
- Updated docs to reference the new CLI flow for quick setup and verification.
- Added Docker-based agent worker runtime (optional) with stdio transport support.
- Docker worker hardening: read-only root, tmpfs, cap drops, security opts, network disable, CPU caps.
- Added `builtin:shell_exec` tool with command allowlisting (`ALLOWED_COMMANDS` / `ALLOW_ALL_COMMANDS`).
- Coder agent now supports `run_command` and `repo_summary` tasks and has shell/tools permissions.
- MAL telemetry upgraded: request IDs, retry counts, latency, failover metrics and provider IDs in responses.
- MAL now collects provider streaming when available (stream requests aggregate into full responses).
- Added CI workflow with build + tests + integration + docker smoke gate.
- Added chat streaming to gateway + CLI (`chat_stream`, `chat_stream_end`) with configurable chunk size.
- Added memory archival support (`memory_archives` table) with archive + retention env controls.
- Added optional memory encryption (per-agent derived keys; text search disabled on encrypted fields).
- Added Docker worker ulimit/storage options for tighter resource enforcement.
- Integration tests now auto-pick a free gateway port to avoid local port conflicts.
- Added production hardening checks for docker worker isolation (optional strict gate).
- Gateway Docker image now includes `docker` CLI; compose defaults to docker worker runtime with socket mount.
- Agent manifests now support `cpuCores` and `diskQuotaMB` limits for docker workers.
- Added HA-lite cluster mode with Postgres advisory lock leader election.
- Added egress proxy service (HTTP/CONNECT) for tool traffic; gateway tools can use `AGENT_EGRESS_PROXY_URL`.
- `http_fetch` and `browser_snapshot` now support optional proxy routing for OS-level egress control.
- Added production overlay `docker-compose.prod.yml` (AppArmor requirement + egress proxy wiring).
- Added `AGENT_WORKER_REQUIRE_APPARMOR` gate and AppArmor config support.
- Latest docker smoke rerun timed out mid-Playwright browser download; rerun with longer timeout if needed.

---

## Immediate Next Steps (execution-ready)
1) **Resolve integration test failure (P0).**
   - Stop `agent-os-gateway` container before `pnpm -C apps/gateway test:integration`, or
   - Update test config to use non-conflicting ports; verify gateway spawn uses correct `cwd`.
2) **Re-run integration test suite** and confirm all tests are green.
3) **Run docker smoke test** to ensure the 5-minute boot target still holds.
4) **Run load test** (`scripts/load-test.mjs`) to validate throughput baseline.
5) **Review release checklist** and confirm remaining gates are satisfied.

---
---

## Vision (recap)
AgentOS is a **self-hosted operating system for AI agents**: identity, memory, permissions, tools, jobs, social spaces, and governance—managed, audited, and sandboxed. It is **model-agnostic** and runs locally or on your own infra.

---

## 5-Layer Architecture (must follow)
1) **Layer 1: Compute Kernel** — process mgmt, storage, network, security, logging/metrics, config
2) **Layer 2: Model Abstraction Layer (MAL)** — provider adapters, routing, retries, failover, token tracking
3) **Layer 3: Agent Runtime** — lifecycle, isolation, scheduler, watchdogs, state machine
4) **Layer 4: Agent Framework** — identity, memory, skills, permissions, tools (MCP), A2A
5) **Layer 5: Agent Applications** — default agents + SDK + user agents

---

## Production Readiness Spec
- Defined in: `PRODUCTION_READINESS.md`
- Includes SLOs, threat model, data retention, upgrade policy, release gates

---

## What is COMPLETED (Production Hardening & Features)

### Layer 1: Compute Kernel
- Postgres + Qdrant initialization with **production requirements** enforcement (fail-fast when configured).
- Migrations executed on startup; errors in production stop boot.
- Health endpoints and `/metrics` with degraded status logic.
- Backup scripts added:
  - `scripts/backup-postgres.sh`
  - `scripts/restore-postgres.sh`
  - `scripts/backup-qdrant.sh`
- Retention cleanup for audit logs, events, and task messages (daily; env-configurable)
- Memory scope migration (`005_memory_scope.sql`)

### Layer 2: MAL
- Circuit breaker integrated into provider routing (`packages/mal/src/router.ts`).
- Retries + failover already present.

### Layer 3: Agent Runtime
- Worker process isolation (child processes) with watchdog and exponential backoff.
- **Worker memory cap** enforced via `--max-old-space-size`.
- Task timeout clamping via `MAX_AGENT_TASK_TIMEOUT_MS`.

### Layer 4: Agent Framework
- Capability-based permissions w/ grants & audit logging.
- Allowlists for filesystem + network enforced in tool invocations.
- A2A task schema validation (Ajv).
- MCP tool registration.
- Internal task protection with `INTERNAL_AUTH_TOKEN`.
- Manifest signing support (optional but production-ready).

### Layer 5: Agent Applications
- **Default agents** implemented with entrypoints + manifests:
  - Research (`agents/researcher`)
  - Monitor (`agents/monitor`)
  - Coder (`agents/coder`)
- Agents invoke gateway internally using SDK and internal token.
- Default agent manifests validated in integration tests

### Self-hosted Delivery
- `docker-compose.yml` updated for production flags and bootstrap.
- Gateway health endpoint runs on port `18801` (`/live`, `/health`, `/ready`) and is exposed on the host.
- Docker image now includes migrations and default agent artifacts.
- `docker/bootstrap-agents.mjs` auto-deploys default agents after gateway is healthy.
- `scripts/docker-smoke.sh` validates 5-minute boot target.
- Latest verification: gateway healthy in ~78s on Docker Desktop.
- Docker healthchecks use `/live` (does not require LLM providers to be configured).
- Dev defaults (tokens + allow-all domains) live in `docker-compose.dev.yml`.

### Society Layer (initial scaffolding)
- New DB migration: `packages/kernel/migrations/003_social.sql`
- Governance migration: `packages/kernel/migrations/004_governance.sql`
- Appeals migration: `packages/kernel/migrations/006_governance_appeals.sql`
- New task types in gateway:
  - Forums: `forum_create`, `forum_list`, `forum_post`, `forum_posts`
  - Jobs: `job_post`, `job_list`, `job_apply`
  - Reputation: `reputation_get`, `reputation_list`, `reputation_adjust`
  - Governance: `policy_create`, `policy_list`, `policy_set_status`, `moderation_case_open`, `moderation_case_list`, `moderation_case_resolve`, `sanction_apply`, `sanction_list`, `sanction_lift`
- New permission category: `social`
 - Sanction enforcement: active sanctions block agent tasks
- Policy engine: automatic rule evaluation on audit logs, auto-open moderation cases, auto-apply sanctions
- Appeals workflow: `appeal_open`, `appeal_list`, `appeal_resolve` tasks
- **Agent directory:** `agent_directory` task + dashboard + SDK + CLI support

---

## Test & Validation Status
### Integration tests
- **Status:** Failing due to gateway connection errors (`createTestConnection` returning `ok: false`).
- **Most likely cause:** Port conflict with running docker gateway container.
- **Required action:** Stop the container or move integration test ports.

### Chaos tests
- **Status:** Implemented (`test-2-db-outage.test.ts`), not yet re-run since the last infra changes.

### Docker smoke test
- **Status:** Implemented (`scripts/docker-smoke.sh`), needs re-run after infra fixes.

---

---

## New/Updated Files (Important)
- `PRODUCTION_READINESS.md`
- `OPERATIONS.md`
- `RELEASE_CHECKLIST.md`
- `AGENTOS_CONTINUATION.md` (this file)
- `packages/kernel/migrations/003_social.sql`
- `packages/kernel/migrations/005_memory_scope.sql`
- `packages/kernel/migrations/006_governance_appeals.sql`
- `scripts/backup-postgres.sh`, `scripts/restore-postgres.sh`, `scripts/backup-qdrant.sh`
- `scripts/docker-smoke.sh`
- `scripts/load-test.mjs`
- `docker/bootstrap-agents.mjs`
- `docker-compose.yml`, `Dockerfile`, `.env.example`
- `apps/gateway/src/main.ts`, `apps/gateway/src/websocket.ts`, `apps/gateway/src/types.ts`
- `apps/gateway/tests/integration/test-11-policy-appeals.test.ts`
- `apps/gateway/tests/chaos/test-2-db-outage.test.ts`
- `apps/gateway/tests/integration/global-setup.ts`, `apps/gateway/tests/integration/global-teardown.ts`
- `apps/dashboard/index.html`, `apps/dashboard/src/main.js`
- `packages/mal/src/router.ts`
- `packages/framework/permissions/src/capabilities.ts`
- `packages/sdk/src/index.ts`

---

## Key Environment Variables (Production)
**Required in production**
- `GATEWAY_AUTH_TOKEN`
- `INTERNAL_AUTH_TOKEN`
- `PERMISSION_SECRET` (>= 16 chars)
- `ALLOWED_PATHS` or `ALLOW_ALL_PATHS=true`
- `ALLOWED_DOMAINS` or `ALLOW_ALL_DOMAINS=true`

**Optional but recommended**
- `MANIFEST_SIGNING_SECRET`
- `REQUIRE_MANIFEST_SIGNATURE=true`

**Operational controls**
- `GATEWAY_MAX_PAYLOAD_BYTES`, `GATEWAY_MAX_CONNECTIONS`, `GATEWAY_MESSAGE_RATE_LIMIT`
- `MAX_AGENT_TASK_TIMEOUT_MS`
- `REQUIRE_PERSISTENT_STORE`, `REQUIRE_VECTOR_STORE`
- `AUDIT_LOG_RETENTION_DAYS`, `EVENTS_RETENTION_DAYS`, `TASK_MESSAGES_RETENTION_DAYS`
- `EPISODIC_RETENTION_DAYS`, `SEMANTIC_RETENTION_DAYS`, `PROCEDURAL_RETENTION_DAYS`
- `EPISODIC_ARCHIVE_DAYS`, `SEMANTIC_ARCHIVE_DAYS`, `PROCEDURAL_ARCHIVE_DAYS`
- `MEMORY_ARCHIVE_RETENTION_DAYS`
- `MEMORY_ENCRYPTION_ENABLED`, `MEMORY_ENCRYPTION_KEY`
- `CHAT_STREAM_CHUNK_SIZE`
- `TRACING_ENABLED`, `TRACING_SAMPLE_RATE`, `TRACING_EXPORTER_URL`

---

## What is STILL PENDING (to be done)

### 0) Production Gaps (must address)
- OS-level isolation uses Docker workers by default in compose; **seccomp profile is enforced**, AppArmor remains optional.
- Disk I/O quotas + egress firewall enforcement are **configurable** (worker storage opts + internal network), but gateway egress is not firewalled.
- Multi-node scheduling/HA is **partial** (leader-only scheduler via DB lock; full cluster scheduling still pending).
- Memory privacy is **partial**: per-agent at-rest encryption exists, but embeddings + varchar fields remain plaintext.
- Dashboard now includes permission review, audit log query, and incident lockdown controls; advanced workflows still pending.
- Browser automation tool + hardened MCP bridges are implemented (Playwright-based snapshot + MCP allowlist).

### 1) Governance / Policy Engine (Layer 4-5)
- Basic policy + moderation + sanctions tables and tasks added
- ✅ Appeals and dispute resolution workflows — COMPLETED
- ✅ Policy DSL + rule evaluation engine — COMPLETED
- ✅ Sanction automation hooks (auto‑throttle, auto‑quarantine) — COMPLETED

### 2) Full Social Layer UX (Layer 5 Dashboard)
- ✅ Dashboard panels for forums/jobs/reputation + governance snapshots
- ✅ Moderation tooling UI (case creation + sanction apply)
- ✅ Appeals visibility/actions in dashboard governance panel
- ✅ Agent directory + reputation surfacing (expanded profiles)
- ✅ Basic directory filters (query + status)
- ✅ Governance list details (case reasons + appeal resolution)
- ✅ Directory pagination (limit + offset)

### 3) SDK / CLI Enhancements
- ✅ CLI `agent-os sign` (manifest signing) — COMPLETED
- ✅ CLI helpers for social/governance/audit tasks — COMPLETED
- ✅ SDK: convenience wrappers for social/governance/audit tasks — COMPLETED

### 4) Scheduler & Long-Running Agent Jobs
- ✅ Scheduler implemented in kernel — COMPLETED
  - Interval-based job scheduling with error handling
  - Auto-pause on consecutive failures
  - Job pause/resume/trigger operations
  - Event listeners for job execution
  - 31 new tests
- ✅ Monitor agent scheduled in gateway via `MONITOR_AGENT_INTERVAL_MS` — COMPLETED
- ✅ Background job runner in runtime layer (uses kernel scheduler; no overlap)

### 5) Security Hardening (Advanced)
- ✅ Manifest signature required by default in production
- ✅ Add replay protection for A2A (nonce / timestamp) — COMPLETED
  - Server: `ReplayProtectionConfig` in `A2AServerConfig`
  - Client: `A2AClientConfig.replayProtection` option
  - Tests: 11 new tests for replay protection
- ✅ Security utilities extracted with comprehensive tests — COMPLETED
  - `security-utils.ts`: path/domain allowlists, manifest signing, production validation
  - 55 tests covering all security utility functions
- ✅ Tool approval mechanism with trust levels — COMPLETED
  - `ensureApproval()` for supervised agents and tools with `requiresConfirmation`
  - `builtin:file_write` now requires confirmation (destructive operation)
  - 19 new tests documenting approval behavior
- Signed A2A tasks

### 6) Observability + Alerting
- ✅ DatabaseAuditSink for persistent audit logging — COMPLETED
  - Runtime audit events now persist to PostgreSQL `audit_log` table
  - Supports batching, auto-flush, and graceful shutdown
  - 14 new tests for database audit sink
- ✅ Agent lifecycle audit logging — COMPLETED
  - `agent.spawn` and `agent.terminate` events recorded to audit log
  - 26 total audit log call sites covering critical actions
- ✅ Metrics export includes token + cost totals and per-state counts
- ✅ Alerts emitted for rate-limit breaches, budget exceed, and error thresholds
- ✅ Tracing wired through gateway message handling (exporter optional)
- ✅ Dashboard metrics panel (real-time snapshot)

### 7) Data Governance
- ✅ Memory retention policies (episodic/semantic/procedural)
- ✅ Privacy scopes (public/private/shared memory)
- ✅ Backup/restore automation + docs

---

## Roadmap (phases, production focus)
### Phase 0 — Stabilize (P0)
- Fix integration test harness (port conflicts + gateway spawn correctness).
- Validate tests and smoke runs on a clean environment.
- Confirm docker compose boot target and default agent bootstrap.

### Phase 1 — Harden (P1)
- Add port/health prechecks in integration test setup to avoid silent failures.
- Make Qdrant healthcheck robust (install curl or use native HTTP check).
- Add CI-friendly test profile (no port collisions, uses random ephemeral ports).

### Phase 2 — Ops & SRE (P2)
- Add exportable operational dashboards (SLOs, p95 latency, error rates).
- Enhance alert routing (webhooks, Slack, email).
- Add backup/restore verification tests.

### Phase 3 — UX & Ecosystem (P3)
- Expand dashboard: agent memory explorer, permissions editor, live audit streams.
- SDK agent scaffolding command and templates (if not already in CLI).
- Marketplace-like “agent cards” registry (optional, still self-hostable).

---

## Execution Checklist (for handoff)
1) Stop `agent-os-gateway` container or change integration test ports.
2) Run `pnpm -C apps/gateway test:integration` and fix any remaining failures.
3) Run `pnpm -C apps/gateway test:chaos`.
4) Run `./scripts/docker-smoke.sh`.
5) Run `node scripts/load-test.mjs`.
6) Re-check `RELEASE_CHECKLIST.md` and update status.


### 8) Test Coverage
- ✅ Social + governance tasks now covered by integration tests
- ✅ Default agent manifests covered by integration tests
- ✅ Chaos tests added (connection churn + agent churn) with CI gate

---

## Roadmap (Phases)

### Phase 0: Production Readiness Spec ✅
- Done in `PRODUCTION_READINESS.md`

### Phase 1: Hardening ✅
- Permissions, isolation, watchdogs, circuit breakers

### Phase 2: Storage Reliability ✅
- Migrations, backup scripts, prod requirements

### Phase 3: Observability ✅
- Health/metrics + audit query task

### Phase 4: Default Agents ✅
- Research, Monitor, Coder

### Phase 5: Self-hosted Delivery ✅
- Docker compose, bootstrap

### Phase 6: Society Layer (partial) ⚠️
- DB schema + gateway tasks done
- Dashboard/UI + governance pending

### Phase 7: QA + Release (partial) ⚠️
- Release checklist added
- ✅ Load test script added (`scripts/load-test.mjs`)
- ✅ Chaos tests added (connection churn + agent churn + DB outage) with CI gate

---

## How to Resume (Commands)

**Install + build**
```bash
pnpm install
pnpm --filter @agent-os/sdk build
pnpm --filter @agent-os/mal build
pnpm --filter @agent-os/gateway build
```

**Docker boot**
```bash
cp .env.example .env
# add secrets + allowlists

docker compose up --build
```

---

## Recommended Next Steps (Highest Priority)

1) **QA + Release hardening**
   - Run load tests (WS fan‑out + agent task throughput)
   - Expand chaos tests to cover provider outages (optional; provider failover already covered in integration tests)

2) **Docs + Ops**
   - Review ops docs after next release cut

3) **UI polish**
   - Governance panel details (appeal evidence + outcomes)

---

## Known Risks / Notes
- If `MANIFEST_SIGNING_SECRET` is set, manifests must be signed (SDK helper exists: `signManifest`).
- In production, `ALLOW_ALL_PATHS` and `ALLOW_ALL_DOMAINS` should be false; allowlists required.
- Social layer tasks require Postgres; they error in in-memory mode.
- Qdrant is optional unless `REQUIRE_VECTOR_STORE=true`.

---

## Release Checklist
See `RELEASE_CHECKLIST.md` for production gate checklist.

---

## API / Task Examples (Gateway WebSocket)

All gateway messages are JSON over WebSocket:
```json
{ "type": "agent_task", "id": "msg-123", "payload": { ... } }
```

### Auth
```json
{ "type": "auth", "id": "auth-1", "payload": { "token": "GATEWAY_AUTH_TOKEN" } }
```

### Spawn Agent (signed manifest)
```json
{
  "type": "agent_spawn",
  "id": "spawn-1",
  "payload": {
    "manifest": {
      "id": "researcher",
      "name": "Research Agent",
      "version": "0.1.0",
      "preferredModel": "gpt-4o-mini",
      "entryPoint": "agents/researcher/dist/index.js",
      "permissions": ["memory.read","memory.write","tools.execute","network.fetch","llm.execute"],
      "trustLevel": "semi-autonomous",
      "signature": "<hex>"
    }
  }
}
```

### Agent Task (tool)
```json
{
  "type": "agent_task",
  "id": "task-1",
  "payload": {
    "agentId": "<agent-uuid>",
    "task": {
      "type": "invoke_tool",
      "toolId": "builtin:http_fetch",
      "arguments": { "url": "https://example.com" }
    }
  }
}
```

### Internal Task (agent worker -> gateway)
```json
{
  "type": "agent_task",
  "id": "task-2",
  "payload": {
    "agentId": "<agent-uuid>",
    "internal": true,
    "internalToken": "INTERNAL_AUTH_TOKEN",
    "task": { "type": "search_memory", "query": "vector databases" }
  }
}
```

### A2A Task (schema validated)
```json
{
  "type": "agent_task",
  "id": "task-3",
  "payload": {
    "agentId": "<caller-agent-id>",
    "task": {
      "type": "a2a_task",
      "targetAgentId": "<target-agent-id>",
      "task": { "type": "research_query", "question": "Summarize recent papers" }
    }
  }
}
```

### Forum / Jobs / Reputation
```json
{ "type": "agent_task", "id": "f1", "payload": { "agentId": "<id>", "task": { "type": "forum_create", "name": "agents-town", "description": "Town square" } } }
{ "type": "agent_task", "id": "f2", "payload": { "agentId": "<id>", "task": { "type": "forum_post", "forumId": "<forum-id>", "content": "Hello agents" } } }
{ "type": "agent_task", "id": "j1", "payload": { "agentId": "<id>", "task": { "type": "job_post", "title": "Code review", "budgetUsd": 5 } } }
{ "type": "agent_task", "id": "r1", "payload": { "agentId": "<id>", "task": { "type": "reputation_get", "agentId": "<id>" } } }
```

### Audit Log Query
```json
{
  "type": "agent_task",
  "id": "audit-1",
  "payload": {
    "agentId": "<admin-agent-id>",
    "task": { "type": "audit_query", "action": "tool.invoked", "limit": 50 }
  }
}
```

---

## SDK Example (Manifest Signing)
```ts
import { signManifest } from "@agent-os/sdk";

const manifest = { id: "agent-x", name: "Agent X", permissions: ["memory.read"] };
const signed = signManifest(manifest, process.env.MANIFEST_SIGNING_SECRET!);
```

---

## Sprint-by-Sprint Plan (Suggested)

### Sprint 1 — Governance Core
- Add policy schema + enforcement actions (warn, throttle, quarantine, ban)
- Add moderation tasks (policy_apply, policy_list, policy_case_open)
- DB migration for policy + moderation tables

### Sprint 2 — Social Layer UI + APIs
- Dashboard pages: forums, jobs, reputation
- Moderation UI (review queue)
- SDK helpers + CLI commands for social actions

### Sprint 3 — Scheduler + Background Jobs
- Runtime scheduler for recurring tasks (cron/interval)
- Monitor agent auto-check intervals
- Job runner health + retry/backoff

### Sprint 4 — Security Hardening
- Require manifest signatures in production by default
- A2A replay protection (nonce + timestamp)
- Signed A2A task envelopes

### Sprint 5 — Observability & Alerting
- Metrics: token/cost, rate limit hits, restart loops
- Alerts + incident playbook integration
- Dashboard real-time graphs

### Sprint 6 — Release & Stability
- Load tests + chaos tests
- Backup/restore drills
- Final release checklist run

---

## Summary
AgentOS is now **production-hardened at the OS level**, has default agents, docker bootstrap, and initial social primitives. The next major efforts are **governance**, **scheduler**, **UI for social layer**, and **robust test coverage**.

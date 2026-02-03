# AgentOS Production Readiness Spec

This document defines what “production ready” means for AgentOS, with explicit
SLOs, security posture, operational policies, and release gates. It follows the
5‑layer architecture and assumes self‑hosted deployments.

## Goals
- Provide a secure, reliable, self‑hosted OS for AI agents.
- Enforce permissions, isolation, and auditability by default.
- Ensure agents can persist, communicate, and operate safely at scale.
- Maintain upgrade safety and operational recoverability.

## Non‑Goals (for v1 production readiness)
- Multi‑region HA and geo‑replication (future).
- Fully managed SaaS operation (self‑hosted only).
- Cryptoeconomic incentives (non‑crypto internal credits only).

---

## 5‑Layer Production Requirements

### Layer 1 — Compute Kernel
**Responsibilities:** process management, storage, network, security, logging/metrics, config.

**Production requirements**
- Secure config loading and secrets management (no secrets in logs).
- Encryption at rest for Postgres and vector store (documented setup).
- TLS support for all external endpoints.
- Backup & restore procedures for Postgres and vector data.
- Audit log persistence with append‑only guarantees.
- Resource accounting: CPU, memory, disk, network usage.
- Production hardening gate available (`ENFORCE_PRODUCTION_HARDENING=true`).

### Layer 2 — Model Abstraction Layer (MAL)
**Responsibilities:** provider adapters, routing, failover, retries, token tracking.

**Production requirements**
- Provider failover strategies with bounded retry policies.
- Token and cost accounting with per‑agent budgets.
- Deterministic error handling (no uncaught exceptions).
- Provider health checks and circuit breakers.

### Layer 3 — Agent Runtime
**Responsibilities:** lifecycle, isolation, scheduler, state management.

**Production requirements**
- Per‑agent process isolation with crash containment.
- Watchdog + exponential backoff restart policy.
- Resource limits enforced at runtime.
- Deterministic lifecycle state transitions.
- Cluster mode supports leader-only scheduling (HA-lite).

### Layer 4 — Agent Framework
**Responsibilities:** identity, memory, skills, communication (A2A), permissions, tools.

**Production requirements**
- Signed manifests with deny‑by‑default permissions.
- Strict schema validation for A2A messages.
- Tool invocation approvals where required by trust level.
- Memory retention policy + vector store hardening.
- Event/audit trail for every security‑relevant action.

### Layer 5 — Agent Applications
**Responsibilities:** default agents + SDK.

**Production requirements**
- Default agents must operate within budgets and permissions.
- Safe handling of untrusted content (no auto‑tool execution).
- Functional tests and golden‑path demos for Research/Monitor/Coder.

---

## Service‑Level Objectives (SLOs)
> These are defaults for a single‑node self‑hosted deployment.

- **Gateway availability:** 99.5% monthly uptime
- **WebSocket task latency:** p95 < 1500 ms (non‑LLM tasks)
- **LLM routing overhead:** p95 < 250 ms (excluding provider latency)
- **Memory query latency:** p95 < 800 ms for top‑k <= 10
- **Agent restart recovery:** < 10s for single failure, < 60s for repeated failure
- **Audit log write latency:** p95 < 200 ms

---

## Threat Model (Baseline)

**Assets**
- Agent identity + manifests
- Memory (episodic/semantic/procedural)
- Tool credentials and secrets
- Audit logs and event history

**Trust boundaries**
- External clients → Gateway
- Agent workers → Gateway
- Gateway → Tooling/MCP servers
- Gateway → Datastores (Postgres, Qdrant, Redis)

**Threats**
- Unauthorized tool execution
- Permission escalation
- Data exfiltration via network/file tools
- Prompt injection via social content
- Replay/forged A2A tasks
- Rogue agent behavior or runaway costs

**Required mitigations**
- Strict auth + token rotation
- Manifest signing + permission validation
- Tool allowlists + domain/path restrictions
- Input validation on every boundary
- Audit logging of all security‑relevant actions
- Budget caps and rate limits

---

## Data Retention & Privacy
- **Audit logs:** retained for 365 days by default (configurable)
- **Memory:** retained with configurable TTLs (episodic/semantic/procedural defaults set in `.env.example`)
- **Memory archival:** optional archive tables for cold storage (`memory_archives`) with separate retention
- **PII handling:** opt‑in, with redaction hooks for logs
- **Memory encryption:** optional at-rest encryption with per-agent derived keys (`MEMORY_ENCRYPTION_ENABLED`)
- **Backups:** daily full backup + 7‑day rolling snapshots
- **Restore drill:** quarterly minimum

Retention controls are configured via `*_RETENTION_DAYS` environment variables in `.env.example`.

---

## Upgrade & Compatibility Policy
- Semantic versioning for all packages.
- Database migrations must be forward‑compatible with rollback guidance.
- No breaking changes to agent manifests within a minor release.
- Release notes must include upgrade steps and known risks.

---

## Release Gates (must pass)
- Security: permission enforcement + audit coverage tests pass
- Reliability: crash recovery and watchdog tests pass
- Reliability: chaos tests (connection churn + agent churn) pass
- Data safety: backup/restore validated
- Observability: metrics + logs + audit dashboards functional
- Default agents: smoke tests pass

---

## Compliance Targets (Self‑Hosted)
- SOC‑2‑style controls for access/logging (documented, not certified)
- OWASP Top 10 coverage for gateway endpoints
- Dependency scanning and SBOM export

---

## Operational Playbooks (required)
- Incident response and rollback
- Credential rotation
- Disaster recovery
- Performance tuning guide

---

## Production Readiness Checklist (Summary)
- [x] Signed manifests + permission validation (CLI `agent-os sign` command)
- [x] OS-level isolation defaults (seccomp enforced; AppArmor enforceable via prod overlay)
- [x] Disk I/O quotas and network egress enforcement (storage limits + internal worker network + optional egress proxy)
- [x] Process isolation + resource caps (Docker worker optional; CPU/memory/pids caps supported)
- [x] A2A schema validation + replay protection (server + client support)
- [x] Tool approvals + allowlists (path/domain allowlists, trust-level approval, tool confirmation flags)
- [x] Audit logging for all critical actions (agent lifecycle, permissions, tools, memory, A2A, social)
- [x] Backup/restore + migration safety
- [x] Metrics + tracing + alerting
- [x] Streaming responses surfaced end-to-end (gateway + CLI; simulated when provider lacks streaming)
- [ ] Memory lifecycle policies with archival + privacy (archival + encryption done; tiering pending)
- [x] Dashboard operational workflows (permission review, audit trails, incident handling)
- [x] CI gate for build + tests + docker smoke on every commit
- [x] Default agents with guardrails + tests
- [x] Docker compose boot under 5 minutes (verified via `scripts/docker-smoke.sh`)

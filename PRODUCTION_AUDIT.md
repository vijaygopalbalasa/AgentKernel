# AgentOS Production Audit (2026-02-03)

This audit covers the full 5-layer architecture. It lists **verified gaps** (not aspirational) and the **exact fixes** required. Test mocks remain in tests only.

## Summary
- **P0 blockers (fixed)**: Docker build reliability, enforced isolation defaults in production, cluster task routing, memory privacy for embeddings.
- **P1 blockers (partial)**: multi-node HA beyond job locks, secrets management (vault), TLS termination model.
- **P2 readiness (in progress)**: dashboard workflows, onboarding, SDK docs consistency.

---

## Layer 1 — Compute Kernel

### Findings
1) **Docker build reliability**: `docker-smoke.sh` fails on some hosts due to `chown -R /app` in `Dockerfile` (BuildKit I/O errors).
   - Evidence: `Dockerfile` stage `production` last step.
2) **Production hardening default is opt-in** via `ENFORCE_PRODUCTION_HARDENING`; it should default to enforced in production.
   - Evidence: `apps/gateway/src/main.ts` `validateProductionHardening` uses env default `false`.
3) **TLS not provided by gateway** (intended to be behind reverse proxy). This is documented but not enforced.

### Exact fixes
- Modify `Dockerfile` to avoid full-tree `chown`, create only writable dirs and set ownership there.
- Default `ENFORCE_PRODUCTION_HARDENING` to `true` when `NODE_ENV=production`.
- Document TLS termination requirement explicitly in `OPERATIONS.md` (reverse proxy), and add a `CADDYFILE`/`nginx` example.

---

## Layer 2 — Model Abstraction Layer (MAL)

### Findings
1) **Provider health status in `/health`** is derived from router state only (ok), but degraded states currently map to 503 (fixed in health server).

### Exact fixes
- Ensure `/health` returns 200 for `ok|degraded` and 503 only for `error`.

---

## Layer 3 — Agent Runtime

### Findings
1) **Cluster mode is leader-only scheduler** and distributed job locks exist, but **agent task routing is single-node** (no cross-node task forwarding).
2) **Agent registry is in-memory only**; DB is used for persistence but not for routing.

### Exact fixes
- Add `gateway_nodes` registry table + `agents.node_id` column.
- Register each gateway node (heartbeat) and persist node assignments on agent spawn.
- Forward `agent_task` and `agent_status` to the owning node when `CLUSTER_MODE=true`.

---

## Layer 4 — Agent Framework

### Findings
1) **Memory encryption does not cover embeddings** stored in Qdrant. Text search is disabled, but embeddings remain plaintext.
2) **Vector search remains enabled when encryption is on**, which undermines the privacy story.

### Exact fixes
- Disable vector search automatically when `MEMORY_ENCRYPTION_ENABLED=true`.
- Skip embedding upserts/reads when encryption is enabled.
- Add explicit docs warning + optional purge command for existing embeddings.

---

## Layer 5 — Agent Apps + UX

### Findings
1) **Dashboard workflows are basic** (permission review, incident handling, audit filters are minimal) and lack guided onboarding.

### Exact fixes
- Add a simple onboarding flow (copyable install steps + first-agent creation checklist).
- Add incident controls: a global “lockdown” toggle with audit logs.
- Add permission review actions (capability grant/revoke + visibility) beyond “Quarantine”.

---

## Execution Plan (Phased)

### Phase P0 (Must pass before public use)
- Fix Dockerfile ownership step to avoid BuildKit I/O failure.
- Enforce production hardening defaults.
- Add cluster routing support for multi-node tasks.
- Harden memory privacy for embeddings.

### Phase P1 (Security & Reliability)
- Add vault integration or documented secret-mount interface.
- Add TLS proxy example + environment enforcement.

### Phase P2 (Product readiness)
- Dashboard onboarding + permission workflow + incident response improvements.

---

## Status
- Audit complete.
- P0 fixes implemented (see git changes).
- P1/P2 items in progress.

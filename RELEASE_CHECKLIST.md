# AgentOS Release Checklist

## Security
- [ ] PERMISSION_SECRET set and rotated for release
- [ ] GATEWAY_AUTH_TOKEN + INTERNAL_AUTH_TOKEN set
- [ ] Manifest signing enabled in production
- [ ] Allowlist configured (paths/domains)

## Reliability
- [ ] Database migrations applied cleanly
- [ ] Backup + restore tested (Postgres + Qdrant)
- [ ] Crash recovery / watchdog verified
- [ ] Chaos tests pass (connection churn, agent churn)
- [ ] Load test run (`scripts/load-test.mjs`) and results recorded

## Observability
- [ ] Audit log coverage validated
- [ ] Metrics endpoint /health, /ready, /live reachable
- [ ] Error budgets reviewed

## Default Agents
- [ ] Research, Monitor, Coder smoke tests pass
- [ ] Budgets and rate limits enforced

## Self-hosted UX
- [ ] docker compose up works in <5 minutes
- [ ] Dashboard loads and shows agents
- [ ] Docs updated with config changes

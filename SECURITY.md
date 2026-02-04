# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in AgentRun, please report it responsibly.

**DO NOT** open a public GitHub issue for security vulnerabilities.

Instead, open a [private security advisory](https://github.com/vijaygopalbalasa/AgentRun/security/advisories/new) on GitHub with:
- Description of the vulnerability
- Steps to reproduce
- Impact assessment
- Suggested fix (if any)

We will acknowledge receipt within 48 hours and provide a timeline for a fix.

## Security Architecture

### Threat Model

AgentRun runs AI agents that execute code, make API calls, and interact with external systems. The primary threats are:

1. **Prompt injection** — Malicious inputs causing agents to perform unintended actions
2. **Agent escape** — An agent breaking out of its sandbox to access host resources
3. **Credential theft** — Agent accessing secrets it shouldn't have
4. **Resource exhaustion** — An agent consuming excessive compute, memory, or API tokens
5. **Agent-to-agent attacks** — A compromised agent attacking other agents

### Defenses

#### Sandboxing (Layer 3: Runtime)
- Each agent runs in an isolated process (Docker container in production)
- Filesystem access restricted to configured `ALLOWED_PATHS`
- Network access filtered through egress proxy with domain allowlists
- Resource limits enforced: CPU, memory, token budgets, process count

#### Capability-Based Permissions (Layer 4: Framework)
- Agents receive unforgeable HMAC-signed capability tokens
- Tokens are scoped to specific resources with expiration
- Principle of least privilege: agents start with minimal permissions
- Human approval required for high-risk actions (shell execution, file writes)

#### Input Validation
- All external inputs validated with Zod schemas at system boundaries
- Path traversal protection with symlink resolution (`realpath`)
- Shell command allowlisting
- Environment variable isolation for spawned processes

#### Authentication & Authorization
- WebSocket connections require token-based authentication
- Auth rate limiting (5 failures per 60 seconds per client)
- Production mode enforces strong secrets (32+ character minimum)
- Internal service-to-service authentication

#### Audit & Monitoring
- All agent actions logged to audit trail
- Rate limiting on API endpoints
- Circuit breakers on external service calls
- Health monitoring with Prometheus metrics

### Production Hardening Checklist

Before deploying to production:

- [ ] Set `GATEWAY_AUTH_TOKEN` to a random 32+ character string
- [ ] Set `PERMISSION_SECRET` to a random 32+ character string
- [ ] Set `INTERNAL_AUTH_TOKEN` to a random 32+ character string
- [ ] Set `ENFORCE_PRODUCTION_HARDENING=true`
- [ ] Set `AGENT_WORKER_RUNTIME=docker` (not `local`)
- [ ] Configure `ALLOWED_PATHS` to minimum required directories
- [ ] Configure `ALLOWED_DOMAINS` for network egress
- [ ] Set `ALLOW_ALL_PATHS=false`
- [ ] Set `ALLOW_ALL_DOMAINS=false`
- [ ] Enable egress proxy (`ENFORCE_EGRESS_PROXY=true`)
- [ ] Set database passwords to strong random values
- [ ] Enable TLS for all external connections
- [ ] Review and minimize agent permissions

### Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |

### Security Standards

AgentRun follows:
- OWASP Top 10 for LLM Applications (2025)
- OWASP API Security Top 10
- CIS Docker Benchmark
- Principle of least privilege throughout

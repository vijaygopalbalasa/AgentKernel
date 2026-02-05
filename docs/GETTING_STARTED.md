# Getting Started with AgentKernel

AgentKernel protects your AI agents from doing dangerous things — stealing credentials, exfiltrating data, running malware. This guide gets you from zero to protected in under 5 minutes.

## Prerequisites

- Node.js 20+
- npm or pnpm

## Step 1: Install

```bash
npm install -g @agentkernel/agent-kernel
```

Verify installation:

```bash
agentkernel --version
# agentkernel v0.1.6
```

## Step 2: Initialize a Security Policy

```bash
agentkernel init
```

This launches an interactive wizard that asks:
1. **Protection level** — strict, balanced (recommended), or permissive
2. **Project folder** — auto-detected from your current directory
3. **Dev tools** — whether to allow npm, GitHub, PyPI network access

The wizard creates `~/.agentkernel/policy.yaml` with your choices.

You can also skip the wizard:

```bash
agentkernel init --template balanced
```

## Step 3: Start the Security Proxy

```bash
agentkernel start
```

AgentKernel starts in **standalone mode** — no external gateway needed. It runs an HTTP API and WebSocket server on port 18788.

```
AgentKernel is running in STANDALONE mode!

HTTP API:
  curl http://localhost:18788/health
  curl -X POST http://localhost:18788/evaluate \
    -d '{"tool":"bash","args":{"command":"cat ~/.ssh/id_rsa"}}'

WebSocket: ws://localhost:18788
```

## Step 4: Test It

Open a new terminal and try these:

```bash
# Health check
curl http://localhost:18788/health
# → {"status":"ok","mode":"evaluate","uptime":5}

# Try to steal SSH keys — BLOCKED
curl -X POST http://localhost:18788/evaluate \
  -H "Content-Type: application/json" \
  -d '{"tool":"bash","args":{"command":"cat ~/.ssh/id_rsa"}}'
# → {"decision":"block","reason":"Shell command \"cat\" accesses blocked file..."}

# Safe operation — ALLOWED
curl -X POST http://localhost:18788/evaluate \
  -H "Content-Type: application/json" \
  -d '{"tool":"bash","args":{"command":"git status"}}'
# → {"decision":"allow"}

# View live stats
curl http://localhost:18788/stats
```

## Managing Your Policy

You don't need to edit YAML files. Use the CLI:

```bash
# Block a known threat
agentkernel block "telegram"

# Allow a trusted resource
agentkernel allow "github"

# Target specific types
agentkernel allow --domain api.myapp.com
agentkernel allow --file ~/my-project
agentkernel block --command "rm -rf*"

# Remove a block
agentkernel unblock "telegram"

# See everything in plain English
agentkernel policy show

# Dry-run test
agentkernel policy test --domain api.telegram.org
# → BLOCKED - Data exfiltration channel

agentkernel policy test --file ~/.ssh/id_rsa
# → BLOCKED - SSH credentials
```

## Viewing Audit Logs

Every operation gets logged. View them with:

```bash
# All recent entries
agentkernel audit

# Only blocked operations
agentkernel audit --blocked-only

# Last hour
agentkernel audit --since 1h

# Filter by tool
agentkernel audit --tool bash --limit 50
```

## Proxy Mode (for OpenClaw/Gateway)

If you have an OpenClaw gateway or similar, AgentKernel can intercept traffic:

```bash
agentkernel start --gateway ws://my-gateway:18789
```

In proxy mode, AgentKernel sits between your agent and the gateway, evaluating every tool call before forwarding it.

## Using with LangChain

Install the adapter:

```bash
npm install @agentkernel/langchain-adapter
```

Wrap any LangChain tool with policy enforcement:

```typescript
import { wrapToolWithPolicy } from '@agentkernel/langchain-adapter';
import { PolicyEngine } from '@agentkernel/runtime';

const engine = new PolicyEngine(myPolicy);
const safeTool = wrapToolWithPolicy(myTool, engine, { agentId: 'my-agent' });

// Use safeTool like any LangChain tool — dangerous operations auto-blocked
```

## Using the HTTP API Programmatically

Send tool calls directly via HTTP:

```bash
# Simple format
curl -X POST http://localhost:18788/evaluate \
  -H "Content-Type: application/json" \
  -d '{"tool":"read","args":{"path":"/etc/passwd"}}'

# MCP/JSON-RPC format
curl -X POST http://localhost:18788/evaluate \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":"1","method":"tools/call","params":{"name":"bash","arguments":{"command":"git status"}}}'
```

The HTTP API accepts three message formats:
- **Simple** — `{"tool":"...", "args":{...}}`
- **MCP/JSON-RPC** — `{"jsonrpc":"2.0", "method":"tools/call", ...}`
- **OpenClaw** — `{"type":"tool_invoke", "data":{"tool":"...", "args":{...}}}`

## Using Capability Tokens

For fine-grained, time-bounded permissions:

```typescript
import { createCapabilityManager } from '@agentkernel/permissions';

const manager = createCapabilityManager({
  secret: process.env.PERMISSION_SECRET  // 32+ char secret
});

// Grant: read /workspace/** for 1 hour
const token = manager.grant({
  agentId: 'my-agent',
  permissions: [{
    category: 'filesystem',
    actions: ['read'],
    resource: '/workspace/**'
  }],
  purpose: 'Read project files',
  durationMs: 3600000,
});

// Check before any operation
const check = manager.check('my-agent', 'filesystem', 'read', '/workspace/src/app.ts');
// check.allowed === true
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AGENTKERNEL_HOST` | Bind address | `0.0.0.0` |
| `AGENTKERNEL_PORT` | Listen port | `18788` |
| `AGENTKERNEL_GATEWAY_URL` | Gateway URL (enables proxy mode) | — |
| `AGENTKERNEL_POLICY_FILE` | Custom policy file path | `~/.agentkernel/policy.yaml` |
| `AGENTKERNEL_PRODUCTION_HARDENING` | Enforce production security checks | `false` |
| `PERMISSION_SECRET` | HMAC signing secret (32+ chars) | — |

## What's Blocked by Default?

Even before you configure anything, AgentKernel blocks 341+ known malicious patterns:

- **AMOS Stealer** — crypto wallets, browser credentials
- **Reverse shells** — `bash -i`, `nc -e`, `python pty.spawn`
- **Data exfiltration** — Telegram bots, Discord webhooks, paste sites
- **SSRF** — cloud metadata (169.254.169.254), internal networks
- **Download & execute** — `curl|bash`, `wget|sh`
- **Credential files** — `~/.ssh/*`, `~/.aws/*`, browser password stores

## Next Steps

- [Architecture Guide](./ARCHITECTURE.md) — How AgentKernel works under the hood
- [Examples](./EXAMPLES.md) — Real-world integration patterns
- [GitHub](https://github.com/vijaygopalbalasa/AgentKernel) — Source code, issues, contributions

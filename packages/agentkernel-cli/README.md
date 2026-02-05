# agentkernel

Security runtime for AI agents — protect against malicious tools, data theft, and prompt injection. Works with OpenClaw, LangChain, and any agent framework.

## Installation

```bash
npm install -g @agentkernel/agent-kernel
```

## Quick Start

```bash
# Initialize a security policy (interactive wizard)
agentkernel init

# Start the security proxy (standalone mode — no gateway needed)
agentkernel start

# Test it
curl http://localhost:18788/health
curl -X POST http://localhost:18788/evaluate \
  -H "Content-Type: application/json" \
  -d '{"tool":"read","args":{"path":"/home/user/.ssh/id_rsa"}}'
```

## CLI Commands

```bash
agentkernel init                          # Interactive policy setup wizard
agentkernel init --template balanced      # Non-interactive init
agentkernel start                         # Start in standalone mode (HTTP + WebSocket)
agentkernel start --gateway ws://gw:18789 # Start in proxy mode (intercept gateway traffic)
agentkernel allow "github"                # Allow by known name
agentkernel allow --domain api.example.com  # Allow a domain
agentkernel allow --file ~/my-project     # Allow a file path
agentkernel block "telegram"              # Block by known name
agentkernel block --command "rm -rf*"     # Block a command
agentkernel unblock "telegram"            # Remove block rules
agentkernel policy show                   # Human-readable policy view
agentkernel policy test --domain api.telegram.org  # Dry-run test
agentkernel status                        # Check health (connects to running proxy)
agentkernel audit                         # Query audit logs
```

## Two Modes

### Standalone Mode (default)
No gateway needed. Evaluates tool calls via HTTP API and WebSocket:

```bash
agentkernel start
# Listening on http://0.0.0.0:18788 (standalone evaluate mode)
```

### Proxy Mode
Intercepts traffic between your agent and a gateway:

```bash
agentkernel start --gateway ws://my-gateway:18789
```

## HTTP API

When running in either mode, the following HTTP endpoints are available:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check with uptime and mode |
| `/evaluate` | POST | Evaluate a tool call against policies |
| `/stats` | GET | Live proxy statistics |
| `/audit` | GET | Recent audit log entries |

### POST /evaluate

Accepts tool calls in three formats:

```bash
# Simple format
curl -X POST http://localhost:18788/evaluate \
  -H "Content-Type: application/json" \
  -d '{"tool":"read","args":{"path":"/home/user/.ssh/id_rsa"}}'

# MCP/JSON-RPC format
curl -X POST http://localhost:18788/evaluate \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":"1","method":"tools/call","params":{"name":"bash","arguments":{"command":"git status"}}}'
```

### WebSocket

Connect to `ws://localhost:18788` and send tool calls in OpenClaw, MCP/JSON-RPC, or Simple format.

## Programmatic Usage

```typescript
import { createToolInterceptor, createOpenClawProxy } from '@agentkernel/agent-kernel';
import { normalizeMessage, formatResponse } from '@agentkernel/agent-kernel';

// Create a standalone security proxy
const proxy = await createOpenClawProxy({
  listenPort: 18788,
  policySet: myPolicy,
});

// Intercept tool calls with security policies
const interceptor = createToolInterceptor({
  agentId: 'my-agent',
  policySet: myPolicy,
  onBlocked: (call) => console.log('Blocked:', call.tool),
});

const result = await interceptor.intercept({ tool: 'read', args: { path: '/etc/passwd' } });
// result.allowed === false
```

## Policy Management

```typescript
import {
  resolveTarget,
  addAllowRule,
  addBlockRule,
  generatePolicyFromTemplate,
  summarizePolicy,
  testPolicy,
} from '@agentkernel/agent-kernel';

// Resolve natural language to policy patterns
const target = resolveTarget("telegram");
// { type: "domain", patterns: ["api.telegram.org", "*.telegram.org"], knownMalicious: true }

// Generate a policy from template
const yaml = generatePolicyFromTemplate({ template: "balanced", projectFolder: "~/my-project" });

// Test what the policy would do
const result = await testPolicy("~/.agentkernel/policy.yaml", { domain: "api.telegram.org" });
// { decision: "block", reason: "Data exfiltration channel" }
```

## Default Security Policy

Out of the box, AgentKernel blocks 341+ known malicious patterns including:

- **AMOS Stealer** — crypto wallets, browser credentials
- **Reverse shells** — bash -i, nc -e, python pty.spawn
- **Data exfiltration** — Telegram bots, Discord webhooks, paste sites
- **SSRF** — cloud metadata endpoints, internal networks
- **Download & execute** — curl|bash, wget|sh

See the [main repo](https://github.com/vijaygopalbalasa/AgentKernel) for full documentation.

## License

MIT

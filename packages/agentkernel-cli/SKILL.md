# AgentKernel Security

Protect your OpenClaw agents from malicious skills and data theft. **AgentKernel is a security proxy** — it sits between your OpenClaw client and the gateway, intercepting all tool calls and enforcing security policies before execution.

> **Important**: AgentKernel is NOT an agent — it's a transparent security proxy. You don't "make it an agent" — you point OpenClaw to the proxy.

## Why You Need This

- **341+ malicious skills discovered on ClawHub** stealing crypto wallets, API keys, and credentials
- **AMOS Stealer** variants targeting macOS users through disguised skills
- **Reverse shell attacks** that give attackers remote access to your machine
- **Prompt injection** attacks that hijack your agent's behavior

## Architecture

```
OpenClaw Client ──→ AgentKernel Proxy ──→ OpenClaw Gateway
                          │
                    ┌─────┴─────┐
                    │ Security  │
                    │  Engine   │
                    ├───────────┤
                    │ Policy    │
                    │ Engine    │
                    ├───────────┤
                    │ Rate      │
                    │ Limiter   │
                    ├───────────┤
                    │ Audit     │
                    │ Logger    │
                    └───────────┘
```

AgentKernel intercepts ALL tool calls, validates them against security policies, and only forwards allowed calls to the gateway.

## Quick Start

```bash
# Install globally
npm install -g @agentkernel/agent-kernel

# Start the security proxy
agentkernel start
```

Then configure OpenClaw to route through the proxy. Edit `~/.openclaw/openclaw.json` (JSON5 format):

```json5
{
  // Route all traffic through AgentKernel security proxy
  "gateway": {
    "remote": {
      "url": "ws://localhost:18788",  // AgentKernel proxy port
      "token": "your-gateway-token"   // Optional: if your gateway requires auth
    }
  }
}
```

**Alternative**: If you're running OpenClaw gateway locally:

```json5
{
  "gateway": {
    "port": 18789  // OpenClaw listens on 18789
  }
}
```

Then start AgentKernel to proxy port 18788 → 18789:

```bash
agentkernel start --port 18788 --gateway ws://localhost:18789
```

## Security Policies

AgentKernel ships with a **deny-by-default** policy that:

### Blocks by Default
- All file access except `/tmp`, `~/workspace`, and current directory
- All network access except whitelisted APIs (npm, GitHub, PyPI, etc.)
- All shell commands except common safe tools (git, npm, node, etc.)
- All secret/env var access except safe variables (PATH, HOME, etc.)

### Credential Theft Patterns Blocked
- Reading `~/.ssh/`, `~/.aws/`, `~/.config/gcloud/`
- Accessing browser credential stores (Chrome, Firefox, Safari)
- Exfiltrating `.env` files and API tokens
- Keychain/credential manager access

### Network Attacks Blocked
- Connections to Telegram bot APIs (common exfil channel)
- Discord webhook abuse
- Pastebin/hastebin data exfiltration
- Internal network SSRF (169.254.x.x, 10.x.x.x, 192.168.x.x)
- Cloud metadata endpoints (AWS, GCP, Azure)

### Malware Patterns Blocked
- `curl | bash` and similar download-and-execute
- Reverse shell commands (nc, bash -i, python pty)
- Process injection and memory manipulation
- Base64-obfuscated command execution

### Sensitive Commands Blocked
- `rm -rf`, `git push --force`, `sudo`, `npm publish`
- These require explicit policy override to enable

## Custom Policies

Create `~/.agentkernel/policy.yaml` to customize:

```yaml
# Override default deny-by-default behavior for specific patterns
name: my-custom-policy
description: Custom policy for my project
defaultDecision: block  # Keep deny-by-default

fileRules:
  - id: allow-my-project
    type: file
    decision: allow
    priority: 100
    enabled: true
    pathPatterns:
      - "~/my-project/**"
    operations: [read, write, list]

shellRules:
  - id: allow-docker
    type: shell
    decision: allow
    priority: 100
    enabled: true
    commandPatterns:
      - "docker*"

networkRules:
  - id: allow-my-api
    type: network
    decision: allow
    priority: 100
    enabled: true
    hostPatterns:
      - "api.mycompany.com"
```

## Audit Log

View what your agents have been doing:

```bash
agentkernel audit --since 1h
agentkernel audit --blocked-only
agentkernel audit --tool bash
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENTKERNEL_PORT` | `18788` | Proxy listen port |
| `AGENTKERNEL_GATEWAY_URL` | `ws://127.0.0.1:18789` | OpenClaw gateway URL |
| `AGENTKERNEL_POLICY_FILE` | - | Custom policy file path |
| `AGENTKERNEL_AGENT_ID` | `openclaw-agent` | Agent ID for audit logs |
| `ENFORCE_PRODUCTION_HARDENING` | `false` | Enable strict production checks |
| `AGENTKERNEL_SKIP_SSRF_VALIDATION` | `false` | Disable SSRF checks (localhost only) |

## Works With

- **OpenClaw** — The personal AI assistant (point gateway.remote.url to proxy)
- **Moltbook** — Social network for AI agents
- **Any MCP-compatible agent** — AgentKernel proxies the WebSocket connection

## Requirements

- Node.js 20+
- OpenClaw or any WebSocket-based agent gateway

## Support

- GitHub: https://github.com/vijaygopalbalasa/AgentKernel
- Issues: https://github.com/vijaygopalbalasa/AgentKernel/issues

## License

MIT

# AgentKernel Security

Protect your OpenClaw agents from malicious skills and data theft. AgentKernel intercepts all tool calls and enforces security policies before execution.

## Why You Need This

- **341+ malicious skills discovered on ClawHub** stealing crypto wallets, API keys, and credentials
- **AMOS Stealer** variants targeting macOS users through disguised skills
- **Reverse shell attacks** that give attackers remote access to your machine
- **Prompt injection** attacks that hijack your agent's behavior

## Features

- **Tool Call Interception**: Every bash, file, and network operation is validated before execution
- **SSRF Protection**: Blocks access to internal networks and cloud metadata endpoints
- **Rate Limiting**: Prevents runaway agents from consuming excessive resources
- **Credential Protection**: Blocks exfiltration of API keys, tokens, and secrets
- **Audit Logging**: Complete history of all agent actions for review
- **Human-in-the-Loop**: Require approval for sensitive operations

## Quick Start

```bash
# Install globally
npm install -g agentkernel

# Start the security proxy
agentkernel start
```

Then configure OpenClaw to use the proxy:

```yaml
# ~/.agentkernel/config.yaml
gateway:
  url: ws://localhost:18788  # AgentKernel proxy port
```

## Security Policies

AgentKernel ships with a default policy that blocks:

### Credential Theft Patterns
- Reading `~/.ssh/`, `~/.aws/`, `~/.config/gcloud/`
- Accessing browser credential stores (Chrome, Firefox, Safari)
- Exfiltrating `.env` files and API tokens
- Keychain/credential manager access

### Network Attacks
- Connections to Telegram bot APIs (common exfil channel)
- Discord webhook abuse
- Pastebin/hastebin data exfiltration
- Internal network SSRF (169.254.x.x, 10.x.x.x, etc.)

### Malware Patterns
- `curl | bash` and similar download-and-execute
- Reverse shell commands (nc, bash -i, python pty)
- Process injection and memory manipulation
- Base64-obfuscated command execution

### Crypto Wallet Protection
- Blocks access to wallet directories (Metamask, Phantom, Exodus)
- Prevents reading browser extension storage
- Monitors for known stealer signatures

## Custom Policies

Create `~/.agentkernel/security-policy.yaml`:

```yaml
file:
  allow:
    - "~/workspace/**"
    - "/tmp/**"
  block:
    - "~/.ssh/**"
    - "~/.aws/**"
    - "**/.env"
    - "**/credentials*"

shell:
  allow:
    - git
    - npm
    - pnpm
    - node
  block:
    - curl|bash
    - wget|sh
    - nc -e
    - bash -i

network:
  block:
    - "api.telegram.org"
    - "discord.com/api/webhooks"
    - "*.ngrok.io"
    - "169.254.169.254"  # Cloud metadata
```

## Human Approval

For sensitive operations, AgentKernel can prompt for approval:

```yaml
approvalRequired:
  - pattern: "rm -rf"
    reason: "Destructive file operation"
  - pattern: "git push --force"
    reason: "Force push to repository"
  - pattern: "npm publish"
    reason: "Publishing package"
```

## Audit Log

View what your agents have been doing:

```bash
agentkernel audit --since 1h
agentkernel audit --blocked-only
agentkernel audit --tool bash
```

## Integration with OpenClaw

AgentKernel acts as a transparent proxy between OpenClaw and its tools:

```
OpenClaw Client → AgentKernel Proxy → OpenClaw Gateway
                        ↓
                  Policy Engine
                  Audit Logger
                  Rate Limiter
```

All tool calls pass through AgentKernel for validation before reaching the actual tools.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENTKERNEL_PORT` | `18788` | Proxy listen port |
| `AGENTKERNEL_GATEWAY_URL` | `ws://127.0.0.1:18789` | OpenClaw gateway |
| `AGENTKERNEL_POLICY_FILE` | - | Custom policy file path |
| `AGENTKERNEL_AGENT_ID` | `openclaw-agent` | Agent ID for audit logs |

## Requirements

- Node.js 20+
- OpenClaw installed and configured

## Support

- GitHub: https://github.com/vijaygopalbalasa/AgentKernel
- Issues: https://github.com/vijaygopalbalasa/AgentKernel/issues

## License

MIT

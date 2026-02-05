# agentkernel

Security runtime for AI agents — protect against malicious tools, data theft, and prompt injection. Works with OpenClaw, LangChain, and any agent framework.

## Installation

```bash
npm install -g agentkernel
```

## CLI Commands

```bash
agentkernel init                          # Interactive policy setup wizard
agentkernel init --template balanced      # Non-interactive init
agentkernel start                         # Start the security proxy
agentkernel allow "github"                # Allow by known name
agentkernel allow --domain api.example.com  # Allow a domain
agentkernel allow --file ~/my-project     # Allow a file path
agentkernel block "telegram"              # Block by known name
agentkernel block --command "rm -rf*"     # Block a command
agentkernel unblock "telegram"            # Remove block rules
agentkernel policy show                   # Human-readable policy view
agentkernel policy test --domain api.telegram.org  # Dry-run test
agentkernel status                        # Check health
agentkernel audit                         # Query audit logs
```

## Programmatic Usage

```typescript
import { createToolInterceptor, createOpenClawProxy } from 'agentkernel';

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
} from 'agentkernel';

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

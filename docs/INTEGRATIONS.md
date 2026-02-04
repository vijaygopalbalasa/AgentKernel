# Integrations

AgentRun is the infrastructure layer. External agent systems connect via adapters, the A2A protocol, or MCP.

---

## OpenClaw — Built-in Adapter

AgentRun includes a first-class OpenClaw adapter that wraps OpenClaw agents in a sandboxed runtime.

### Quick start

```bash
agentrun run ./openclaw-config.yaml --adapter openclaw
```

### What the adapter does

1. **Parses** OpenClaw config files (YAML or JSON)
2. **Maps skills to capabilities** — e.g., `file-system` → `file:read` + `file:write`, `shell-exec` → `shell:execute`, `web-browse` → `network:http`
3. **Enforces sandbox permissions** — every skill invocation checks the capability sandbox before executing
4. **Preserves personality** — OpenClaw's `personality` or `system_prompt` field is forwarded to the LLM
5. **Validates tool calls** — path-based tools check allowed paths, network tools check allowed hosts

### Skill-to-capability mapping

| OpenClaw Skill | AgentRun Capabilities |
|---------------|----------------------|
| `file-system` | `file:read`, `file:write` |
| `file-read` | `file:read` |
| `shell-exec` | `shell:execute` |
| `web-browse` | `network:http` |
| `web-search` | `network:http` |
| `memory` | `memory:read`, `memory:write` |
| `mcp` | `tool:mcp` |
| `agent-delegate` | `agent:communicate` |

All OpenClaw agents also get `llm:chat` and `llm:stream` capabilities automatically.

### Security policies

```bash
# Strict mode (default) — agent supervised, dangerous capabilities require explicit grant
agentrun run config.yaml --adapter openclaw --policy strict

# Permissive mode — all required capabilities auto-granted
agentrun run config.yaml --adapter openclaw --policy permissive
```

### Example OpenClaw config

```yaml
name: my-assistant
personality: You are a helpful coding assistant.
model: claude-sonnet-4-20250514
skills:
  - file-system
  - web-browse
  - memory
```

---

## Adapter Pattern — Run Any Framework

AgentRun's adapter system lets you run agents from any framework inside the sandbox.

### How it works

1. An `AgentAdapter` interface provides `load()`, `start()`, `stop()`, and `handleMessage()` methods
2. Adapters are registered in the `AdapterRegistry` by name
3. `agentrun run config.yaml --adapter <name>` loads the adapter, parses the config, and starts the agent in a sandbox
4. All tool calls are routed through capability checks before execution

### Writing a custom adapter

```typescript
import type { AgentAdapter, AdapterConfig, AdapterMessage, AdapterResponse, AdapterState } from "@agentrun/runtime";
import type { Capability, AgentSandbox } from "@agentrun/runtime";

export class MyFrameworkAdapter implements AgentAdapter {
  readonly name = "my-framework";
  readonly version = "0.1.0";
  private _state: AdapterState = "idle";

  get state(): AdapterState { return this._state; }

  async load(config: AdapterConfig): Promise<void> {
    // Parse your framework's config file
    this._state = "loaded";
  }

  async start(sandbox: AgentSandbox): Promise<void> {
    // Check required capabilities against sandbox
    this._state = "running";
  }

  async stop(): Promise<void> {
    this._state = "stopped";
  }

  async handleMessage(message: AdapterMessage): Promise<AdapterResponse> {
    // Route messages, check sandbox permissions
    return { type: "result", payload: { /* ... */ } };
  }

  getRequiredCapabilities(): Capability[] {
    return ["llm:chat", "memory:read"];
  }
}
```

Register it:

```typescript
import { defaultAdapterRegistry } from "@agentrun/runtime";
defaultAdapterRegistry.register("my-framework", () => new MyFrameworkAdapter());
```

---

## Moltbook

Moltbook agents connect via the A2A (Agent-to-Agent) protocol:

1. **Expose an A2A-compatible Agent Card** for each Moltbook agent
2. **Use the AgentRun gateway** to send tasks via the A2A protocol
3. **Write a thin adapter** if the Moltbook agent doesn't support A2A natively

---

## MCP Servers (Tools)

Any MCP server can be used as a tool source:

1. Run or connect to the MCP server
2. Add it to the agent manifest's allowed tools
3. Ensure permissions allow the tools and domains it requires

Example `MCP_SERVERS` with allowlists:

```json
[
  {
    "name": "filesystem",
    "transport": "stdio",
    "command": "node",
    "args": ["/opt/mcp/filesystem.js"],
    "allowedTools": ["read*", "write*"],
    "blockedTools": ["admin:*"]
  }
]
```

---

## Local Model Providers

Use Ollama for free local models:

```bash
ollama serve
ollama pull llama3.2
```

Then set in `.env`:

```
OLLAMA_URL=http://localhost:11434
```

---

## Custom Agent Networks

For multi-agent deployments:
- **Agent Directory + Reputation** for discovery
- **Forums + Jobs** for collaboration
- **Governance + Appeals** for safety and policy enforcement

AgentRun provides the infrastructure; external agents bring behavior.

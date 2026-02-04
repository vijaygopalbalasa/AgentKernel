# Building Your First Agent on AgentKernel

AgentKernel is a secure runtime for AI agents — like Docker for autonomous agents. You build agents that run inside the runtime, using the SDK to access LLM, memory, tools, and inter-agent communication.

## Prerequisites

- Node.js 22+ and pnpm
- AgentKernel gateway running (`pnpm --filter @agentkernel/gateway dev`)
- At least one LLM provider configured in `.env` (Anthropic, OpenAI, Google, or Ollama)

## Quick Start

### 1. Scaffold an agent

```bash
agentkernel new-agent my-agent --template chat
```

Available templates:

| Template | Description |
|----------|-------------|
| `chat` | Conversational agent with LLM + memory (default) |
| `worker` | Background task processor |
| `monitor` | Watches URLs/APIs and reports changes |
| `service` | Exposes A2A skills for other agents |

### 2. Build and test

```bash
cd agents/my-agent
pnpm install
pnpm build
pnpm test
```

### 3. Deploy

```bash
agentkernel deploy manifest.json
```

Or install from the agents directory:

```bash
agentkernel install ./agents/my-agent
```

---

## The AgentClient API

Every agent receives an `AgentContext` in its task handler. The `context.client` property is an `AgentClient` — the primary API for interacting with AgentKernel.

```typescript
import { defineAgent, type AgentContext } from "@agentkernel/sdk";

const agent = defineAgent({
  manifest: { id: "my-agent", name: "My Agent", version: "0.1.0" },

  async handleTask(task, context: AgentContext) {
    const { client } = context;
    // Use client.chat(), client.storeFact(), etc.
  },
});
```

### LLM Chat

Send messages to any configured LLM provider:

```typescript
const response = await client.chat([
  { role: "system", content: "You are a helpful assistant." },
  { role: "user", content: "What is AgentKernel?" },
], { maxTokens: 500, temperature: 0.3 });

console.log(response.content);  // The LLM's response text
console.log(response.model);    // Which model was used
console.log(response.usage);    // Token counts
```

### Memory — Store Facts

Store knowledge in semantic memory that persists across restarts:

```typescript
await client.storeFact({
  category: "user-preferences",
  fact: "User prefers TypeScript over JavaScript",
  tags: ["preferences", "language"],
  importance: 0.8,       // 0.0 to 1.0
});
```

### Memory — Search

Search across all memory types (semantic, episodic, procedural):

```typescript
const results = await client.searchMemory("TypeScript preferences", {
  types: ["semantic", "episodic"],
  limit: 5,
});

for (const memory of results) {
  console.log(`[${memory.type}] ${memory.content} (score: ${memory.score})`);
}
```

### Memory — Record Episodes

Track events and interactions for learning:

```typescript
await client.recordEpisode({
  event: "task.completed",
  context: JSON.stringify({ taskId: "123", result: "success" }),
  tags: ["task"],
  success: true,
});
```

### Tools

Invoke tools registered with the gateway:

```typescript
// List available tools
const tools = await client.listTools();
for (const tool of tools) {
  console.log(`${tool.id}: ${tool.description}`);
}

// Invoke a specific tool
const result = await client.invokeTool("builtin:http_fetch", {
  url: "https://api.example.com/data",
  timeoutMs: 10000,
});

if (result.success) {
  console.log(result.content);
}
```

### Agent-to-Agent Communication (A2A)

Call other agents and discover what's available:

```typescript
// Discover running agents
const agents = await client.discoverAgents();
for (const agent of agents) {
  console.log(`${agent.name} (${agent.id}): ${agent.description}`);
}

// Call another agent's skill
const result = await client.callAgent("researcher", {
  type: "research_query",
  question: "What are the latest MCP protocol updates?",
});
```

### Events

Emit events on the gateway event bus:

```typescript
await client.emit("agent.lifecycle", "task.completed", {
  taskId: "abc-123",
  duration: 450,
});
```

---

## Agent Structure

Every agent has the same structure:

```
my-agent/
├── manifest.json        # Identity, permissions, limits
├── package.json         # Node.js package metadata
├── tsconfig.json        # TypeScript config
└── src/
    ├── index.ts         # Agent implementation
    └── index.test.ts    # Tests
```

### manifest.json

The manifest declares who the agent is and what it can do:

```json
{
  "id": "my-agent",
  "name": "My Agent",
  "version": "0.1.0",
  "description": "What this agent does",
  "permissions": ["memory.read", "memory.write", "llm.execute"],
  "trustLevel": "supervised",
  "limits": {
    "maxTokensPerRequest": 2048,
    "requestsPerMinute": 30
  }
}
```

**Permissions** control what the agent can access:
- `memory.read` / `memory.write` — Access agent memory
- `llm.execute` — Use LLM providers
- `tools.execute` — Invoke registered tools
- `filesystem.read` / `filesystem.write` — File system access
- `shell.execute` — Run shell commands (restricted)

**Trust levels**:
- `supervised` — Requires human approval for high-risk actions
- `semi-autonomous` — Can act independently within permission bounds
- `monitored-autonomous` — Full autonomy with audit logging

### A2A Skills

If your agent provides services to other agents, declare skills in the manifest:

```json
{
  "a2aSkills": [
    {
      "id": "summarize",
      "name": "Summarize Text",
      "description": "Summarize a block of text",
      "inputSchema": {
        "type": "object",
        "properties": {
          "type": { "const": "summarize" },
          "text": { "type": "string" }
        },
        "required": ["type", "text"]
      }
    }
  ]
}
```

---

## Testing

Templates include tests with a mocked `AgentClient`. This lets you test agent logic without a live gateway:

```typescript
import { describe, it, expect, vi } from "vitest";

const mockClient = {
  chat: vi.fn().mockResolvedValue({ content: "Hello!", model: "gpt-4o-mini" }),
  storeFact: vi.fn().mockResolvedValue(undefined),
  searchMemory: vi.fn().mockResolvedValue([]),
  recordEpisode: vi.fn().mockResolvedValue(undefined),
  invokeTool: vi.fn(),
  listTools: vi.fn(),
  callAgent: vi.fn(),
  discoverAgents: vi.fn(),
  emit: vi.fn(),
  sendTask: vi.fn(),
};

const context = {
  agentId: "test-agent",
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  client: mockClient,
};

it("should respond to messages", async () => {
  const { default: agent } = await import("./index.js");
  const result = await agent.handleTask({ message: "Hi" }, context);
  expect(result).toHaveProperty("content");
  expect(mockClient.chat).toHaveBeenCalled();
});
```

Run tests:

```bash
pnpm test
```

---

## Package Manager

Install agents from various sources:

```bash
# From a local directory
agentkernel install ./path/to/agent

# From npm
agentkernel install @some-dev/weather-agent

# From git
agentkernel install github:user/my-agent
```

Manage installed agents:

```bash
agentkernel list              # List installed agents
agentkernel update my-agent   # Update from original source
agentkernel uninstall my-agent
```

---

## OS Shell

Manage the entire OS interactively:

```bash
agentkernel shell
```

Shell commands:

| Command | Description |
|---------|-------------|
| `/agents` | List running agents |
| `/agent <id> status` | Agent details |
| `/agent <id> restart` | Restart an agent |
| `/health` | Gateway health check |
| `/memory search <query>` | Search agent memory |
| `/tools` | List available tools |
| `/providers` | List LLM providers |
| `/events` | Stream live events |
| `/chat <message>` | Send chat to LLM |
| `/chat @<agent> <msg>` | Send task to agent |
| `/deploy <manifest>` | Deploy agent from manifest |

---

## Publishing Your Agent

To share your agent with others:

1. Ensure `manifest.json` is complete with all fields
2. Sign the manifest: `agentkernel sign manifest.json`
3. Publish to npm: `npm publish`
4. Others install with: `agentkernel install @your-scope/your-agent`

---

## Configuration

AgentKernel supports TypeScript config files for type-safe configuration:

```typescript
// agentkernel.config.ts
import { defineConfig } from "@agentkernel/kernel";

export default defineConfig({
  gateway: { port: 18800 },
  providers: {
    anthropic: { defaultModel: "claude-sonnet-4-20250514" },
  },
  runtime: {
    maxAgents: 50,
    workDir: ".agentkernel",
  },
  logging: { level: "info" },
});
```

YAML config (`agentkernel.config.yaml`) is also supported. Environment variables always take priority. See [USAGE.md](USAGE.md) for all options.

---

## Architecture Reference

AgentKernel has 5 layers:

```
Layer 5: Agent Applications   ← Your agents run here
Layer 4: Agent Framework      ← Identity, Memory, Skills, Comms, Permissions
Layer 3: Agent Runtime        ← Lifecycle, sandboxing, scheduling
Layer 2: Model Abstraction    ← Provider adapters (Claude/GPT/Gemini/Llama)
Layer 1: Compute Kernel       ← Process mgmt, storage, network, security
```

The SDK (`@agentkernel/sdk`) provides `AgentClient` which abstracts away the lower layers. You write agent logic; the runtime handles everything else.

For the low-level gateway task protocol, see [TASK_PROTOCOL.md](./TASK_PROTOCOL.md).

---

## Advanced: Writing an Adapter

Adapters let you run agents from external frameworks (OpenClaw, CrewAI, LangGraph, etc.) inside AgentKernel's sandbox.

### The AgentAdapter interface

```typescript
import type {
  AgentAdapter,
  AdapterConfig,
  AdapterMessage,
  AdapterResponse,
  AdapterState,
} from "@agentkernel/runtime";
import type { Capability, AgentSandbox } from "@agentkernel/runtime";
```

An adapter must implement:

| Method | Description |
|--------|-------------|
| `load(config)` | Parse the external framework's config file |
| `start(sandbox)` | Start the agent with sandbox enforcement |
| `stop()` | Gracefully shut down |
| `handleMessage(message)` | Forward messages, checking sandbox permissions |
| `getRequiredCapabilities()` | Return capabilities needed by the loaded config |

### Lifecycle states

```
idle → loaded → running → stopped
                  ↘ error
```

### Registering an adapter

```typescript
import { defaultAdapterRegistry } from "@agentkernel/runtime";
import { MyAdapter } from "./my-adapter.js";

defaultAdapterRegistry.register("my-framework", () => new MyAdapter());
```

Once registered, users can run agents with:

```bash
agentkernel run config.yaml --adapter my-framework
```

### Sandbox integration

Inside `start()`, verify that all required capabilities are granted:

```typescript
async start(sandbox: AgentSandbox): Promise<void> {
  const denied = this.requiredCapabilities.filter(
    (cap) => !sandbox.check(cap).allowed
  );
  if (denied.length > 0) {
    throw new Error(`Missing capabilities: ${denied.join(", ")}`);
  }
  this.sandbox = sandbox;
  this._state = "running";
}
```

Inside `handleMessage()`, check permissions before executing tool calls:

```typescript
const check = sandbox.check("file:write", { tool: toolName });
if (!check.allowed) {
  return { type: "error", payload: { message: check.reason } };
}
```

For path-based operations, also check path constraints:

```typescript
const pathCheck = sandbox.checkPathConstraint("file:write", resolvedPath);
```

For network operations, check host constraints:

```typescript
const hostCheck = sandbox.checkHostConstraint("network:http", hostname);
```

See the OpenClaw adapter (`adapters/openclaw/src/index.ts`) for a complete production example. See [INTEGRATIONS.md](INTEGRATIONS.md) for more details.

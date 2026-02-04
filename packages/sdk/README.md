# @agentkernel/sdk

The Software Development Kit for building agents on AgentKernel.

## Installation

```bash
pnpm add @agentkernel/sdk
```

## Quick Start

```typescript
import { defineAgent, type AgentContext } from "@agentkernel/sdk";

const agent = defineAgent({
  manifest: {
    id: "my-agent",
    name: "My Agent",
    version: "0.1.0",
    permissions: ["memory.read", "memory.write", "llm.execute"],
  },

  async handleTask(task, context: AgentContext) {
    const { client } = context;

    // Chat with an LLM
    const response = await client.chat([
      { role: "user", content: task.message },
    ]);

    // Store a fact in memory
    await client.storeFact({
      category: "conversations",
      fact: `Discussed: ${task.message}`,
    });

    return { content: response.content };
  },
});

export default agent;
```

## AgentClient API

The `context.client` provides these methods:

| Method | Description |
|--------|-------------|
| `chat(messages, options?)` | Send messages to an LLM |
| `storeFact(fact)` | Store a fact in semantic memory |
| `searchMemory(query, options?)` | Search across all memory types |
| `recordEpisode(episode)` | Record an event in episodic memory |
| `invokeTool(toolId, args)` | Invoke a registered tool |
| `listTools()` | List available tools |
| `callAgent(agentId, task)` | Call another agent via A2A |
| `discoverAgents(query?)` | Discover registered agents |
| `emit(channel, type, data?)` | Emit an event on the event bus |

## Scaffolding

Use the CLI to generate agents from templates:

```bash
agentkernel new-agent my-agent --template chat     # Conversational agent
agentkernel new-agent my-worker --template worker   # Background processor
agentkernel new-agent my-monitor --template monitor # Change detector
agentkernel new-agent my-service --template service # A2A microservice
```

## Full Documentation

See [docs/DEVELOPER.md](../../docs/DEVELOPER.md) for the complete developer guide.

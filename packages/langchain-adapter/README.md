# @agentkernel/langchain-adapter

LangChain adapter for AgentKernel — intercepts tool calls with PolicyEngine to enforce security policies on any LangChain tool.

## Installation

```bash
pnpm add @agentkernel/langchain-adapter
```

## Peer Dependencies

- `@langchain/core` >= 0.2.0

## Usage

```typescript
import { wrapToolWithPolicy } from '@agentkernel/langchain-adapter';
import { PolicyEngine } from '@agentkernel/runtime';

const policyEngine = new PolicyEngine(myPolicySet);

// Wrap any LangChain tool with policy enforcement
const safeTool = wrapToolWithPolicy(myLangChainTool, policyEngine, {
  agentId: 'my-agent',
});

// Tool calls are now intercepted and checked against policies
const result = await safeTool.invoke({ input: 'read /etc/passwd' });
```

See the [main repo](https://github.com/vijaygopalbalasa/AgentKernel) for full documentation.

## License

MIT

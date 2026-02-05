# @agentkernel/runtime

Agent runtime for AgentKernel — policy engine, process sandboxing, audit logging, rate limiting, and state persistence.

## Installation

```bash
pnpm add @agentkernel/runtime
```

## What's Included

- **Policy Engine** — Allow/block/approve rules for file, network, shell, and secret access
- **Process Sandbox** — OS-level isolation with memory limits and execution timeouts
- **Audit Logger** — Multi-sink audit logging (console, file, memory, PostgreSQL)
- **Rate Limiter** — Per-agent token bucket rate limiting
- **State Persistence** — PostgreSQL-backed agent state and capability token storage

## Usage

```typescript
import { PolicyEngine, WorkerSandbox, AuditLogger } from '@agentkernel/runtime';

const engine = new PolicyEngine(policySet);
const result = engine.evaluate({
  type: 'file',
  path: '/etc/passwd',
  operation: 'read',
  agentId: 'agent-1',
});

if (result.decision === 'block') {
  console.log('Blocked:', result.reason);
}
```

See the [main repo](https://github.com/vijaygopalbalasa/AgentKernel) for full documentation.

## License

MIT

# @agentkernel/permissions

Capability-based permission system for AgentKernel — HMAC-signed tokens with constant-time verification.

## Installation

```bash
pnpm add @agentkernel/permissions
```

## What's Included

- **Capability Manager** — Create, verify, and revoke HMAC-SHA256 signed permission tokens
- **Time-bounded grants** — Permissions automatically expire after a configurable duration
- **Resource-scoped** — Fine-grained control over file, network, shell, and secret access
- **Constant-time verification** — Resistant to timing attacks

## Usage

```typescript
import { createCapabilityManager } from '@agentkernel/permissions';

const manager = createCapabilityManager({ secret: process.env.PERMISSION_SECRET });

// Grant limited file access for 1 hour
const token = manager.grant({
  agentId: 'my-agent',
  permissions: [{ category: 'filesystem', actions: ['read'], resource: '/workspace/**' }],
  purpose: 'Read project files',
  durationMs: 3600000,
});

// Verify before any operation
const check = manager.check('my-agent', 'filesystem', 'read', '/workspace/src/app.ts');
```

See the [main repo](https://github.com/vijaygopalbalasa/AgentKernel) for full documentation.

## License

MIT

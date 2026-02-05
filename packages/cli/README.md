# @agentkernel/cli

Programmatic API for AgentKernel — run proxies, check status, and query audit logs via PostgreSQL.

## Installation

```bash
pnpm add @agentkernel/cli
```

This is a **library package** (no CLI binary). For the CLI binary, install `agentkernel` instead.

## Usage

```typescript
import { runProxy, checkStatus, queryAudit } from '@agentkernel/cli';

// Start a security proxy programmatically
await runProxy({ port: 18788, policy: myPolicy });

// Check infrastructure health
const status = await checkStatus({ databaseUrl: process.env.DATABASE_URL });

// Query audit logs
const logs = await queryAudit({ agentId: 'my-agent', limit: 100 });
```

See the [main repo](https://github.com/vijaygopalbalasa/AgentKernel) for full documentation.

## License

MIT

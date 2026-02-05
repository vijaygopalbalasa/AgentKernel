# @agentkernel/kernel

Core infrastructure for AgentKernel — config, structured logging, PostgreSQL database, Redis cache, Qdrant vector store, and security utilities.

## Installation

```bash
pnpm add @agentkernel/kernel
```

## What's Included

- **Database** — PostgreSQL client with migrations, connection pooling, and query circuit breaker
- **Logger** — Pino-based structured logging with configurable levels
- **Security** — Input validation, secrets management, rate limiting, audit helpers
- **Config** — Typed configuration with Zod validation and environment variable loading
- **Health** — Infrastructure health checks for PostgreSQL, Redis, and Qdrant

## Usage

```typescript
import { createDatabase, createLogger, createConfig } from '@agentkernel/kernel';

const config = createConfig();
const logger = createLogger({ level: config.logLevel });
const db = createDatabase(config.database);
```

See the [main repo](https://github.com/vijaygopalbalasa/AgentKernel) for full documentation.

## License

MIT

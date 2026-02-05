# @agentkernel/shared

Shared types, utilities, and constants for the AgentKernel monorepo.

## Installation

```bash
pnpm add @agentkernel/shared
```

## What's Included

- **Result types** — `Ok<T>` and `Err<E>` for type-safe error handling (neverthrow pattern)
- **Shared constants** — Common configuration defaults and limits
- **Type definitions** — Shared TypeScript interfaces used across packages

## Usage

```typescript
import { ok, err, type Result } from '@agentkernel/shared';

function parseConfig(input: string): Result<Config, Error> {
  try {
    return ok(JSON.parse(input));
  } catch (e) {
    return err(new Error('Invalid config'));
  }
}
```

See the [main repo](https://github.com/vijaygopalbalasa/AgentKernel) for full documentation.

## License

MIT

# Contributing to AgentKernel

Thank you for your interest in contributing to AgentKernel.

## Getting Started

### Prerequisites

- Node.js 22+
- pnpm 9+
- Docker (for integration tests)

### Setup

```bash
git clone https://github.com/vijaygopalbalasa/AgentKernel.git
cd AgentKernel
pnpm install
pnpm build
pnpm test
```

### Project Structure

```
agentkernel/
  packages/
    kernel/          # L1: Database, cache, logging, health
    mal/             # L2: LLM provider routing & abstraction
    runtime/         # L3: Agent lifecycle, sandboxing, state
    framework/       # L4: Identity, memory, permissions, tools, events
    sdk/             # Developer SDK
    shared/          # Shared types and utilities
  providers/         # LLM provider adapters
  apps/
    gateway/         # Main daemon process
    cli/             # CLI tool
    dashboard/       # Web monitoring UI
  agents/            # Example agents
```

## Development Workflow

1. **Create a branch** from `master`
2. **Make your changes** following the coding standards below
3. **Run the checks**:
   ```bash
   pnpm build        # Must compile with 0 errors
   pnpm test         # All tests must pass
   pnpm typecheck    # TypeScript strict mode check
   ```
4. **Submit a pull request** with a clear description

## Coding Standards

### TypeScript
- Strict mode always enabled
- **No `any` type** — ever
- **No default exports** — always named exports
- **No `console.log`** in library code — use the structured logger from `@agentkernel/kernel`
- Use `interface` over `type` for public APIs
- Use Zod for runtime validation of all external inputs
- Error handling: use `Result` types, not bare try/catch for business logic

### Naming
- `PascalCase` for types, interfaces, classes
- `camelCase` for functions, variables, methods
- `SCREAMING_SNAKE_CASE` for constants

### Testing
- Tests colocated with source: `foo.ts` -> `foo.test.ts`
- Use Vitest
- Test edge cases: timeouts, errors, retries
- Minimum coverage expectations per layer

### Architecture
- **No class inheritance** — prefer composition and interfaces
- **No custom protocols** — use MCP for tools, A2A for agent communication
- Every package exports from a single `index.ts` barrel file
- Every public function needs JSDoc comments

## What We Accept

- Bug fixes with tests
- Performance improvements with benchmarks
- New LLM provider adapters
- New skills (installable capabilities)
- Documentation improvements
- Security fixes (see SECURITY.md for reporting)

## What We Don't Accept

- Breaking API changes without discussion
- Features that lock to a single LLM provider
- Blockchain, Web3, or token-based features
- Dependencies with restrictive licenses

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

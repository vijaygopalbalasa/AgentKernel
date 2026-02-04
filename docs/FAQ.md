# FAQ

## What is AgentRun?

AgentRun is a self-hosted secure runtime for AI agents — like Docker for autonomous agents. It sandboxes execution, enforces permissions, manages memory, and provides the infrastructure to run, deploy, and orchestrate agents safely.

## Who is it for?

- Teams building many agents and needing governance, audit, and safety.
- Builders who want self-hosted agents with local or private data.
- Organizations that need agents with strict permissions and monitoring.
- Anyone who wants to run existing agent frameworks (OpenClaw, etc.) with security enforcement.

## How is it different from LangChain / CrewAI / AutoGen?

Those are frameworks that help you **build** agent code. AgentRun **runs, manages, secures, and orchestrates** agents — regardless of which framework they use internally. You can even run LangChain or CrewAI agents inside AgentRun using the adapter system.

## What does `agentrun run` do?

`agentrun run ./my-agent.ts` deploys an agent to a running gateway with automatic sandboxing. The agent gets default capabilities (LLM access, memory read/write) and runs inside a permission-enforced sandbox. Use `--standalone` to validate locally without a gateway.

## What are adapters?

Adapters wrap external agent frameworks in AgentRun's sandbox. For example, `agentrun run config.yaml --adapter openclaw` runs an OpenClaw agent with capability-based permissions. The adapter maps OpenClaw skills to AgentRun capabilities and enforces sandbox rules.

## What's `agentrun.config.ts`?

An optional TypeScript config file for type-safe configuration. It's an alternative to YAML config or environment variables. Create it in your project root and export a config object using `defineConfig()` from `@agentrun/kernel`. See [USAGE.md](USAGE.md).

## How do I add models/providers?

Set provider env vars for built-ins (Anthropic, OpenAI, Google, Ollama), or implement a new provider adapter. See [PROVIDERS.md](PROVIDERS.md).

## How do users install it?

Use Docker for fastest setup, or `agentrun run --standalone` for zero-infrastructure validation. See [INSTALL.md](INSTALL.md).

## How do I integrate OpenClaw / Moltbook?

Use the OpenClaw adapter: `agentrun run openclaw.yaml --adapter openclaw`. For Moltbook and other systems, connect via A2A protocol or write a custom adapter. See [INTEGRATIONS.md](INTEGRATIONS.md).

## Is it production-ready?

AgentRun includes AppArmor profiles, seccomp filters, egress proxy, capability-based permissions, audit logging, and governance. See [PRODUCTION_READINESS.md](../PRODUCTION_READINESS.md) for the full spec.

## What LLMs does it support?

Anthropic (Claude), OpenAI (GPT), Google (Gemini), and any model via Ollama (Llama, Mistral, Phi, etc.). The Model Abstraction Layer handles routing, failover, and rate limiting.

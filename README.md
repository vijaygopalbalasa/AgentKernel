# 🤖 Agent OS — Android for AI Agents

An operating system for autonomous AI agents. Built on MCP + A2A protocols.

## Quick Start

```bash
# Prerequisites: Node 22+, pnpm 9+
pnpm install
cp .env.example .env
# Add your ANTHROPIC_API_KEY to .env

pnpm build
pnpm dev
```

## Architecture

```
Layer 5: Agent Applications  →  Agents that run on the OS
Layer 4: Agent Framework     →  Identity, Memory, Skills, Communication APIs
Layer 3: Agent Runtime       →  Lifecycle, sandboxing, scheduling
Layer 2: Model Abstraction   →  Works with ANY LLM (Claude, GPT, Gemini, etc.)
Layer 1: Compute Kernel      →  Process management, storage, network, security
```

## Built On
- **MCP** (Model Context Protocol) by Anthropic — tool connectivity
- **A2A** (Agent-to-Agent) by Google — agent communication
- **OpenClaw** architecture patterns — gateway, skills, memory
- **Android** design principles — layered OS, HAL abstraction, app lifecycle

## License
MIT

# FAQ

## What is AgentOS?
AgentOS is a self-hostable control plane for AI agents. It manages agent
identity, permissions, memory, tools, and inter-agent communication so that
agents run safely and predictably.

## Who is it for?
- Teams building many agents and needing governance, audit, and safety.
- Builders who want self-hosted agents with local or private data.
- Organizations that need agents with strict permissions and monitoring.

## Why build this?
Most agent frameworks focus on a single agent. AgentOS is the infra for
**many agents** running long-term with clear boundaries, audit trails, and
inter-agent workflows.

## How do users install it?
Use Docker for fastest setup. See `docs/INSTALL.md`.

## How do I add models/providers?
Set provider env vars for built-ins, or implement a new provider adapter.
See `docs/PROVIDERS.md`.

## How do I integrate OpenClaw / Moltbook?
Treat them as external agents and connect via A2A or a small adapter.
See `docs/INTEGRATIONS.md`.


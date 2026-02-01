# Agent OS — Starting with Claude Code

## Step 1: Install Claude Code (one time)

```bash
# Pick ONE method:
npm install -g @anthropic-ai/claude-code    # npm
brew install claude-code                      # macOS
winget install Anthropic.ClaudeCode           # Windows

# Verify it works
claude --version

# Login (first time only — opens browser)
claude
# Type: /login
# Select your Claude Pro/Max account
```

## Step 2: Create the project

```bash
# Create project directory
mkdir agent-os && cd agent-os

# Copy these files into agent-os/:
#   - CLAUDE.md (the brain — Claude Code reads this every session)
#   - bootstrap.sh (sets up the entire monorepo)

# Run bootstrap
chmod +x bootstrap.sh
bash bootstrap.sh

# Install dependencies
pnpm install

# Add your API key
cp .env.example .env
# Edit .env and add: ANTHROPIC_API_KEY=sk-ant-...

# Build everything
pnpm build

# Test it works
pnpm dev
```

## Step 3: Start Claude Code and build

```bash
# Make sure you're in the agent-os/ directory
cd agent-os

# Launch Claude Code
claude
```

## Step 4: What to tell Claude Code (in order)

### Session 1 — Get the basics working
```
Read CLAUDE.md and understand the project. Then build and run the gateway
to verify the Anthropic provider works. Fix any issues.
```

### Session 2 — Add WebSocket control plane
```
Add a WebSocket server to the gateway (like OpenClaw's ws://127.0.0.1:18789).
It should:
- Listen on the configured port
- Accept agent connections
- Handle message routing between agents
- Include a health check endpoint at GET /health
Use the ws npm package.
```

### Session 3 — Build the Agent Runtime (Layer 3)
```
Build packages/runtime — the Agent Runtime that manages agent lifecycle.
It should:
- Spawn agents as isolated processes
- Track agent state (initializing → ready → running → paused → terminated)
- Enforce resource limits (max tokens per minute, memory caps)
- Support agent hot-reload (update code without killing the agent)
- Emit lifecycle events through the event system
Look at how OpenClaw manages Pi agent processes for inspiration.
```

### Session 4 — Build Memory Manager (Layer 4)
```
Build packages/framework/memory — persistent agent memory.
Three types:
1. Episodic memory — what happened (conversation history, events)
2. Semantic memory — what the agent knows (facts, learned information)
3. Procedural memory — how to do things (skills, workflows)
Use Qdrant for vector storage and PostgreSQL for structured data.
Each agent gets isolated memory — like OpenClaw's per-user sessions.
```

### Session 5 — Build Identity + Permissions (Layer 4)
```
Build packages/framework/identity and packages/framework/permissions.
Identity: agent registration, Agent Cards (A2A spec), DID generation.
Permissions: capability-based security — agents declare what they need
in their AgentManifest, and the OS grants or denies access.
Like Android's permission system but for AI agents.
```

### Session 6 — MCP Integration (Layer 4)
```
Build packages/framework/tools — MCP client integration.
Agents should be able to:
- Connect to any MCP server (filesystem, browser, APIs)
- Discover available tools from MCP servers
- Call tools through the MCP protocol
- Handle tool results and errors
Use the @modelcontextprotocol/sdk npm package.
```

### Session 7 — Build a real agent
```
Build agents/assistant — a personal assistant agent that:
- Has an AgentManifest declaring its identity and permissions
- Uses the Memory Manager to remember conversations
- Connects to MCP servers for tools (file system, web browse)
- Can be talked to via the WebSocket control plane
- Persists across gateway restarts
```

## Claude Code Tips

### Custom slash commands (already set up)
```
/project:new-package <name>     # Scaffold a new package
/project:new-agent <name>       # Scaffold a new agent
/project:add-provider <name>    # Add an LLM provider adapter
```

### Useful Claude Code commands
```
/help                           # See all commands
/status                         # Current project status
/cost                           # How much this session cost
/compact                        # Compress context to save tokens
/clear                          # Reset conversation
```

### Power moves
```
# Give Claude a screenshot of an error
# Just paste the screenshot directly (Cmd+Ctrl+Shift+4 on Mac)

# Reference specific files
claude "fix the bug in packages/kernel/src/config.ts"

# Run in non-interactive mode for quick tasks
claude -p "add a health check endpoint to the gateway"

# Pipe files in
cat packages/mal/src/router.ts | claude "review this code"
```

### The CLAUDE.md is your superpower
Every time you see Claude Code make a mistake:
1. Tell it the correct approach
2. Add a rule to CLAUDE.md so it never makes that mistake again
3. Commit the CLAUDE.md update

This is exactly how the Anthropic team uses it internally.

## Architecture Reminder

```
Human → Gateway (WebSocket) → Agent Runtime → Agent
                                    ↓
                              Agent Framework
                           ┌────────┼────────┐
                        Memory  Identity  Skills
                           │       │        │
                          MCP    A2A    Permissions
                           │
                    Model Abstraction Layer
                    ┌──────┼──────┐
                 Claude   GPT   Gemini
```

## What You're Building (the big picture)

OpenClaw = 1 agent for 1 human (personal assistant)
Agent OS = unlimited agents for anyone (the operating system itself)

OpenClaw is like a single Android app.
Agent OS is Android itself.

Anyone can deploy agents on Agent OS.
Those agents can use any LLM, any tool, any skill.
They can find and talk to other agents via A2A.
They persist, remember, learn, and grow.

That's the vision. Start with Session 1. Ship fast.

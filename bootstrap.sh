#!/bin/bash
# Agent OS — Project Bootstrap Script
# Run this ONCE to set up the monorepo structure
# After this, use Claude Code for all development

set -e

echo "🤖 Agent OS — Bootstrapping project..."

# ─── Root Config ───
echo "📦 Initializing pnpm workspace..."

# package.json (root)
cat > package.json << 'EOF'
{
  "name": "agent-os",
  "version": "0.1.0",
  "private": true,
  "description": "Android for AI Agents — an operating system for autonomous AI agents",
  "license": "MIT",
  "engines": {
    "node": ">=22.0.0",
    "pnpm": ">=9.0.0"
  },
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "test:watch": "pnpm -r test:watch",
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "dev": "pnpm --filter @agent-os/gateway dev",
    "clean": "pnpm -r exec rm -rf dist node_modules"
  }
}
EOF

# pnpm-workspace.yaml
cat > pnpm-workspace.yaml << 'EOF'
packages:
  - "packages/*"
  - "packages/framework/*"
  - "apps/*"
  - "agents/*"
  - "providers/*"
  - "skills/*"
EOF

# tsconfig.json (root)
cat > tsconfig.json << 'EOF'
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src",
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": false
  },
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
EOF

# biome.json
cat > biome.json << 'EOF'
{
  "$schema": "https://biomejs.dev/schemas/2.0.0/schema.json",
  "organizeImports": { "enabled": true },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "complexity": { "noExcessiveCognitiveComplexity": "warn" },
      "suspicious": { "noExplicitAny": "error" }
    }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  }
}
EOF

# .gitignore
cat > .gitignore << 'EOF'
node_modules/
dist/
.env
.env.local
*.log
.DS_Store
coverage/
.turbo/
EOF

# .env.example
cat > .env.example << 'EOF'
# LLM Providers (add at least one)
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GOOGLE_AI_API_KEY=...

# Database
DATABASE_URL=postgresql://localhost:5432/agent_os
REDIS_URL=redis://localhost:6379
QDRANT_URL=http://localhost:6333

# Gateway
GATEWAY_PORT=18800
GATEWAY_TOKEN=change-me-to-a-random-secret

# Logging
LOG_LEVEL=info
EOF

# ─── Create Directory Structure ───
echo "📁 Creating directory structure..."

# Core packages
mkdir -p packages/kernel/src
mkdir -p packages/mal/src
mkdir -p packages/runtime/src
mkdir -p packages/shared/src
mkdir -p packages/sdk/src

# Framework sub-packages
mkdir -p packages/framework/identity/src
mkdir -p packages/framework/memory/src
mkdir -p packages/framework/skills/src
mkdir -p packages/framework/communication/src
mkdir -p packages/framework/tools/src
mkdir -p packages/framework/permissions/src
mkdir -p packages/framework/events/src

# Apps
mkdir -p apps/gateway/src
mkdir -p apps/cli/src
mkdir -p apps/dashboard/src

# Agents
mkdir -p agents/assistant/src
mkdir -p agents/coder/src
mkdir -p agents/system/src

# Providers
mkdir -p providers/anthropic/src
mkdir -p providers/openai/src
mkdir -p providers/google/src
mkdir -p providers/ollama/src

# Skills
mkdir -p skills/web-browse/src
mkdir -p skills/file-system/src
mkdir -p skills/shell-exec/src

# ─── Package: @agent-os/shared ───
cat > packages/shared/package.json << 'EOF'
{
  "name": "@agent-os/shared",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": "./dist/index.js" },
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts",
    "test": "vitest run",
    "test:watch": "vitest watch"
  }
}
EOF

cat > packages/shared/tsconfig.json << 'EOF'
{ "extends": "../../tsconfig.json", "compilerOptions": { "outDir": "dist", "rootDir": "src" }, "include": ["src"] }
EOF

cat > packages/shared/src/index.ts << 'EOF'
// @agent-os/shared — Shared types, utils, and constants

// ─── Result Type (no try/catch for business logic) ───
export interface Ok<T> { readonly ok: true; readonly value: T }
export interface Err<E> { readonly ok: false; readonly error: E }
export type Result<T, E = Error> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> { return { ok: true, value }; }
export function err<E>(error: E): Err<E> { return { ok: false, error }; }

// ─── Agent Identity ───
export interface AgentId {
  /** Unique identifier for this agent instance */
  readonly id: string;
  /** Human-readable name */
  readonly name: string;
  /** Version of the agent */
  readonly version: string;
}

// ─── Agent Manifest (like Android's AndroidManifest.xml) ───
export interface AgentManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly author: string;
  /** Which LLM model this agent prefers */
  readonly preferredModel?: string;
  /** Skills this agent requires */
  readonly requiredSkills: string[];
  /** Permissions this agent needs */
  readonly permissions: string[];
  /** MCP servers this agent connects to */
  readonly mcpServers?: McpServerConfig[];
}

export interface McpServerConfig {
  readonly name: string;
  readonly transport: "stdio" | "sse" | "streamable-http";
  readonly command?: string;
  readonly args?: string[];
  readonly url?: string;
}

// ─── Agent Lifecycle States ───
export type AgentState =
  | "initializing"
  | "ready"
  | "running"
  | "paused"
  | "error"
  | "terminated";

// ─── Provider Types ───
export interface LlmProvider {
  readonly id: string;
  readonly name: string;
  readonly models: string[];
}

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface ChatRequest {
  readonly model: string;
  readonly messages: ChatMessage[];
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly stream?: boolean;
}

export interface ChatResponse {
  readonly content: string;
  readonly model: string;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
}

// ─── Events ───
export interface AgentEvent {
  readonly type: string;
  readonly agentId: string;
  readonly timestamp: number;
  readonly payload: unknown;
}

// ─── Logger Interface ───
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

console.log("✅ @agent-os/shared types loaded");
EOF

# ─── Package: @agent-os/kernel ───
cat > packages/kernel/package.json << 'EOF'
{
  "name": "@agent-os/kernel",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": "./dist/index.js" },
  "dependencies": {
    "@agent-os/shared": "workspace:*",
    "zod": "^3.24.0",
    "pino": "^9.0.0"
  },
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts",
    "test": "vitest run",
    "test:watch": "vitest watch"
  }
}
EOF

cat > packages/kernel/tsconfig.json << 'EOF'
{ "extends": "../../tsconfig.json", "compilerOptions": { "outDir": "dist", "rootDir": "src" }, "include": ["src"] }
EOF

cat > packages/kernel/src/index.ts << 'EOF'
// @agent-os/kernel — Compute Kernel (Layer 1)
// Manages: process management, storage, network, security, logging

export { createLogger } from "./logger.js";
export { createConfig, type KernelConfig } from "./config.js";
export type { Logger } from "@agent-os/shared";

console.log("✅ @agent-os/kernel loaded");
EOF

cat > packages/kernel/src/logger.ts << 'EOF'
import type { Logger, LogLevel } from "@agent-os/shared";

/** Creates a structured logger instance */
export function createLogger(name: string, level: LogLevel = "info"): Logger {
  const levels: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  const currentLevel = levels[level];

  const log = (msgLevel: LogLevel, message: string, context?: Record<string, unknown>) => {
    if (levels[msgLevel] >= currentLevel) {
      const entry = {
        timestamp: new Date().toISOString(),
        level: msgLevel,
        name,
        message,
        ...context,
      };
      const output = msgLevel === "error" ? console.error : console.log;
      output(JSON.stringify(entry));
    }
  };

  return {
    debug: (msg, ctx) => log("debug", msg, ctx),
    info: (msg, ctx) => log("info", msg, ctx),
    warn: (msg, ctx) => log("warn", msg, ctx),
    error: (msg, ctx) => log("error", msg, ctx),
  };
}
EOF

cat > packages/kernel/src/config.ts << 'EOF'
import { z } from "zod";

const kernelConfigSchema = z.object({
  gateway: z.object({
    port: z.number().default(18800),
    host: z.string().default("127.0.0.1"),
    token: z.string().optional(),
  }).default({}),
  database: z.object({
    url: z.string().default("postgresql://localhost:5432/agent_os"),
  }).default({}),
  redis: z.object({
    url: z.string().default("redis://localhost:6379"),
  }).default({}),
  logging: z.object({
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
  }).default({}),
});

export type KernelConfig = z.infer<typeof kernelConfigSchema>;

/** Creates and validates kernel configuration from env/file */
export function createConfig(overrides?: Partial<KernelConfig>): KernelConfig {
  return kernelConfigSchema.parse({
    gateway: {
      port: Number(process.env.GATEWAY_PORT) || overrides?.gateway?.port,
      host: process.env.GATEWAY_HOST || overrides?.gateway?.host,
      token: process.env.GATEWAY_TOKEN || overrides?.gateway?.token,
    },
    database: {
      url: process.env.DATABASE_URL || overrides?.database?.url,
    },
    redis: {
      url: process.env.REDIS_URL || overrides?.redis?.url,
    },
    logging: {
      level: (process.env.LOG_LEVEL as KernelConfig["logging"]["level"]) || overrides?.logging?.level,
    },
  });
}
EOF

# ─── Package: @agent-os/mal (Model Abstraction Layer) ───
cat > packages/mal/package.json << 'EOF'
{
  "name": "@agent-os/mal",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": "./dist/index.js" },
  "dependencies": {
    "@agent-os/shared": "workspace:*",
    "@agent-os/kernel": "workspace:*"
  },
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts",
    "test": "vitest run"
  }
}
EOF

cat > packages/mal/tsconfig.json << 'EOF'
{ "extends": "../../tsconfig.json", "compilerOptions": { "outDir": "dist", "rootDir": "src" }, "include": ["src"] }
EOF

cat > packages/mal/src/index.ts << 'EOF'
// @agent-os/mal — Model Abstraction Layer (Layer 2)
// Like Android's HAL — makes ANY AI model work through a standard interface

import type { ChatRequest, ChatResponse, Result } from "@agent-os/shared";

/** Provider adapter interface — every LLM provider implements this */
export interface ProviderAdapter {
  readonly id: string;
  readonly name: string;
  readonly models: string[];

  /** Send a chat completion request */
  chat(request: ChatRequest): Promise<Result<ChatResponse>>;

  /** Check if provider is available (has valid API key, etc.) */
  isAvailable(): Promise<boolean>;
}

/** Model router — picks the best provider/model for each request */
export interface ModelRouter {
  /** Route a request to the best available provider */
  route(request: ChatRequest): Promise<Result<ChatResponse>>;

  /** Register a provider adapter */
  registerProvider(provider: ProviderAdapter): void;

  /** List all available models across all providers */
  listModels(): string[];
}

export { createModelRouter } from "./router.js";

console.log("✅ @agent-os/mal loaded");
EOF

cat > packages/mal/src/router.ts << 'EOF'
import type { ChatRequest, ChatResponse, Result } from "@agent-os/shared";
import { ok, err } from "@agent-os/shared";
import { createLogger } from "@agent-os/kernel";
import type { ModelRouter, ProviderAdapter } from "./index.js";

/** Creates a model router that distributes requests across providers */
export function createModelRouter(): ModelRouter {
  const providers = new Map<string, ProviderAdapter>();
  const logger = createLogger("mal:router");

  return {
    registerProvider(provider: ProviderAdapter) {
      providers.set(provider.id, provider);
      logger.info(`Registered provider: ${provider.name}`, {
        models: provider.models,
      });
    },

    listModels(): string[] {
      return Array.from(providers.values()).flatMap((p) => p.models);
    },

    async route(request: ChatRequest): Promise<Result<ChatResponse>> {
      // Find a provider that supports the requested model
      for (const provider of providers.values()) {
        if (provider.models.includes(request.model)) {
          const available = await provider.isAvailable();
          if (available) {
            logger.info(`Routing to ${provider.name}`, { model: request.model });
            return provider.chat(request);
          }
        }
      }

      // Fallback: try any available provider
      for (const provider of providers.values()) {
        const available = await provider.isAvailable();
        if (available) {
          logger.warn(`Falling back to ${provider.name}`, {
            requestedModel: request.model,
            fallbackModel: provider.models[0],
          });
          return provider.chat({
            ...request,
            model: provider.models[0] ?? request.model,
          });
        }
      }

      return err(new Error("No available LLM providers. Add at least one API key."));
    },
  };
}
EOF

# ─── Provider: Anthropic ───
cat > providers/anthropic/package.json << 'EOF'
{
  "name": "@agent-os/provider-anthropic",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": "./dist/index.js" },
  "dependencies": {
    "@agent-os/shared": "workspace:*",
    "@agent-os/mal": "workspace:*",
    "@anthropic-ai/sdk": "^0.39.0"
  },
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts",
    "test": "vitest run"
  }
}
EOF

cat > providers/anthropic/tsconfig.json << 'EOF'
{ "extends": "../../tsconfig.json", "compilerOptions": { "outDir": "dist", "rootDir": "src" }, "include": ["src"] }
EOF

cat > providers/anthropic/src/index.ts << 'EOF'
// @agent-os/provider-anthropic — Claude adapter for the Model Abstraction Layer

import Anthropic from "@anthropic-ai/sdk";
import type { ChatRequest, ChatResponse, Result } from "@agent-os/shared";
import { ok, err } from "@agent-os/shared";
import type { ProviderAdapter } from "@agent-os/mal";

export function createAnthropicProvider(apiKey?: string): ProviderAdapter {
  const key = apiKey ?? process.env.ANTHROPIC_API_KEY;

  return {
    id: "anthropic",
    name: "Anthropic Claude",
    models: [
      "claude-opus-4-5-20251101",
      "claude-sonnet-4-5-20250929",
      "claude-haiku-4-5-20251001",
    ],

    async isAvailable(): Promise<boolean> {
      return !!key;
    },

    async chat(request: ChatRequest): Promise<Result<ChatResponse>> {
      if (!key) return err(new Error("ANTHROPIC_API_KEY not set"));

      try {
        const client = new Anthropic({ apiKey: key });

        // Separate system message from conversation
        const systemMsg = request.messages.find((m) => m.role === "system");
        const chatMsgs = request.messages
          .filter((m) => m.role !== "system")
          .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

        const response = await client.messages.create({
          model: request.model,
          max_tokens: request.maxTokens ?? 4096,
          system: systemMsg?.content,
          messages: chatMsgs,
        });

        const textBlock = response.content.find((b) => b.type === "text");

        return ok({
          content: textBlock?.text ?? "",
          model: response.model,
          usage: {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
          },
        });
      } catch (error) {
        return err(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}
EOF

# ─── App: Gateway ───
cat > apps/gateway/package.json << 'EOF'
{
  "name": "@agent-os/gateway",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "build": "tsup src/main.ts --format esm",
    "start": "node dist/main.js"
  },
  "dependencies": {
    "@agent-os/kernel": "workspace:*",
    "@agent-os/mal": "workspace:*",
    "@agent-os/shared": "workspace:*",
    "@agent-os/provider-anthropic": "workspace:*"
  },
  "devDependencies": {
    "tsx": "^4.19.0"
  }
}
EOF

cat > apps/gateway/tsconfig.json << 'EOF'
{ "extends": "../../tsconfig.json", "compilerOptions": { "outDir": "dist", "rootDir": "src" }, "include": ["src"] }
EOF

cat > apps/gateway/src/main.ts << 'EOF'
// Agent OS Gateway — The main daemon process
// Like OpenClaw's gateway — single control plane for everything

import { createLogger, createConfig } from "@agent-os/kernel";
import { createModelRouter } from "@agent-os/mal";
import { createAnthropicProvider } from "@agent-os/provider-anthropic";

async function main() {
  const config = createConfig();
  const logger = createLogger("gateway", config.logging.level);

  logger.info("🤖 Agent OS Gateway starting...", {
    port: config.gateway.port,
    host: config.gateway.host,
  });

  // ─── Layer 2: Initialize Model Abstraction Layer ───
  const router = createModelRouter();

  // Register available providers
  const anthropic = createAnthropicProvider();
  if (await anthropic.isAvailable()) {
    router.registerProvider(anthropic);
    logger.info("Anthropic Claude provider registered");
  }

  const models = router.listModels();
  if (models.length === 0) {
    logger.error("No LLM providers available! Add at least one API key to .env");
    process.exit(1);
  }

  logger.info(`Available models: ${models.join(", ")}`);

  // ─── Quick test: send a message ───
  const result = await router.route({
    model: "claude-sonnet-4-5-20250929",
    messages: [
      { role: "system", content: "You are an agent running on Agent OS. Respond briefly." },
      { role: "user", content: "Hello! What are you?" },
    ],
    maxTokens: 200,
  });

  if (result.ok) {
    logger.info("Agent response", {
      content: result.value.content,
      tokens: result.value.usage,
    });
  } else {
    logger.error("Agent failed", { error: result.error.message });
  }

  logger.info("🤖 Agent OS Gateway ready", { port: config.gateway.port });
}

main().catch(console.error);
EOF

# ─── Vitest Config ───
cat > vitest.config.ts << 'EOF'
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    coverage: {
      provider: "v8",
      thresholds: { statements: 70, branches: 70, functions: 70, lines: 70 },
    },
  },
});
EOF

# ─── Claude Code Custom Commands ───
mkdir -p .claude/commands

cat > .claude/commands/new-package.md << 'EOF'
Create a new package in the Agent OS monorepo for: $ARGUMENTS

Follow these steps:
1. Create directory under packages/ (or the appropriate location)
2. Add package.json with name @agent-os/<name>, workspace dependencies
3. Add tsconfig.json extending root
4. Create src/index.ts with exports
5. Add to pnpm-workspace.yaml if needed
6. Follow the coding standards from CLAUDE.md
EOF

cat > .claude/commands/new-agent.md << 'EOF'
Create a new agent for Agent OS: $ARGUMENTS

Follow these steps:
1. Create directory under agents/<name>/
2. Add package.json depending on @agent-os/sdk
3. Create src/index.ts with agent manifest and main logic
4. The agent must define an AgentManifest with required permissions and skills
5. Follow the coding standards from CLAUDE.md
EOF

cat > .claude/commands/add-provider.md << 'EOF'
Add a new LLM provider adapter for: $ARGUMENTS

Follow these steps:
1. Create directory under providers/<name>/
2. Implement the ProviderAdapter interface from @agent-os/mal
3. Add the provider's official SDK as a dependency
4. Export a createXxxProvider() factory function
5. Add to the gateway's provider registration in apps/gateway/src/main.ts
6. Follow the coding standards from CLAUDE.md
EOF

# ─── README ───
cat > README.md << 'EOF'
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
EOF

# ─── Git Init ───
echo "🔧 Initializing git..."
git init
git add -A
git commit -m "feat: initial Agent OS monorepo scaffold

- 5-layer architecture (Kernel → MAL → Runtime → Framework → Apps)
- @agent-os/shared: types, Result type, AgentManifest
- @agent-os/kernel: logger, config with Zod validation
- @agent-os/mal: model router with provider abstraction
- @agent-os/provider-anthropic: Claude adapter
- @agent-os/gateway: main daemon process
- CLAUDE.md for Claude Code integration
- Custom slash commands for development workflow"

echo ""
echo "✅ Agent OS bootstrapped successfully!"
echo ""
echo "Next steps:"
echo "  1. cd agent-os"
echo "  2. cp .env.example .env && add your ANTHROPIC_API_KEY"
echo "  3. pnpm install"
echo "  4. pnpm build"
echo "  5. pnpm dev"
echo ""
echo "Or open Claude Code and start building:"
echo "  claude"
echo "  > Build the WebSocket server for the gateway on port 18800"
echo ""

# AgentRun Production Dockerfile
# Multi-stage build for minimal image size

# Stage 1: Dependencies
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy workspace config files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/kernel/package.json ./packages/kernel/
COPY packages/mal/package.json ./packages/mal/
COPY packages/runtime/package.json ./packages/runtime/
COPY packages/framework/identity/package.json ./packages/framework/identity/
COPY packages/framework/memory/package.json ./packages/framework/memory/
COPY packages/framework/skills/package.json ./packages/framework/skills/
COPY packages/framework/communication/package.json ./packages/framework/communication/
COPY packages/framework/tools/package.json ./packages/framework/tools/
COPY packages/framework/permissions/package.json ./packages/framework/permissions/
COPY packages/framework/events/package.json ./packages/framework/events/
COPY providers/anthropic/package.json ./providers/anthropic/
COPY providers/openai/package.json ./providers/openai/
COPY providers/google/package.json ./providers/google/
COPY providers/ollama/package.json ./providers/ollama/
COPY apps/gateway/package.json ./apps/gateway/
COPY agents/assistant/package.json ./agents/assistant/
COPY agents/system/package.json ./agents/system/
COPY agents/researcher/package.json ./agents/researcher/
COPY agents/monitor/package.json ./agents/monitor/
COPY agents/coder/package.json ./agents/coder/

# Install dependencies
RUN pnpm install --frozen-lockfile --prod=false

# Stage 2: Build
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/*/node_modules ./packages/
RUN mkdir -p ./providers/anthropic ./providers/openai ./providers/google ./providers/ollama
COPY --from=deps /app/providers/anthropic/node_modules ./providers/anthropic/node_modules
COPY --from=deps /app/providers/openai/node_modules ./providers/openai/node_modules
COPY --from=deps /app/providers/google/node_modules ./providers/google/node_modules
COPY --from=deps /app/providers/ollama/node_modules ./providers/ollama/node_modules
COPY --from=deps /app/apps/*/node_modules ./apps/
COPY --from=deps /app/agents/*/node_modules ./agents/

# Copy source code
COPY . .

# Build all packages
RUN pnpm build

# Stage 3: Production
FROM node:22-bookworm-slim AS production
WORKDIR /app

# Security: Run as non-root user
RUN groupadd -g 1001 nodejs && \
    useradd -m -u 1001 -g nodejs agentuser

# Optional: docker CLI for spawning worker containers via host socket
RUN apt-get update && \
    apt-get install -y --no-install-recommends docker.io ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/kernel/package.json ./packages/kernel/
COPY packages/mal/package.json ./packages/mal/
COPY packages/runtime/package.json ./packages/runtime/
COPY packages/framework/identity/package.json ./packages/framework/identity/
COPY packages/framework/memory/package.json ./packages/framework/memory/
COPY packages/framework/skills/package.json ./packages/framework/skills/
COPY packages/framework/communication/package.json ./packages/framework/communication/
COPY packages/framework/tools/package.json ./packages/framework/tools/
COPY packages/framework/permissions/package.json ./packages/framework/permissions/
COPY packages/framework/events/package.json ./packages/framework/events/
COPY providers/anthropic/package.json ./providers/anthropic/
COPY providers/openai/package.json ./providers/openai/
COPY providers/google/package.json ./providers/google/
COPY providers/ollama/package.json ./providers/ollama/
COPY apps/gateway/package.json ./apps/gateway/
COPY agents/assistant/package.json ./agents/assistant/
COPY agents/system/package.json ./agents/system/
COPY agents/researcher/package.json ./agents/researcher/
COPY agents/monitor/package.json ./agents/monitor/
COPY agents/coder/package.json ./agents/coder/

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Install Playwright system dependencies (Chromium)
RUN pnpm --filter @agentrun/tools exec playwright install-deps chromium

# Copy built artifacts
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/sdk/dist ./packages/sdk/dist
COPY --from=builder /app/packages/kernel/dist ./packages/kernel/dist
COPY --from=builder /app/packages/kernel/migrations ./packages/kernel/migrations
COPY --from=builder /app/packages/mal/dist ./packages/mal/dist
COPY --from=builder /app/packages/runtime/dist ./packages/runtime/dist
COPY --from=builder /app/packages/framework/identity/dist ./packages/framework/identity/dist
COPY --from=builder /app/packages/framework/memory/dist ./packages/framework/memory/dist
COPY --from=builder /app/packages/framework/skills/dist ./packages/framework/skills/dist
COPY --from=builder /app/packages/framework/communication/dist ./packages/framework/communication/dist
COPY --from=builder /app/packages/framework/tools/dist ./packages/framework/tools/dist
COPY --from=builder /app/packages/framework/permissions/dist ./packages/framework/permissions/dist
COPY --from=builder /app/packages/framework/events/dist ./packages/framework/events/dist
COPY --from=builder /app/providers/anthropic/dist ./providers/anthropic/dist
COPY --from=builder /app/providers/openai/dist ./providers/openai/dist
COPY --from=builder /app/providers/google/dist ./providers/google/dist
COPY --from=builder /app/providers/ollama/dist ./providers/ollama/dist
COPY --from=builder /app/apps/gateway/dist ./apps/gateway/dist
COPY --from=builder /app/agents/assistant/dist ./agents/assistant/dist
COPY --from=builder /app/agents/system/dist ./agents/system/dist
COPY --from=builder /app/agents/researcher/dist ./agents/researcher/dist
COPY --from=builder /app/agents/monitor/dist ./agents/monitor/dist
COPY --from=builder /app/agents/coder/dist ./agents/coder/dist
COPY --from=builder /app/agents/researcher/manifest.json ./agents/researcher/manifest.json
COPY --from=builder /app/agents/monitor/manifest.json ./agents/monitor/manifest.json
COPY --from=builder /app/agents/coder/manifest.json ./agents/coder/manifest.json
COPY --from=builder /app/docker/bootstrap-agents.mjs ./docker/bootstrap-agents.mjs

# Prepare writable dirs for non-root runtime + Playwright cache
RUN mkdir -p /app/.agentrun /app/.cache/ms-playwright && \
    chown -R agentuser:nodejs /app/.agentrun /app/.cache

# Switch to non-root user and install browser binaries to owned cache
USER agentuser
RUN pnpm --filter @agentrun/tools exec playwright install chromium

# Expose ports
EXPOSE 18800
EXPOSE 18801

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://localhost:18801/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

# Environment variables
ENV NODE_ENV=production
ENV PORT=18800
ENV LOG_LEVEL=info
ENV PLAYWRIGHT_BROWSERS_PATH=/app/.cache/ms-playwright

# Start the gateway
CMD ["node", "apps/gateway/dist/main.js"]

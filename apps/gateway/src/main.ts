// AgentRun Gateway — The main daemon process
// Production quality with Zod validation and Layer 4 integration

import { config as loadEnv } from "dotenv";
import { randomUUID } from "crypto";
import { resolve } from "path";
import { z } from "zod";
import { ProxyAgent, setGlobalDispatcher } from "undici";

// Load .env from the monorepo root (skip in test to avoid leaking local secrets into CI/tests)
if (process.env.NODE_ENV !== "test") {
  // Try CWD first (running from repo root), then relative to script location (running from apps/gateway/)
  loadEnv({ path: resolve(process.cwd(), ".env") });
  loadEnv({ path: resolve(process.cwd(), "../../.env") });
}

import {
  createLogger,
  loadConfig,
  getTracer,
  type Config,
  type Database,
  type VectorStore,
} from "@agentrun/kernel";
import { createModelRouter, type ModelRouter, type ProviderAdapter } from "@agentrun/mal";
import { createAnthropicProvider } from "@agentrun/provider-anthropic";
import { createOpenAIProvider } from "@agentrun/provider-openai";
import { createGoogleProvider } from "@agentrun/provider-google";
import { createOllamaProvider } from "@agentrun/provider-ollama";
import { createEventBus, type EventBus } from "@agentrun/events";
import { ok, err, type Result } from "@agentrun/shared";
import { MemoryManager } from "@agentrun/memory";
import { createCapabilityManager } from "@agentrun/permissions";
import { JobRunner } from "@agentrun/runtime";

import {
  createToolRegistry,
  registerBuiltinTools,
  createMCPClientManager,
  type ToolDefinition,
} from "@agentrun/tools";

import { createWebSocketServer, type WsServer, type MessageHandler } from "./websocket.js";
import { createHealthServer, type HealthServer } from "./health.js";
import {
  parseAllowedPaths,
  parseAllowedDomains,
  parseAllowedCommands,
  parseBoolean,
} from "./security-utils.js";

// ─── Extracted Modules ──────────────────────────────────────
import { type AgentEntry, type A2ATaskEntry, type ClusterCoordinator } from "./gateway-types.js";
import {
  parseMcpServers,
  createMockProvider,
  resolveEgressProxyUrl,
  resolveRetentionDays,
  resolveOptionalNumber,
  scheduleRetentionCleanup,
  validateProductionHardening,
  createEventId,
} from "./gateway-utils.js";
import { resolveWorkerHeartbeatTimeoutMs } from "./worker-manager.js";
import {
  createClusterCoordinator,
  registerClusterNode,
  resolveClusterNodeWsUrl,
  createJobLockProvider,
} from "./cluster.js";
import { handleClientMessage } from "./message-handler.js";
import { initializeMemorySubsystem } from "./db-operations.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger({ name: "gateway" });
  const proxyUrl = resolveEgressProxyUrl();
  const enforceProxy = parseBoolean(process.env.ENFORCE_EGRESS_PROXY, false);
  if (proxyUrl) {
    try {
      setGlobalDispatcher(new ProxyAgent(proxyUrl));
      log.info("Global egress proxy enabled", { proxyUrl });
    } catch (error) {
      if (enforceProxy) {
        log.error("ENFORCE_EGRESS_PROXY=true but proxy initialization failed", {
          proxyUrl,
          error: error instanceof Error ? error.message : String(error),
        });
        process.exit(1);
      }
      log.warn("Failed to configure global egress proxy", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } else if (enforceProxy) {
    log.error("ENFORCE_EGRESS_PROXY=true but no proxy URL configured");
    process.exit(1);
  }
  const exporterUrl = process.env.TRACING_EXPORTER_URL?.trim() || undefined;
  const tracer = getTracer({
    enabled: parseBoolean(process.env.TRACING_ENABLED, false),
    exporterUrl,
    serviceName: "agentrun-gateway",
    sampleRate: Number(process.env.TRACING_SAMPLE_RATE ?? 1),
  });
  if (exporterUrl) {
    tracer.startExport();
  }

  log.info("AgentRun Gateway starting...", {
    port: config.gateway.port,
    host: config.gateway.host,
  });

  // ─── Layer 1: Initialize Persistence (Postgres + Qdrant) ───
  const { db, vectorStore, memory } = await initializeMemorySubsystem(config, log);

  // ─── Tool Registry (built-ins + MCP) ───
  const toolRegistry = createToolRegistry();
  registerBuiltinTools(toolRegistry);
  log.info("Tool registry initialized", { tools: toolRegistry.list().length });

  const mcpManager = createMCPClientManager();
  const mcpServersRaw = process.env.MCP_SERVERS;
  const mcpServers = parseMcpServers(mcpServersRaw);
  if (mcpServersRaw && mcpServers.length === 0) {
    log.warn("MCP_SERVERS provided but could not be parsed or is empty");
  }
  for (const server of mcpServers) {
    const registerResult = mcpManager.registerServer(server);
    if (!registerResult.ok) {
      log.warn("Failed to register MCP server", { server: server.name, error: registerResult.error.message });
      continue;
    }
    const connectResult = await mcpManager.connect(server.name);
    if (!connectResult.ok) {
      log.warn("Failed to connect MCP server", { server: server.name, error: connectResult.error.message });
      continue;
    }
  }

  const mcpTools = mcpManager.getAllTools();
  for (const tool of mcpTools) {
    const toolId = `mcp:${tool.serverName}:${tool.id}`;
    const definition: ToolDefinition = {
      ...tool,
      id: toolId,
      category: tool.category ?? "mcp",
      tags: Array.from(new Set([...(tool.tags ?? []), "mcp", tool.serverName])),
    };
    toolRegistry.register(
      definition,
      async (args) => {
        const result = await mcpManager.invokeTool(tool.serverName, tool.id, args);
        if (!result.ok) {
          return { success: false, error: result.error.message };
        }
        return result.value;
      },
      { overwrite: true }
    );
  }

  if (mcpTools.length > 0) {
    log.info("MCP tools registered", { count: mcpTools.length });
  }

  // ─── Layer 2: Initialize Model Abstraction Layer ───
  const router = createModelRouter();

  const useMockProviders =
    process.env.NODE_ENV === "test" &&
    parseBoolean(process.env.MAL_USE_MOCK_PROVIDERS, true);

  if (useMockProviders) {
    const mockProviders = [
      { name: "Mock Anthropic Claude", provider: createMockProvider("anthropic") },
      { name: "Mock OpenAI GPT", provider: createMockProvider("openai") },
      { name: "Mock Google Gemini", provider: createMockProvider("google") },
      { name: "Mock Ollama", provider: createMockProvider("ollama") },
    ];
    for (const { name, provider } of mockProviders) {
      router.registerProvider(provider);
      log.info(`${name} provider registered`);
    }
  } else {
    // Register available providers
    const providers = [
      { name: "Anthropic Claude", provider: createAnthropicProvider() },
      { name: "OpenAI GPT", provider: createOpenAIProvider() },
      { name: "Google Gemini", provider: createGoogleProvider() },
      { name: "Ollama (Local)", provider: createOllamaProvider() },
    ];

    for (const { name, provider } of providers) {
      if (await provider.isAvailable()) {
        router.registerProvider(provider);
        log.info(`${name} provider registered`);
      }
    }
  }

  const models = router.listModels();
  if (models.length === 0) {
    log.error("No LLM providers available! Add at least one API key to .env");
    process.exit(1);
  }

  log.info(`Available models: ${models.join(", ")}`);

  // ─── Layer 4: Initialize Event Bus ───
  const eventBus = createEventBus();
  eventBus.setMaxHistorySize(1000);
  log.info("Event bus initialized");

  // ─── Agent Tracking ───
  const agents = new Map<string, AgentEntry>();
  const distributedScheduler = parseBoolean(
    process.env.DISTRIBUTED_SCHEDULER,
    parseBoolean(process.env.CLUSTER_MODE, false)
  );
  const jobLockProvider = db && distributedScheduler ? createJobLockProvider(db, log) : undefined;
  const jobRunner = new JobRunner({ logExecutions: false, lockProvider: jobLockProvider });
  const a2aTasks = new Map<string, A2ATaskEntry>();
  const allowedPaths = parseAllowedPaths(process.env.ALLOWED_PATHS);
  const allowedDomains = parseAllowedDomains(process.env.ALLOWED_DOMAINS);
  const allowedCommands = parseAllowedCommands(process.env.ALLOWED_COMMANDS);
  const isProduction = process.env.NODE_ENV === "production";
  const allowAllPaths = parseBoolean(process.env.ALLOW_ALL_PATHS, !isProduction);
  const allowAllDomains = parseBoolean(process.env.ALLOW_ALL_DOMAINS, !isProduction);
  const allowAllCommands = parseBoolean(process.env.ALLOW_ALL_COMMANDS, false);
  const requireVectorStore = parseBoolean(process.env.REQUIRE_VECTOR_STORE, isProduction);
  const monitorIntervalMs = Number(process.env.MONITOR_AGENT_INTERVAL_MS ?? 60000);
  let clusterCoordinator: ClusterCoordinator | null = null;
  let clusterNodeId: string | null = null;
  let clusterHeartbeat: NodeJS.Timeout | null = null;
  if (parseBoolean(process.env.CLUSTER_MODE, false)) {
    if (!db) {
      log.error("CLUSTER_MODE requires persistent storage");
      process.exit(1);
    }
    clusterCoordinator = await createClusterCoordinator(db, log);
    if (!clusterCoordinator) {
      log.error("Failed to initialize cluster coordinator");
      process.exit(1);
    }
    clusterNodeId = clusterCoordinator.nodeId;
    const wsUrl = resolveClusterNodeWsUrl(config);
    if (wsUrl) {
      clusterHeartbeat = await registerClusterNode(db, clusterCoordinator.nodeId, wsUrl, log);
    } else {
      log.warn("CLUSTER_MODE enabled but CLUSTER_NODE_WS_URL/CLUSTER_NODE_HOST not set; routing disabled");
    }
  }
  if (!clusterCoordinator || distributedScheduler || clusterCoordinator.isLeader()) {
    jobRunner.start();
  } else {
    log.info("Cluster follower: scheduler paused", { nodeId: clusterCoordinator.nodeId });
  }
  if (clusterCoordinator && !distributedScheduler) {
    clusterCoordinator.onChange((isLeader) => {
      if (isLeader) {
        log.info("Cluster leadership acquired; starting scheduler", { nodeId: clusterCoordinator?.nodeId });
        jobRunner.start();
      } else {
        log.warn("Cluster leadership lost; stopping scheduler", { nodeId: clusterCoordinator?.nodeId });
        void jobRunner.stop();
      }
    });
  } else if (clusterCoordinator && distributedScheduler) {
    log.info("Distributed scheduler enabled; job locks handle coordination", {
      nodeId: clusterCoordinator.nodeId,
    });
  }
  const permissionSecret = process.env.PERMISSION_SECRET ?? process.env.CAPABILITY_SECRET;
  if (!permissionSecret || permissionSecret.length < 32) {
    if (isProduction) {
      log.error("PERMISSION_SECRET is required in production and must be at least 32 characters");
      process.exit(1);
    }
    log.warn("PERMISSION_SECRET not set or too short; generating ephemeral dev secret (not suitable for production)");
  }
  const effectiveSecret = permissionSecret && permissionSecret.length >= 32
    ? permissionSecret
    : `dev-ephemeral-${randomUUID()}-${randomUUID()}`;
  const permissionManager = createCapabilityManager({
    secret: effectiveSecret,
  });
  if (isProduction && !config.gateway.authToken) {
    log.error("GATEWAY_AUTH_TOKEN is required in production");
    process.exit(1);
  }
  if (!isProduction && !config.gateway.authToken) {
    log.warn("⚠ GATEWAY_AUTH_TOKEN is not set — any non-empty token will be accepted (dev mode)");
  }
  if (isProduction && !process.env.INTERNAL_AUTH_TOKEN) {
    log.error("INTERNAL_AUTH_TOKEN is required in production");
    process.exit(1);
  }
  if (isProduction && !allowAllPaths && allowedPaths.length === 0) {
    log.error("ALLOWED_PATHS must be set in production (or set ALLOW_ALL_PATHS=true)");
    process.exit(1);
  }
  if (isProduction && !allowAllDomains && allowedDomains.length === 0) {
    log.error("ALLOWED_DOMAINS must be set in production (or set ALLOW_ALL_DOMAINS=true)");
    process.exit(1);
  }
  if (isProduction && !allowAllCommands && allowedCommands.length === 0) {
    log.warn("ALLOWED_COMMANDS not set; shell tools will be blocked");
  }
  // Block production from running with wildcard security bypasses
  if (isProduction && allowAllPaths && allowAllDomains && parseBoolean(process.env.ALLOW_ALL_COMMANDS, false)) {
    log.error("Production cannot run with ALLOW_ALL_PATHS, ALLOW_ALL_DOMAINS, and ALLOW_ALL_COMMANDS all enabled — this disables all security controls");
    process.exit(1);
  }
  validateProductionHardening(log, isProduction);
  const memoryLimitEnv = process.env.MAX_MEMORY_PER_AGENT_MB;
  const memoryLimitMb = memoryLimitEnv && memoryLimitEnv.trim() !== ""
    ? Number(memoryLimitEnv)
    : Math.floor(config.runtime.defaultMemoryLimit / (1024 * 1024));
  const heartbeatTimeoutMs = resolveWorkerHeartbeatTimeoutMs();
  const auditRetentionDays = resolveRetentionDays(process.env.AUDIT_LOG_RETENTION_DAYS, 365);
  const eventsRetentionDays = resolveRetentionDays(process.env.EVENTS_RETENTION_DAYS, 90);
  const taskRetentionDays = resolveRetentionDays(process.env.TASK_MESSAGES_RETENTION_DAYS, 90);
  const episodicRetentionDays = resolveRetentionDays(process.env.EPISODIC_RETENTION_DAYS, 365);
  const semanticRetentionDays = resolveRetentionDays(process.env.SEMANTIC_RETENTION_DAYS, 365);
  const proceduralRetentionDays = resolveRetentionDays(process.env.PROCEDURAL_RETENTION_DAYS, 365);
  const episodicArchiveDays = resolveRetentionDays(process.env.EPISODIC_ARCHIVE_DAYS, 0);
  const semanticArchiveDays = resolveRetentionDays(process.env.SEMANTIC_ARCHIVE_DAYS, 0);
  const proceduralArchiveDays = resolveRetentionDays(process.env.PROCEDURAL_ARCHIVE_DAYS, 0);
  const archiveRetentionDays = resolveRetentionDays(process.env.MEMORY_ARCHIVE_RETENTION_DAYS, 0);
  const episodicTierDays = resolveRetentionDays(process.env.EPISODIC_TIER_DAYS, 0);
  const semanticTierDays = resolveRetentionDays(process.env.SEMANTIC_TIER_DAYS, 0);
  const proceduralTierDays = resolveRetentionDays(process.env.PROCEDURAL_TIER_DAYS, 0);
  const tierImportanceMax = resolveOptionalNumber(process.env.MEMORY_TIER_IMPORTANCE_MAX);
  const memoryEncryptionEnabled = parseBoolean(process.env.MEMORY_ENCRYPTION_ENABLED, false);
  const archiveCompact = parseBoolean(process.env.MEMORY_ARCHIVE_COMPACT, false) && !memoryEncryptionEnabled;
  const archiveTextLimit = Math.max(
    256,
    Math.floor(resolveOptionalNumber(process.env.MEMORY_ARCHIVE_TEXT_LIMIT) ?? 4096)
  );
  const retentionInterval = db
    ? scheduleRetentionCleanup(db, vectorStore, log, {
        auditDays: auditRetentionDays,
        eventsDays: eventsRetentionDays,
        taskDays: taskRetentionDays,
        episodicDays: episodicRetentionDays,
        semanticDays: semanticRetentionDays,
        proceduralDays: proceduralRetentionDays,
        episodicArchiveDays,
        semanticArchiveDays,
        proceduralArchiveDays,
        archiveRetentionDays,
        episodicTierDays,
        semanticTierDays,
        proceduralTierDays,
        tierImportanceMax,
        archiveCompact,
        archiveTextLimit,
      })
    : undefined;

  // ─── Message Handler ───
  const handleMessage: MessageHandler = async (client, message) => {
    return tracer.trace(`ws.${message.type}`, async (span) => {
      span.setAttributes({
        "client.id": client.id,
        "message.id": message.id ?? "",
        "message.type": message.type,
      });
      return handleClientMessage(client, message, {
        router,
        eventBus,
        agents,
        jobRunner,
        monitorIntervalMs,
        log,
        memory,
        db,
        toolRegistry,
        permissionManager,
        a2aTasks,
        allowedPaths,
        allowedDomains,
        allowedCommands,
        allowAllPaths,
        allowAllDomains,
        allowAllCommands,
        memoryLimitMb,
        clusterNodeId,
      });
    });
  };

  const heartbeatInterval = setInterval(() => {
    const now = Date.now();
    for (const agent of agents.values()) {
      if (!agent.worker || agent.shutdownRequested || agent.state === "terminated") continue;
      if (!agent.lastHeartbeatAt) {
        agent.lastHeartbeatAt = now;
        continue;
      }
      if (now - agent.lastHeartbeatAt > heartbeatTimeoutMs) {
        log.warn("Agent worker heartbeat missed", {
          agentId: agent.id,
          lastHeartbeatAt: agent.lastHeartbeatAt,
        });
        agent.worker.kill("SIGTERM");
      }
    }
  }, Math.min(heartbeatTimeoutMs / 2, 15000));

  // ─── WebSocket Server ───
  const wsResult = createWebSocketServer(
    {
      port: config.gateway.port,
      host: config.gateway.host,
      authToken: config.gateway.authToken,
      maxConnections: config.gateway.maxConnections,
      messageRateLimit: config.gateway.messageRateLimit,
      maxPayloadSize: config.gateway.maxPayloadSize,
    },
    handleMessage
  );

  if (!wsResult.ok) {
    log.error("Failed to create WebSocket server", { error: wsResult.error.message });
    process.exit(1);
  }

  const wsServer = wsResult.value;

  // ─── Health Server (HTTP on port + 1) ───
  const healthPort = config.gateway.port + 1;
  const healthServer = createHealthServer(
    { port: healthPort, host: config.gateway.host },
    () => ({
      status: (() => {
        const providerStates = router.getState().providers;
        const healthyProviders = providerStates.filter((p) => p.healthy).length;
        if (healthyProviders === 0) return "error";
        if (!db) return "degraded";
        if (healthyProviders < providerStates.length) return "degraded";
        if (requireVectorStore && !vectorStore) return "degraded";
        return "ok";
      })(),
      version: "0.2.0",
      providers: models,
      agents: agents.size,
      connections: wsServer.getConnectionCount(),
    }),
    () => {
      const entries = Array.from(agents.values());
      const totals = entries.reduce(
        (acc, agent) => {
          acc.input += agent.tokenUsage.input;
          acc.output += agent.tokenUsage.output;
          acc.cost += agent.costUsageUSD;
          acc.states[agent.state] = (acc.states[agent.state] ?? 0) + 1;
          return acc;
        },
        {
          input: 0,
          output: 0,
          cost: 0,
          states: {} as Record<string, number>,
        }
      );

      const stateMetrics = Object.entries(totals.states).flatMap(([state, count]) => [
        `agent_os_agents_state_total{state="${state}"} ${count}`,
      ]);

      return [
        ``,
        `# HELP agent_os_tokens_input_total Total input tokens processed`,
        `# TYPE agent_os_tokens_input_total counter`,
        `agent_os_tokens_input_total ${totals.input}`,
        ``,
        `# HELP agent_os_tokens_output_total Total output tokens processed`,
        `# TYPE agent_os_tokens_output_total counter`,
        `agent_os_tokens_output_total ${totals.output}`,
        ``,
        `# HELP agent_os_cost_usd_total Total estimated model spend (USD)`,
        `# TYPE agent_os_cost_usd_total counter`,
        `agent_os_cost_usd_total ${totals.cost.toFixed(6)}`,
        ``,
        `# HELP agent_os_agents_state_total Agents by state`,
        `# TYPE agent_os_agents_state_total gauge`,
        ...stateMetrics,
      ];
    }
  );

  // ─── Event Broadcasting ───
  eventBus.subscribe("*", (event) => {
    wsServer.broadcast({
      type: "event",
      payload: {
        channel: event.channel,
        type: event.type,
        data: event.data,
        timestamp: event.timestamp.getTime(),
      },
    });
  });

  // ─── Optional: Quick LLM test ───
  if (process.env.TEST_LLM === "true") {
    log.info("Testing LLM connectivity...");
    const result = await router.route({
      model: "claude-3-haiku-20240307",
      messages: [
        { role: "system", content: "You are an agent running on AgentRun. Respond in one sentence." },
        { role: "user", content: "Hello! What are you?" },
      ],
      maxTokens: 50,
    });

    if (result.ok) {
      log.info("LLM test passed", {
        content: result.value.content,
        tokens: result.value.usage,
      });
    } else {
      log.warn("LLM test failed (continuing anyway)", { error: result.error.message });
    }
  }

  log.info("AgentRun Gateway ready", {
    ws: `ws://${config.gateway.host}:${config.gateway.port}`,
    health: `http://${config.gateway.host}:${healthPort}/health`,
  });

  // ─── Graceful Shutdown ───
  const shutdown = async (): Promise<void> => {
    log.info("Gateway shutting down...");

    // Publish shutdown event (non-blocking, best-effort)
    eventBus.publish({
      id: createEventId(),
      channel: "system",
      type: "system.shutdown",
      timestamp: new Date(),
      data: { message: "signal" },
    }).catch((error) => {
      log.warn("Failed to publish shutdown event", {
        error: error instanceof Error ? error.message : String(error),
      });
    });

    await wsServer.drain(15000);
    healthServer.close();
    await memory.stop();
    clearInterval(heartbeatInterval);
    if (retentionInterval) {
      clearInterval(retentionInterval);
    }
    if (clusterHeartbeat) {
      clearInterval(clusterHeartbeat);
    }
    if (clusterCoordinator) {
      await clusterCoordinator.stop();
    }
    tracer.stopExport();
    await jobRunner.stop();
    await db?.close();
    await vectorStore?.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  // Use structured logger if available, fallback to stderr JSON for log aggregation
  const errorInfo = {
    level: "fatal",
    component: "gateway",
    msg: "Gateway failed to start",
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    time: new Date().toISOString(),
  };
  process.stderr.write(JSON.stringify(errorInfo) + "\n");
  process.exit(1);
});

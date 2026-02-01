// Agent OS Gateway — The main daemon process
// Like OpenClaw's gateway — single control plane for everything

import { config as loadEnv } from "dotenv";
import { resolve } from "path";

// Load .env from the monorepo root
loadEnv({ path: resolve(process.cwd(), "../../.env") });

import { createLogger, createConfig } from "@agent-os/kernel";
import { createModelRouter, type ModelRouter } from "@agent-os/mal";
import { createAnthropicProvider } from "@agent-os/provider-anthropic";
import { createOpenAIProvider } from "@agent-os/provider-openai";
import { createGoogleProvider } from "@agent-os/provider-google";
import { createOllamaProvider } from "@agent-os/provider-ollama";
import { createWebSocketServer, type WsMessage, type ClientConnection } from "./websocket.js";
import { createHealthServer } from "./health.js";

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
  const providers = [
    { name: "Anthropic Claude", provider: createAnthropicProvider() },
    { name: "OpenAI GPT", provider: createOpenAIProvider() },
    { name: "Google Gemini", provider: createGoogleProvider() },
    { name: "Ollama (Local)", provider: createOllamaProvider() },
  ];

  for (const { name, provider } of providers) {
    if (await provider.isAvailable()) {
      router.registerProvider(provider);
      logger.info(`${name} provider registered`);
    }
  }

  const models = router.listModels();
  if (models.length === 0) {
    logger.error("No LLM providers available! Add at least one API key to .env");
    process.exit(1);
  }

  logger.info(`Available models: ${models.join(", ")}`);

  // ─── WebSocket Server ───
  const wsServer = createWebSocketServer(
    {
      port: config.gateway.port,
      host: config.gateway.host,
      authToken: config.gateway.token,
    },
    createLogger("ws", config.logging.level),
    async (client, message) => handleClientMessage(client, message, router, logger)
  );

  // ─── Health Server (HTTP on port + 1) ───
  const healthPort = config.gateway.port + 1;
  const healthServer = createHealthServer(
    { port: healthPort, host: config.gateway.host },
    createLogger("health", config.logging.level),
    () => ({
      status: "ok",
      version: "0.1.0",
      providers: models,
      agents: 0, // TODO: Track running agents
      connections: wsServer.getConnectionCount(),
    })
  );

  // ─── Optional: Quick LLM test ───
  if (process.env.TEST_LLM === "true") {
    logger.info("Testing LLM connectivity...");
    const result = await router.route({
      model: "claude-3-haiku-20240307",
      messages: [
        { role: "system", content: "You are an agent running on Agent OS. Respond in one sentence." },
        { role: "user", content: "Hello! What are you?" },
      ],
      maxTokens: 50,
    });

    if (result.ok) {
      logger.info("✅ LLM test passed", {
        content: result.value.content,
        tokens: result.value.usage,
      });
    } else {
      logger.warn("⚠️ LLM test failed (continuing anyway)", { error: result.error.message });
    }
  }

  logger.info("🤖 Agent OS Gateway ready", {
    ws: `ws://${config.gateway.host}:${config.gateway.port}`,
    health: `http://${config.gateway.host}:${healthPort}/health`,
  });

  // ─── Graceful Shutdown ───
  const shutdown = () => {
    logger.info("Gateway shutting down...");
    wsServer.close();
    healthServer.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/** Handle incoming WebSocket messages */
async function handleClientMessage(
  client: ClientConnection,
  message: WsMessage,
  router: ModelRouter,
  logger: ReturnType<typeof createLogger>
): Promise<WsMessage | null> {
  switch (message.type) {
    case "chat": {
      const payload = message.payload as {
        model?: string;
        messages?: Array<{ role: string; content: string }>;
        maxTokens?: number;
      };

      if (!payload.messages || payload.messages.length === 0) {
        return {
          type: "error",
          id: message.id,
          payload: { message: "No messages provided" },
        };
      }

      logger.info("Chat request", { clientId: client.id, model: payload.model });

      const result = await router.route({
        model: payload.model ?? "claude-3-haiku-20240307",
        messages: payload.messages.map((m) => ({
          role: m.role as "system" | "user" | "assistant",
          content: m.content,
        })),
        maxTokens: payload.maxTokens ?? 1024,
      });

      if (result.ok) {
        return {
          type: "chat_response",
          id: message.id,
          payload: {
            content: result.value.content,
            model: result.value.model,
            usage: result.value.usage,
          },
        };
      } else {
        return {
          type: "error",
          id: message.id,
          payload: { message: result.error.message },
        };
      }
    }

    case "agent_status": {
      // TODO: Implement agent status tracking
      return {
        type: "agent_status",
        id: message.id,
        payload: { agents: [], count: 0 },
      };
    }

    default:
      return {
        type: "error",
        id: message.id,
        payload: { message: `Unhandled message type: ${message.type}` },
      };
  }
}

main().catch(console.error);

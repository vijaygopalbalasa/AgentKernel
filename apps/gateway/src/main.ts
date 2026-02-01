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

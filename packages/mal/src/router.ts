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

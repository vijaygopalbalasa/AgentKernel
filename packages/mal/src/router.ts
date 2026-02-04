// Model router with retry, rate limiting, failover, and token tracking
// Distributes requests across providers intelligently

import type { ChatRequest, ChatResponse, Result } from "@agentkernel/shared";
import { ok, err } from "@agentkernel/shared";
import { createLogger, type Logger, getCircuitBreaker, getMetricsRegistry } from "@agentkernel/kernel";
import type { ProviderAdapter, ModelRouter, ProviderStatus, StreamingProviderAdapter } from "./index.js";
import { createRateLimiterRegistry, type RateLimiterRegistry } from "./rate-limiter.js";
import { withRetry, type RetryConfig, DEFAULT_RETRY_CONFIG } from "./retry.js";
import {
  createTokenTracker,
  extractUsage,
  type TokenTracker,
  type TokenTrackerConfig,
} from "./token-tracker.js";
import { collectStream } from "./streaming.js";

/** Router configuration */
export interface RouterConfig {
  /** Enable automatic failover to other providers */
  enableFailover?: boolean;
  /** Maximum failover attempts */
  maxFailoverAttempts?: number;
  /** Retry configuration */
  retryConfig?: Partial<RetryConfig>;
  /** Token tracker configuration */
  tokenTrackerConfig?: TokenTrackerConfig;
  /** Logger instance */
  logger?: Logger;
  /** Model aliases (e.g., "claude" -> "claude-sonnet-4-5-20250929") */
  modelAliases?: Record<string, string>;
  /** Model preferences for fallback (ordered by preference) */
  modelPreferences?: string[];
  /** Provider priority order */
  providerPriority?: string[];
  /** Health check interval in ms (0 to disable) */
  healthCheckIntervalMs?: number;
}

/** Router state for monitoring */
export interface RouterState {
  /** Registered providers */
  providers: ProviderStatus[];
  /** Available models */
  models: string[];
  /** Token usage stats */
  tokenUsage: ReturnType<TokenTracker["getStats"]>;
  /** Rate limiter states */
  rateLimiterStates: ReturnType<RateLimiterRegistry["getAllStates"]>;
  /** Current budget status */
  budgetStatus: ReturnType<TokenTracker["getBudgetStatus"]>;
}

/** Extended model router with production features */
export interface ExtendedModelRouter extends ModelRouter {
  /** Get router state for monitoring */
  getState(): RouterState;

  /** Get token tracker */
  getTokenTracker(): TokenTracker;

  /** Get rate limiter registry */
  getRateLimiterRegistry(): RateLimiterRegistry;

  /** Check provider health */
  checkHealth(providerId?: string): Promise<Record<string, boolean>>;

  /** Set model alias */
  setModelAlias(alias: string, model: string): void;

  /** Set budget limit */
  setBudget(limitUsd: number, period?: "hourly" | "daily" | "weekly" | "monthly"): void;

  /** Unregister a provider */
  unregisterProvider(providerId: string): void;

  /** Get provider by ID */
  getProvider(providerId: string): ProviderAdapter | undefined;

  /** Clean up resources (health check intervals) */
  dispose(): void;
}

/** Default router configuration */
const DEFAULT_CONFIG: Required<RouterConfig> = {
  enableFailover: true,
  maxFailoverAttempts: 3,
  retryConfig: DEFAULT_RETRY_CONFIG,
  tokenTrackerConfig: {},
  logger: createLogger({ name: "mal:router" }),
  modelAliases: {
    // Anthropic aliases
    claude: "claude-sonnet-4-5-20250929",
    "claude-opus": "claude-opus-4-5-20251101",
    "claude-sonnet": "claude-sonnet-4-5-20250929",
    "claude-haiku": "claude-3-5-haiku-20241022",
    // OpenAI aliases
    gpt4: "gpt-4o",
    "gpt-4": "gpt-4o",
    gpt: "gpt-4o",
    "gpt-mini": "gpt-4o-mini",
    // Google aliases
    gemini: "gemini-1.5-pro",
    "gemini-pro": "gemini-1.5-pro",
    "gemini-flash": "gemini-2.0-flash",
  },
  modelPreferences: [
    "claude-sonnet-4-5-20250929",
    "gpt-4o",
    "gemini-1.5-pro",
    "claude-3-5-haiku-20241022",
    "gpt-4o-mini",
    "gemini-1.5-flash",
  ],
  providerPriority: ["anthropic", "openai", "google", "ollama"],
  healthCheckIntervalMs: 60000,
};

/** Generate a unique request ID */
function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

/** Creates a production model router */
export function createModelRouter(config?: RouterConfig): ExtendedModelRouter {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };
  const log = finalConfig.logger;

  const providers = new Map<string, ProviderAdapter>();
  const providerHealth = new Map<string, boolean>();
  const modelToProvider = new Map<string, string[]>();
  const aliases = new Map(Object.entries(finalConfig.modelAliases));

  const rateLimiterRegistry = createRateLimiterRegistry(log);
  const tokenTracker = createTokenTracker(finalConfig.tokenTrackerConfig, log);
  const metrics = getMetricsRegistry();
  const requestCounter = metrics.counter(
    "mal_requests_total",
    "Total LLM requests by provider/model/outcome",
    ["provider", "model", "outcome"]
  );
  const retryCounter = metrics.counter(
    "mal_retries_total",
    "Total retry attempts by provider/model",
    ["provider", "model"]
  );
  const failoverCounter = metrics.counter(
    "mal_failovers_total",
    "Total failover attempts by provider/model",
    ["from", "to", "model"]
  );
  const latencyHistogram = metrics.histogram(
    "mal_latency_seconds",
    "LLM request latency (seconds) by provider/model",
    ["provider", "model"]
  );

  let healthCheckInterval: NodeJS.Timeout | null = null;

  /** Resolve model alias to actual model */
  function resolveModel(model: string): string {
    return aliases.get(model) ?? model;
  }

  /** Find providers that support a model */
  function findProvidersForModel(model: string): ProviderAdapter[] {
    const resolvedModel = resolveModel(model);
    const providerIds = modelToProvider.get(resolvedModel) ?? [];

    // Sort by priority
    const priorityOrder = finalConfig.providerPriority;
    providerIds.sort((a, b) => {
      const aIndex = priorityOrder.indexOf(a);
      const bIndex = priorityOrder.indexOf(b);
      return (aIndex === -1 ? 999 : aIndex) - (bIndex === -1 ? 999 : bIndex);
    });

    return providerIds
      .map((id) => providers.get(id))
      .filter((p): p is ProviderAdapter => p !== undefined);
  }

  /** Find any available provider for fallback */
  function findFallbackProvider(): { provider: ProviderAdapter; model: string } | null {
    for (const model of finalConfig.modelPreferences) {
      const providerList = findProvidersForModel(model);
      for (const provider of providerList) {
        if (providerHealth.get(provider.id) !== false) {
          return { provider, model };
        }
      }
    }

    // Last resort: any available provider
    for (const provider of providers.values()) {
      const firstModel = provider.models[0];
      if (providerHealth.get(provider.id) !== false && firstModel !== undefined) {
        return { provider, model: firstModel };
      }
    }

    return null;
  }

  /** Execute request with a specific provider */
  async function executeWithProvider(
    provider: ProviderAdapter,
    request: ChatRequest,
    requestId: string
  ): Promise<Result<ChatResponse>> {
    const startedAt = Date.now();
    let retryCount = 0;
    const rateLimiter = rateLimiterRegistry.get(provider.id);
    const circuit = getCircuitBreaker(`provider:${provider.id}`, {
      failureThreshold: finalConfig.retryConfig?.maxRetries ? finalConfig.retryConfig.maxRetries + 1 : 5,
      resetTimeout: 30000,
      timeout: 10000,
    });

    // Estimate tokens (rough: 4 chars per token for input, maxTokens for output)
    const inputChars = request.messages.reduce((sum, m) => sum + m.content.length, 0);
    const estimatedInputTokens = Math.ceil(inputChars / 4);
    const estimatedOutputTokens = request.maxTokens ?? 1000;
    const estimatedTotalTokens = estimatedInputTokens + estimatedOutputTokens;

    // Check budget
    if (!tokenTracker.isUnderBudget()) {
      return err(new Error("Budget limit exceeded"));
    }

    // Acquire rate limit capacity
    const acquired = await rateLimiter.acquire(estimatedTotalTokens);
    if (!acquired) {
      return err(new Error(`Rate limit exceeded for provider ${provider.id}`));
    }

    log.debug("Executing request", {
      requestId,
      provider: provider.id,
      model: request.model,
      estimatedTokens: estimatedTotalTokens,
    });

    const circuitResult = await circuit.execute(async () => {
      const result = await withRetry({
        operation: async () => {
          const streamingProvider = provider as StreamingProviderAdapter;
          if (request.stream && streamingProvider.supportsStreaming && streamingProvider.chatStream) {
            // Timeout on stream initialization to prevent hanging on connection setup
            const streamPromise = Promise.resolve(streamingProvider.chatStream(request));
            const stream = await Promise.race([
              streamPromise,
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("Stream initialization timed out")), 30_000)
              ),
            ]);
            const collected = await collectStream(stream, log);
            if (!collected.ok) {
              return err(collected.error);
            }
            return ok({
              content: collected.value.content,
              model: collected.value.model || request.model,
              usage: collected.value.usage,
            });
          }
          return provider.chat(request);
        },
        config: finalConfig.retryConfig,
        logger: log,
        operationName: `${provider.id}:chat`,
        onRetry: () => {
          retryCount += 1;
          retryCounter.inc({ provider: provider.id, model: request.model });
        },
      });
      if (!result.ok) {
        throw result.error;
      }
      return result.value;
    });

    const result = circuitResult.ok
      ? ok(circuitResult.value)
      : err(circuitResult.error);

    const latencyMs = Date.now() - startedAt;
    latencyHistogram.observe({ provider: provider.id, model: request.model }, latencyMs / 1000);

    if (result.ok) {
      requestCounter.inc({ provider: provider.id, model: result.value.model, outcome: "success" });
      // Track token usage
      tokenTracker.record(extractUsage(result.value, provider.id, requestId));

      // Report actual usage to rate limiter
      const actualTokens = result.value.usage.inputTokens + result.value.usage.outputTokens;
      rateLimiter.reportUsage(actualTokens);

      log.info("Request completed", {
        requestId,
        provider: provider.id,
        model: result.value.model,
        inputTokens: result.value.usage.inputTokens,
        outputTokens: result.value.usage.outputTokens,
        latencyMs,
        retryCount,
      });

      return ok({
        ...result.value,
        requestId,
        providerId: provider.id,
        latencyMs,
        retryCount,
      });
    } else {
      requestCounter.inc({ provider: provider.id, model: request.model, outcome: "error" });
      log.error("Request failed", {
        requestId,
        provider: provider.id,
        error: result.error.message,
        latencyMs,
        retryCount,
      });

      // Update provider health
      providerHealth.set(provider.id, false);
    }

    return result;
  }

  /** Start periodic health checks */
  function startHealthChecks(): void {
    if (healthCheckInterval) return;
    if (finalConfig.healthCheckIntervalMs === 0) return; // Disabled

    healthCheckInterval = setInterval(async () => {
      for (const provider of providers.values()) {
        try {
          const healthy = await provider.isAvailable();
          providerHealth.set(provider.id, healthy);
        } catch {
          providerHealth.set(provider.id, false);
        }
      }
    }, finalConfig.healthCheckIntervalMs);

    log.debug("Health checks started", {
      intervalMs: finalConfig.healthCheckIntervalMs,
    });
  }

  const router: ExtendedModelRouter = {
    registerProvider(provider: ProviderAdapter): void {
      providers.set(provider.id, provider);
      providerHealth.set(provider.id, true); // Assume healthy initially

      // Map models to this provider
      for (const model of provider.models) {
        const existing = modelToProvider.get(model) ?? [];
        if (!existing.includes(provider.id)) {
          existing.push(provider.id);
          modelToProvider.set(model, existing);
        }
      }

      log.info("Provider registered", {
        id: provider.id,
        name: provider.name,
        models: provider.models,
      });

      // Start health checks when first provider is registered
      if (providers.size === 1) {
        startHealthChecks();
      }
    },

    unregisterProvider(providerId: string): void {
      const provider = providers.get(providerId);
      if (provider) {
        // Remove model mappings
        for (const model of provider.models) {
          const existing = modelToProvider.get(model) ?? [];
          const index = existing.indexOf(providerId);
          if (index !== -1) {
            existing.splice(index, 1);
          }
          if (existing.length === 0) {
            modelToProvider.delete(model);
          } else {
            modelToProvider.set(model, existing);
          }
        }

        providers.delete(providerId);
        providerHealth.delete(providerId);

        log.info("Provider unregistered", { id: providerId });
      }
    },

    getProvider(providerId: string): ProviderAdapter | undefined {
      return providers.get(providerId);
    },

    listModels(): string[] {
      const models = new Set<string>();

      // Add actual models
      for (const provider of providers.values()) {
        for (const model of provider.models) {
          models.add(model);
        }
      }

      // Add aliases
      for (const alias of aliases.keys()) {
        models.add(alias);
      }

      return Array.from(models).sort();
    },

    async route(request: ChatRequest): Promise<Result<ChatResponse>> {
      const requestId = generateRequestId();
      const resolvedModel = resolveModel(request.model);

      log.debug("Routing request", {
        requestId,
        requestedModel: request.model,
        resolvedModel,
      });

      // Find providers for the requested model
      const matchingProviders = findProvidersForModel(resolvedModel);

      if (matchingProviders.length === 0) {
        log.warn("No provider found for model", {
          requestId,
          model: resolvedModel,
        });

        // Try fallback if enabled
        if (finalConfig.enableFailover) {
          const fallback = findFallbackProvider();
          if (fallback) {
            log.warn("Falling back to alternative model", {
              requestId,
              originalModel: resolvedModel,
              fallbackModel: fallback.model,
              provider: fallback.provider.id,
            });

            return executeWithProvider(
              fallback.provider,
              { ...request, model: fallback.model },
              requestId
            );
          }
        }

        return err(
          new Error(
            `No provider found for model "${request.model}" (resolved: "${resolvedModel}")`
          )
        );
      }

      // Try each provider in order
      let lastError: Error | null = null;
      let attemptCount = 0;

      for (let index = 0; index < matchingProviders.length; index += 1) {
        const provider = matchingProviders[index];
        if (!provider) {
          continue;
        }
        if (attemptCount >= finalConfig.maxFailoverAttempts) {
          break;
        }

        // Skip unhealthy providers
        if (providerHealth.get(provider.id) === false) {
          log.debug("Skipping unhealthy provider", {
            requestId,
            provider: provider.id,
          });
          continue;
        }

        attemptCount++;

        const result = await executeWithProvider(
          provider,
          { ...request, model: resolvedModel },
          requestId
        );

        if (result.ok) {
          const enriched = {
            ...result.value,
            failoverCount: attemptCount > 1 ? attemptCount - 1 : 0,
          };
          return ok(enriched);
        }

        lastError = result.error;

        // If failover is disabled, don't try other providers
        if (!finalConfig.enableFailover) {
          return result;
        }

        const nextProvider = matchingProviders[index + 1];
        if (nextProvider) {
          failoverCounter.inc({ from: provider.id, to: nextProvider.id, model: resolvedModel });
        }
        log.debug("Provider failed, trying next", {
          requestId,
          provider: provider.id,
          error: result.error.message,
          attemptCount,
        });
      }

      // All matching providers failed, try fallback if different model
      if (finalConfig.enableFailover) {
        const fallback = findFallbackProvider();
        if (fallback && fallback.model !== resolvedModel) {
          log.warn("All providers failed, trying fallback model", {
            requestId,
            originalModel: resolvedModel,
            fallbackModel: fallback.model,
            provider: fallback.provider.id,
          });

          const fallbackResult = await executeWithProvider(
            fallback.provider,
            { ...request, model: fallback.model },
            requestId
          );
          if (fallbackResult.ok) {
            const enriched = {
              ...fallbackResult.value,
              failoverCount: attemptCount,
              fallbackModel: fallback.model,
            };
            failoverCounter.inc({ from: "fallback", to: fallback.provider.id, model: fallback.model });
            return ok(enriched);
          }
          return fallbackResult;
        }
      }

      return err(
        lastError ?? new Error("No available LLM providers. Add at least one API key.")
      );
    },

    getState(): RouterState {
      const providerStatuses: ProviderStatus[] = [];

      for (const provider of providers.values()) {
        providerStatuses.push({
          id: provider.id,
          name: provider.name,
          models: [...provider.models],
          healthy: providerHealth.get(provider.id) ?? false,
          rateLimiterState: rateLimiterRegistry.get(provider.id).getState(),
        });
      }

      return {
        providers: providerStatuses,
        models: this.listModels(),
        tokenUsage: tokenTracker.getStats(),
        rateLimiterStates: rateLimiterRegistry.getAllStates(),
        budgetStatus: tokenTracker.getBudgetStatus(),
      };
    },

    getTokenTracker(): TokenTracker {
      return tokenTracker;
    },

    getRateLimiterRegistry(): RateLimiterRegistry {
      return rateLimiterRegistry;
    },

    async checkHealth(providerId?: string): Promise<Record<string, boolean>> {
      const results: Record<string, boolean> = {};

      const toCheck = providerId
        ? [providers.get(providerId)].filter((p): p is ProviderAdapter => !!p)
        : Array.from(providers.values());

      for (const provider of toCheck) {
        try {
          const healthy = await provider.isAvailable();
          providerHealth.set(provider.id, healthy);
          results[provider.id] = healthy;
        } catch {
          providerHealth.set(provider.id, false);
          results[provider.id] = false;
        }
      }

      return results;
    },

    setModelAlias(alias: string, model: string): void {
      aliases.set(alias, model);
      log.debug("Model alias set", { alias, model });
    },

    setBudget(
      limitUsd: number,
      period?: "hourly" | "daily" | "weekly" | "monthly"
    ): void {
      tokenTracker.setBudget(limitUsd, period);
    },

    dispose(): void {
      if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
        log.debug("Router health checks stopped");
      }
    },
  };

  return router;
}

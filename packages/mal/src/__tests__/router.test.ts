import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createModelRouter,
  type ExtendedModelRouter,
  type RouterConfig,
} from "../router.js";
import type { ProviderAdapter } from "../index.js";
import { ok, err, type Result, type ChatRequest, type ChatResponse } from "@agentkernel/shared";

function getFirst<T>(items: T[]): T {
  const first = items[0];
  if (!first) {
    throw new Error("Expected at least one item");
  }
  return first;
}

/** Create a mock provider */
function createMockProvider(
  id: string,
  models: string[],
  options: {
    available?: boolean;
    chatResult?: Result<ChatResponse>;
  } = {}
): ProviderAdapter {
  const { available = true, chatResult } = options;

  return {
    id,
    name: `Mock ${id}`,
    models,
    isAvailable: vi.fn().mockResolvedValue(available),
    chat: vi.fn().mockResolvedValue(
      chatResult ??
        ok({
          content: `Response from ${id}`,
          model: models[0] ?? "test-model",
          usage: { inputTokens: 100, outputTokens: 50 },
        })
    ),
  };
}

describe("Model Router", () => {
  let router: ExtendedModelRouter;

  beforeEach(() => {
    vi.useFakeTimers();
    router = createModelRouter({
      healthCheckIntervalMs: 0, // Disable health checks in tests
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("createModelRouter", () => {
    it("should create a router with all methods", () => {
      expect(router).toHaveProperty("registerProvider");
      expect(router).toHaveProperty("unregisterProvider");
      expect(router).toHaveProperty("getProvider");
      expect(router).toHaveProperty("listModels");
      expect(router).toHaveProperty("route");
      expect(router).toHaveProperty("getState");
      expect(router).toHaveProperty("getTokenTracker");
      expect(router).toHaveProperty("getRateLimiterRegistry");
      expect(router).toHaveProperty("checkHealth");
      expect(router).toHaveProperty("setModelAlias");
      expect(router).toHaveProperty("setBudget");
    });
  });

  describe("registerProvider", () => {
    it("should register a provider", () => {
      const provider = createMockProvider("test", ["model-1"]);
      router.registerProvider(provider);

      expect(router.getProvider("test")).toBe(provider);
    });

    it("should add provider models to available models", () => {
      router.registerProvider(createMockProvider("test", ["model-1", "model-2"]));

      const models = router.listModels();
      expect(models).toContain("model-1");
      expect(models).toContain("model-2");
    });
  });

  describe("unregisterProvider", () => {
    it("should remove a provider", () => {
      const provider = createMockProvider("test", ["model-1"]);
      router.registerProvider(provider);
      router.unregisterProvider("test");

      expect(router.getProvider("test")).toBeUndefined();
    });

    it("should remove provider models from available models", () => {
      router.registerProvider(createMockProvider("test", ["unique-model"]));
      router.unregisterProvider("test");

      const models = router.listModels();
      expect(models).not.toContain("unique-model");
    });
  });

  describe("listModels", () => {
    it("should list all models from all providers", () => {
      router.registerProvider(createMockProvider("provider1", ["model-a", "model-b"]));
      router.registerProvider(createMockProvider("provider2", ["model-c"]));

      const models = router.listModels();

      expect(models).toContain("model-a");
      expect(models).toContain("model-b");
      expect(models).toContain("model-c");
    });

    it("should include model aliases", () => {
      router.setModelAlias("my-alias", "some-model");

      const models = router.listModels();
      expect(models).toContain("my-alias");
    });

    it("should deduplicate models", () => {
      router.registerProvider(createMockProvider("provider1", ["shared-model"]));
      router.registerProvider(createMockProvider("provider2", ["shared-model"]));

      const models = router.listModels();
      const count = models.filter((m) => m === "shared-model").length;
      expect(count).toBe(1);
    });
  });

  describe("route", () => {
    it("should route to provider with matching model", async () => {
      const provider = createMockProvider("test", ["target-model"]);
      router.registerProvider(provider);

      const request: ChatRequest = {
        model: "target-model",
        messages: [{ role: "user", content: "Hello" }],
      };

      const resultPromise = router.route(request);
      await vi.advanceTimersByTimeAsync(100);
      const result = await resultPromise;

      expect(result.ok).toBe(true);
      expect(provider.chat).toHaveBeenCalled();
    });

    it("should resolve model aliases", async () => {
      const provider = createMockProvider("test", ["actual-model"]);
      router.registerProvider(provider);
      router.setModelAlias("alias", "actual-model");

      const request: ChatRequest = {
        model: "alias",
        messages: [{ role: "user", content: "Hello" }],
      };

      const resultPromise = router.route(request);
      await vi.advanceTimersByTimeAsync(100);
      const result = await resultPromise;

      expect(result.ok).toBe(true);
      expect(provider.chat).toHaveBeenCalledWith(
        expect.objectContaining({ model: "actual-model" })
      );
    });

    it("should return error when no provider found", async () => {
      const request: ChatRequest = {
        model: "nonexistent-model",
        messages: [{ role: "user", content: "Hello" }],
      };

      const resultPromise = router.route(request);
      await vi.advanceTimersByTimeAsync(100);
      const result = await resultPromise;

      expect(result.ok).toBe(false);
    });

    it("should failover to next provider on error", async () => {
      const failingProvider = createMockProvider("failing", ["shared-model"], {
        chatResult: err(new Error("Provider failed")),
      });
      const workingProvider = createMockProvider("working", ["shared-model"]);

      router.registerProvider(failingProvider);
      router.registerProvider(workingProvider);

      const request: ChatRequest = {
        model: "shared-model",
        messages: [{ role: "user", content: "Hello" }],
      };

      const resultPromise = router.route(request);
      await vi.advanceTimersByTimeAsync(100);
      const result = await resultPromise;

      expect(result.ok).toBe(true);
      expect(workingProvider.chat).toHaveBeenCalled();
    });

    it("should respect provider priority", async () => {
      // Create router with specific priority
      const routerWithPriority = createModelRouter({
        providerPriority: ["preferred", "fallback"],
        healthCheckIntervalMs: 0, // Disable health checks in tests
      });

      const fallbackProvider = createMockProvider("fallback", ["shared-model"]);
      const preferredProvider = createMockProvider("preferred", ["shared-model"]);

      // Register in reverse order
      routerWithPriority.registerProvider(fallbackProvider);
      routerWithPriority.registerProvider(preferredProvider);

      const request: ChatRequest = {
        model: "shared-model",
        messages: [{ role: "user", content: "Hello" }],
      };

      const resultPromise = routerWithPriority.route(request);
      await vi.advanceTimersByTimeAsync(100);
      await resultPromise;

      // Preferred should be called first
      expect(preferredProvider.chat).toHaveBeenCalled();
    });

    it("should track token usage", async () => {
      const provider = createMockProvider("test", ["model"], {
        chatResult: ok({
          content: "Response",
          model: "model",
          usage: { inputTokens: 100, outputTokens: 50 },
        }),
      });
      router.registerProvider(provider);

      const request: ChatRequest = {
        model: "model",
        messages: [{ role: "user", content: "Hello" }],
      };

      const resultPromise = router.route(request);
      await vi.advanceTimersByTimeAsync(100);
      await resultPromise;

      const stats = router.getTokenTracker().getStats();
      expect(stats.totalInputTokens).toBe(100);
      expect(stats.totalOutputTokens).toBe(50);
    });

    it("should respect budget limits", async () => {
      router.setBudget(0.00001, "daily"); // Very small budget

      const provider = createMockProvider("test", ["model"], {
        chatResult: ok({
          content: "Response",
          model: "model",
          usage: { inputTokens: 1000000, outputTokens: 1000000 },
        }),
      });
      router.registerProvider(provider);

      // First request succeeds but uses up budget
      const request1: ChatRequest = {
        model: "model",
        messages: [{ role: "user", content: "Hello" }],
      };

      const result1Promise = router.route(request1);
      await vi.advanceTimersByTimeAsync(100);
      await result1Promise;

      // Second request should fail due to budget
      const request2: ChatRequest = {
        model: "model",
        messages: [{ role: "user", content: "Another" }],
      };

      const result2Promise = router.route(request2);
      await vi.advanceTimersByTimeAsync(100);
      const result2 = await result2Promise;

      expect(result2.ok).toBe(false);
      if (!result2.ok) {
        expect(result2.error.message).toContain("Budget");
      }
    });
  });

  describe("getState", () => {
    it("should return router state", () => {
      router.registerProvider(createMockProvider("test", ["model"]));

      const state = router.getState();

      expect(state).toHaveProperty("providers");
      expect(state).toHaveProperty("models");
      expect(state).toHaveProperty("tokenUsage");
      expect(state).toHaveProperty("rateLimiterStates");
      expect(state).toHaveProperty("budgetStatus");
    });

    it("should include provider health", () => {
      router.registerProvider(createMockProvider("test", ["model"]));

      const state = router.getState();

      expect(getFirst(state.providers)).toHaveProperty("healthy");
    });
  });

  describe("checkHealth", () => {
    it("should check all providers when no ID specified", async () => {
      const provider1 = createMockProvider("p1", ["m1"], { available: true });
      const provider2 = createMockProvider("p2", ["m2"], { available: false });

      router.registerProvider(provider1);
      router.registerProvider(provider2);

      const health = await router.checkHealth();

      expect(health.p1).toBe(true);
      expect(health.p2).toBe(false);
    });

    it("should check specific provider when ID specified", async () => {
      const provider = createMockProvider("test", ["model"], { available: true });
      router.registerProvider(provider);

      const health = await router.checkHealth("test");

      expect(health.test).toBe(true);
      expect(Object.keys(health).length).toBe(1);
    });
  });

  describe("setModelAlias", () => {
    it("should add model alias", () => {
      router.setModelAlias("fast", "gpt-4o-mini");

      const models = router.listModels();
      expect(models).toContain("fast");
    });
  });

  describe("setBudget", () => {
    it("should set budget limit", () => {
      router.setBudget(100, "daily");

      const status = router.getTokenTracker().getBudgetStatus();
      expect(status.limitUsd).toBe(100);
      expect(status.period).toBe("daily");
    });
  });

  describe("getTokenTracker", () => {
    it("should return token tracker", () => {
      const tracker = router.getTokenTracker();

      expect(tracker).toHaveProperty("record");
      expect(tracker).toHaveProperty("getStats");
    });
  });

  describe("getRateLimiterRegistry", () => {
    it("should return rate limiter registry", () => {
      const registry = router.getRateLimiterRegistry();

      expect(registry).toHaveProperty("get");
      expect(registry).toHaveProperty("configure");
    });
  });
});

describe("RouterConfig", () => {
  it("should accept custom configuration", () => {
    const router = createModelRouter({
      enableFailover: false,
      maxFailoverAttempts: 5,
      modelAliases: { custom: "custom-model" },
      providerPriority: ["custom-provider"],
      healthCheckIntervalMs: 30000,
    });

    expect(router).toBeDefined();
  });
});

describe("Default Model Aliases", () => {
  it("should include common aliases", () => {
    const router = createModelRouter();
    const models = router.listModels();

    // Anthropic aliases
    expect(models).toContain("claude");
    expect(models).toContain("claude-opus");
    expect(models).toContain("claude-sonnet");
    expect(models).toContain("claude-haiku");

    // OpenAI aliases
    expect(models).toContain("gpt");
    expect(models).toContain("gpt4");
    expect(models).toContain("gpt-4");

    // Google aliases
    expect(models).toContain("gemini");
    expect(models).toContain("gemini-pro");
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createTokenTracker,
  extractUsage,
  DEFAULT_MODEL_PRICING,
  type TokenTracker,
  type TokenUsage,
} from "../token-tracker.js";
import type { ChatResponse } from "@agentkernel/shared";

describe("Token Tracker", () => {
  let tracker: TokenTracker;

  beforeEach(() => {
    tracker = createTokenTracker();
  });

  describe("createTokenTracker", () => {
    it("should create a token tracker with all methods", () => {
      expect(tracker).toHaveProperty("record");
      expect(tracker).toHaveProperty("getStats");
      expect(tracker).toHaveProperty("getHistory");
      expect(tracker).toHaveProperty("getBudgetStatus");
      expect(tracker).toHaveProperty("isUnderBudget");
      expect(tracker).toHaveProperty("estimateCost");
      expect(tracker).toHaveProperty("setBudget");
      expect(tracker).toHaveProperty("reset");
      expect(tracker).toHaveProperty("getPricing");
      expect(tracker).toHaveProperty("setPricing");
    });
  });

  describe("record", () => {
    it("should record token usage", () => {
      const usage = tracker.record({
        inputTokens: 100,
        outputTokens: 50,
        model: "gpt-4o",
        providerId: "openai",
      });

      expect(usage.inputTokens).toBe(100);
      expect(usage.outputTokens).toBe(50);
      expect(usage.totalTokens).toBe(150);
      expect(usage.model).toBe("gpt-4o");
      expect(usage.providerId).toBe("openai");
      expect(usage.timestamp).toBeInstanceOf(Date);
      expect(usage.estimatedCostUsd).toBeGreaterThan(0);
    });

    it("should calculate cost correctly", () => {
      const usage = tracker.record({
        inputTokens: 1000000, // 1M input tokens
        outputTokens: 0,
        model: "gpt-4o",
        providerId: "openai",
      });

      // gpt-4o input is $2.5 per 1M tokens
      expect(usage.estimatedCostUsd).toBeCloseTo(2.5, 2);
    });

    it("should add to history", () => {
      tracker.record({
        inputTokens: 100,
        outputTokens: 50,
        model: "gpt-4o",
        providerId: "openai",
      });

      const history = tracker.getHistory();
      expect(history.length).toBe(1);
    });

    it("should include requestId when provided", () => {
      const usage = tracker.record({
        inputTokens: 100,
        outputTokens: 50,
        model: "gpt-4o",
        providerId: "openai",
        requestId: "req_123",
      });

      expect(usage.requestId).toBe("req_123");
    });
  });

  describe("getStats", () => {
    it("should return empty stats when no usage recorded", () => {
      const stats = tracker.getStats();

      expect(stats.totalInputTokens).toBe(0);
      expect(stats.totalOutputTokens).toBe(0);
      expect(stats.totalTokens).toBe(0);
      expect(stats.totalCostUsd).toBe(0);
      expect(stats.requestCount).toBe(0);
    });

    it("should aggregate stats correctly", () => {
      tracker.record({
        inputTokens: 100,
        outputTokens: 50,
        model: "gpt-4o",
        providerId: "openai",
      });

      tracker.record({
        inputTokens: 200,
        outputTokens: 100,
        model: "claude-sonnet-4-5-20250929",
        providerId: "anthropic",
      });

      const stats = tracker.getStats();

      expect(stats.totalInputTokens).toBe(300);
      expect(stats.totalOutputTokens).toBe(150);
      expect(stats.totalTokens).toBe(450);
      expect(stats.requestCount).toBe(2);
      expect(stats.avgTokensPerRequest).toBe(225);
    });

    it("should break down by provider", () => {
      tracker.record({
        inputTokens: 100,
        outputTokens: 50,
        model: "gpt-4o",
        providerId: "openai",
      });

      tracker.record({
        inputTokens: 200,
        outputTokens: 100,
        model: "claude-sonnet-4-5-20250929",
        providerId: "anthropic",
      });

      const stats = tracker.getStats();

      const openai = stats.byProvider.openai;
      const anthropic = stats.byProvider.anthropic;
      expect(openai).toBeDefined();
      expect(anthropic).toBeDefined();
      if (!openai || !anthropic) return;
      expect(openai.inputTokens).toBe(100);
      expect(anthropic.inputTokens).toBe(200);
    });

    it("should break down by model", () => {
      tracker.record({
        inputTokens: 100,
        outputTokens: 50,
        model: "gpt-4o",
        providerId: "openai",
      });

      tracker.record({
        inputTokens: 200,
        outputTokens: 100,
        model: "gpt-4o",
        providerId: "openai",
      });

      const stats = tracker.getStats();

      const gpt4o = stats.byModel["gpt-4o"];
      expect(gpt4o).toBeDefined();
      if (!gpt4o) return;
      expect(gpt4o.inputTokens).toBe(300);
      expect(gpt4o.requestCount).toBe(2);
    });

    it("should filter by time range", () => {
      const now = new Date();
      const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);

      tracker.record({
        inputTokens: 100,
        outputTokens: 50,
        model: "gpt-4o",
        providerId: "openai",
      });

      const stats = tracker.getStats({
        from: hourAgo,
        to: now,
      });

      expect(stats.requestCount).toBe(1);
    });
  });

  describe("getHistory", () => {
    it("should return usage history", () => {
      tracker.record({
        inputTokens: 100,
        outputTokens: 50,
        model: "gpt-4o",
        providerId: "openai",
      });

      tracker.record({
        inputTokens: 200,
        outputTokens: 100,
        model: "claude-sonnet-4-5-20250929",
        providerId: "anthropic",
      });

      const history = tracker.getHistory();

      expect(history.length).toBe(2);
    });

    it("should respect limit parameter", () => {
      for (let i = 0; i < 10; i++) {
        tracker.record({
          inputTokens: 100,
          outputTokens: 50,
          model: "gpt-4o",
          providerId: "openai",
        });
      }

      const history = tracker.getHistory(5);
      expect(history.length).toBe(5);
    });

    it("should return most recent entries", () => {
      for (let i = 0; i < 10; i++) {
        tracker.record({
          inputTokens: i,
          outputTokens: 0,
          model: "gpt-4o",
          providerId: "openai",
        });
      }

      const history = tracker.getHistory(3);
      const first = history[0];
      const second = history[1];
      const third = history[2];
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      expect(third).toBeDefined();
      if (!first || !second || !third) return;
      expect(first.inputTokens).toBe(7);
      expect(second.inputTokens).toBe(8);
      expect(third.inputTokens).toBe(9);
    });
  });

  describe("budget management", () => {
    it("should return no budget when not set", () => {
      const status = tracker.getBudgetStatus();

      expect(status.limitUsd).toBeNull();
      expect(status.exceeded).toBe(false);
    });

    it("should track budget", () => {
      tracker.setBudget(10, "daily");

      const status = tracker.getBudgetStatus();

      expect(status.limitUsd).toBe(10);
      expect(status.currentSpendUsd).toBe(0);
      expect(status.remainingUsd).toBe(10);
      expect(status.percentUsed).toBe(0);
    });

    it("should detect budget exceeded", () => {
      tracker.setBudget(0.001, "daily"); // Very small budget

      tracker.record({
        inputTokens: 1000000, // This will cost more than $0.001
        outputTokens: 1000000,
        model: "gpt-4o",
        providerId: "openai",
      });

      const status = tracker.getBudgetStatus();
      expect(status.exceeded).toBe(true);
    });

    it("should check if under budget", () => {
      tracker.setBudget(100, "daily");

      expect(tracker.isUnderBudget()).toBe(true);

      tracker.setBudget(0.0001, "daily");

      tracker.record({
        inputTokens: 1000000,
        outputTokens: 0,
        model: "gpt-4o",
        providerId: "openai",
      });

      expect(tracker.isUnderBudget()).toBe(false);
    });
  });

  describe("estimateCost", () => {
    it("should estimate cost for known models", () => {
      // gpt-4o: $2.5/1M input, $10/1M output
      const cost = tracker.estimateCost("gpt-4o", 1000000, 500000);
      expect(cost).toBeCloseTo(2.5 + 5, 2); // 7.5
    });

    it("should use default pricing for unknown models", () => {
      const cost = tracker.estimateCost("unknown-model", 1000000, 1000000);
      expect(cost).toBeGreaterThan(0);
    });
  });

  describe("pricing", () => {
    it("should get pricing for known models", () => {
      const pricing = tracker.getPricing("gpt-4o");
      expect(pricing.inputPer1M).toBe(2.5);
      expect(pricing.outputPer1M).toBe(10);
    });

    it("should set custom pricing", () => {
      tracker.setPricing("custom-model", {
        inputPer1M: 5,
        outputPer1M: 15,
      });

      const pricing = tracker.getPricing("custom-model");
      expect(pricing.inputPer1M).toBe(5);
      expect(pricing.outputPer1M).toBe(15);
    });

    it("should use custom pricing for cost calculation", () => {
      tracker.setPricing("custom-model", {
        inputPer1M: 10,
        outputPer1M: 20,
      });

      const usage = tracker.record({
        inputTokens: 1000000,
        outputTokens: 500000,
        model: "custom-model",
        providerId: "custom",
      });

      expect(usage.estimatedCostUsd).toBeCloseTo(10 + 10, 2); // 20
    });
  });

  describe("reset", () => {
    it("should clear history", () => {
      tracker.record({
        inputTokens: 100,
        outputTokens: 50,
        model: "gpt-4o",
        providerId: "openai",
      });

      tracker.reset();

      const history = tracker.getHistory();
      expect(history.length).toBe(0);
    });
  });
});

describe("extractUsage", () => {
  it("should extract usage from chat response", () => {
    const response: ChatResponse = {
      content: "Hello!",
      model: "gpt-4o",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
      },
    };

    const usage = extractUsage(response, "openai", "req_123");

    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(50);
    expect(usage.model).toBe("gpt-4o");
    expect(usage.providerId).toBe("openai");
    expect(usage.requestId).toBe("req_123");
  });
});

describe("DEFAULT_MODEL_PRICING", () => {
  it("should have pricing for Anthropic models", () => {
    expect(DEFAULT_MODEL_PRICING["claude-opus-4-5-20251101"]).toBeDefined();
    expect(DEFAULT_MODEL_PRICING["claude-sonnet-4-5-20250929"]).toBeDefined();
    expect(DEFAULT_MODEL_PRICING["claude-3-5-haiku-20241022"]).toBeDefined();
  });

  it("should have pricing for OpenAI models", () => {
    expect(DEFAULT_MODEL_PRICING["gpt-4o"]).toBeDefined();
    expect(DEFAULT_MODEL_PRICING["gpt-4o-mini"]).toBeDefined();
    expect(DEFAULT_MODEL_PRICING["gpt-4-turbo"]).toBeDefined();
  });

  it("should have pricing for Google models", () => {
    expect(DEFAULT_MODEL_PRICING["gemini-1.5-pro"]).toBeDefined();
    expect(DEFAULT_MODEL_PRICING["gemini-1.5-flash"]).toBeDefined();
  });

  it("should have zero cost for local models", () => {
    const llamaPricing = DEFAULT_MODEL_PRICING["llama-3.2"];
    expect(llamaPricing).toBeDefined();
    if (!llamaPricing) return;
    expect(llamaPricing.inputPer1M).toBe(0);
    expect(llamaPricing.outputPer1M).toBe(0);
  });
});

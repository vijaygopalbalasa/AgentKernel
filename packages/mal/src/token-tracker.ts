// Token usage tracking and cost estimation
// Monitors LLM usage for budgeting and analytics

import type { Logger } from "@agentkernel/kernel";
import type { ChatResponse } from "@agentkernel/shared";

/** Token usage record */
export interface TokenUsage {
  /** Input/prompt tokens */
  inputTokens: number;
  /** Output/completion tokens */
  outputTokens: number;
  /** Total tokens */
  totalTokens: number;
  /** Estimated cost in USD */
  estimatedCostUsd: number;
  /** Timestamp of usage */
  timestamp: Date;
  /** Model used */
  model: string;
  /** Provider ID */
  providerId: string;
  /** Request ID for correlation */
  requestId?: string;
}

/** Aggregated usage statistics */
export interface UsageStats {
  /** Total input tokens */
  totalInputTokens: number;
  /** Total output tokens */
  totalOutputTokens: number;
  /** Total tokens */
  totalTokens: number;
  /** Total estimated cost in USD */
  totalCostUsd: number;
  /** Number of requests */
  requestCount: number;
  /** Average tokens per request */
  avgTokensPerRequest: number;
  /** Usage by provider */
  byProvider: Record<string, ProviderUsage>;
  /** Usage by model */
  byModel: Record<string, ModelUsage>;
  /** Time range */
  timeRange: {
    from: Date;
    to: Date;
  };
}

/** Per-provider usage stats */
export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  requestCount: number;
}

/** Per-model usage stats */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  requestCount: number;
}

/** Model pricing per 1M tokens (USD) */
export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

/** Default pricing for common models (as of 2025) */
export const DEFAULT_MODEL_PRICING: Record<string, ModelPricing> = {
  // Anthropic models
  "claude-opus-4-5-20251101": { inputPer1M: 15.0, outputPer1M: 75.0 },
  "claude-sonnet-4-5-20250929": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "claude-3-5-haiku-20241022": { inputPer1M: 0.8, outputPer1M: 4.0 },
  "claude-3-5-sonnet-20241022": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "claude-3-opus-20240229": { inputPer1M: 15.0, outputPer1M: 75.0 },
  "claude-3-haiku-20240307": { inputPer1M: 0.25, outputPer1M: 1.25 },

  // OpenAI models
  "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10.0 },
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  "gpt-4-turbo": { inputPer1M: 10.0, outputPer1M: 30.0 },
  "gpt-4": { inputPer1M: 30.0, outputPer1M: 60.0 },
  "gpt-3.5-turbo": { inputPer1M: 0.5, outputPer1M: 1.5 },
  "o1": { inputPer1M: 15.0, outputPer1M: 60.0 },
  "o1-mini": { inputPer1M: 3.0, outputPer1M: 12.0 },

  // Google models
  "gemini-1.5-pro": { inputPer1M: 1.25, outputPer1M: 5.0 },
  "gemini-1.5-flash": { inputPer1M: 0.075, outputPer1M: 0.3 },
  "gemini-2.0-flash": { inputPer1M: 0.1, outputPer1M: 0.4 },
  "gemini-2.0-pro": { inputPer1M: 2.0, outputPer1M: 8.0 },

  // Local models (free)
  "llama-3.2": { inputPer1M: 0, outputPer1M: 0 },
  "llama-3.1": { inputPer1M: 0, outputPer1M: 0 },
  "mistral": { inputPer1M: 0, outputPer1M: 0 },
  "mixtral": { inputPer1M: 0, outputPer1M: 0 },
  "codellama": { inputPer1M: 0, outputPer1M: 0 },
};

/** Default pricing for unknown models */
const DEFAULT_UNKNOWN_PRICING: ModelPricing = {
  inputPer1M: 1.0,
  outputPer1M: 3.0,
};

/** Token tracker configuration */
export interface TokenTrackerConfig {
  /** Custom model pricing */
  customPricing?: Record<string, ModelPricing>;
  /** Maximum history entries to keep */
  maxHistorySize?: number;
  /** Budget alert threshold in USD */
  budgetAlertThreshold?: number;
  /** Budget limit in USD (hard stop) */
  budgetLimit?: number;
  /** Reset budget period */
  budgetPeriod?: "hourly" | "daily" | "weekly" | "monthly";
}

/** Token tracker interface */
export interface TokenTracker {
  /** Record token usage */
  record(usage: Omit<TokenUsage, "timestamp" | "totalTokens" | "estimatedCostUsd">): TokenUsage;

  /** Get aggregated stats */
  getStats(options?: { from?: Date; to?: Date }): UsageStats;

  /** Get recent usage history */
  getHistory(limit?: number): TokenUsage[];

  /** Get current budget status */
  getBudgetStatus(): BudgetStatus;

  /** Check if under budget */
  isUnderBudget(): boolean;

  /** Estimate cost for a request */
  estimateCost(model: string, inputTokens: number, outputTokens: number): number;

  /** Set budget */
  setBudget(limitUsd: number, period?: "hourly" | "daily" | "weekly" | "monthly"): void;

  /** Reset usage tracking */
  reset(): void;

  /** Get pricing for a model */
  getPricing(model: string): ModelPricing;

  /** Set custom pricing for a model */
  setPricing(model: string, pricing: ModelPricing): void;
}

/** Budget status */
export interface BudgetStatus {
  /** Current spend in USD */
  currentSpendUsd: number;
  /** Budget limit in USD */
  limitUsd: number | null;
  /** Remaining budget in USD */
  remainingUsd: number | null;
  /** Percentage of budget used */
  percentUsed: number | null;
  /** Whether budget is exceeded */
  exceeded: boolean;
  /** Whether alert threshold reached */
  alertTriggered: boolean;
  /** Budget period */
  period: "hourly" | "daily" | "weekly" | "monthly" | null;
  /** Period start time */
  periodStart: Date | null;
}

/** Create a token tracker */
export function createTokenTracker(
  config?: TokenTrackerConfig,
  logger?: Logger
): TokenTracker {
  const maxHistorySize = config?.maxHistorySize ?? 10000;
  const history: TokenUsage[] = [];
  const customPricing: Record<string, ModelPricing> = {
    ...config?.customPricing,
  };

  let budgetLimit = config?.budgetLimit ?? null;
  let budgetAlertThreshold = config?.budgetAlertThreshold ?? null;
  let budgetPeriod = config?.budgetPeriod ?? null;
  let periodStart: Date | null = budgetPeriod ? new Date() : null;

  /** Get pricing for a model */
  function getPricing(model: string): ModelPricing {
    // Check custom pricing first
    if (customPricing[model]) {
      return customPricing[model];
    }

    // Check default pricing (exact match)
    if (DEFAULT_MODEL_PRICING[model]) {
      return DEFAULT_MODEL_PRICING[model];
    }

    // Try to match by prefix (e.g., "gpt-4o-2024-..." matches "gpt-4o")
    for (const [key, pricing] of Object.entries(DEFAULT_MODEL_PRICING)) {
      if (model.startsWith(key)) {
        return pricing;
      }
    }

    logger?.debug("Using default pricing for unknown model", { model });
    return DEFAULT_UNKNOWN_PRICING;
  }

  /** Calculate cost */
  function calculateCost(
    model: string,
    inputTokens: number,
    outputTokens: number
  ): number {
    const pricing = getPricing(model);
    const inputCost = (inputTokens / 1_000_000) * pricing.inputPer1M;
    const outputCost = (outputTokens / 1_000_000) * pricing.outputPer1M;
    return inputCost + outputCost;
  }

  /** Get period start time */
  function getPeriodStart(period: "hourly" | "daily" | "weekly" | "monthly"): Date {
    const now = new Date();
    switch (period) {
      case "hourly":
        return new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours());
      case "daily":
        return new Date(now.getFullYear(), now.getMonth(), now.getDate());
      case "weekly": {
        const day = now.getDay();
        const diff = now.getDate() - day;
        return new Date(now.getFullYear(), now.getMonth(), diff);
      }
      case "monthly":
        return new Date(now.getFullYear(), now.getMonth(), 1);
    }
  }

  /** Check and reset period if needed */
  function checkPeriodReset(): void {
    if (!budgetPeriod || !periodStart) return;

    const newPeriodStart = getPeriodStart(budgetPeriod);
    if (newPeriodStart.getTime() > periodStart.getTime()) {
      logger?.info("Budget period reset", {
        period: budgetPeriod,
        oldStart: periodStart.toISOString(),
        newStart: newPeriodStart.toISOString(),
      });
      periodStart = newPeriodStart;
    }
  }

  /** Get current period spend */
  function getCurrentPeriodSpend(): number {
    if (!budgetPeriod || !periodStart) {
      return history.reduce((sum, u) => sum + u.estimatedCostUsd, 0);
    }

    checkPeriodReset();
    return history
      .filter((u) => u.timestamp >= periodStart!)
      .reduce((sum, u) => sum + u.estimatedCostUsd, 0);
  }

  return {
    record(
      usage: Omit<TokenUsage, "timestamp" | "totalTokens" | "estimatedCostUsd">
    ): TokenUsage {
      const totalTokens = usage.inputTokens + usage.outputTokens;
      const estimatedCostUsd = calculateCost(
        usage.model,
        usage.inputTokens,
        usage.outputTokens
      );

      const record: TokenUsage = {
        ...usage,
        totalTokens,
        estimatedCostUsd,
        timestamp: new Date(),
      };

      history.push(record);

      // Trim history if needed
      while (history.length > maxHistorySize) {
        history.shift();
      }

      logger?.debug("Token usage recorded", {
        model: usage.model,
        providerId: usage.providerId,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUsd: estimatedCostUsd.toFixed(6),
      });

      // Check budget alerts
      if (budgetLimit !== null || budgetAlertThreshold !== null) {
        const currentSpend = getCurrentPeriodSpend();

        if (budgetLimit !== null && currentSpend >= budgetLimit) {
          logger?.warn("Budget limit exceeded", {
            currentSpend,
            limit: budgetLimit,
            period: budgetPeriod,
          });
        } else if (
          budgetAlertThreshold !== null &&
          currentSpend >= budgetAlertThreshold
        ) {
          logger?.warn("Budget alert threshold reached", {
            currentSpend,
            threshold: budgetAlertThreshold,
            limit: budgetLimit,
            period: budgetPeriod,
          });
        }
      }

      return record;
    },

    getStats(options?: { from?: Date; to?: Date }): UsageStats {
      const from = options?.from ?? new Date(0);
      const to = options?.to ?? new Date();

      const filtered = history.filter(
        (u) => u.timestamp >= from && u.timestamp <= to
      );

      const byProvider: Record<string, ProviderUsage> = {};
      const byModel: Record<string, ModelUsage> = {};

      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let totalCostUsd = 0;

      for (const usage of filtered) {
        totalInputTokens += usage.inputTokens;
        totalOutputTokens += usage.outputTokens;
        totalCostUsd += usage.estimatedCostUsd;

        // By provider
        let providerStats = byProvider[usage.providerId];
        if (!providerStats) {
          providerStats = {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            costUsd: 0,
            requestCount: 0,
          };
          byProvider[usage.providerId] = providerStats;
        }
        providerStats.inputTokens += usage.inputTokens;
        providerStats.outputTokens += usage.outputTokens;
        providerStats.totalTokens += usage.totalTokens;
        providerStats.costUsd += usage.estimatedCostUsd;
        providerStats.requestCount++;

        // By model
        let modelStats = byModel[usage.model];
        if (!modelStats) {
          modelStats = {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            costUsd: 0,
            requestCount: 0,
          };
          byModel[usage.model] = modelStats;
        }
        modelStats.inputTokens += usage.inputTokens;
        modelStats.outputTokens += usage.outputTokens;
        modelStats.totalTokens += usage.totalTokens;
        modelStats.costUsd += usage.estimatedCostUsd;
        modelStats.requestCount++;
      }

      return {
        totalInputTokens,
        totalOutputTokens,
        totalTokens: totalInputTokens + totalOutputTokens,
        totalCostUsd,
        requestCount: filtered.length,
        avgTokensPerRequest:
          filtered.length > 0
            ? (totalInputTokens + totalOutputTokens) / filtered.length
            : 0,
        byProvider,
        byModel,
        timeRange: { from, to },
      };
    },

    getHistory(limit: number = 100): TokenUsage[] {
      return history.slice(-limit);
    },

    getBudgetStatus(): BudgetStatus {
      checkPeriodReset();
      const currentSpend = getCurrentPeriodSpend();
      const remaining = budgetLimit !== null ? budgetLimit - currentSpend : null;
      const percentUsed =
        budgetLimit !== null ? (currentSpend / budgetLimit) * 100 : null;

      return {
        currentSpendUsd: currentSpend,
        limitUsd: budgetLimit,
        remainingUsd: remaining,
        percentUsed,
        exceeded: budgetLimit !== null && currentSpend >= budgetLimit,
        alertTriggered:
          budgetAlertThreshold !== null && currentSpend >= budgetAlertThreshold,
        period: budgetPeriod,
        periodStart,
      };
    },

    isUnderBudget(): boolean {
      if (budgetLimit === null) return true;
      checkPeriodReset();
      return getCurrentPeriodSpend() < budgetLimit;
    },

    estimateCost(model: string, inputTokens: number, outputTokens: number): number {
      return calculateCost(model, inputTokens, outputTokens);
    },

    setBudget(
      limitUsd: number,
      period?: "hourly" | "daily" | "weekly" | "monthly"
    ): void {
      budgetLimit = limitUsd;
      if (period) {
        budgetPeriod = period;
        periodStart = getPeriodStart(period);
      }
      budgetAlertThreshold = limitUsd * 0.8; // Alert at 80%

      logger?.info("Budget set", {
        limit: limitUsd,
        period,
        alertThreshold: budgetAlertThreshold,
      });
    },

    reset(): void {
      history.length = 0;
      if (budgetPeriod) {
        periodStart = getPeriodStart(budgetPeriod);
      }
      logger?.debug("Token tracker reset");
    },

    getPricing,

    setPricing(model: string, pricing: ModelPricing): void {
      customPricing[model] = pricing;
      logger?.debug("Custom pricing set", { model, pricing });
    },
  };
}

/** Extract usage from a chat response */
export function extractUsage(
  response: ChatResponse,
  providerId: string,
  requestId?: string
): Omit<TokenUsage, "timestamp" | "totalTokens" | "estimatedCostUsd"> {
  return {
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    model: response.model,
    providerId,
    requestId,
  };
}

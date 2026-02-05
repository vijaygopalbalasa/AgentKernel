// Agent Context — runtime state and resources for an agent instance
// Like Android's ApplicationContext

import type { AgentState } from "./state-machine.js";

/** Unique identifier for an agent instance */
export type AgentId = string;

/** Resource limits for an agent */
export interface ResourceLimits {
  /** Maximum tokens per request */
  maxTokensPerRequest: number;
  /** Maximum total tokens per minute */
  tokensPerMinute: number;
  /** Maximum memory in MB */
  maxMemoryMB: number;
  /** Maximum concurrent requests */
  maxConcurrentRequests: number;
  /** Cost budget in USD (0 = unlimited) */
  costBudgetUSD: number;
}

/** Resource usage tracking */
export interface ResourceUsage {
  /** Total input tokens consumed */
  inputTokens: number;
  /** Total output tokens consumed */
  outputTokens: number;
  /** Total requests made */
  requestCount: number;
  /** Estimated cost in USD */
  estimatedCostUSD: number;
  /** Current memory usage in MB */
  currentMemoryMB: number;
  /** Active concurrent requests */
  activeRequests: number;
  /** Tokens used in current minute window */
  tokensThisMinute: number;
  /** Start of current minute window */
  minuteWindowStart: Date;
}

/** Agent metadata from manifest */
export interface AgentMetadata {
  /** Agent name */
  name: string;
  /** Version string */
  version: string;
  /** Description */
  description?: string;
  /** Author */
  author?: string;
  /** Tags for discovery */
  tags?: string[];
}

/** Runtime context for an agent instance */
export interface AgentContext {
  /** Unique instance identifier */
  readonly id: AgentId;
  /** Agent metadata from manifest */
  readonly metadata: AgentMetadata;
  /** Current state */
  readonly state: AgentState;
  /** Resource limits */
  readonly limits: ResourceLimits;
  /** Current resource usage */
  readonly usage: ResourceUsage;
  /** When the agent was created */
  readonly createdAt: Date;
  /** When the agent last transitioned states */
  readonly lastStateChange: Date;
  /** Parent agent ID (if spawned by another agent) */
  readonly parentId?: AgentId;
  /** Environment variables available to the agent */
  readonly env: Record<string, string>;
}

/** Default resource limits for new agents */
export const DEFAULT_LIMITS: ResourceLimits = {
  maxTokensPerRequest: 4096,
  tokensPerMinute: 100_000,
  maxMemoryMB: 512,
  maxConcurrentRequests: 5,
  costBudgetUSD: 0, // Unlimited by default
};

/** Create initial resource usage tracker */
export function createInitialUsage(): ResourceUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    requestCount: 0,
    estimatedCostUSD: 0,
    currentMemoryMB: 0,
    activeRequests: 0,
    tokensThisMinute: 0,
    minuteWindowStart: new Date(),
  };
}

/** Check if usage exceeds limits */
export function checkLimits(usage: ResourceUsage, limits: ResourceLimits): LimitCheckResult {
  const violations: string[] = [];

  if (usage.activeRequests >= limits.maxConcurrentRequests) {
    violations.push(
      `Max concurrent requests exceeded (${usage.activeRequests}/${limits.maxConcurrentRequests})`,
    );
  }

  if (usage.tokensThisMinute >= limits.tokensPerMinute) {
    violations.push(
      `Rate limit exceeded (${usage.tokensThisMinute}/${limits.tokensPerMinute} tokens/min)`,
    );
  }

  if (usage.currentMemoryMB >= limits.maxMemoryMB) {
    violations.push(`Memory limit exceeded (${usage.currentMemoryMB}/${limits.maxMemoryMB} MB)`);
  }

  if (limits.costBudgetUSD > 0 && usage.estimatedCostUSD >= limits.costBudgetUSD) {
    violations.push(
      `Cost budget exceeded ($${usage.estimatedCostUSD.toFixed(4)}/$${limits.costBudgetUSD})`,
    );
  }

  return {
    allowed: violations.length === 0,
    violations,
  };
}

export interface LimitCheckResult {
  allowed: boolean;
  violations: string[];
}

/** Default pricing for unknown models */
const DEFAULT_PRICING = { input: 1.0, output: 3.0 };

/** Simplified pricing (per 1M tokens) */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Claude models
  "claude-opus-4-5-20251101": { input: 15.0, output: 75.0 },
  "claude-sonnet-4-5-20250929": { input: 3.0, output: 15.0 },
  "claude-3-5-haiku-20241022": { input: 1.0, output: 5.0 },
  "claude-3-haiku-20240307": { input: 0.25, output: 1.25 },
  // GPT models
  "gpt-4o": { input: 5.0, output: 15.0 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4-turbo": { input: 10.0, output: 30.0 },
  // Gemini (approximate)
  "gemini-2.5-pro": { input: 1.25, output: 5.0 },
  "gemini-2.5-flash": { input: 0.075, output: 0.3 },
};

/** Estimate cost based on model and tokens (simplified) */
export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model] ?? DEFAULT_PRICING;
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;

  return inputCost + outputCost;
}

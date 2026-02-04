// @agentrun/mal — Model Abstraction Layer (Layer 2)
// Like Android's HAL — makes ANY AI model work through a standard interface

import type { ChatRequest, ChatResponse, Result } from "@agentrun/shared";
import type { RateLimiterState } from "./rate-limiter.js";

// ─── Provider Adapter Interface ───
// Every LLM provider implements this interface

/** Provider adapter interface — every LLM provider implements this */
export interface ProviderAdapter {
  /** Unique provider identifier */
  readonly id: string;
  /** Human-readable provider name */
  readonly name: string;
  /** Models supported by this provider */
  readonly models: string[];

  /** Send a chat completion request */
  chat(request: ChatRequest): Promise<Result<ChatResponse>>;

  /** Check if provider is available (has valid API key, etc.) */
  isAvailable(): Promise<boolean>;
}

/** Streaming provider adapter (optional extension) */
export interface StreamingProviderAdapter extends ProviderAdapter {
  /** Whether this provider supports streaming */
  readonly supportsStreaming: boolean;

  /** Send a streaming chat request */
  chatStream?(
    request: ChatRequest
  ): AsyncGenerator<import("./streaming.js").StreamChunk>;
}

// ─── Model Router Interface ───

/** Model router — picks the best provider/model for each request */
export interface ModelRouter {
  /** Route a request to the best available provider */
  route(request: ChatRequest): Promise<Result<ChatResponse>>;

  /** Register a provider adapter */
  registerProvider(provider: ProviderAdapter): void;

  /** List all available models across all providers */
  listModels(): string[];
}

// ─── Provider Status ───

/** Provider status for monitoring */
export interface ProviderStatus {
  /** Provider ID */
  id: string;
  /** Provider name */
  name: string;
  /** Supported models */
  models: string[];
  /** Whether provider is healthy */
  healthy: boolean;
  /** Rate limiter state */
  rateLimiterState: RateLimiterState;
}

// ─── Re-exports ───

// Router
export { createModelRouter, type RouterConfig, type RouterState, type ExtendedModelRouter } from "./router.js";

// Rate Limiting
export {
  createRateLimiter,
  createRateLimiterRegistry,
  DEFAULT_RATE_LIMITS,
  type RateLimitConfig,
  type RateLimiter,
  type RateLimiterState,
  type RateLimiterRegistry,
} from "./rate-limiter.js";

// Retry Logic
export {
  withRetry,
  isRetryableError,
  calculateRetryDelay,
  createRetryWrapper,
  retryable,
  DEFAULT_RETRY_CONFIG,
  type RetryConfig,
  type RetryState,
  type WithRetryOptions,
} from "./retry.js";

// Token Tracking
export {
  createTokenTracker,
  extractUsage,
  DEFAULT_MODEL_PRICING,
  type TokenTracker,
  type TokenUsage,
  type UsageStats,
  type ProviderUsage,
  type ModelUsage,
  type ModelPricing,
  type TokenTrackerConfig,
  type BudgetStatus,
} from "./token-tracker.js";

// Streaming
export {
  createStreamController,
  estimateTokens,
  transformProviderStream,
  createChunkBuffer,
  throttleStream,
  collectStream,
  responseToStream,
  type StreamChunk,
  type StreamResult,
  type StreamHandler,
  type StreamOptions,
  type StreamController,
} from "./streaming.js";

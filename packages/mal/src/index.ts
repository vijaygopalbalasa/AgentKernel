// @agent-os/mal — Model Abstraction Layer (Layer 2)
// Like Android's HAL — makes ANY AI model work through a standard interface

import type { ChatRequest, ChatResponse, Result } from "@agent-os/shared";

/** Provider adapter interface — every LLM provider implements this */
export interface ProviderAdapter {
  readonly id: string;
  readonly name: string;
  readonly models: string[];

  /** Send a chat completion request */
  chat(request: ChatRequest): Promise<Result<ChatResponse>>;

  /** Check if provider is available (has valid API key, etc.) */
  isAvailable(): Promise<boolean>;
}

/** Model router — picks the best provider/model for each request */
export interface ModelRouter {
  /** Route a request to the best available provider */
  route(request: ChatRequest): Promise<Result<ChatResponse>>;

  /** Register a provider adapter */
  registerProvider(provider: ProviderAdapter): void;

  /** List all available models across all providers */
  listModels(): string[];
}

export { createModelRouter } from "./router.js";

console.log("✅ @agent-os/mal loaded");

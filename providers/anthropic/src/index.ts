// @agentrun/provider-anthropic — Claude adapter for the Model Abstraction Layer

import Anthropic from "@anthropic-ai/sdk";
import type { ChatRequest, ChatResponse, Result } from "@agentrun/shared";
import { ok, err } from "@agentrun/shared";
import type { StreamingProviderAdapter, StreamChunk } from "@agentrun/mal";

/** Anthropic-specific error with HTTP status for classification */
interface AnthropicApiError extends Error {
  status?: number;
  error?: { type?: string; message?: string };
}

/** Classify Anthropic errors for intelligent retry decisions */
function classifyError(error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error(String(error));
  }

  const apiError = error as AnthropicApiError;
  const status = apiError.status;

  if (status === 429) {
    const classified = new Error(`Anthropic rate limit exceeded: ${error.message}`);
    classified.name = "RateLimitError";
    return classified;
  }
  if (status === 401 || status === 403) {
    const classified = new Error(`Anthropic authentication failed: ${error.message}`);
    classified.name = "AuthenticationError";
    return classified;
  }
  if (status !== undefined && status >= 500) {
    const classified = new Error(`Anthropic server error (${status}): ${error.message}`);
    classified.name = "ServerError";
    return classified;
  }
  if (error.name === "AbortError" || error.message.includes("timeout")) {
    const classified = new Error(`Anthropic request timeout: ${error.message}`);
    classified.name = "TimeoutError";
    return classified;
  }
  if (error.message.includes("ECONNREFUSED") || error.message.includes("ENOTFOUND") || error.message.includes("fetch failed")) {
    const classified = new Error(`Anthropic network error: ${error.message}`);
    classified.name = "NetworkError";
    return classified;
  }

  return error;
}

/**
 * Creates an Anthropic provider adapter for the Model Abstraction Layer.
 * Supports Claude 4.5 Opus, Claude 4.5 Sonnet, Claude 3.5 Haiku, and legacy models.
 * Implements full streaming via the Anthropic SDK's messages.stream() API.
 */
export function createAnthropicProvider(apiKey?: string): StreamingProviderAdapter {
  const key = apiKey ?? process.env.ANTHROPIC_API_KEY;

  return {
    id: "anthropic",
    name: "Anthropic Claude",
    models: [
      // Current production models (2025-2026)
      "claude-opus-4-5-20251101",
      "claude-sonnet-4-5-20250929",
      "claude-3-5-haiku-20241022",
      // Legacy models still available
      "claude-3-5-sonnet-20241022",
      "claude-3-opus-20240229",
      "claude-3-haiku-20240307",
    ],

    supportsStreaming: true,

    async isAvailable(): Promise<boolean> {
      return !!key;
    },

    async chat(request: ChatRequest): Promise<Result<ChatResponse>> {
      if (!key) return err(new Error("ANTHROPIC_API_KEY not set"));

      try {
        const client = new Anthropic({ apiKey: key, timeout: 120_000 });

        // Separate system message from conversation
        const systemMsg = request.messages.find((m) => m.role === "system");
        const chatMsgs = request.messages
          .filter((m) => m.role !== "system")
          .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

        const response = await client.messages.create({
          model: request.model,
          max_tokens: request.maxTokens ?? 4096,
          system: systemMsg?.content,
          messages: chatMsgs,
          temperature: request.temperature,
        });

        const textBlock = response.content.find((b) => b.type === "text");

        return ok({
          content: textBlock?.text ?? "",
          model: response.model,
          finishReason: response.stop_reason ?? undefined,
          usage: {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
          },
        });
      } catch (error) {
        return err(classifyError(error));
      }
    },

    async *chatStream(request: ChatRequest): AsyncGenerator<StreamChunk> {
      if (!key) throw new Error("ANTHROPIC_API_KEY not set");

      const client = new Anthropic({ apiKey: key, timeout: 120_000 });

      const systemMsg = request.messages.find((m) => m.role === "system");
      const chatMsgs = request.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

      const stream = client.messages.stream({
        model: request.model,
        max_tokens: request.maxTokens ?? 4096,
        system: systemMsg?.content,
        messages: chatMsgs,
        temperature: request.temperature,
      });

      let model = request.model;

      try {
        for await (const event of stream) {
          if (event.type === "message_start") {
            model = event.message.model;
          }

          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            yield {
              content: event.delta.text,
              isComplete: false,
              model,
            };
          }

          if (event.type === "message_delta") {
            // Final event with usage stats
            yield {
              content: "",
              isComplete: true,
              model,
              tokens: event.usage.output_tokens,
              metadata: {
                stopReason: event.delta.stop_reason,
                outputTokens: event.usage.output_tokens,
              },
            };
          }
        }
      } catch (error) {
        throw classifyError(error);
      }
    },
  };
}

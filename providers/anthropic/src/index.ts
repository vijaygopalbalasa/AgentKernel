// @agent-os/provider-anthropic — Claude adapter for the Model Abstraction Layer

import Anthropic from "@anthropic-ai/sdk";
import type { ChatRequest, ChatResponse, Result } from "@agent-os/shared";
import { ok, err } from "@agent-os/shared";
import type { ProviderAdapter } from "@agent-os/mal";

export function createAnthropicProvider(apiKey?: string): ProviderAdapter {
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

    async isAvailable(): Promise<boolean> {
      return !!key;
    },

    async chat(request: ChatRequest): Promise<Result<ChatResponse>> {
      if (!key) return err(new Error("ANTHROPIC_API_KEY not set"));

      try {
        const client = new Anthropic({ apiKey: key });

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
        });

        const textBlock = response.content.find((b) => b.type === "text");

        return ok({
          content: textBlock?.text ?? "",
          model: response.model,
          usage: {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
          },
        });
      } catch (error) {
        return err(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}

// @agent-os/provider-openai — OpenAI GPT adapter for the Model Abstraction Layer

import OpenAI from "openai";
import type { ChatRequest, ChatResponse, Result } from "@agent-os/shared";
import { ok, err } from "@agent-os/shared";
import type { ProviderAdapter } from "@agent-os/mal";

/**
 * Creates an OpenAI provider adapter for the Model Abstraction Layer.
 * Supports GPT-4, GPT-4o, GPT-3.5-turbo, and other OpenAI models.
 */
export function createOpenAIProvider(apiKey?: string): ProviderAdapter {
  const key = apiKey ?? process.env.OPENAI_API_KEY;

  return {
    id: "openai",
    name: "OpenAI GPT",
    models: [
      // GPT-4o (most capable, multimodal)
      "gpt-4o",
      "gpt-4o-2024-11-20",
      "gpt-4o-mini",
      "gpt-4o-mini-2024-07-18",
      // GPT-4 Turbo
      "gpt-4-turbo",
      "gpt-4-turbo-preview",
      // GPT-4
      "gpt-4",
      "gpt-4-0613",
      // GPT-3.5
      "gpt-3.5-turbo",
      "gpt-3.5-turbo-0125",
    ],

    async isAvailable(): Promise<boolean> {
      return !!key;
    },

    async chat(request: ChatRequest): Promise<Result<ChatResponse>> {
      if (!key) return err(new Error("OPENAI_API_KEY not set"));

      try {
        const client = new OpenAI({ apiKey: key });

        const response = await client.chat.completions.create({
          model: request.model,
          max_tokens: request.maxTokens ?? 4096,
          temperature: request.temperature ?? 1,
          messages: request.messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
          stream: false,
        });

        const choice = response.choices[0];
        if (!choice) {
          return err(new Error("No response from OpenAI"));
        }

        return ok({
          content: choice.message.content ?? "",
          model: response.model,
          usage: {
            inputTokens: response.usage?.prompt_tokens ?? 0,
            outputTokens: response.usage?.completion_tokens ?? 0,
          },
        });
      } catch (error) {
        return err(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}

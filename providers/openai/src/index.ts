// @agentkernel/provider-openai — OpenAI GPT adapter for the Model Abstraction Layer

import OpenAI from "openai";
import type { ChatRequest, ChatResponse, Result } from "@agentkernel/shared";
import { ok, err } from "@agentkernel/shared";
import type { StreamingProviderAdapter, StreamChunk } from "@agentkernel/mal";

/** OpenAI-specific error with HTTP status for classification */
interface OpenAIApiError extends Error {
  status?: number;
  code?: string;
  type?: string;
}

/** Classify OpenAI errors for intelligent retry decisions */
function classifyError(error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error(String(error));
  }

  const apiError = error as OpenAIApiError;
  const status = apiError.status;

  if (status === 429) {
    const classified = new Error(`OpenAI rate limit exceeded: ${error.message}`);
    classified.name = "RateLimitError";
    return classified;
  }
  if (status === 401 || status === 403) {
    const classified = new Error(`OpenAI authentication failed: ${error.message}`);
    classified.name = "AuthenticationError";
    return classified;
  }
  if (status !== undefined && status >= 500) {
    const classified = new Error(`OpenAI server error (${status}): ${error.message}`);
    classified.name = "ServerError";
    return classified;
  }
  if (error.name === "AbortError" || error.message.includes("timeout")) {
    const classified = new Error(`OpenAI request timeout: ${error.message}`);
    classified.name = "TimeoutError";
    return classified;
  }
  if (error.message.includes("ECONNREFUSED") || error.message.includes("ENOTFOUND") || error.message.includes("fetch failed")) {
    const classified = new Error(`OpenAI network error: ${error.message}`);
    classified.name = "NetworkError";
    return classified;
  }

  return error;
}

/** Generate an embedding vector using OpenAI's text-embedding-3-small model (1536 dimensions).
 *  Returns null if OPENAI_API_KEY is not set. */
export async function generateEmbedding(text: string, apiKey?: string): Promise<number[] | null> {
  const key = apiKey ?? process.env.OPENAI_API_KEY;
  if (!key) return null;

  const client = new OpenAI({ apiKey: key, timeout: 30_000, maxRetries: 1 });
  const response = await client.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });

  const embedding = response.data[0]?.embedding;
  return embedding ?? null;
}

/**
 * Creates an OpenAI provider adapter for the Model Abstraction Layer.
 * Supports GPT-4o, GPT-4o-mini, GPT-4 Turbo, and other OpenAI models.
 * Implements full streaming via the OpenAI SDK's stream API.
 */
export function createOpenAIProvider(apiKey?: string): StreamingProviderAdapter {
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

    supportsStreaming: true,

    async isAvailable(): Promise<boolean> {
      return !!key;
    },

    async chat(request: ChatRequest): Promise<Result<ChatResponse>> {
      if (!key) return err(new Error("OPENAI_API_KEY not set"));

      try {
        const client = new OpenAI({ apiKey: key, timeout: 120_000, maxRetries: 0 });

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
          finishReason: choice.finish_reason ?? undefined,
          usage: {
            inputTokens: response.usage?.prompt_tokens ?? 0,
            outputTokens: response.usage?.completion_tokens ?? 0,
          },
        });
      } catch (error) {
        return err(classifyError(error));
      }
    },

    async *chatStream(request: ChatRequest): AsyncGenerator<StreamChunk> {
      if (!key) throw new Error("OPENAI_API_KEY not set");

      const client = new OpenAI({ apiKey: key, timeout: 120_000, maxRetries: 0 });

      try {
        const stream = await client.chat.completions.create({
          model: request.model,
          max_tokens: request.maxTokens ?? 4096,
          temperature: request.temperature ?? 1,
          messages: request.messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
          stream: true,
          stream_options: { include_usage: true },
        });

        let model = request.model;

        for await (const chunk of stream) {
          model = chunk.model ?? model;
          const choice = chunk.choices[0];

          if (choice?.delta?.content) {
            yield {
              content: choice.delta.content,
              isComplete: false,
              model,
            };
          }

          // Final chunk with usage stats (OpenAI sends usage on last chunk when include_usage is true)
          if (choice?.finish_reason) {
            yield {
              content: "",
              isComplete: true,
              model,
              tokens: chunk.usage?.completion_tokens,
              metadata: {
                finishReason: choice.finish_reason,
                inputTokens: chunk.usage?.prompt_tokens,
                outputTokens: chunk.usage?.completion_tokens,
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

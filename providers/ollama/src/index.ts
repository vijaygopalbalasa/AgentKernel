// @agentkernel/provider-ollama — Ollama adapter for the Model Abstraction Layer
// Supports local models like Llama, Mistral, CodeLlama, etc.
// Free to use - no API key required, just run Ollama locally

import type { ChatRequest, ChatResponse, Result } from "@agentkernel/shared";
import { ok, err } from "@agentkernel/shared";
import type { StreamingProviderAdapter, StreamChunk } from "@agentkernel/mal";

/** Ollama API response type (non-streaming) */
interface OllamaResponse {
  model: string;
  message: {
    role: string;
    content: string;
  };
  done: boolean;
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

/** Ollama streaming chunk type */
interface OllamaStreamChunk {
  model: string;
  message: {
    role: string;
    content: string;
  };
  done: boolean;
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

/** Ollama models list response */
interface OllamaModelsResponse {
  models: Array<{
    name: string;
    modified_at: string;
    size: number;
  }>;
}

/** Classify Ollama errors for intelligent retry decisions */
function classifyError(error: unknown, status?: number): Error {
  if (!(error instanceof Error)) {
    return new Error(String(error));
  }

  if (status === 429) {
    const classified = new Error(`Ollama rate limit exceeded: ${error.message}`);
    classified.name = "RateLimitError";
    return classified;
  }
  if (status !== undefined && status >= 500) {
    const classified = new Error(`Ollama server error (${status}): ${error.message}`);
    classified.name = "ServerError";
    return classified;
  }
  if (error.name === "AbortError") {
    const classified = new Error("Ollama request timed out");
    classified.name = "TimeoutError";
    return classified;
  }
  if (
    error.message.includes("ECONNREFUSED") ||
    error.message.includes("ENOTFOUND") ||
    error.message.includes("fetch failed") ||
    error.message.includes("Failed to parse URL") ||
    (error.name === "TypeError" && (error.cause as Error | undefined)?.message?.includes("ECONNREFUSED"))
  ) {
    const classified = new Error(`Ollama not reachable: ${error.message}`);
    classified.name = "NetworkError";
    return classified;
  }

  return error;
}

/**
 * Creates an Ollama provider adapter for the Model Abstraction Layer.
 * Supports any model running locally via Ollama (Llama, Mistral, CodeLlama, etc.)
 * Implements full streaming via Ollama's NDJSON streaming API.
 *
 * Prerequisites:
 * 1. Install Ollama: https://ollama.ai/download
 * 2. Pull a model: `ollama pull llama3.2` or `ollama pull mistral`
 * 3. Ollama runs on http://localhost:11434 by default
 */
export function createOllamaProvider(baseUrl?: string): StreamingProviderAdapter {
  const url =
    baseUrl ??
    process.env.OLLAMA_URL ??
    process.env.OLLAMA_BASE_URL ??
    (process.env.OLLAMA_HOST ? `http://${process.env.OLLAMA_HOST}` : undefined) ??
    "http://localhost:11434";

  // Cache available models
  let cachedModels: string[] | null = null;

  return {
    id: "ollama",
    name: "Ollama (Local)",
    // Default popular models - actual available models fetched dynamically
    models: [
      "llama3.2",
      "llama3.2:1b",
      "llama3.1",
      "llama3.1:70b",
      "mistral",
      "mistral:7b",
      "mixtral",
      "codellama",
      "codellama:13b",
      "phi3",
      "gemma2",
      "qwen2.5",
      "deepseek-coder",
    ],

    supportsStreaming: true,

    async isAvailable(): Promise<boolean> {
      try {
        const response = await fetch(`${url}/api/tags`, {
          method: "GET",
          signal: AbortSignal.timeout(2000), // 2 second timeout
        });

        if (response.ok) {
          const data = (await response.json()) as OllamaModelsResponse;
          cachedModels = data.models.map((m) => m.name);
          return cachedModels.length > 0;
        }
        return false;
      } catch {
        // Ollama not running or not accessible
        return false;
      }
    },

    async chat(request: ChatRequest): Promise<Result<ChatResponse>> {
      try {
        // Build messages array for Ollama
        const messages = request.messages.map((m) => ({
          role: m.role,
          content: m.content,
        }));

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 120_000);
        const response = await fetch(`${url}/api/chat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: request.model,
            messages,
            stream: false,
            options: {
              num_predict: request.maxTokens ?? 4096,
              temperature: request.temperature ?? 0.7,
            },
          }),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorText = await response.text();
          return err(classifyError(new Error(`Ollama error: ${response.status} ${errorText}`), response.status));
        }

        const data = (await response.json()) as OllamaResponse;

        return ok({
          content: data.message.content,
          model: data.model,
          usage: {
            inputTokens: data.prompt_eval_count ?? 0,
            outputTokens: data.eval_count ?? 0,
          },
        });
      } catch (error) {
        return err(classifyError(error));
      }
    },

    async *chatStream(request: ChatRequest): AsyncGenerator<StreamChunk> {
      const messages = request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 300_000); // 5 min for streaming

      try {
        const response = await fetch(`${url}/api/chat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: request.model,
            messages,
            stream: true,
            options: {
              num_predict: request.maxTokens ?? 4096,
              temperature: request.temperature ?? 0.7,
            },
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          clearTimeout(timeoutId);
          const errorText = await response.text();
          throw classifyError(new Error(`Ollama error: ${response.status} ${errorText}`), response.status);
        }

        if (!response.body) {
          clearTimeout(timeoutId);
          throw new Error("Ollama streaming response has no body");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // Ollama streams NDJSON - one JSON object per line
            const lines = buffer.split("\n");
            // Keep the last potentially incomplete line in the buffer
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;

              const chunk = JSON.parse(trimmed) as OllamaStreamChunk;

              if (chunk.done) {
                // Final chunk with stats
                yield {
                  content: chunk.message.content,
                  isComplete: true,
                  model: chunk.model,
                  tokens: chunk.eval_count,
                  metadata: {
                    inputTokens: chunk.prompt_eval_count,
                    outputTokens: chunk.eval_count,
                    totalDuration: chunk.total_duration,
                  },
                };
              } else {
                yield {
                  content: chunk.message.content,
                  isComplete: false,
                  model: chunk.model,
                };
              }
            }
          }
        } finally {
          reader.releaseLock();
        }
      } catch (error) {
        throw classifyError(error);
      } finally {
        clearTimeout(timeoutId);
      }
    },
  };
}

/**
 * List models currently available in the local Ollama installation.
 * Returns empty array if Ollama is not running.
 */
export async function listOllamaModels(baseUrl?: string): Promise<string[]> {
  const ollamaUrl =
    baseUrl ??
    process.env.OLLAMA_URL ??
    process.env.OLLAMA_BASE_URL ??
    (process.env.OLLAMA_HOST ? `http://${process.env.OLLAMA_HOST}` : undefined) ??
    "http://localhost:11434";

  try {
    const response = await fetch(`${ollamaUrl}/api/tags`);
    if (response.ok) {
      const data = (await response.json()) as OllamaModelsResponse;
      return data.models.map((m) => m.name);
    }
    return [];
  } catch {
    return [];
  }
}

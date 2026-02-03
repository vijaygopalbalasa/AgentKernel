// @agent-os/provider-ollama — Ollama adapter for the Model Abstraction Layer
// Supports local models like Llama, Mistral, CodeLlama, etc.
// Free to use - no API key required, just run Ollama locally

import type { ChatRequest, ChatResponse, Result } from "@agent-os/shared";
import { ok, err } from "@agent-os/shared";
import type { ProviderAdapter } from "@agent-os/mal";

/** Ollama API response type */
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

/** Ollama models list response */
interface OllamaModelsResponse {
  models: Array<{
    name: string;
    modified_at: string;
    size: number;
  }>;
}

/**
 * Creates an Ollama provider adapter for the Model Abstraction Layer.
 * Supports any model running locally via Ollama (Llama, Mistral, CodeLlama, etc.)
 *
 * Prerequisites:
 * 1. Install Ollama: https://ollama.ai/download
 * 2. Pull a model: `ollama pull llama3.2` or `ollama pull mistral`
 * 3. Ollama runs on http://localhost:11434 by default
 */
export function createOllamaProvider(baseUrl?: string): ProviderAdapter {
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
        });

        if (!response.ok) {
          const errorText = await response.text();
          return err(new Error(`Ollama error: ${response.status} ${errorText}`));
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
        if (error instanceof Error && error.name === "AbortError") {
          return err(new Error("Ollama request timed out"));
        }
        return err(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}

/**
 * List models currently available in the local Ollama installation.
 * Returns empty array if Ollama is not running.
 */
export async function listOllamaModels(baseUrl?: string): Promise<string[]> {
  const url =
    baseUrl ??
    process.env.OLLAMA_URL ??
    process.env.OLLAMA_BASE_URL ??
    (process.env.OLLAMA_HOST ? `http://${process.env.OLLAMA_HOST}` : undefined) ??
    "http://localhost:11434";

  try {
    const response = await fetch(`${url}/api/tags`);
    if (response.ok) {
      const data = (await response.json()) as OllamaModelsResponse;
      return data.models.map((m) => m.name);
    }
    return [];
  } catch {
    return [];
  }
}

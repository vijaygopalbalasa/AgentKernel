// @agentrun/provider-google — Google Gemini adapter for the Model Abstraction Layer
// Uses @google/genai SDK (unified Google AI SDK)

import { GoogleGenAI } from "@google/genai";
import type { ChatRequest, ChatResponse, Result } from "@agentrun/shared";
import { ok, err } from "@agentrun/shared";
import type { StreamingProviderAdapter, StreamChunk } from "@agentrun/mal";

/** Google-specific error with HTTP status for classification */
interface GoogleApiError extends Error {
  status?: number;
  code?: number;
  errorDetails?: unknown[];
}

/** Classify Google API errors for intelligent retry decisions */
function classifyError(error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error(String(error));
  }

  const apiError = error as GoogleApiError;
  const status = apiError.status ?? apiError.code;

  if (status === 429) {
    const classified = new Error(`Google AI rate limit exceeded: ${error.message}`);
    classified.name = "RateLimitError";
    return classified;
  }
  if (status === 401 || status === 403) {
    const classified = new Error(`Google AI authentication failed: ${error.message}`);
    classified.name = "AuthenticationError";
    return classified;
  }
  if (status !== undefined && status >= 500) {
    const classified = new Error(`Google AI server error (${status}): ${error.message}`);
    classified.name = "ServerError";
    return classified;
  }
  if (error.name === "AbortError" || error.message.includes("timeout") || error.message.includes("DEADLINE_EXCEEDED")) {
    const classified = new Error(`Google AI request timeout: ${error.message}`);
    classified.name = "TimeoutError";
    return classified;
  }
  if (error.message.includes("ECONNREFUSED") || error.message.includes("ENOTFOUND") || error.message.includes("fetch failed")) {
    const classified = new Error(`Google AI network error: ${error.message}`);
    classified.name = "NetworkError";
    return classified;
  }

  return error;
}

/** Resolve model name - ensure it has the gemini- prefix */
function resolveModelName(model: string): string {
  return model.startsWith("gemini-") ? model : `gemini-${model}`;
}

/**
 * Creates a Google Gemini provider adapter for the Model Abstraction Layer.
 * Supports Gemini 2.5, 2.0, and 1.5 models.
 * Implements full streaming via the @google/genai SDK's generateContentStream() API.
 */
export function createGoogleProvider(apiKey?: string): StreamingProviderAdapter {
  const key = apiKey ?? process.env.GOOGLE_AI_API_KEY;

  return {
    id: "google",
    name: "Google Gemini",
    models: [
      // Gemini 2.5 (latest)
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      // Gemini 2.0
      "gemini-2.0-flash",
      "gemini-2.0-flash-exp",
      "gemini-2.0-flash-thinking-exp",
      // Gemini 1.5 (legacy)
      "gemini-1.5-pro",
      "gemini-1.5-pro-latest",
      "gemini-1.5-flash",
      "gemini-1.5-flash-latest",
      "gemini-1.5-flash-8b",
    ],

    supportsStreaming: true,

    async isAvailable(): Promise<boolean> {
      return !!key;
    },

    async chat(request: ChatRequest): Promise<Result<ChatResponse>> {
      if (!key) return err(new Error("GOOGLE_AI_API_KEY not set"));

      try {
        const ai = new GoogleGenAI({ apiKey: key });

        // Build contents array for the SDK
        const systemMsg = request.messages.find((m) => m.role === "system");
        const chatMsgs = request.messages.filter((m) => m.role !== "system");

        const contents = chatMsgs.map((m) => ({
          role: m.role === "assistant" ? ("model" as const) : ("user" as const),
          parts: [{ text: m.content }],
        }));

        const resolvedModel = resolveModelName(request.model);

        const response = await ai.models.generateContent({
          model: resolvedModel,
          contents: contents,
          config: {
            maxOutputTokens: request.maxTokens ?? 4096,
            temperature: request.temperature ?? 1,
            systemInstruction: systemMsg ? systemMsg.content : undefined,
          },
        });

        // Extract text from response
        const text = response.text ?? "";

        // Get usage metadata if available
        const usage = response.usageMetadata;

        return ok({
          content: text,
          model: request.model,
          usage: {
            inputTokens: usage?.promptTokenCount ?? 0,
            outputTokens: usage?.candidatesTokenCount ?? 0,
          },
        });
      } catch (error) {
        return err(classifyError(error));
      }
    },

    async *chatStream(request: ChatRequest): AsyncGenerator<StreamChunk> {
      if (!key) throw new Error("GOOGLE_AI_API_KEY not set");

      const ai = new GoogleGenAI({ apiKey: key });

      const systemMsg = request.messages.find((m) => m.role === "system");
      const chatMsgs = request.messages.filter((m) => m.role !== "system");

      const contents = chatMsgs.map((m) => ({
        role: m.role === "assistant" ? ("model" as const) : ("user" as const),
        parts: [{ text: m.content }],
      }));

      const resolvedModel = resolveModelName(request.model);

      try {
        const streamResponse = await ai.models.generateContentStream({
          model: resolvedModel,
          contents: contents,
          config: {
            maxOutputTokens: request.maxTokens ?? 4096,
            temperature: request.temperature ?? 1,
            systemInstruction: systemMsg ? systemMsg.content : undefined,
          },
        });

        let lastUsage: { promptTokenCount?: number; candidatesTokenCount?: number } | undefined;

        for await (const chunk of streamResponse) {
          // Track usage from the last chunk
          if (chunk.usageMetadata) {
            lastUsage = chunk.usageMetadata;
          }

          const candidate = chunk.candidates?.[0];
          const text = candidate?.content?.parts?.[0]?.text;

          if (text) {
            yield {
              content: text,
              isComplete: false,
              model: request.model,
            };
          }

          // Check for finish
          if (candidate?.finishReason && candidate.finishReason !== "FINISH_REASON_UNSPECIFIED") {
            yield {
              content: "",
              isComplete: true,
              model: request.model,
              tokens: lastUsage?.candidatesTokenCount,
              metadata: {
                finishReason: candidate.finishReason,
                inputTokens: lastUsage?.promptTokenCount,
                outputTokens: lastUsage?.candidatesTokenCount,
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

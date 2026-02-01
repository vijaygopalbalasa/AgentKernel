// @agent-os/provider-google — Google Gemini adapter for the Model Abstraction Layer
// Updated for @google/genai SDK (2026)

import { GoogleGenAI } from "@google/genai";
import type { ChatRequest, ChatResponse, Result } from "@agent-os/shared";
import { ok, err } from "@agent-os/shared";
import type { ProviderAdapter } from "@agent-os/mal";

/**
 * Creates a Google Gemini provider adapter for the Model Abstraction Layer.
 * Supports Gemini 2.0, 2.5, and other Google AI models.
 * Uses the new unified @google/genai SDK.
 */
export function createGoogleProvider(apiKey?: string): ProviderAdapter {
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

    async isAvailable(): Promise<boolean> {
      return !!key;
    },

    async chat(request: ChatRequest): Promise<Result<ChatResponse>> {
      if (!key) return err(new Error("GOOGLE_AI_API_KEY not set"));

      try {
        const ai = new GoogleGenAI({ apiKey: key });

        // Build contents array for the new SDK
        // The new SDK expects contents as an array of parts or a string
        const systemMsg = request.messages.find((m) => m.role === "system");
        const chatMsgs = request.messages.filter((m) => m.role !== "system");

        // Build the contents array
        const contents = chatMsgs.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        }));

        // Use generateContent for single-turn or multi-turn conversations
        const response = await ai.models.generateContent({
          model: request.model.startsWith("gemini-") ? request.model : `gemini-${request.model}`,
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
        return err(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}

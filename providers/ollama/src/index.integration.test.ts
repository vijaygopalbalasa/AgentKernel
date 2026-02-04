// Real Ollama Integration Tests
// Requires: Ollama running locally with at least one model pulled
// Run with: pnpm --filter @agentkernel/provider-ollama test:integration

import { describe, it, expect, beforeAll } from "vitest";
import { createOllamaProvider, listOllamaModels } from "./index.js";

let isAvailable = false;
let testModel = "llama3.2:1b"; // Default to smallest model

describe("Ollama Provider Integration Tests (Local)", () => {
  beforeAll(async () => {
    const provider = createOllamaProvider();
    isAvailable = await provider.isAvailable();

    if (!isAvailable) {
      console.warn("⚠ Ollama not running or no models available. Skipping tests.");
      return;
    }

    // Find the smallest available model for testing
    const models = await listOllamaModels();
    if (models.length > 0) {
      // Prefer smaller models for faster tests
      const preferred = ["llama3.2:1b", "phi3", "llama3.2", "gemma2", "mistral:7b"];
      const found = preferred.find((m) => models.some((available) => available.startsWith(m)));
      testModel = found ?? models[0]!;
    }

    console.log(`Using Ollama model: ${testModel}`);
  });

  // ─── Non-Streaming Tests ───

  it("should report availability correctly", async () => {
    const provider = createOllamaProvider();
    const available = await provider.isAvailable();
    // Just check it returns a boolean without throwing
    expect(typeof available).toBe("boolean");
  });

  it("should report unavailable for invalid URL", async () => {
    const provider = createOllamaProvider("http://localhost:19999");
    const available = await provider.isAvailable();
    expect(available).toBe(false);
  });

  it("should list available models", async () => {
    if (!isAvailable) return;
    const models = await listOllamaModels();
    expect(models.length).toBeGreaterThan(0);
    expect(typeof models[0]).toBe("string");
  });

  it("should complete a simple chat request", async () => {
    if (!isAvailable) return;
    const provider = createOllamaProvider();

    const result = await provider.chat({
      model: testModel,
      messages: [
        { role: "user", content: "Reply with exactly the word 'pong' and nothing else." },
      ],
      maxTokens: 20,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content.length).toBeGreaterThan(0);
      expect(result.value.model).toBeDefined();
      expect(result.value.usage).toBeDefined();
    }
  }, 120000); // Ollama can be slow on first request

  it("should handle system messages", async () => {
    if (!isAvailable) return;
    const provider = createOllamaProvider();

    const result = await provider.chat({
      model: testModel,
      messages: [
        { role: "system", content: "You are a calculator. Only respond with numbers." },
        { role: "user", content: "What is 2+2?" },
      ],
      maxTokens: 20,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toContain("4");
    }
  }, 120000);

  it("should return error for nonexistent model", async () => {
    if (!isAvailable) return;
    const provider = createOllamaProvider();

    const result = await provider.chat({
      model: "nonexistent-model-xyz-99999",
      messages: [{ role: "user", content: "test" }],
      maxTokens: 10,
    });

    expect(result.ok).toBe(false);
  }, 30000);

  it("should classify network errors correctly", async () => {
    const provider = createOllamaProvider("http://localhost:19999");

    const result = await provider.chat({
      model: "any-model",
      messages: [{ role: "user", content: "test" }],
      maxTokens: 10,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("NetworkError");
    }
  }, 10000);

  it("should expose correct provider metadata", () => {
    const provider = createOllamaProvider();
    expect(provider.id).toBe("ollama");
    expect(provider.name).toBe("Ollama (Local)");
    expect(provider.models.length).toBeGreaterThan(0);
    expect(provider.supportsStreaming).toBe(true);
  });

  // ─── Streaming Tests ───

  it("should stream a simple chat response", async () => {
    if (!isAvailable) return;
    const provider = createOllamaProvider();

    const chunks: string[] = [];
    let gotComplete = false;

    const stream = provider.chatStream!({
      model: testModel,
      messages: [
        { role: "user", content: "Say hello" },
      ],
      maxTokens: 30,
      stream: true,
    });

    for await (const chunk of stream) {
      if (chunk.content) {
        chunks.push(chunk.content);
      }
      if (chunk.isComplete) {
        gotComplete = true;
      }
    }

    const fullContent = chunks.join("");
    expect(fullContent.length).toBeGreaterThan(0);
    expect(chunks.length).toBeGreaterThan(0);
    expect(gotComplete).toBe(true);
  }, 120000);

  it("should stream with system messages", async () => {
    if (!isAvailable) return;
    const provider = createOllamaProvider();

    const chunks: string[] = [];

    const stream = provider.chatStream!({
      model: testModel,
      messages: [
        { role: "system", content: "You are a calculator. Only respond with numbers." },
        { role: "user", content: "What is 5+3?" },
      ],
      maxTokens: 20,
      stream: true,
    });

    for await (const chunk of stream) {
      if (chunk.content) {
        chunks.push(chunk.content);
      }
    }

    const fullContent = chunks.join("");
    expect(fullContent).toContain("8");
  }, 120000);

  it("should throw error when streaming with invalid URL", async () => {
    const provider = createOllamaProvider("http://localhost:19999");

    const stream = provider.chatStream!({
      model: "any-model",
      messages: [{ role: "user", content: "test" }],
      maxTokens: 10,
      stream: true,
    });

    try {
      for await (const _ of stream) {
        // Should not reach here
      }
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe("NetworkError");
    }
  }, 10000);

  it("should produce content both streaming and non-streaming", async () => {
    if (!isAvailable) return;
    const provider = createOllamaProvider();

    const messages = [
      { role: "user" as const, content: "What is 2+3? Reply with just the number." },
    ];

    // Non-streaming
    const syncResult = await provider.chat({
      model: testModel,
      messages,
      maxTokens: 20,
    });

    // Streaming
    const chunks: string[] = [];
    const stream = provider.chatStream!({
      model: testModel,
      messages,
      maxTokens: 20,
      stream: true,
    });

    for await (const chunk of stream) {
      if (chunk.content) {
        chunks.push(chunk.content);
      }
    }

    expect(syncResult.ok).toBe(true);
    const streamContent = chunks.join("");
    expect(streamContent.length).toBeGreaterThan(0);
    if (syncResult.ok) {
      expect(syncResult.value.content.length).toBeGreaterThan(0);
    }
  }, 120000);
});

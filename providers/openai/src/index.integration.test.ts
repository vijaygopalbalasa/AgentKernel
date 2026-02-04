// Real OpenAI API Integration Tests
// Requires: OPENAI_API_KEY environment variable
// Run with: OPENAI_API_KEY=sk-... pnpm --filter @agentkernel/provider-openai test:integration

import { describe, it, expect, beforeAll } from "vitest";
import { createOpenAIProvider } from "./index.js";

const hasApiKey = !!process.env.OPENAI_API_KEY;

describe("OpenAI Provider Integration Tests (Real API)", () => {
  beforeAll(() => {
    if (!hasApiKey) {
      console.warn("⚠ OPENAI_API_KEY not set. Skipping real API tests.");
    }
  });

  // ─── Non-Streaming Tests ───

  it("should report available when API key is set", async () => {
    if (!hasApiKey) return;
    const provider = createOpenAIProvider();
    const available = await provider.isAvailable();
    expect(available).toBe(true);
  });

  it("should complete a simple chat request", async () => {
    if (!hasApiKey) return;
    const provider = createOpenAIProvider();

    const result = await provider.chat({
      model: "gpt-4o-mini", // Cheapest model
      messages: [
        { role: "user", content: "Reply with exactly the word 'pong' and nothing else." },
      ],
      maxTokens: 10,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content.toLowerCase()).toContain("pong");
      expect(result.value.model).toBeDefined();
      expect(result.value.usage).toBeDefined();
      expect(result.value.usage.inputTokens).toBeGreaterThan(0);
      expect(result.value.usage.outputTokens).toBeGreaterThan(0);
    }
  }, 30000);

  it("should handle system messages", async () => {
    if (!hasApiKey) return;
    const provider = createOpenAIProvider();

    const result = await provider.chat({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a calculator. Only respond with numbers." },
        { role: "user", content: "What is 3+5?" },
      ],
      maxTokens: 10,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toContain("8");
    }
  }, 30000);

  it("should return classified error for invalid API key", async () => {
    const provider = createOpenAIProvider("sk-invalid-key-12345");

    const result = await provider.chat({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "test" }],
      maxTokens: 10,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("AuthenticationError");
    }
  }, 30000);

  it("should expose correct provider metadata", () => {
    const provider = createOpenAIProvider();
    expect(provider.id).toBe("openai");
    expect(provider.name).toBeDefined();
    expect(provider.models.length).toBeGreaterThan(0);
    expect(provider.supportsStreaming).toBe(true);
  });

  // ─── Streaming Tests ───

  it("should stream a simple chat response", async () => {
    if (!hasApiKey) return;
    const provider = createOpenAIProvider();

    const chunks: string[] = [];
    let gotComplete = false;

    const stream = provider.chatStream!({
      model: "gpt-4o-mini",
      messages: [
        { role: "user", content: "Reply with exactly: hello world" },
      ],
      maxTokens: 20,
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
    expect(fullContent.toLowerCase()).toContain("hello");
    expect(chunks.length).toBeGreaterThan(0);
    expect(gotComplete).toBe(true);
  }, 30000);

  it("should stream with system messages", async () => {
    if (!hasApiKey) return;
    const provider = createOpenAIProvider();

    const chunks: string[] = [];

    const stream = provider.chatStream!({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a calculator. Only respond with numbers." },
        { role: "user", content: "What is 5+3?" },
      ],
      maxTokens: 10,
      stream: true,
    });

    for await (const chunk of stream) {
      if (chunk.content) {
        chunks.push(chunk.content);
      }
    }

    const fullContent = chunks.join("");
    expect(fullContent).toContain("8");
  }, 30000);

  it("should throw classified error when streaming with invalid key", async () => {
    const provider = createOpenAIProvider("sk-invalid-key-12345");

    const stream = provider.chatStream!({
      model: "gpt-4o-mini",
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
      expect((error as Error).name).toBe("AuthenticationError");
    }
  }, 30000);

  it("should produce same content streaming vs non-streaming", async () => {
    if (!hasApiKey) return;
    const provider = createOpenAIProvider();

    const messages = [
      { role: "user" as const, content: "What is 2+3? Reply with just the number." },
    ];

    // Non-streaming
    const syncResult = await provider.chat({
      model: "gpt-4o-mini",
      messages,
      maxTokens: 10,
      temperature: 0,
    });

    // Streaming
    const chunks: string[] = [];
    const stream = provider.chatStream!({
      model: "gpt-4o-mini",
      messages,
      maxTokens: 10,
      temperature: 0,
      stream: true,
    });

    for await (const chunk of stream) {
      if (chunk.content) {
        chunks.push(chunk.content);
      }
    }

    expect(syncResult.ok).toBe(true);
    if (syncResult.ok) {
      const streamContent = chunks.join("");
      expect(syncResult.value.content).toContain("5");
      expect(streamContent).toContain("5");
    }
  }, 60000);
});

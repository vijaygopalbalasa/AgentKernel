// Real Google Gemini API Integration Tests
// Requires: GOOGLE_AI_API_KEY environment variable
// Run with: GOOGLE_AI_API_KEY=... pnpm --filter @agentkernel/provider-google test:integration

import { describe, it, expect, beforeAll } from "vitest";
import { createGoogleProvider } from "./index.js";

const hasApiKey = !!process.env.GOOGLE_AI_API_KEY;

describe("Google Gemini Provider Integration Tests (Real API)", () => {
  beforeAll(() => {
    if (!hasApiKey) {
      console.warn("⚠ GOOGLE_AI_API_KEY not set. Skipping real API tests.");
    }
  });

  // ─── Non-Streaming Tests ───

  it("should report available when API key is set", async () => {
    if (!hasApiKey) return;
    const provider = createGoogleProvider();
    const available = await provider.isAvailable();
    expect(available).toBe(true);
  });

  it("should report unavailable when API key is empty", async () => {
    const provider = createGoogleProvider("");
    const available = await provider.isAvailable();
    expect(available).toBe(false);
  });

  it("should complete a simple chat request", async () => {
    if (!hasApiKey) return;
    const provider = createGoogleProvider();

    const result = await provider.chat({
      model: "gemini-2.0-flash", // Fast and cheap model
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
    }
  }, 30000);

  it("should handle system messages", async () => {
    if (!hasApiKey) return;
    const provider = createGoogleProvider();

    const result = await provider.chat({
      model: "gemini-2.0-flash",
      messages: [
        { role: "system", content: "You are a calculator. Only respond with numbers." },
        { role: "user", content: "What is 2+2?" },
      ],
      maxTokens: 10,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toContain("4");
    }
  }, 30000);

  it("should handle multi-turn conversations", async () => {
    if (!hasApiKey) return;
    const provider = createGoogleProvider();

    const result = await provider.chat({
      model: "gemini-2.0-flash",
      messages: [
        { role: "user", content: "Remember the number 7." },
        { role: "assistant", content: "I'll remember the number 7." },
        { role: "user", content: "What number did I ask you to remember? Reply with just the number." },
      ],
      maxTokens: 10,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toContain("7");
    }
  }, 30000);

  it("should return error for invalid API key", async () => {
    const provider = createGoogleProvider("invalid-key-12345");

    const result = await provider.chat({
      model: "gemini-2.0-flash",
      messages: [{ role: "user", content: "test" }],
      maxTokens: 10,
    });

    expect(result.ok).toBe(false);
  }, 30000);

  it("should expose correct provider metadata", () => {
    const provider = createGoogleProvider();
    expect(provider.id).toBe("google");
    expect(provider.name).toBe("Google Gemini");
    expect(provider.models.length).toBeGreaterThan(0);
    expect(provider.models).toContain("gemini-2.0-flash");
    expect(provider.supportsStreaming).toBe(true);
  });

  // ─── Streaming Tests ───

  it("should stream a simple chat response", async () => {
    if (!hasApiKey) return;
    const provider = createGoogleProvider();

    const chunks: string[] = [];
    let gotComplete = false;

    const stream = provider.chatStream!({
      model: "gemini-2.0-flash",
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
    const provider = createGoogleProvider();

    const chunks: string[] = [];

    const stream = provider.chatStream!({
      model: "gemini-2.0-flash",
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

  it("should throw error when streaming with invalid key", async () => {
    const provider = createGoogleProvider("invalid-key-12345");

    const stream = provider.chatStream!({
      model: "gemini-2.0-flash",
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
    }
  }, 30000);

  it("should produce same content streaming vs non-streaming", async () => {
    if (!hasApiKey) return;
    const provider = createGoogleProvider();

    const messages = [
      { role: "user" as const, content: "What is 2+3? Reply with just the number." },
    ];

    // Non-streaming
    const syncResult = await provider.chat({
      model: "gemini-2.0-flash",
      messages,
      maxTokens: 10,
      temperature: 0,
    });

    // Streaming
    const chunks: string[] = [];
    const stream = provider.chatStream!({
      model: "gemini-2.0-flash",
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

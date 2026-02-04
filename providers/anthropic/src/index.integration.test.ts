// Real Anthropic API Integration Tests
// Requires: ANTHROPIC_API_KEY environment variable
// Run with: ANTHROPIC_API_KEY=sk-ant-... pnpm --filter @agentkernel/provider-anthropic test:integration

import { describe, it, expect, beforeAll } from "vitest";
import { createAnthropicProvider } from "./index.js";

const hasApiKey = !!process.env.ANTHROPIC_API_KEY;

describe("Anthropic Provider Integration Tests (Real API)", () => {
  beforeAll(() => {
    if (!hasApiKey) {
      console.warn("⚠ ANTHROPIC_API_KEY not set. Skipping real API tests.");
    }
  });

  // ─── Non-Streaming Tests ───

  it("should report available when API key is set", async () => {
    if (!hasApiKey) return;
    const provider = createAnthropicProvider();
    const available = await provider.isAvailable();
    expect(available).toBe(true);
  });

  it("should report unavailable when API key is empty", async () => {
    const provider = createAnthropicProvider("");
    const available = await provider.isAvailable();
    expect(available).toBe(false);
  });

  it("should complete a simple chat request", async () => {
    if (!hasApiKey) return;
    const provider = createAnthropicProvider();

    const result = await provider.chat({
      model: "claude-3-5-haiku-20241022", // Cheapest model
      messages: [
        { role: "user", content: "Reply with exactly the word 'pong' and nothing else." },
      ],
      maxTokens: 10,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content.toLowerCase()).toContain("pong");
      expect(result.value.model).toContain("claude");
      expect(result.value.usage).toBeDefined();
      expect(result.value.usage.inputTokens).toBeGreaterThan(0);
      expect(result.value.usage.outputTokens).toBeGreaterThan(0);
    }
  }, 30000);

  it("should handle system messages", async () => {
    if (!hasApiKey) return;
    const provider = createAnthropicProvider();

    const result = await provider.chat({
      model: "claude-3-5-haiku-20241022",
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
    const provider = createAnthropicProvider();

    const result = await provider.chat({
      model: "claude-3-5-haiku-20241022",
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

  it("should return error for invalid model", async () => {
    if (!hasApiKey) return;
    const provider = createAnthropicProvider();

    const result = await provider.chat({
      model: "nonexistent-model-xyz",
      messages: [{ role: "user", content: "test" }],
      maxTokens: 10,
    });

    expect(result.ok).toBe(false);
  }, 30000);

  it("should return classified error for invalid API key", async () => {
    const provider = createAnthropicProvider("sk-ant-invalid-key-12345");

    const result = await provider.chat({
      model: "claude-3-5-haiku-20241022",
      messages: [{ role: "user", content: "test" }],
      maxTokens: 10,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("AuthenticationError");
    }
  }, 30000);

  it("should respect maxTokens limit", async () => {
    if (!hasApiKey) return;
    const provider = createAnthropicProvider();

    const result = await provider.chat({
      model: "claude-3-5-haiku-20241022",
      messages: [
        { role: "user", content: "Write a very long essay about the history of computing." },
      ],
      maxTokens: 20, // Very short limit
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Output tokens should be around or under maxTokens
      expect(result.value.usage.outputTokens).toBeLessThanOrEqual(25);
    }
  }, 30000);

  it("should expose correct provider metadata", () => {
    const provider = createAnthropicProvider();
    expect(provider.id).toBe("anthropic");
    expect(provider.name).toBe("Anthropic Claude");
    expect(provider.models.length).toBeGreaterThan(0);
    expect(provider.models).toContain("claude-3-5-haiku-20241022");
    expect(provider.supportsStreaming).toBe(true);
  });

  // ─── Streaming Tests ───

  it("should stream a simple chat response", async () => {
    if (!hasApiKey) return;
    const provider = createAnthropicProvider();

    const chunks: string[] = [];
    let gotComplete = false;
    let outputTokens = 0;

    const stream = provider.chatStream!({
      model: "claude-3-5-haiku-20241022",
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
        if (chunk.tokens) {
          outputTokens = chunk.tokens;
        }
      }
    }

    const fullContent = chunks.join("");
    expect(fullContent.toLowerCase()).toContain("hello");
    expect(chunks.length).toBeGreaterThan(0);
    expect(gotComplete).toBe(true);
    expect(outputTokens).toBeGreaterThan(0);
  }, 30000);

  it("should stream with system messages", async () => {
    if (!hasApiKey) return;
    const provider = createAnthropicProvider();

    const chunks: string[] = [];

    const stream = provider.chatStream!({
      model: "claude-3-5-haiku-20241022",
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

  it("should stream multi-turn conversations", async () => {
    if (!hasApiKey) return;
    const provider = createAnthropicProvider();

    const chunks: string[] = [];

    const stream = provider.chatStream!({
      model: "claude-3-5-haiku-20241022",
      messages: [
        { role: "user", content: "Remember the color blue." },
        { role: "assistant", content: "I'll remember blue." },
        { role: "user", content: "What color did I say? Reply with just the color." },
      ],
      maxTokens: 10,
      stream: true,
    });

    for await (const chunk of stream) {
      if (chunk.content) {
        chunks.push(chunk.content);
      }
    }

    const fullContent = chunks.join("").toLowerCase();
    expect(fullContent).toContain("blue");
  }, 30000);

  it("should throw classified error when streaming with invalid key", async () => {
    const provider = createAnthropicProvider("sk-ant-invalid-key-12345");

    const stream = provider.chatStream!({
      model: "claude-3-5-haiku-20241022",
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
    const provider = createAnthropicProvider();

    // Use a deterministic prompt
    const messages = [
      { role: "user" as const, content: "What is 2+3? Reply with just the number." },
    ];

    // Non-streaming
    const syncResult = await provider.chat({
      model: "claude-3-5-haiku-20241022",
      messages,
      maxTokens: 10,
      temperature: 0,
    });

    // Streaming
    const chunks: string[] = [];
    const stream = provider.chatStream!({
      model: "claude-3-5-haiku-20241022",
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
      // Both should contain "5"
      expect(syncResult.value.content).toContain("5");
      expect(streamContent).toContain("5");
    }
  }, 60000);
});

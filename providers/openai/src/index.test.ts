// Unit tests for OpenAI provider — tests logic without API keys

import { describe, it, expect } from "vitest";
import { createOpenAIProvider } from "./index.js";

describe("OpenAI Provider Unit Tests", () => {
  // ─── Provider Metadata ───

  it("should have correct provider ID", () => {
    const provider = createOpenAIProvider("fake-key");
    expect(provider.id).toBe("openai");
  });

  it("should have correct provider name", () => {
    const provider = createOpenAIProvider("fake-key");
    expect(provider.name).toBe("OpenAI GPT");
  });

  it("should list supported models", () => {
    const provider = createOpenAIProvider("fake-key");
    expect(provider.models.length).toBeGreaterThan(0);
    expect(provider.models).toContain("gpt-4o");
    expect(provider.models).toContain("gpt-4o-mini");
    expect(provider.models).toContain("gpt-4-turbo");
    expect(provider.models).toContain("gpt-3.5-turbo");
  });

  it("should declare streaming support", () => {
    const provider = createOpenAIProvider("fake-key");
    expect(provider.supportsStreaming).toBe(true);
  });

  it("should expose chatStream method", () => {
    const provider = createOpenAIProvider("fake-key");
    expect(provider.chatStream).toBeDefined();
    expect(typeof provider.chatStream).toBe("function");
  });

  // ─── Availability ───

  it("should report available when API key is provided", async () => {
    const provider = createOpenAIProvider("sk-some-key");
    expect(await provider.isAvailable()).toBe(true);
  });

  it("should report unavailable when API key is empty string", async () => {
    const provider = createOpenAIProvider("");
    expect(await provider.isAvailable()).toBe(false);
  });

  // ─── Error Handling (no API key) ───

  it("should return error for chat when no API key", async () => {
    const provider = createOpenAIProvider("");
    const result = await provider.chat({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "test" }],
      maxTokens: 10,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("OPENAI_API_KEY not set");
    }
  });

  it("should throw error for chatStream when no API key", async () => {
    const provider = createOpenAIProvider("");

    try {
      const stream = provider.chatStream!({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "test" }],
        maxTokens: 10,
        stream: true,
      });
      for await (const _ of stream) {
        // noop
      }
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("OPENAI_API_KEY not set");
    }
  });

  // ─── Error Classification (invalid key hits real API) ───

  it("should classify auth error for invalid API key", async () => {
    const provider = createOpenAIProvider("sk-invalid-key-12345");
    const result = await provider.chat({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "test" }],
      maxTokens: 10,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("AuthenticationError");
      expect(result.error.message).toContain("authentication");
    }
  }, 15000);

  // ─── Model List Integrity ───

  it("should not have duplicate models", () => {
    const provider = createOpenAIProvider("fake-key");
    const uniqueModels = new Set(provider.models);
    expect(uniqueModels.size).toBe(provider.models.length);
  });

  it("should list only gpt models", () => {
    const provider = createOpenAIProvider("fake-key");
    for (const model of provider.models) {
      expect(model).toMatch(/^gpt-/);
    }
  });
});

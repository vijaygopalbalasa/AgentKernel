// Unit tests for Ollama provider — tests logic without running Ollama

import { describe, it, expect } from "vitest";
import { createOllamaProvider, listOllamaModels } from "./index.js";

describe("Ollama Provider Unit Tests", () => {
  // ─── Provider Metadata ───

  it("should have correct provider ID", () => {
    const provider = createOllamaProvider();
    expect(provider.id).toBe("ollama");
  });

  it("should have correct provider name", () => {
    const provider = createOllamaProvider();
    expect(provider.name).toBe("Ollama (Local)");
  });

  it("should list default models", () => {
    const provider = createOllamaProvider();
    expect(provider.models.length).toBeGreaterThan(0);
    expect(provider.models).toContain("llama3.2");
    expect(provider.models).toContain("mistral");
    expect(provider.models).toContain("codellama");
  });

  it("should declare streaming support", () => {
    const provider = createOllamaProvider();
    expect(provider.supportsStreaming).toBe(true);
  });

  it("should expose chatStream method", () => {
    const provider = createOllamaProvider();
    expect(provider.chatStream).toBeDefined();
    expect(typeof provider.chatStream).toBe("function");
  });

  // ─── Availability ───

  it("should report unavailable when Ollama is not running", async () => {
    // Use a valid but unbound port
    const provider = createOllamaProvider("http://localhost:19999");
    const available = await provider.isAvailable();
    expect(available).toBe(false);
  });

  it("should use custom base URL", () => {
    const provider = createOllamaProvider("http://custom-host:11434");
    // Can't directly inspect the URL, but creating shouldn't throw
    expect(provider.id).toBe("ollama");
  });

  // ─── Error Classification ───

  it("should classify network error for unreachable host", async () => {
    const provider = createOllamaProvider("http://localhost:19999");
    const result = await provider.chat({
      model: "llama3.2",
      messages: [{ role: "user", content: "test" }],
      maxTokens: 10,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("NetworkError");
    }
  }, 10000);

  it("should classify network error for chatStream with unreachable host", async () => {
    const provider = createOllamaProvider("http://localhost:19999");

    try {
      const stream = provider.chatStream!({
        model: "llama3.2",
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
      expect((error as Error).name).toBe("NetworkError");
    }
  }, 10000);

  // ─── listOllamaModels ───

  it("should return empty array when Ollama is not running", async () => {
    const models = await listOllamaModels("http://localhost:19999");
    expect(models).toEqual([]);
  });

  // ─── Model List Integrity ───

  it("should not have duplicate models", () => {
    const provider = createOllamaProvider();
    const uniqueModels = new Set(provider.models);
    expect(uniqueModels.size).toBe(provider.models.length);
  });
});

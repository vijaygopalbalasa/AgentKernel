// Unit tests for Google Gemini provider — tests logic without API keys

import { describe, it, expect } from "vitest";
import { createGoogleProvider } from "./index.js";

describe("Google Gemini Provider Unit Tests", () => {
  // ─── Provider Metadata ───

  it("should have correct provider ID", () => {
    const provider = createGoogleProvider("fake-key");
    expect(provider.id).toBe("google");
  });

  it("should have correct provider name", () => {
    const provider = createGoogleProvider("fake-key");
    expect(provider.name).toBe("Google Gemini");
  });

  it("should list supported models", () => {
    const provider = createGoogleProvider("fake-key");
    expect(provider.models.length).toBeGreaterThan(0);
    expect(provider.models).toContain("gemini-2.5-pro");
    expect(provider.models).toContain("gemini-2.5-flash");
    expect(provider.models).toContain("gemini-2.0-flash");
    expect(provider.models).toContain("gemini-1.5-pro");
    expect(provider.models).toContain("gemini-1.5-flash");
  });

  it("should declare streaming support", () => {
    const provider = createGoogleProvider("fake-key");
    expect(provider.supportsStreaming).toBe(true);
  });

  it("should expose chatStream method", () => {
    const provider = createGoogleProvider("fake-key");
    expect(provider.chatStream).toBeDefined();
    expect(typeof provider.chatStream).toBe("function");
  });

  // ─── Availability ───

  it("should report available when API key is provided", async () => {
    const provider = createGoogleProvider("AIza-some-key");
    expect(await provider.isAvailable()).toBe(true);
  });

  it("should report unavailable when API key is empty string", async () => {
    const provider = createGoogleProvider("");
    expect(await provider.isAvailable()).toBe(false);
  });

  // ─── Error Handling (no API key) ───

  it("should return error for chat when no API key", async () => {
    const provider = createGoogleProvider("");
    const result = await provider.chat({
      model: "gemini-2.0-flash",
      messages: [{ role: "user", content: "test" }],
      maxTokens: 10,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("GOOGLE_AI_API_KEY not set");
    }
  });

  it("should throw error for chatStream when no API key", async () => {
    const provider = createGoogleProvider("");

    try {
      const stream = provider.chatStream!({
        model: "gemini-2.0-flash",
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
      expect((error as Error).message).toContain("GOOGLE_AI_API_KEY not set");
    }
  });

  // ─── Error Classification (invalid key hits real API) ───

  it("should return error for invalid API key", async () => {
    const provider = createGoogleProvider("invalid-key-12345");
    const result = await provider.chat({
      model: "gemini-2.0-flash",
      messages: [{ role: "user", content: "test" }],
      maxTokens: 10,
    });

    expect(result.ok).toBe(false);
  }, 15000);

  // ─── Model List Integrity ───

  it("should not have duplicate models", () => {
    const provider = createGoogleProvider("fake-key");
    const uniqueModels = new Set(provider.models);
    expect(uniqueModels.size).toBe(provider.models.length);
  });

  it("should list only gemini models", () => {
    const provider = createGoogleProvider("fake-key");
    for (const model of provider.models) {
      expect(model).toMatch(/^gemini-/);
    }
  });
});

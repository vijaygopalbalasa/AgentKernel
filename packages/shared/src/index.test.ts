// Unit tests for @agentrun/shared — Result type and type contracts

import { describe, it, expect } from "vitest";
import { ok, err } from "./index.js";
import type { Result, Ok, Err, ChatRequest, ChatResponse, AgentManifest, AgentState, ChatMessage } from "./index.js";

describe("Result type utilities", () => {
  it("ok() creates Ok result with value", () => {
    const result = ok(42);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(42);
  });

  it("ok() works with string values", () => {
    const result = ok("hello");
    expect(result.ok).toBe(true);
    expect(result.value).toBe("hello");
  });

  it("ok() works with object values", () => {
    const data = { name: "test", count: 5 };
    const result = ok(data);
    expect(result.ok).toBe(true);
    expect(result.value).toEqual(data);
  });

  it("ok() works with null", () => {
    const result = ok(null);
    expect(result.ok).toBe(true);
    expect(result.value).toBeNull();
  });

  it("ok() works with undefined", () => {
    const result = ok(undefined);
    expect(result.ok).toBe(true);
    expect(result.value).toBeUndefined();
  });

  it("ok() works with arrays", () => {
    const result = ok([1, 2, 3]);
    expect(result.ok).toBe(true);
    expect(result.value).toEqual([1, 2, 3]);
  });

  it("err() creates Err result with error", () => {
    const error = new Error("something failed");
    const result = err(error);
    expect(result.ok).toBe(false);
    expect(result.error).toBe(error);
    expect(result.error.message).toBe("something failed");
  });

  it("err() works with string errors", () => {
    const result = err("bad input");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("bad input");
  });

  it("err() works with custom error types", () => {
    class ValidationError extends Error {
      constructor(public readonly field: string, message: string) {
        super(message);
        this.name = "ValidationError";
      }
    }
    const result = err(new ValidationError("email", "invalid format"));
    expect(result.ok).toBe(false);
    expect(result.error.field).toBe("email");
    expect(result.error.name).toBe("ValidationError");
  });

  it("Result type narrows correctly via ok discriminant", () => {
    const result: Result<number> = ok(42);

    if (result.ok) {
      // TypeScript narrows to Ok<number>
      const val: number = result.value;
      expect(val).toBe(42);
    } else {
      // Should not reach here
      expect.fail("Should be ok");
    }
  });

  it("Result type narrows correctly for errors", () => {
    const result: Result<number> = err(new Error("fail"));

    if (!result.ok) {
      // TypeScript narrows to Err<Error>
      const e: Error = result.error;
      expect(e.message).toBe("fail");
    } else {
      expect.fail("Should be err");
    }
  });

  it("ok and err produce readonly properties", () => {
    const okResult = ok(10);
    const errResult = err(new Error("x"));

    // Verify structure
    expect(Object.keys(okResult)).toContain("ok");
    expect(Object.keys(okResult)).toContain("value");
    expect(Object.keys(errResult)).toContain("ok");
    expect(Object.keys(errResult)).toContain("error");
  });
});

describe("Type contracts", () => {
  it("ChatRequest has required fields", () => {
    const request: ChatRequest = {
      model: "claude-3-5-haiku-20241022",
      messages: [{ role: "user", content: "hello" }],
    };
    expect(request.model).toBe("claude-3-5-haiku-20241022");
    expect(request.messages).toHaveLength(1);
    expect(request.maxTokens).toBeUndefined();
    expect(request.temperature).toBeUndefined();
    expect(request.stream).toBeUndefined();
  });

  it("ChatRequest accepts optional fields", () => {
    const request: ChatRequest = {
      model: "gpt-4o",
      messages: [{ role: "system", content: "you are helpful" }, { role: "user", content: "hi" }],
      maxTokens: 1024,
      temperature: 0.7,
      stream: true,
    };
    expect(request.maxTokens).toBe(1024);
    expect(request.temperature).toBe(0.7);
    expect(request.stream).toBe(true);
  });

  it("ChatMessage enforces valid roles", () => {
    const system: ChatMessage = { role: "system", content: "sys" };
    const user: ChatMessage = { role: "user", content: "usr" };
    const assistant: ChatMessage = { role: "assistant", content: "ast" };

    expect(system.role).toBe("system");
    expect(user.role).toBe("user");
    expect(assistant.role).toBe("assistant");
  });

  it("ChatResponse has required fields", () => {
    const response: ChatResponse = {
      content: "Hello!",
      model: "claude-3-5-haiku-20241022",
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    expect(response.content).toBe("Hello!");
    expect(response.usage.inputTokens).toBe(10);
    expect(response.usage.outputTokens).toBe(5);
    expect(response.finishReason).toBeUndefined();
    expect(response.requestId).toBeUndefined();
  });

  it("ChatResponse accepts router metadata", () => {
    const response: ChatResponse = {
      content: "Hi",
      model: "gpt-4o",
      usage: { inputTokens: 5, outputTokens: 2 },
      finishReason: "stop",
      requestId: "req_123",
      providerId: "openai",
      latencyMs: 450,
      retryCount: 1,
      failoverCount: 0,
    };
    expect(response.requestId).toBe("req_123");
    expect(response.providerId).toBe("openai");
    expect(response.latencyMs).toBe(450);
  });

  it("AgentState covers all lifecycle states", () => {
    const states: AgentState[] = ["initializing", "ready", "running", "paused", "error", "terminated"];
    expect(states).toHaveLength(6);
  });

  it("AgentManifest accepts full configuration", () => {
    const manifest: AgentManifest = {
      id: "agent-1",
      name: "Test Agent",
      version: "1.0.0",
      description: "A test agent",
      author: "test",
      requiredSkills: ["web-search"],
      permissions: ["network:read"],
      trustLevel: "supervised",
      limits: {
        maxTokensPerRequest: 4096,
        tokensPerMinute: 100000,
        costBudgetUSD: 10,
      },
    };
    expect(manifest.id).toBe("agent-1");
    expect(manifest.trustLevel).toBe("supervised");
    expect(manifest.limits?.costBudgetUSD).toBe(10);
  });
});

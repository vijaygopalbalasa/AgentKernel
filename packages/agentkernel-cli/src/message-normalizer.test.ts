import { describe, expect, it } from "vitest";
import {
  type NormalizedMessage,
  formatResponse,
  normalizeMessage,
} from "./message-normalizer.js";
import type { ToolResult } from "./interceptor.js";

// ─── NORMALIZE ───────────────────────────────────────────────

describe("normalizeMessage", () => {
  describe("OpenClaw real gateway protocol (req/node.invoke)", () => {
    it("parses node.invoke request frame", () => {
      const msg = JSON.stringify({
        type: "req",
        id: "req-abc-123",
        method: "node.invoke",
        params: {
          nodeId: "device-1",
          command: "bash",
          params: { command: "ls -la" },
          timeoutMs: 30000,
          idempotencyKey: "key-1",
        },
      });
      const result = normalizeMessage(msg);
      expect(result).not.toBeNull();
      expect(result!.format).toBe("openclaw");
      expect(result!.id).toBe("req-abc-123");
      expect(result!.toolCall.tool).toBe("bash");
      expect(result!.toolCall.args).toEqual({ command: "ls -la" });
    });

    it("parses node.invoke with read command", () => {
      const msg = JSON.stringify({
        type: "req",
        id: "req-2",
        method: "node.invoke",
        params: {
          nodeId: "laptop",
          command: "read",
          params: { path: "/home/user/.ssh/id_rsa" },
          idempotencyKey: "k2",
        },
      });
      const result = normalizeMessage(msg);
      expect(result).not.toBeNull();
      expect(result!.toolCall.tool).toBe("read");
      expect(result!.toolCall.args).toEqual({ path: "/home/user/.ssh/id_rsa" });
    });

    it("parses node.invoke without params (no tool args)", () => {
      const msg = JSON.stringify({
        type: "req",
        id: "req-3",
        method: "node.invoke",
        params: {
          nodeId: "device-1",
          command: "status",
          idempotencyKey: "k3",
        },
      });
      const result = normalizeMessage(msg);
      expect(result).not.toBeNull();
      expect(result!.toolCall.tool).toBe("status");
      expect(result!.toolCall.args).toBeUndefined();
    });

    it("parses node.invoke with paramsJSON string", () => {
      const msg = JSON.stringify({
        type: "req",
        id: "req-4",
        method: "node.invoke",
        params: {
          nodeId: "device-1",
          command: "write",
          params: JSON.stringify({ path: "/tmp/test.txt", content: "hello" }),
          idempotencyKey: "k4",
        },
      });
      const result = normalizeMessage(msg);
      expect(result).not.toBeNull();
      expect(result!.toolCall.tool).toBe("write");
      // String params should be parsed as JSON
      expect(result!.toolCall.args).toEqual({ path: "/tmp/test.txt", content: "hello" });
    });

    it("ignores non-node.invoke req frames", () => {
      const msg = JSON.stringify({
        type: "req",
        id: "req-5",
        method: "chat.send",
        params: { message: "hello" },
      });
      // Should NOT match — method is not "node.invoke"
      const result = normalizeMessage(msg);
      expect(result).toBeNull();
    });

    it("ignores res frames", () => {
      const msg = JSON.stringify({
        type: "res",
        id: "req-1",
        ok: true,
        payload: {},
      });
      expect(normalizeMessage(msg)).toBeNull();
    });

    it("ignores event frames", () => {
      const msg = JSON.stringify({
        type: "event",
        event: "chat.token",
        payload: { token: "hello" },
      });
      expect(normalizeMessage(msg)).toBeNull();
    });

    it("ignores hello-ok frames", () => {
      const msg = JSON.stringify({
        type: "hello-ok",
        protocol: 1,
        server: { version: "1.0", connId: "c1" },
        features: { methods: [], events: [] },
        snapshot: {},
        policy: { maxPayload: 1000, maxBufferedBytes: 5000, tickIntervalMs: 1000 },
      });
      expect(normalizeMessage(msg)).toBeNull();
    });
  });

  describe("OpenClaw legacy format (tool_invoke)", () => {
    it("parses valid legacy OpenClaw message", () => {
      const msg = JSON.stringify({
        type: "tool_invoke",
        id: "abc-123",
        sessionId: "sess-1",
        data: { tool: "bash", args: { command: "ls" } },
      });
      const result = normalizeMessage(msg);
      expect(result).not.toBeNull();
      expect(result!.format).toBe("openclaw-legacy");
      expect(result!.id).toBe("abc-123");
      expect(result!.sessionId).toBe("sess-1");
      expect(result!.toolCall.tool).toBe("bash");
      expect(result!.toolCall.args).toEqual({ command: "ls" });
    });

    it("parses legacy OpenClaw without sessionId", () => {
      const msg = JSON.stringify({
        type: "tool_invoke",
        id: "1",
        data: { tool: "read", args: { path: "/tmp/x" } },
      });
      const result = normalizeMessage(msg);
      expect(result).not.toBeNull();
      expect(result!.format).toBe("openclaw-legacy");
      expect(result!.sessionId).toBeUndefined();
    });

    it("parses legacy OpenClaw without args", () => {
      const msg = JSON.stringify({
        type: "tool_invoke",
        id: "1",
        data: { tool: "status" },
      });
      const result = normalizeMessage(msg);
      expect(result).not.toBeNull();
      expect(result!.toolCall.args).toBeUndefined();
    });
  });

  describe("MCP / JSON-RPC format", () => {
    it("parses valid MCP message with string id", () => {
      const msg = JSON.stringify({
        jsonrpc: "2.0",
        id: "req-1",
        method: "tools/call",
        params: { name: "bash", arguments: { command: "git status" } },
      });
      const result = normalizeMessage(msg);
      expect(result).not.toBeNull();
      expect(result!.format).toBe("mcp");
      expect(result!.id).toBe("req-1");
      expect(result!.toolCall.tool).toBe("bash");
      expect(result!.toolCall.args).toEqual({ command: "git status" });
    });

    it("parses MCP message with numeric id", () => {
      const msg = JSON.stringify({
        jsonrpc: "2.0",
        id: 42,
        method: "tools/call",
        params: { name: "read", arguments: { path: "/tmp" } },
      });
      const result = normalizeMessage(msg);
      expect(result).not.toBeNull();
      expect(result!.id).toBe("42");
    });

    it("parses MCP message without id", () => {
      const msg = JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "bash", arguments: {} },
      });
      const result = normalizeMessage(msg);
      expect(result).not.toBeNull();
      expect(result!.id).toBeUndefined();
    });

    it("parses MCP message without arguments", () => {
      const msg = JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "tools/call",
        params: { name: "status" },
      });
      const result = normalizeMessage(msg);
      expect(result).not.toBeNull();
      expect(result!.toolCall.args).toBeUndefined();
    });

    it("rejects non-tools/call method", () => {
      const msg = JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "resources/list",
        params: {},
      });
      expect(normalizeMessage(msg)).toBeNull();
    });

    it("rejects wrong jsonrpc version", () => {
      const msg = JSON.stringify({
        jsonrpc: "1.0",
        method: "tools/call",
        params: { name: "bash" },
      });
      expect(normalizeMessage(msg)).toBeNull();
    });
  });

  describe("Simple format", () => {
    it("parses valid Simple message", () => {
      const msg = JSON.stringify({ tool: "bash", args: { command: "ls" } });
      const result = normalizeMessage(msg);
      expect(result).not.toBeNull();
      expect(result!.format).toBe("simple");
      expect(result!.toolCall.tool).toBe("bash");
      expect(result!.toolCall.args).toEqual({ command: "ls" });
    });

    it("parses Simple message without args", () => {
      const msg = JSON.stringify({ tool: "status" });
      const result = normalizeMessage(msg);
      expect(result).not.toBeNull();
      expect(result!.toolCall.args).toBeUndefined();
    });

    it("does not have id or sessionId", () => {
      const msg = JSON.stringify({ tool: "bash", args: {} });
      const result = normalizeMessage(msg);
      expect(result).not.toBeNull();
      expect(result!.id).toBeUndefined();
      expect(result!.sessionId).toBeUndefined();
    });
  });

  describe("unrecognized formats", () => {
    it("returns null for non-JSON", () => {
      expect(normalizeMessage("not json")).toBeNull();
    });

    it("returns null for empty object", () => {
      expect(normalizeMessage("{}")).toBeNull();
    });

    it("returns null for array", () => {
      expect(normalizeMessage("[]")).toBeNull();
    });

    it("returns null for random JSON", () => {
      expect(normalizeMessage('{"foo":"bar"}')).toBeNull();
    });

    it("returns null for empty tool name", () => {
      expect(normalizeMessage('{"tool":""}')).toBeNull();
    });

    it("returns null for non-tool_invoke type", () => {
      const msg = JSON.stringify({
        type: "tool_result",
        id: "1",
        data: { result: "ok" },
      });
      expect(normalizeMessage(msg)).toBeNull();
    });
  });

  describe("format priority", () => {
    it("OpenClaw req takes priority over legacy when both could match", () => {
      // Real OpenClaw req frame should match first
      const msg = JSON.stringify({
        type: "req",
        id: "1",
        method: "node.invoke",
        params: { nodeId: "d1", command: "bash", params: { command: "ls" }, idempotencyKey: "k" },
      });
      const result = normalizeMessage(msg);
      expect(result).not.toBeNull();
      expect(result!.format).toBe("openclaw");
    });

    it("Legacy OpenClaw takes priority when both type and tool exist", () => {
      const msg = JSON.stringify({
        type: "tool_invoke",
        id: "1",
        data: { tool: "bash" },
        tool: "should-not-match",
      });
      const result = normalizeMessage(msg);
      expect(result).not.toBeNull();
      expect(result!.format).toBe("openclaw-legacy");
      expect(result!.toolCall.tool).toBe("bash");
    });
  });
});

// ─── FORMAT RESPONSE ─────────────────────────────────────────

describe("formatResponse", () => {
  const makeNormalized = (
    format: "openclaw" | "openclaw-legacy" | "mcp" | "simple",
    overrides: Partial<NormalizedMessage> = {},
  ): NormalizedMessage => ({
    format,
    id: "test-id",
    toolCall: { tool: "bash", args: { command: "ls" }, timestamp: new Date() },
    raw: {},
    ...overrides,
  });

  const allowedResult: ToolResult = {
    allowed: true,
    evaluation: { decision: "allow", reason: "Matched allowlist" },
    executionTimeMs: 2,
  };

  const blockedResult: ToolResult = {
    allowed: false,
    error: "Blocked by policy",
    evaluation: { decision: "block", reason: "Sensitive file access" },
    executionTimeMs: 1,
  };

  describe("OpenClaw real protocol responses (res frame)", () => {
    it("formats allowed response as res frame", () => {
      const resp = JSON.parse(formatResponse(makeNormalized("openclaw"), allowedResult));
      expect(resp.type).toBe("res");
      expect(resp.id).toBe("test-id");
      expect(resp.ok).toBe(true);
      expect(resp.payload.decision).toBe("allowed");
    });

    it("formats blocked response as res frame with error", () => {
      const resp = JSON.parse(formatResponse(makeNormalized("openclaw"), blockedResult));
      expect(resp.type).toBe("res");
      expect(resp.id).toBe("test-id");
      expect(resp.ok).toBe(false);
      expect(resp.error.code).toBe("POLICY_BLOCKED");
      expect(resp.error.message).toBe("Sensitive file access");
      expect(resp.error.details.tool).toBe("bash");
      expect(resp.error.details.decision).toBe("blocked");
    });
  });

  describe("OpenClaw legacy responses (tool_result)", () => {
    it("formats allowed response", () => {
      const resp = JSON.parse(formatResponse(makeNormalized("openclaw-legacy"), allowedResult));
      expect(resp.type).toBe("tool_result");
      expect(resp.id).toBe("test-id");
      expect(resp.data.result.decision).toBe("allowed");
    });

    it("formats blocked response", () => {
      const resp = JSON.parse(formatResponse(makeNormalized("openclaw-legacy"), blockedResult));
      expect(resp.type).toBe("tool_result");
      expect(resp.data.error.code).toBe("POLICY_BLOCKED");
      expect(resp.data.error.decision).toBe("blocked");
      expect(resp.data.error.tool).toBe("bash");
    });
  });

  describe("MCP responses", () => {
    it("formats allowed response", () => {
      const resp = JSON.parse(formatResponse(makeNormalized("mcp"), allowedResult));
      expect(resp.jsonrpc).toBe("2.0");
      expect(resp.id).toBe("test-id");
      expect(resp.result.content[0].type).toBe("text");
      const inner = JSON.parse(resp.result.content[0].text);
      expect(inner.decision).toBe("allowed");
    });

    it("formats blocked response", () => {
      const resp = JSON.parse(formatResponse(makeNormalized("mcp"), blockedResult));
      expect(resp.jsonrpc).toBe("2.0");
      expect(resp.error.code).toBe(-32600);
      expect(resp.error.data.decision).toBe("blocked");
    });

    it("uses null for missing id", () => {
      const resp = JSON.parse(
        formatResponse(makeNormalized("mcp", { id: undefined }), allowedResult),
      );
      expect(resp.id).toBeNull();
    });
  });

  describe("Simple responses", () => {
    it("formats allowed response", () => {
      const resp = JSON.parse(formatResponse(makeNormalized("simple"), allowedResult));
      expect(resp.decision).toBe("allowed");
      expect(resp.reason).toBe("Matched allowlist");
      expect(resp.tool).toBe("bash");
      expect(resp.executionTimeMs).toBe(2);
    });

    it("formats blocked response", () => {
      const resp = JSON.parse(formatResponse(makeNormalized("simple"), blockedResult));
      expect(resp.decision).toBe("blocked");
      expect(resp.reason).toBe("Sensitive file access");
    });
  });

  describe("approval_required", () => {
    it("formats approval required response", () => {
      const approvalResult: ToolResult = {
        allowed: false,
        evaluation: { decision: "approve", reason: "Needs manual approval" },
      };
      const resp = JSON.parse(formatResponse(makeNormalized("simple"), approvalResult));
      expect(resp.decision).toBe("approval_required");
    });
  });
});

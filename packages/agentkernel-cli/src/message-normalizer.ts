// Message Normalizer — accepts OpenClaw, MCP/JSON-RPC, and Simple formats
// Normalizes all formats into the internal ToolCall type

import { z } from "zod";
import type { ToolCall, ToolResult } from "./interceptor.js";

// ─── MESSAGE SCHEMAS ─────────────────────────────────────────

/**
 * OpenClaw real gateway protocol — request frame with node.invoke method.
 * Format: { type: "req", id: "...", method: "node.invoke", params: { nodeId, command, params, ... } }
 * See: openclaw/src/gateway/protocol/schema/frames.ts + nodes.ts
 */
const OpenClawReqSchema = z.object({
  type: z.literal("req"),
  id: z.string().min(1),
  method: z.literal("node.invoke"),
  params: z.object({
    nodeId: z.string().min(1),
    command: z.string().min(1),
    params: z.unknown().optional(),
    timeoutMs: z.number().optional(),
    idempotencyKey: z.string().optional(),
  }),
});

/** OpenClaw legacy format (tool_invoke — kept for backward compat) */
const OpenClawLegacySchema = z.object({
  type: z.literal("tool_invoke"),
  id: z.string(),
  sessionId: z.string().optional(),
  data: z.object({
    tool: z.string().min(1),
    args: z.record(z.unknown()).optional(),
  }),
});

/** MCP / JSON-RPC 2.0 format */
const McpSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.literal("tools/call"),
  params: z.object({
    name: z.string().min(1),
    arguments: z.record(z.unknown()).optional(),
  }),
});

/** Simple format — for quick testing and integrations */
const SimpleSchema = z.object({
  tool: z.string().min(1),
  args: z.record(z.unknown()).optional(),
});

// ─── TYPES ───────────────────────────────────────────────────

export type MessageFormat = "openclaw" | "openclaw-legacy" | "mcp" | "simple";

export interface NormalizedMessage {
  /** Which format the original message was in */
  format: MessageFormat;
  /** Message ID (from OpenClaw id or JSON-RPC id) */
  id?: string;
  /** Session ID (from OpenClaw sessionId) */
  sessionId?: string;
  /** Normalized tool call for the interceptor */
  toolCall: ToolCall;
  /** Original parsed message (for forwarding in proxy mode) */
  raw: unknown;
}

export interface EvaluationResponse {
  decision: "allowed" | "blocked" | "approval_required";
  reason: string;
  tool: string;
  matchedRule?: string;
  executionTimeMs?: number;
}

// ─── NORMALIZE ───────────────────────────────────────────────

/**
 * Parse a raw message string and normalize it into the internal ToolCall type.
 * Tries OpenClaw req format first, then legacy OpenClaw, then MCP/JSON-RPC, then Simple.
 * Returns null if the message doesn't match any recognized format.
 */
export function normalizeMessage(data: string): NormalizedMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }

  // Try OpenClaw real gateway protocol: { type: "req", method: "node.invoke", params: { command, params } }
  const ocReq = OpenClawReqSchema.safeParse(parsed);
  if (ocReq.success) {
    // params.params can be an object (tool args) or a JSON string
    let args: Record<string, unknown> | undefined;
    const rawParams = ocReq.data.params.params;
    if (rawParams && typeof rawParams === "object" && !Array.isArray(rawParams)) {
      args = rawParams as Record<string, unknown>;
    } else if (typeof rawParams === "string") {
      try {
        const p = JSON.parse(rawParams);
        if (p && typeof p === "object" && !Array.isArray(p)) args = p;
      } catch {
        // not JSON — ignore
      }
    }
    return {
      format: "openclaw",
      id: ocReq.data.id,
      toolCall: {
        tool: ocReq.data.params.command,
        args,
        timestamp: new Date(),
      },
      raw: parsed,
    };
  }

  // Try OpenClaw legacy format: { type: "tool_invoke", data: { tool, args } }
  const ocLegacy = OpenClawLegacySchema.safeParse(parsed);
  if (ocLegacy.success) {
    return {
      format: "openclaw-legacy",
      id: ocLegacy.data.id,
      sessionId: ocLegacy.data.sessionId,
      toolCall: {
        tool: ocLegacy.data.data.tool,
        args: ocLegacy.data.data.args,
        sessionId: ocLegacy.data.sessionId,
        timestamp: new Date(),
      },
      raw: parsed,
    };
  }

  // Try MCP / JSON-RPC format
  const mcp = McpSchema.safeParse(parsed);
  if (mcp.success) {
    return {
      format: "mcp",
      id: mcp.data.id != null ? String(mcp.data.id) : undefined,
      toolCall: {
        tool: mcp.data.params.name,
        args: mcp.data.params.arguments,
        timestamp: new Date(),
      },
      raw: parsed,
    };
  }

  // Try Simple format (must have "tool" string field, no "type"/"jsonrpc" to avoid false matches)
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "tool" in parsed &&
    !("type" in parsed) &&
    !("jsonrpc" in parsed)
  ) {
    const simple = SimpleSchema.safeParse(parsed);
    if (simple.success) {
      return {
        format: "simple",
        toolCall: {
          tool: simple.data.tool,
          args: simple.data.args,
          timestamp: new Date(),
        },
        raw: parsed,
      };
    }
  }

  return null;
}

// ─── FORMAT RESPONSE ─────────────────────────────────────────

/**
 * Format a ToolResult response in the same format as the incoming message.
 */
export function formatResponse(
  normalized: NormalizedMessage,
  result: ToolResult,
): string {
  const decision = result.allowed ? "allowed" : (result.evaluation?.decision === "approve" ? "approval_required" : "blocked");
  const reason = result.evaluation?.reason ?? result.error ?? "Unknown";

  switch (normalized.format) {
    case "openclaw":
      // Real OpenClaw gateway protocol: { type: "res", id, ok, payload/error }
      if (result.allowed) {
        return JSON.stringify({
          type: "res",
          id: normalized.id,
          ok: true,
          payload: { decision: "allowed", reason },
        });
      }
      return JSON.stringify({
        type: "res",
        id: normalized.id,
        ok: false,
        error: {
          code: "POLICY_BLOCKED",
          message: reason,
          details: {
            tool: normalized.toolCall.tool,
            decision,
          },
        },
      });

    case "openclaw-legacy":
      if (result.allowed) {
        return JSON.stringify({
          type: "tool_result",
          id: normalized.id,
          sessionId: normalized.sessionId,
          data: {
            result: { decision: "allowed", reason },
          },
        });
      }
      return JSON.stringify({
        type: "tool_result",
        id: normalized.id,
        sessionId: normalized.sessionId,
        data: {
          error: {
            code: "POLICY_BLOCKED",
            message: reason,
            tool: normalized.toolCall.tool,
            decision,
          },
        },
      });

    case "mcp":
      if (result.allowed) {
        return JSON.stringify({
          jsonrpc: "2.0",
          id: normalized.id ?? null,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({ decision: "allowed", reason, tool: normalized.toolCall.tool }),
              },
            ],
          },
        });
      }
      return JSON.stringify({
        jsonrpc: "2.0",
        id: normalized.id ?? null,
        error: {
          code: -32600,
          message: reason,
          data: {
            decision,
            tool: normalized.toolCall.tool,
          },
        },
      });

    case "simple":
      return JSON.stringify({
        decision,
        reason,
        tool: normalized.toolCall.tool,
        executionTimeMs: result.executionTimeMs,
      } satisfies EvaluationResponse);
  }
}

// @agentrun/sdk — AgentRun Software Development Kit
// The primary API for building agents on AgentRun.
//
// Key exports:
// - defineAgent()  — Define an agent with manifest + task handler
// - AgentClient    — High-level API for LLM, memory, tools, A2A, events
// - AgentContext    — Context passed to agent task handlers (includes client)
// - signManifest() — Sign agent manifests for production deployment

import { z } from "zod";
import { createHmac } from "crypto";
import { type Result, ok, err } from "@agentrun/shared";
import { AgentClient } from "./agent-client.js";

// ─── MANIFEST ───────────────────────────────────────────────

export const AgentManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().default("0.1.0"),
  description: z.string().optional(),
  author: z.string().optional(),
  preferredModel: z.string().optional(),
  signedAt: z.string().optional(),
  signedBy: z.string().optional(),
  signature: z.string().optional(),
  entryPoint: z.string().optional(),
  requiredSkills: z.array(z.string()).default([]),
  permissions: z.array(z.string()).default([]),
  permissionGrants: z
    .array(
      z.object({
        category: z.string().min(1),
        actions: z.array(z.string()).min(1),
        resource: z.string().optional(),
        constraints: z.record(z.unknown()).optional(),
      })
    )
    .optional(),
  trustLevel: z.enum(["supervised", "semi-autonomous", "monitored-autonomous"]).optional(),
  a2aSkills: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().optional(),
        description: z.string().optional(),
        inputSchema: z.record(z.unknown()).optional(),
        outputSchema: z.record(z.unknown()).optional(),
      })
    )
    .optional(),
  limits: z
    .object({
      maxTokensPerRequest: z.number().int().min(1).optional(),
      tokensPerMinute: z.number().int().min(1).optional(),
      requestsPerMinute: z.number().int().min(1).optional(),
      toolCallsPerMinute: z.number().int().min(1).optional(),
      costBudgetUSD: z.number().min(0).optional(),
      maxMemoryMB: z.number().int().min(1).optional(),
      cpuCores: z.number().min(0.1).optional(),
      diskQuotaMB: z.number().int().min(16).optional(),
    })
    .optional(),
  mcpServers: z
    .array(
      z.object({
        name: z.string().min(1),
        transport: z.enum(["stdio", "sse", "streamable-http"]),
        command: z.string().optional(),
        args: z.array(z.string()).optional(),
        url: z.string().optional(),
      })
    )
    .optional(),
  tools: z
    .array(
      z.object({
        id: z.string().min(1),
        enabled: z.boolean().optional(),
      })
    )
    .optional(),
});

export type AgentManifest = z.infer<typeof AgentManifestSchema>;

// ─── AGENT LIFECYCLE ────────────────────────────────────────

/** Logger interface available in agent context. */
export interface AgentLogger {
  info: (message: string, data?: Record<string, unknown>) => void;
  warn: (message: string, data?: Record<string, unknown>) => void;
  error: (message: string, data?: Record<string, unknown>) => void;
}

/**
 * Context provided to agent task handlers.
 *
 * The `client` property provides the high-level AgentClient API
 * for interacting with the gateway (LLM, memory, tools, A2A, events).
 *
 * @example
 * ```typescript
 * async handleTask(task, context) {
 *   // Use the client to call an LLM
 *   const response = await context.client.chat([
 *     { role: "user", content: task.question }
 *   ]);
 *
 *   // Store a fact in memory
 *   await context.client.storeFact({
 *     category: "answers",
 *     fact: response.content,
 *   });
 *
 *   return { answer: response.content };
 * }
 * ```
 */
export interface AgentContext {
  /** The agent's unique ID. */
  agentId: string;
  /** Structured logger. */
  log?: AgentLogger;
  /**
   * High-level client for gateway operations.
   * Provides typed methods for LLM chat, memory, tools, A2A, and events.
   * Available when the agent is running connected to a gateway.
   */
  client: AgentClient;
}

export type AgentTaskHandler<TTask = Record<string, unknown>, TResult = unknown> = (
  task: TTask,
  context: AgentContext
) => Promise<TResult> | TResult;

export interface AgentDefinition<TTask = Record<string, unknown>, TResult = unknown> {
  manifest: AgentManifest;
  initialize?: (context: AgentContext) => Promise<void> | void;
  handleTask: AgentTaskHandler<TTask, TResult>;
  terminate?: (context: AgentContext) => Promise<void> | void;
}

export function createAgentDefinition<TTask = Record<string, unknown>, TResult = unknown>(
  definition: AgentDefinition<TTask, TResult>
): Result<AgentDefinition<TTask, TResult>, Error> {
  const manifestResult = AgentManifestSchema.safeParse(definition.manifest);
  if (!manifestResult.success) {
    return err(new Error(`Invalid agent manifest: ${manifestResult.error.message}`));
  }

  return ok({
    ...definition,
    manifest: manifestResult.data,
  });
}

export function defineAgent<TTask = Record<string, unknown>, TResult = unknown>(
  definition: AgentDefinition<TTask, TResult>
): AgentDefinition<TTask, TResult> {
  const result = createAgentDefinition(definition);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(",")}}`;
}

export function signManifest(manifest: AgentManifest, secret: string): AgentManifest {
  const { signature: _signature, ...payload } = manifest;
  const signature = createHmac("sha256", secret).update(stableStringify(payload)).digest("hex");
  return {
    ...manifest,
    signature,
    signedAt: manifest.signedAt ?? new Date().toISOString(),
  };
}

export {
  sendGatewayTask,
  GatewayClientOptionsSchema,
  GatewayValidationError,
  type GatewayClientOptions,
  type GatewayTaskResult,
} from "./gateway-client.js";

export { AgentClient, createAgentClient, type AgentClientOptions } from "./agent-client.js";

export type {
  ChatMessage,
  ChatOptions,
  ChatResponse,
  StoreFact,
  SearchMemoryOptions,
  MemoryResult,
  RecordEpisode,
  ToolResult,
  ToolInfo,
  AgentInfo,
  EmitEvent,
} from "./types.js";

export * from "./tasks.js";

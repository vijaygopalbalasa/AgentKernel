// Tool Types — MCP-compatible tool definitions
// Based on Model Context Protocol specification

import { z } from "zod";

// ─── ZOD SCHEMAS ────────────────────────────────────────────

/** Unique identifier for a tool */
export type ToolId = string;

/** Tool parameter schema using Zod */
export type ToolSchema = z.AnyZodObject;

// ─── ERROR CLASS ────────────────────────────────────────────

/** Tool error codes */
export type ToolErrorCode =
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "INVOCATION_ERROR"
  | "TIMEOUT_ERROR"
  | "PERMISSION_DENIED"
  | "SERVER_ERROR"
  | "CONNECTION_ERROR";

/**
 * Error class for tool operations.
 */
export class ToolError extends Error {
  constructor(
    message: string,
    public readonly code: ToolErrorCode,
    public readonly toolId?: ToolId
  ) {
    super(message);
    this.name = "ToolError";
  }
}

// ─── TOOL RESULT ────────────────────────────────────────────

/** Tool execution result schema */
export const ToolResultSchema = z.object({
  /** Whether the execution succeeded */
  success: z.boolean(),
  /** Result content (if successful) */
  content: z.unknown().optional(),
  /** Error message (if failed) */
  error: z.string().optional(),
  /** Execution time in ms */
  executionTime: z.number().min(0).optional(),
  /** Additional metadata */
  metadata: z.record(z.unknown()).optional(),
});

/** Tool execution result */
export interface ToolResult {
  /** Whether the execution succeeded */
  success: boolean;
  /** Result content (if successful) */
  content?: unknown;
  /** Error message (if failed) */
  error?: string;
  /** Execution time in ms */
  executionTime?: number;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

// ─── TOOL DEFINITION ────────────────────────────────────────

/** Tool definition schema */
export const ToolDefinitionSchema = z.object({
  /** Unique tool identifier */
  id: z.string().min(1),
  /** Human-readable name */
  name: z.string().min(1),
  /** Description of what the tool does */
  description: z.string().min(1),
  /** Input parameter schema (validated at runtime) */
  inputSchema: z.custom<ToolSchema>((val) => typeof val === "object" && val !== null),
  /** Category for grouping */
  category: z.string().optional(),
  /** Tags for discovery */
  tags: z.array(z.string()).optional(),
  /** Whether this tool requires confirmation before execution */
  requiresConfirmation: z.boolean().optional(),
  /** Required permissions to use this tool */
  requiredPermissions: z.array(z.string()).optional(),
});

/** Tool definition */
export interface ToolDefinition {
  /** Unique tool identifier */
  id: ToolId;
  /** Human-readable name */
  name: string;
  /** Description of what the tool does */
  description: string;
  /** Input parameter schema */
  inputSchema: ToolSchema;
  /** Category for grouping */
  category?: string;
  /** Tags for discovery */
  tags?: string[];
  /** Whether this tool requires confirmation before execution */
  requiresConfirmation?: boolean;
  /** Required permissions to use this tool */
  requiredPermissions?: string[];
}

// ─── TOOL INVOCATION ────────────────────────────────────────

/** Tool invocation request schema */
export const ToolInvocationSchema = z.object({
  /** Tool ID to invoke */
  toolId: z.string().min(1),
  /** Input arguments */
  arguments: z.record(z.unknown()),
  /** Invoking agent ID */
  agentId: z.string().optional(),
  /** Request ID for tracking */
  requestId: z.string().optional(),
});

/** Tool invocation request */
export interface ToolInvocation {
  /** Tool ID to invoke */
  toolId: ToolId;
  /** Input arguments */
  arguments: Record<string, unknown>;
  /** Invoking agent ID */
  agentId?: string;
  /** Request ID for tracking */
  requestId?: string;
}

// ─── TOOL HANDLER ───────────────────────────────────────────

/** Tool handler function */
export type ToolHandler<T = unknown> = (
  args: T,
  context: ToolContext
) => Promise<ToolResult>;

// ─── TOOL CONTEXT ───────────────────────────────────────────

/** Tool context schema */
export const ToolContextSchema = z.object({
  /** Invoking agent ID */
  agentId: z.string().optional(),
  /** Request ID */
  requestId: z.string().optional(),
  /** Abort signal for cancellation (validated at runtime) */
  signal: z.custom<AbortSignal>((val) => val === undefined || val instanceof AbortSignal).optional(),
  /** Logger instance (validated at runtime) */
  logger: z.custom<ToolLogger>((val) => val === undefined || typeof val === "object").optional(),
});

/** Context passed to tool handlers */
export interface ToolContext {
  /** Invoking agent ID */
  agentId?: string;
  /** Request ID */
  requestId?: string;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Logger instance */
  logger?: ToolLogger;
}

// ─── TOOL LOGGER ────────────────────────────────────────────

/** Simple logger interface */
export interface ToolLogger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

// ─── MCP SERVER CONFIG ──────────────────────────────────────

/** MCP transport type */
export const MCPTransportTypeSchema = z.enum(["stdio", "http", "sse"]);
export type MCPTransportType = z.infer<typeof MCPTransportTypeSchema>;

/** MCP auth type */
export const MCPAuthTypeSchema = z.enum(["api_key", "bearer", "oauth2"]);
export type MCPAuthType = z.infer<typeof MCPAuthTypeSchema>;

/** MCP auth config schema */
export const MCPAuthConfigSchema = z.object({
  type: MCPAuthTypeSchema,
  token: z.string().optional(),
});

/** MCP Server connection info schema */
export const MCPServerConfigSchema = z.object({
  /** Server name/identifier */
  name: z.string().min(1),
  /** Transport type */
  transport: MCPTransportTypeSchema,
  /** Command to run (for stdio) */
  command: z.string().optional(),
  /** Command arguments (for stdio) */
  args: z.array(z.string()).optional(),
  /** Server URL (for http/sse) */
  url: z.string().url().optional(),
  /** Environment variables */
  env: z.record(z.string()).optional(),
  /** Authentication */
  auth: MCPAuthConfigSchema.optional(),
  /** Allowlist of tool names (supports '*' wildcards) */
  allowedTools: z.array(z.string()).optional(),
  /** Blocklist of tool names (supports '*' wildcards) */
  blockedTools: z.array(z.string()).optional(),
  /** Allowlist of resource URIs (supports '*' wildcards) */
  allowedResources: z.array(z.string()).optional(),
  /** Blocklist of resource URIs (supports '*' wildcards) */
  blockedResources: z.array(z.string()).optional(),
  /** Allowlist of prompt names (supports '*' wildcards) */
  allowedPrompts: z.array(z.string()).optional(),
  /** Blocklist of prompt names (supports '*' wildcards) */
  blockedPrompts: z.array(z.string()).optional(),
});

/** MCP Server connection info */
export interface MCPServerConfig {
  /** Server name/identifier */
  name: string;
  /** Transport type */
  transport: MCPTransportType;
  /** Command to run (for stdio) */
  command?: string;
  /** Command arguments (for stdio) */
  args?: string[];
  /** Server URL (for http/sse) */
  url?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Authentication */
  auth?: {
    type: MCPAuthType;
    token?: string;
  };
  /** Allowlist of tool names (supports '*' wildcards) */
  allowedTools?: string[];
  /** Blocklist of tool names (supports '*' wildcards) */
  blockedTools?: string[];
  /** Allowlist of resource URIs (supports '*' wildcards) */
  allowedResources?: string[];
  /** Blocklist of resource URIs (supports '*' wildcards) */
  blockedResources?: string[];
  /** Allowlist of prompt names (supports '*' wildcards) */
  allowedPrompts?: string[];
  /** Blocklist of prompt names (supports '*' wildcards) */
  blockedPrompts?: string[];
}

// ─── MCP RESOURCE ───────────────────────────────────────────

/** MCP Resource schema */
export const MCPResourceSchema = z.object({
  /** Resource URI */
  uri: z.string().min(1),
  /** Resource name */
  name: z.string().min(1),
  /** Description */
  description: z.string().optional(),
  /** MIME type */
  mimeType: z.string().optional(),
});

/** MCP Resource definition */
export interface MCPResource {
  /** Resource URI */
  uri: string;
  /** Resource name */
  name: string;
  /** Description */
  description?: string;
  /** MIME type */
  mimeType?: string;
}

// ─── MCP PROMPT ─────────────────────────────────────────────

/** MCP prompt argument schema */
export const MCPPromptArgumentSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  required: z.boolean().optional(),
});

/** MCP Prompt schema */
export const MCPPromptSchema = z.object({
  /** Prompt name */
  name: z.string().min(1),
  /** Description */
  description: z.string().optional(),
  /** Arguments the prompt accepts */
  arguments: z.array(MCPPromptArgumentSchema).optional(),
});

/** MCP Prompt template */
export interface MCPPrompt {
  /** Prompt name */
  name: string;
  /** Description */
  description?: string;
  /** Arguments the prompt accepts */
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

// ─── TOOL EXECUTION EVENT ───────────────────────────────────

/** Tool execution event type */
export const ToolExecutionEventTypeSchema = z.enum(["start", "complete", "error"]);
export type ToolExecutionEventType = z.infer<typeof ToolExecutionEventTypeSchema>;

/** Tool execution event schema */
export const ToolExecutionEventSchema = z.object({
  type: ToolExecutionEventTypeSchema,
  toolId: z.string().min(1),
  agentId: z.string().optional(),
  requestId: z.string().optional(),
  timestamp: z.date(),
  duration: z.number().min(0).optional(),
  success: z.boolean().optional(),
  error: z.string().optional(),
});

/** Tool execution event for monitoring */
export interface ToolExecutionEvent {
  type: ToolExecutionEventType;
  toolId: ToolId;
  agentId?: string;
  requestId?: string;
  timestamp: Date;
  duration?: number;
  success?: boolean;
  error?: string;
}

// ─── REGISTER TOOL OPTIONS ──────────────────────────────────

/** Tool registration options schema */
export const RegisterToolOptionsSchema = z.object({
  /** Override existing tool */
  overwrite: z.boolean().optional(),
});

/** Tool registration options */
export interface RegisterToolOptions {
  /** Override existing tool */
  overwrite?: boolean;
}

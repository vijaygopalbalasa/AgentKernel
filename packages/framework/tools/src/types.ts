// Tool Types — MCP-compatible tool definitions
// Based on Model Context Protocol specification

import { z } from "zod";

/** Unique identifier for a tool */
export type ToolId = string;

/** Tool parameter schema using Zod */
export type ToolSchema = z.ZodObject<z.ZodRawShape>;

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

/** Tool handler function */
export type ToolHandler<T = unknown> = (
  args: T,
  context: ToolContext
) => Promise<ToolResult>;

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

/** Simple logger interface */
export interface ToolLogger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

/** MCP Server connection info */
export interface MCPServerConfig {
  /** Server name/identifier */
  name: string;
  /** Transport type */
  transport: "stdio" | "http" | "sse";
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
    type: "api_key" | "bearer" | "oauth2";
    token?: string;
  };
}

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

/** Tool execution event for monitoring */
export interface ToolExecutionEvent {
  type: "start" | "complete" | "error";
  toolId: ToolId;
  agentId?: string;
  requestId?: string;
  timestamp: Date;
  duration?: number;
  success?: boolean;
  error?: string;
}

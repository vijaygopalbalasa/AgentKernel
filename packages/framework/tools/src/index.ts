// @agentkernel/tools — Tool System with MCP Support (Layer 4: Framework)
// Connect agents to tools via Model Context Protocol

// ─── Types ──────────────────────────────────────────────────
export type {
  ToolId,
  ToolSchema,
  ToolResult,
  ToolDefinition,
  ToolInvocation,
  ToolHandler,
  ToolContext,
  ToolLogger,
  ToolExecutionEvent,
  ToolExecutionEventType,
  MCPServerConfig,
  MCPResource,
  MCPPrompt,
  MCPTransportType,
  MCPAuthType,
  ToolErrorCode,
  RegisterToolOptions,
} from "./types.js";

// ─── Zod Schemas ────────────────────────────────────────────
export {
  ToolResultSchema,
  ToolDefinitionSchema,
  ToolInvocationSchema,
  ToolContextSchema,
  ToolExecutionEventSchema,
  ToolExecutionEventTypeSchema,
  MCPServerConfigSchema,
  MCPResourceSchema,
  MCPPromptSchema,
  MCPPromptArgumentSchema,
  MCPTransportTypeSchema,
  MCPAuthTypeSchema,
  MCPAuthConfigSchema,
  RegisterToolOptionsSchema,
} from "./types.js";

// ─── Error Class ────────────────────────────────────────────
export { ToolError } from "./types.js";

// ─── Registry ───────────────────────────────────────────────
export {
  ToolRegistry,
  createToolRegistry,
} from "./registry.js";

// ─── Built-in tools ─────────────────────────────────────────
export { BUILTIN_TOOLS, registerBuiltinTools } from "./builtin.js";

// ─── MCP Client ─────────────────────────────────────────────
export {
  MCPClientManager,
  createMCPClientManager,
  type MCPClientManagerOptions,
  type MCPConnection,
  type MCPConnectionState,
  type MCPClientEvent,
} from "./mcp-client.js";

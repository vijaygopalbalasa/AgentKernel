// @agent-os/tools — Tool System with MCP Support (Layer 4: Framework)
// Connect agents to tools via Model Context Protocol

console.log("✅ @agent-os/tools loaded");

// Types
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
  MCPServerConfig,
  MCPResource,
  MCPPrompt,
} from "./types.js";

// Registry
export {
  ToolRegistry,
  createToolRegistry,
  type RegisterToolOptions,
} from "./registry.js";

// Built-in tools
export { BUILTIN_TOOLS, registerBuiltinTools } from "./builtin.js";

// MCP Client
export {
  MCPClientManager,
  createMCPClientManager,
  type MCPConnection,
  type MCPConnectionState,
  type MCPClientEvent,
} from "./mcp-client.js";

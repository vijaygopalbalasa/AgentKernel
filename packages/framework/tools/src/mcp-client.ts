// MCP Client — connects to Model Context Protocol servers
// Wraps the official @modelcontextprotocol/sdk

import { type Result, ok, err } from "@agentrun/shared";
import { type Logger, createLogger } from "@agentrun/kernel";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolResultSchema,
  ListToolsResultSchema,
  ListResourcesResultSchema,
  ListPromptsResultSchema,
  ReadResourceResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  type MCPServerConfig,
  type MCPResource,
  type MCPPrompt,
  type ToolDefinition,
  type ToolResult,
  ToolError,
  MCPServerConfigSchema,
} from "./types.js";

/** MCP Connection state */
export type MCPConnectionState = "disconnected" | "connecting" | "connected" | "error";

/** Manager options */
export interface MCPClientManagerOptions {
  mode?: "real" | "mock";
  clientInfo?: { name: string; version: string };
}

/** MCP Server connection */
export interface MCPConnection {
  /** Server configuration */
  config: MCPServerConfig;
  /** Current connection state */
  state: MCPConnectionState;
  /** Available tools from this server */
  tools: ToolDefinition[];
  /** Available resources from this server */
  resources: MCPResource[];
  /** Available prompts from this server */
  prompts: MCPPrompt[];
  /** Last error (if state is error) */
  error?: string;
  /** When the connection was established */
  connectedAt?: Date;
  /** MCP client instance (real mode) */
  client?: Client;
  /** MCP transport instance (real mode) */
  transport?: { close?: () => Promise<void> | void };
}

/**
 * MCP Client Manager — manages connections to MCP servers.
 *
 * Features:
 * - Connect to multiple MCP servers
 * - Discover tools, resources, and prompts
 * - Invoke tools on remote servers
 * - Handle reconnection and errors
 * - Optional mock mode for tests
 */
export class MCPClientManager {
  private connections: Map<string, MCPConnection> = new Map();
  private eventListeners: Array<(event: MCPClientEvent) => void> = [];
  private log: Logger;
  private mode: "real" | "mock";
  private clientInfo: { name: string; version: string };

  constructor(options: MCPClientManagerOptions = {}) {
    this.log = createLogger({ name: "mcp-client-manager" });
    this.mode = options.mode ?? "real";
    this.clientInfo = options.clientInfo ?? { name: "agentrun", version: "0.1.0" };
  }

  /**
   * Register an MCP server configuration.
   */
  registerServer(config: MCPServerConfig): Result<void, ToolError> {
    // Validate config
    const configResult = MCPServerConfigSchema.safeParse(config);
    if (!configResult.success) {
      return err(
        new ToolError(
          `Invalid server config: ${configResult.error.message}`,
          "VALIDATION_ERROR"
        )
      );
    }

    const connection: MCPConnection = {
      config,
      state: "disconnected",
      tools: [],
      resources: [],
      prompts: [],
    };

    this.connections.set(config.name, connection);
    this.emit({ type: "server_registered", serverName: config.name });
    this.log.debug("MCP server registered", { serverName: config.name });
    return ok(undefined);
  }

  /**
   * Connect to a registered MCP server.
   */
  async connect(serverName: string): Promise<Result<void, ToolError>> {
    const connection = this.connections.get(serverName);
    if (!connection) {
      return err(
        new ToolError(`Server not found: ${serverName}`, "NOT_FOUND")
      );
    }

    connection.state = "connecting";
    this.emit({ type: "connecting", serverName });
    this.log.debug("Connecting to MCP server", { serverName });

    try {
      if (this.mode === "mock") {
        await this.connectMock(connection);
      } else {
        await this.connectReal(connection);
      }

      connection.state = "connected";
      connection.connectedAt = new Date();
      connection.error = undefined;

      this.emit({
        type: "connected",
        serverName,
        tools: connection.tools.length,
        resources: connection.resources.length,
      });

      this.log.info("Connected to MCP server", {
        serverName,
        tools: connection.tools.length,
        resources: connection.resources.length,
      });

      return ok(undefined);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      connection.state = "error";
      connection.error = errorMsg;
      this.emit({ type: "error", serverName, error: errorMsg });
      this.log.error("Failed to connect to MCP server", { serverName, error: errorMsg });
      return err(new ToolError(errorMsg, "CONNECTION_ERROR"));
    }
  }

  /**
   * Disconnect from an MCP server.
   */
  async disconnect(serverName: string): Promise<Result<void, ToolError>> {
    const connection = this.connections.get(serverName);
    if (!connection) {
      return err(new ToolError(`Server not found: ${serverName}`, "NOT_FOUND"));
    }

    await this.closeConnection(connection);

    connection.state = "disconnected";
    connection.tools = [];
    connection.resources = [];
    connection.prompts = [];
    connection.connectedAt = undefined;
    connection.error = undefined;
    connection.client = undefined;
    connection.transport = undefined;

    this.emit({ type: "disconnected", serverName });
    this.log.debug("Disconnected from MCP server", { serverName });
    return ok(undefined);
  }

  /**
   * Get connection status for a server.
   */
  getConnection(serverName: string): Result<MCPConnection, ToolError> {
    const connection = this.connections.get(serverName);
    if (!connection) {
      return err(new ToolError(`Server not found: ${serverName}`, "NOT_FOUND"));
    }
    return ok(connection);
  }

  /**
   * List all connections.
   */
  listConnections(): MCPConnection[] {
    return Array.from(this.connections.values());
  }

  /**
   * Get all available tools from connected servers.
   */
  getAllTools(): Array<ToolDefinition & { serverName: string }> {
    const tools: Array<ToolDefinition & { serverName: string }> = [];

    for (const [serverName, connection] of this.connections) {
      if (connection.state === "connected") {
        for (const tool of connection.tools) {
          tools.push({ ...tool, serverName });
        }
      }
    }

    return tools;
  }

  /**
   * Get all available resources from connected servers.
   */
  getAllResources(): Array<MCPResource & { serverName: string }> {
    const resources: Array<MCPResource & { serverName: string }> = [];

    for (const [serverName, connection] of this.connections) {
      if (connection.state === "connected") {
        for (const resource of connection.resources) {
          resources.push({ ...resource, serverName });
        }
      }
    }

    return resources;
  }

  /**
   * Invoke a tool on a specific server.
   */
  async invokeTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<Result<ToolResult, ToolError>> {
    const connection = this.connections.get(serverName);

    if (!connection) {
      return err(new ToolError(`Server not found: ${serverName}`, "NOT_FOUND"));
    }

    if (connection.state !== "connected") {
      return err(new ToolError(`Server not connected: ${serverName}`, "CONNECTION_ERROR"));
    }

    const tool = connection.tools.find((t) => t.id === toolName || t.name === toolName);
    if (!tool) {
      return err(new ToolError(`Tool not found: ${toolName}`, "NOT_FOUND", toolName));
    }
    const toolAllowed = this.isAllowedByPolicy(
      tool.id ?? tool.name,
      connection.config.allowedTools,
      connection.config.blockedTools
    );
    if (!toolAllowed) {
      return err(new ToolError(`Tool blocked by policy: ${toolName}`, "PERMISSION_DENIED", toolName));
    }

    try {
      if (this.mode === "mock") {
        this.emit({ type: "tool_invoked", serverName, toolName, args });
        this.log.debug("Mock tool invoked on MCP server", { serverName, toolName });
        return ok({
          success: true,
          content: {
            message: `Tool ${toolName} invoked on ${serverName}`,
            args,
          },
        });
      }

      if (!connection.client) {
        return err(new ToolError(`Server not connected: ${serverName}`, "CONNECTION_ERROR"));
      }

      const result = await connection.client.request(
        {
          method: "tools/call",
          params: { name: tool.name, arguments: args },
        },
        CallToolResultSchema
      );

      this.emit({ type: "tool_invoked", serverName, toolName, args });
      this.log.debug("Tool invoked on MCP server", { serverName, toolName });

      const isError = (result as { isError?: boolean }).isError === true;
      return ok({
        success: !isError,
        content: (result as { content?: unknown }).content ?? result,
        error: isError ? "MCP tool error" : undefined,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log.error("Tool invocation failed", { serverName, toolName, error: errorMsg });
      return err(new ToolError(errorMsg, "INVOCATION_ERROR", toolName));
    }
  }

  /**
   * Read a resource from a server.
   */
  async readResource(serverName: string, uri: string): Promise<Result<ToolResult, ToolError>> {
    const connection = this.connections.get(serverName);

    if (!connection) {
      return err(new ToolError(`Server not found: ${serverName}`, "NOT_FOUND"));
    }

    if (connection.state !== "connected") {
      return err(new ToolError(`Server not connected: ${serverName}`, "CONNECTION_ERROR"));
    }

    const resourceAllowed = this.isAllowedByPolicy(
      uri,
      connection.config.allowedResources,
      connection.config.blockedResources
    );
    if (!resourceAllowed) {
      return err(new ToolError(`Resource blocked by policy: ${uri}`, "PERMISSION_DENIED"));
    }

    try {
      if (this.mode === "mock") {
        this.emit({ type: "resource_read", serverName, uri });
        this.log.debug("Mock resource read from MCP server", { serverName, uri });
        return ok({
          success: true,
          content: { uri },
        });
      }

      if (!connection.client) {
        return err(new ToolError(`Server not connected: ${serverName}`, "CONNECTION_ERROR"));
      }

      const result = await connection.client.request(
        { method: "resources/read", params: { uri } },
        ReadResourceResultSchema
      );

      this.emit({ type: "resource_read", serverName, uri });
      this.log.debug("Resource read from MCP server", { serverName, uri });

      return ok({
        success: true,
        content: result,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log.error("Resource read failed", { serverName, uri, error: errorMsg });
      return err(new ToolError(errorMsg, "SERVER_ERROR"));
    }
  }

  /**
   * Subscribe to MCP client events.
   */
  onEvent(listener: (event: MCPClientEvent) => void): () => void {
    this.eventListeners.push(listener);
    return () => {
      const index = this.eventListeners.indexOf(listener);
      if (index > -1) {
        this.eventListeners.splice(index, 1);
      }
    };
  }

  /**
   * Disconnect from all servers and cleanup.
   */
  async shutdown(): Promise<void> {
    for (const serverName of this.connections.keys()) {
      await this.disconnect(serverName);
    }
    this.log.info("MCP client manager shut down");
  }

  /**
   * Get the count of registered servers.
   */
  count(): number {
    return this.connections.size;
  }

  /**
   * Get the count of connected servers.
   */
  connectedCount(): number {
    let count = 0;
    for (const connection of this.connections.values()) {
      if (connection.state === "connected") {
        count++;
      }
    }
    return count;
  }

  /** Emit an event to listeners */
  private emit(event: MCPClientEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (error) {
        this.log.error("Event listener error", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private normalizePatterns(value?: string[]): string[] {
    if (!value) return [];
    return value.map((entry) => entry.trim()).filter(Boolean);
  }

  private matchesPattern(value: string, pattern: string): boolean {
    if (pattern === "*") return true;
    if (!pattern.includes("*")) return value === pattern;
    const escaped = pattern
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    const regex = new RegExp(`^${escaped}$`, "i");
    return regex.test(value);
  }

  private isAllowedByPolicy(
    value: string,
    allowlist?: string[],
    blocklist?: string[]
  ): boolean {
    const allow = this.normalizePatterns(allowlist);
    const block = this.normalizePatterns(blocklist);
    if (allow.length > 0) {
      return allow.some((pattern) => this.matchesPattern(value, pattern));
    }
    if (block.length > 0) {
      return !block.some((pattern) => this.matchesPattern(value, pattern));
    }
    return true;
  }

  private async connectReal(connection: MCPConnection): Promise<void> {
    const { transport, client } = this.createClientAndTransport(connection.config);
    await client.connect(transport as never);
    connection.client = client;
    connection.transport = transport;

    const { tools, resources, prompts } = await this.loadCapabilities(client);
    connection.tools = tools.filter((tool) =>
      this.isAllowedByPolicy(
        tool.id ?? tool.name,
        connection.config.allowedTools,
        connection.config.blockedTools
      )
    );
    connection.resources = resources.filter((resource) =>
      this.isAllowedByPolicy(
        resource.uri,
        connection.config.allowedResources,
        connection.config.blockedResources
      )
    );
    connection.prompts = prompts.filter((prompt) =>
      this.isAllowedByPolicy(
        prompt.name,
        connection.config.allowedPrompts,
        connection.config.blockedPrompts
      )
    );
  }

  private async connectMock(connection: MCPConnection): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 50));

    connection.tools = [
      {
        id: `${connection.config.name}:sample_tool`,
        name: "Sample Tool",
        description: "A sample tool from the MCP server",
        inputSchema: z.object({}).passthrough(),
        category: "mcp",
      },
    ];
    connection.resources = [];
    connection.prompts = [];
  }

  private createClientAndTransport(config: MCPServerConfig): {
    client: Client;
    transport: { close?: () => Promise<void> | void };
  } {
    const client = new Client(this.clientInfo, { capabilities: {} });

    if (config.transport === "stdio") {
      if (!config.command) {
        throw new Error("Command required for stdio transport");
      }
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: config.env,
      });
      return { client, transport };
    }

    if (!config.url) {
      throw new Error("URL required for HTTP transport");
    }

    const headers = this.buildAuthHeaders(config);
    const url = new URL(config.url);
    const requestInit = Object.keys(headers).length > 0 ? { headers } : undefined;

    if (config.transport === "sse") {
      const transport = new SSEClientTransport(
        url,
        requestInit ? { requestInit } : undefined
      );
      return { client, transport };
    }

    const transport = new StreamableHTTPClientTransport(
      url,
      requestInit ? { requestInit } : undefined
    );
    return { client, transport };
  }

  private async loadCapabilities(client: Client): Promise<{
    tools: ToolDefinition[];
    resources: MCPResource[];
    prompts: MCPPrompt[];
  }> {
    const tools: ToolDefinition[] = [];
    const resources: MCPResource[] = [];
    const prompts: MCPPrompt[] = [];

    try {
      const toolList = await client.request({ method: "tools/list" }, ListToolsResultSchema);
      for (const tool of toolList.tools ?? []) {
        tools.push({
          id: tool.name,
          name: tool.name,
          description: tool.description ?? tool.name,
          inputSchema: z.object({}).passthrough(),
          category: "mcp",
        });
      }
    } catch (error) {
      this.log.warn("Failed to list MCP tools", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      const resourceList = await client.request(
        { method: "resources/list" },
        ListResourcesResultSchema
      );
      for (const resource of resourceList.resources ?? []) {
        resources.push({
          uri: resource.uri,
          name: resource.name ?? resource.uri,
          description: resource.description,
          mimeType: resource.mimeType,
        });
      }
    } catch (error) {
      this.log.warn("Failed to list MCP resources", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      const promptList = await client.request(
        { method: "prompts/list" },
        ListPromptsResultSchema
      );
      for (const prompt of promptList.prompts ?? []) {
        prompts.push({
          name: prompt.name,
          description: prompt.description,
          arguments: prompt.arguments,
        });
      }
    } catch (error) {
      this.log.warn("Failed to list MCP prompts", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return { tools, resources, prompts };
  }

  private buildAuthHeaders(config: MCPServerConfig): Record<string, string> {
    if (!config.auth?.token) return {};
    if (config.auth.type === "api_key") {
      return { "x-api-key": config.auth.token };
    }
    if (config.auth.type === "bearer") {
      return { Authorization: `Bearer ${config.auth.token}` };
    }
    if (config.auth.type === "oauth2") {
      return { Authorization: `Bearer ${config.auth.token}` };
    }
    return {};
  }

  private async closeConnection(connection: MCPConnection): Promise<void> {
    const closeTransport = connection.transport?.close?.();
    await Promise.resolve(closeTransport);
    const clientClose = (connection.client as { close?: () => Promise<void> | void })?.close?.();
    await Promise.resolve(clientClose);
  }
}

/** MCP Client events */
export type MCPClientEvent =
  | { type: "server_registered"; serverName: string }
  | { type: "connecting"; serverName: string }
  | { type: "connected"; serverName: string; tools: number; resources: number }
  | { type: "disconnected"; serverName: string }
  | { type: "error"; serverName: string; error: string }
  | { type: "tool_invoked"; serverName: string; toolName: string; args: unknown }
  | { type: "resource_read"; serverName: string; uri: string };

/** Create a new MCP client manager */
export function createMCPClientManager(options: MCPClientManagerOptions = {}): MCPClientManager {
  return new MCPClientManager(options);
}

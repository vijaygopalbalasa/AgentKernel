// MCP Client — connects to Model Context Protocol servers
// Wraps the official @modelcontextprotocol/sdk

import type {
  MCPServerConfig,
  MCPResource,
  MCPPrompt,
  ToolDefinition,
  ToolResult,
} from "./types.js";

/** MCP Connection state */
export type MCPConnectionState = "disconnected" | "connecting" | "connected" | "error";

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
}

/**
 * MCP Client Manager — manages connections to MCP servers.
 *
 * Features:
 * - Connect to multiple MCP servers
 * - Discover tools, resources, and prompts
 * - Invoke tools on remote servers
 * - Handle reconnection and errors
 *
 * Note: This is a simplified implementation.
 * Production would use the full @modelcontextprotocol/sdk.
 */
export class MCPClientManager {
  private connections: Map<string, MCPConnection> = new Map();
  private eventListeners: Array<(event: MCPClientEvent) => void> = [];

  /**
   * Register an MCP server configuration.
   */
  registerServer(config: MCPServerConfig): void {
    const connection: MCPConnection = {
      config,
      state: "disconnected",
      tools: [],
      resources: [],
      prompts: [],
    };

    this.connections.set(config.name, connection);
    this.emit({ type: "server_registered", serverName: config.name });
  }

  /**
   * Connect to a registered MCP server.
   */
  async connect(serverName: string): Promise<boolean> {
    const connection = this.connections.get(serverName);
    if (!connection) {
      return false;
    }

    connection.state = "connecting";
    this.emit({ type: "connecting", serverName });

    try {
      // In production, this would use the actual MCP SDK to connect
      // For now, we simulate the connection process

      if (connection.config.transport === "http" || connection.config.transport === "sse") {
        // HTTP/SSE transport — would fetch from URL
        if (!connection.config.url) {
          throw new Error("URL required for HTTP transport");
        }

        // Simulate fetching server capabilities
        // In production: const client = new Client(...); await client.connect();
        await this.simulateHttpConnect(connection);
      } else if (connection.config.transport === "stdio") {
        // Stdio transport — would spawn process
        if (!connection.config.command) {
          throw new Error("Command required for stdio transport");
        }

        // Simulate spawning and connecting
        // In production: const transport = new StdioClientTransport(...);
        await this.simulateStdioConnect(connection);
      }

      connection.state = "connected";
      connection.connectedAt = new Date();
      this.emit({
        type: "connected",
        serverName,
        tools: connection.tools.length,
        resources: connection.resources.length,
      });

      return true;
    } catch (err) {
      connection.state = "error";
      connection.error = err instanceof Error ? err.message : String(err);
      this.emit({ type: "error", serverName, error: connection.error });
      return false;
    }
  }

  /**
   * Disconnect from an MCP server.
   */
  async disconnect(serverName: string): Promise<void> {
    const connection = this.connections.get(serverName);
    if (!connection) return;

    // In production, this would properly close the connection
    connection.state = "disconnected";
    connection.tools = [];
    connection.resources = [];
    connection.prompts = [];
    connection.connectedAt = undefined;

    this.emit({ type: "disconnected", serverName });
  }

  /**
   * Get connection status for a server.
   */
  getConnection(serverName: string): MCPConnection | null {
    return this.connections.get(serverName) ?? null;
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
  ): Promise<ToolResult> {
    const connection = this.connections.get(serverName);

    if (!connection) {
      return { success: false, error: `Server not found: ${serverName}` };
    }

    if (connection.state !== "connected") {
      return { success: false, error: `Server not connected: ${serverName}` };
    }

    const tool = connection.tools.find((t) => t.id === toolName || t.name === toolName);
    if (!tool) {
      return { success: false, error: `Tool not found: ${toolName}` };
    }

    try {
      // In production, this would use the MCP SDK to call the tool
      // const result = await client.callTool({ name: toolName, arguments: args });

      // Simulate tool execution
      this.emit({
        type: "tool_invoked",
        serverName,
        toolName,
        args,
      });

      // For now, return a simulated success
      return {
        success: true,
        content: {
          message: `Tool ${toolName} invoked on ${serverName}`,
          args,
          note: "This is simulated. Production would execute the actual MCP tool.",
        },
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Read a resource from a server.
   */
  async readResource(serverName: string, uri: string): Promise<ToolResult> {
    const connection = this.connections.get(serverName);

    if (!connection) {
      return { success: false, error: `Server not found: ${serverName}` };
    }

    if (connection.state !== "connected") {
      return { success: false, error: `Server not connected: ${serverName}` };
    }

    try {
      // In production: const result = await client.readResource({ uri });

      this.emit({
        type: "resource_read",
        serverName,
        uri,
      });

      return {
        success: true,
        content: {
          uri,
          note: "This is simulated. Production would read the actual MCP resource.",
        },
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
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
  }

  /** Emit an event to listeners */
  private emit(event: MCPClientEvent): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }

  /** Simulate HTTP connection (placeholder for actual SDK) */
  private async simulateHttpConnect(connection: MCPConnection): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Simulate discovered capabilities
    connection.tools = [
      {
        id: `${connection.config.name}:sample_tool`,
        name: "Sample Tool",
        description: "A sample tool from the MCP server",
        inputSchema: {} as any,
        category: "mcp",
      },
    ];
  }

  /** Simulate stdio connection (placeholder for actual SDK) */
  private async simulateStdioConnect(connection: MCPConnection): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Simulate discovered capabilities
    connection.tools = [
      {
        id: `${connection.config.name}:stdio_tool`,
        name: "Stdio Tool",
        description: "A tool from the stdio MCP server",
        inputSchema: {} as any,
        category: "mcp",
      },
    ];
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
export function createMCPClientManager(): MCPClientManager {
  return new MCPClientManager();
}

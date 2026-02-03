// Tools System tests
import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { ToolRegistry, createToolRegistry } from "./registry.js";
import { registerBuiltinTools, BUILTIN_TOOLS } from "./builtin.js";
import { MCPClientManager, createMCPClientManager } from "./mcp-client.js";
import { ToolError } from "./types.js";

describe("ToolRegistry", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = createToolRegistry();
  });

  describe("Registration", () => {
    it("should register a tool", () => {
      const schema = z.object({ input: z.string() });

      const result = registry.register(
        {
          id: "test:tool",
          name: "Test Tool",
          description: "A test tool",
          inputSchema: schema,
        },
        async (args) => ({ success: true, content: args.input })
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe("test:tool");
      expect(registry.has("test:tool")).toBe(true);
    });

    it("should return error for existing tool without overwrite", () => {
      const schema = z.object({ input: z.string() });

      const r1 = registry.register(
        { id: "test:tool", name: "First", description: "First", inputSchema: schema },
        async () => ({ success: true })
      );
      expect(r1.ok).toBe(true);

      const r2 = registry.register(
        { id: "test:tool", name: "Second", description: "Second", inputSchema: schema },
        async () => ({ success: true })
      );

      expect(r2.ok).toBe(false);
      if (r2.ok) return;
      expect(r2.error).toBeInstanceOf(ToolError);
      expect(r2.error.code).toBe("VALIDATION_ERROR");

      // Original tool should remain
      const getResult = registry.get("test:tool");
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;
      expect(getResult.value.name).toBe("First");
    });

    it("should overwrite when option is set", () => {
      const schema = z.object({ input: z.string() });

      const r1 = registry.register(
        { id: "test:tool", name: "First", description: "First", inputSchema: schema },
        async () => ({ success: true })
      );
      expect(r1.ok).toBe(true);

      const r2 = registry.register(
        { id: "test:tool", name: "Second", description: "Second", inputSchema: schema },
        async () => ({ success: true }),
        { overwrite: true }
      );

      expect(r2.ok).toBe(true);
      const getResult = registry.get("test:tool");
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;
      expect(getResult.value.name).toBe("Second");
    });

    it("should unregister a tool", () => {
      const schema = z.object({ input: z.string() });
      registry.register(
        { id: "test:tool", name: "Test", description: "Test", inputSchema: schema },
        async () => ({ success: true })
      );

      const result = registry.unregister("test:tool");
      expect(result.ok).toBe(true);
      expect(registry.has("test:tool")).toBe(false);
    });

    it("should return error when unregistering non-existent tool", () => {
      const result = registry.unregister("nonexistent");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("NOT_FOUND");
    });
  });

  describe("Discovery", () => {
    beforeEach(() => {
      const schema = z.object({});

      registry.register(
        { id: "math:add", name: "Add", description: "Add numbers", inputSchema: schema, category: "math", tags: ["arithmetic"] },
        async () => ({ success: true })
      );
      registry.register(
        { id: "math:subtract", name: "Subtract", description: "Subtract numbers", inputSchema: schema, category: "math", tags: ["arithmetic"] },
        async () => ({ success: true })
      );
      registry.register(
        { id: "text:reverse", name: "Reverse", description: "Reverse text", inputSchema: schema, category: "text", tags: ["string"] },
        async () => ({ success: true })
      );
    });

    it("should list all tools", () => {
      const tools = registry.list();
      expect(tools.length).toBe(3);
    });

    it("should find by category", () => {
      const mathTools = registry.findByCategory("math");
      expect(mathTools.length).toBe(2);
      expect(mathTools.every((t) => t.category === "math")).toBe(true);
    });

    it("should find by tag", () => {
      const arithmeticTools = registry.findByTag("arithmetic");
      expect(arithmeticTools.length).toBe(2);
    });

    it("should search by name or description", () => {
      const results = registry.search("numbers");
      expect(results.length).toBe(2);
    });

    it("should get tool by ID", () => {
      const result = registry.get("math:add");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.name).toBe("Add");
    });

    it("should return error for non-existent tool", () => {
      const result = registry.get("nonexistent");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("NOT_FOUND");
    });
  });

  describe("Invocation", () => {
    it("should invoke a tool with valid arguments", async () => {
      const schema = z.object({
        a: z.number(),
        b: z.number(),
      });

      registry.register(
        { id: "math:add", name: "Add", description: "Add", inputSchema: schema },
        async (args) => ({ success: true, content: args.a + args.b })
      );

      const result = await registry.invoke({
        toolId: "math:add",
        arguments: { a: 5, b: 3 },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.success).toBe(true);
      expect(result.value.content).toBe(8);
      expect(result.value.executionTime).toBeDefined();
    });

    it("should return error for invalid arguments", async () => {
      const schema = z.object({
        a: z.number(),
        b: z.number(),
      });

      registry.register(
        { id: "math:add", name: "Add", description: "Add", inputSchema: schema },
        async (args) => ({ success: true, content: args.a + args.b })
      );

      const result = await registry.invoke({
        toolId: "math:add",
        arguments: { a: "not a number", b: 3 },
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.message).toContain("Invalid arguments");
    });

    it("should return error for non-existent tool", async () => {
      const result = await registry.invoke({
        toolId: "nonexistent",
        arguments: {},
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("NOT_FOUND");
      expect(result.error.message).toContain("Tool not found");
    });

    it("should emit events on invocation", async () => {
      const events: string[] = [];

      registry.onEvent((event) => {
        events.push(event.type);
      });

      const schema = z.object({ x: z.number() });
      registry.register(
        { id: "test:tool", name: "Test", description: "Test", inputSchema: schema },
        async () => ({ success: true })
      );

      await registry.invoke({ toolId: "test:tool", arguments: { x: 1 } });

      expect(events).toContain("start");
      expect(events).toContain("complete");
    });

    it("should return error when handler throws", async () => {
      const schema = z.object({ x: z.number() });
      registry.register(
        { id: "test:error", name: "Error Tool", description: "Tool that throws", inputSchema: schema },
        async () => {
          throw new Error("Handler error");
        }
      );

      const result = await registry.invoke({ toolId: "test:error", arguments: { x: 1 } });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("INVOCATION_ERROR");
      expect(result.error.message).toContain("Handler error");
    });
  });

  describe("MCP Format", () => {
    it("should convert tools to MCP format", () => {
      const schema = z.object({
        message: z.string(),
        count: z.number().optional(),
      });

      registry.register(
        { id: "test:tool", name: "Test", description: "A test tool", inputSchema: schema },
        async () => ({ success: true })
      );

      const mcpTools = registry.toMCPFormat();

      expect(mcpTools.length).toBe(1);
      const firstTool = mcpTools[0];
      expect(firstTool).toBeDefined();
      if (!firstTool) return;
      expect(firstTool.name).toBe("test:tool");
      expect(firstTool.description).toBe("A test tool");
      expect(firstTool.inputSchema).toHaveProperty("type", "object");
    });
  });

  describe("Utility Methods", () => {
    it("should clear all tools", () => {
      const schema = z.object({});
      registry.register(
        { id: "test:tool", name: "Test", description: "Test", inputSchema: schema },
        async () => ({ success: true })
      );

      registry.clear();
      expect(registry.count()).toBe(0);
    });

    it("should return tool count", () => {
      const schema = z.object({});
      registry.register(
        { id: "test:tool1", name: "Test 1", description: "Test", inputSchema: schema },
        async () => ({ success: true })
      );
      registry.register(
        { id: "test:tool2", name: "Test 2", description: "Test", inputSchema: schema },
        async () => ({ success: true })
      );

      expect(registry.count()).toBe(2);
    });
  });
});

describe("Built-in Tools", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = createToolRegistry();
    registerBuiltinTools(registry);
  });

  it("should register all built-in tools", () => {
    expect(registry.list().length).toBe(BUILTIN_TOOLS.length);
  });

  it("echo tool should work", async () => {
    const result = await registry.invoke({
      toolId: "builtin:echo",
      arguments: { message: "Hello, World!" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.success).toBe(true);
    expect((result.value.content as { echo: string }).echo).toBe("Hello, World!");
  });

  it("datetime tool should work", async () => {
    const result = await registry.invoke({
      toolId: "builtin:datetime",
      arguments: { format: "iso" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.success).toBe(true);
    expect((result.value.content as { datetime: string }).datetime).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it("calculate tool should work", async () => {
    const result = await registry.invoke({
      toolId: "builtin:calculate",
      arguments: { expression: "2 + 2 * 3" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.success).toBe(true);
    expect((result.value.content as { result: number }).result).toBe(8);
  });

  it("calculate tool should reject dangerous expressions", async () => {
    const result = await registry.invoke({
      toolId: "builtin:calculate",
      arguments: { expression: "console.log('hack')" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.success).toBe(false);
  });

  it("json_parse tool should work", async () => {
    const result = await registry.invoke({
      toolId: "builtin:json_parse",
      arguments: { json: '{"name": "test", "value": 42}' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.success).toBe(true);
    expect((result.value.content as { name: string }).name).toBe("test");
  });

  it("string_transform tool should work", async () => {
    const result = await registry.invoke({
      toolId: "builtin:string_transform",
      arguments: { input: "hello", operation: "uppercase" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.success).toBe(true);
    expect((result.value.content as { result: string }).result).toBe("HELLO");
  });

  it("random tool should generate values", async () => {
    const result = await registry.invoke({
      toolId: "builtin:random",
      arguments: { type: "number", min: 1, max: 10 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.success).toBe(true);
    const num = (result.value.content as { result: number }).result;
    expect(num).toBeGreaterThanOrEqual(1);
    expect(num).toBeLessThanOrEqual(10);
  });
});

describe("MCPClientManager", () => {
  let manager: MCPClientManager;

  beforeEach(() => {
    manager = createMCPClientManager({ mode: "mock" });
  });

  it("should register servers", () => {
    const result = manager.registerServer({
      name: "test-server",
      transport: "http",
      url: "http://localhost:3000",
    });

    expect(result.ok).toBe(true);

    const connectionResult = manager.getConnection("test-server");
    expect(connectionResult.ok).toBe(true);
    if (!connectionResult.ok) return;
    expect(connectionResult.value.state).toBe("disconnected");
  });

  it("should return error for invalid server config", () => {
    const result = manager.registerServer({
      name: "",  // Invalid: empty name
      transport: "http",
      url: "http://localhost:3000",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("should connect to servers", async () => {
    const regResult = manager.registerServer({
      name: "test-server",
      transport: "http",
      url: "http://localhost:3000",
    });
    expect(regResult.ok).toBe(true);

    const connectResult = await manager.connect("test-server");
    expect(connectResult.ok).toBe(true);

    const connectionResult = manager.getConnection("test-server");
    expect(connectionResult.ok).toBe(true);
    if (!connectionResult.ok) return;
    expect(connectionResult.value.state).toBe("connected");
  });

  it("should return error when connecting to non-existent server", async () => {
    const result = await manager.connect("nonexistent");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });

  it("should emit events", async () => {
    const events: string[] = [];

    manager.onEvent((event) => {
      events.push(event.type);
    });

    manager.registerServer({
      name: "test-server",
      transport: "http",
      url: "http://localhost:3000",
    });

    await manager.connect("test-server");

    expect(events).toContain("server_registered");
    expect(events).toContain("connecting");
    expect(events).toContain("connected");
  });

  it("should list all connections", () => {
    manager.registerServer({ name: "server1", transport: "http", url: "http://a.com" });
    manager.registerServer({ name: "server2", transport: "http", url: "http://b.com" });

    const connections = manager.listConnections();
    expect(connections.length).toBe(2);
  });

  it("should disconnect from servers", async () => {
    manager.registerServer({
      name: "test-server",
      transport: "http",
      url: "http://localhost:3000",
    });

    await manager.connect("test-server");
    const disconnectResult = await manager.disconnect("test-server");

    expect(disconnectResult.ok).toBe(true);

    const connectionResult = manager.getConnection("test-server");
    expect(connectionResult.ok).toBe(true);
    if (!connectionResult.ok) return;
    expect(connectionResult.value.state).toBe("disconnected");
  });

  it("should return error when disconnecting from non-existent server", async () => {
    const result = await manager.disconnect("nonexistent");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });

  it("should invoke tool on connected server", async () => {
    manager.registerServer({
      name: "test-server",
      transport: "http",
      url: "http://localhost:3000",
    });
    await manager.connect("test-server");

    const result = await manager.invokeTool("test-server", "test-server:sample_tool", {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.success).toBe(true);
  });

  it("should return error when invoking tool on disconnected server", async () => {
    manager.registerServer({
      name: "test-server",
      transport: "http",
      url: "http://localhost:3000",
    });

    const result = await manager.invokeTool("test-server", "some_tool", {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CONNECTION_ERROR");
  });

  it("should return count of servers", () => {
    manager.registerServer({ name: "server1", transport: "http", url: "http://a.com" });
    manager.registerServer({ name: "server2", transport: "http", url: "http://b.com" });

    expect(manager.count()).toBe(2);
  });

  it("should return count of connected servers", async () => {
    manager.registerServer({ name: "server1", transport: "http", url: "http://a.com" });
    manager.registerServer({ name: "server2", transport: "http", url: "http://b.com" });

    await manager.connect("server1");

    expect(manager.connectedCount()).toBe(1);
  });
});

describe("ToolError", () => {
  it("should create error with code", () => {
    const error = new ToolError("Tool not found", "NOT_FOUND", "test:tool");

    expect(error.name).toBe("ToolError");
    expect(error.message).toBe("Tool not found");
    expect(error.code).toBe("NOT_FOUND");
    expect(error.toolId).toBe("test:tool");
  });

  it("should be an instance of Error", () => {
    const error = new ToolError("Test error", "VALIDATION_ERROR");
    expect(error instanceof Error).toBe(true);
    expect(error instanceof ToolError).toBe(true);
  });
});

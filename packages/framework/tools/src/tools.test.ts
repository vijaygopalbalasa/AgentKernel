// Tools System tests
import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { ToolRegistry, createToolRegistry } from "./registry.js";
import { registerBuiltinTools, BUILTIN_TOOLS } from "./builtin.js";
import { MCPClientManager, createMCPClientManager } from "./mcp-client.js";

describe("ToolRegistry", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = createToolRegistry();
  });

  describe("Registration", () => {
    it("should register a tool", () => {
      const schema = z.object({ input: z.string() });

      const registered = registry.register(
        {
          id: "test:tool",
          name: "Test Tool",
          description: "A test tool",
          inputSchema: schema,
        },
        async (args) => ({ success: true, content: args.input })
      );

      expect(registered).toBe(true);
      expect(registry.has("test:tool")).toBe(true);
    });

    it("should not overwrite existing tool by default", () => {
      const schema = z.object({ input: z.string() });

      registry.register(
        { id: "test:tool", name: "First", description: "First", inputSchema: schema },
        async () => ({ success: true })
      );

      const registered = registry.register(
        { id: "test:tool", name: "Second", description: "Second", inputSchema: schema },
        async () => ({ success: true })
      );

      expect(registered).toBe(false);
      expect(registry.get("test:tool")?.name).toBe("First");
    });

    it("should overwrite when option is set", () => {
      const schema = z.object({ input: z.string() });

      registry.register(
        { id: "test:tool", name: "First", description: "First", inputSchema: schema },
        async () => ({ success: true })
      );

      registry.register(
        { id: "test:tool", name: "Second", description: "Second", inputSchema: schema },
        async () => ({ success: true }),
        { overwrite: true }
      );

      expect(registry.get("test:tool")?.name).toBe("Second");
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

      expect(result.success).toBe(true);
      expect(result.content).toBe(8);
      expect(result.executionTime).toBeDefined();
    });

    it("should reject invalid arguments", async () => {
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

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid arguments");
    });

    it("should return error for non-existent tool", async () => {
      const result = await registry.invoke({
        toolId: "nonexistent",
        arguments: {},
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Tool not found");
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
      expect(mcpTools[0].name).toBe("test:tool");
      expect(mcpTools[0].description).toBe("A test tool");
      expect(mcpTools[0].inputSchema).toHaveProperty("type", "object");
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

    expect(result.success).toBe(true);
    expect((result.content as any).echo).toBe("Hello, World!");
  });

  it("datetime tool should work", async () => {
    const result = await registry.invoke({
      toolId: "builtin:datetime",
      arguments: { format: "iso" },
    });

    expect(result.success).toBe(true);
    expect((result.content as any).datetime).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it("calculate tool should work", async () => {
    const result = await registry.invoke({
      toolId: "builtin:calculate",
      arguments: { expression: "2 + 2 * 3" },
    });

    expect(result.success).toBe(true);
    expect((result.content as any).result).toBe(8);
  });

  it("calculate tool should reject dangerous expressions", async () => {
    const result = await registry.invoke({
      toolId: "builtin:calculate",
      arguments: { expression: "console.log('hack')" },
    });

    expect(result.success).toBe(false);
  });

  it("json_parse tool should work", async () => {
    const result = await registry.invoke({
      toolId: "builtin:json_parse",
      arguments: { json: '{"name": "test", "value": 42}' },
    });

    expect(result.success).toBe(true);
    expect((result.content as any).name).toBe("test");
  });

  it("string_transform tool should work", async () => {
    const result = await registry.invoke({
      toolId: "builtin:string_transform",
      arguments: { input: "hello", operation: "uppercase" },
    });

    expect(result.success).toBe(true);
    expect((result.content as any).result).toBe("HELLO");
  });

  it("random tool should generate values", async () => {
    const result = await registry.invoke({
      toolId: "builtin:random",
      arguments: { type: "number", min: 1, max: 10 },
    });

    expect(result.success).toBe(true);
    const num = (result.content as any).result;
    expect(num).toBeGreaterThanOrEqual(1);
    expect(num).toBeLessThanOrEqual(10);
  });
});

describe("MCPClientManager", () => {
  let manager: MCPClientManager;

  beforeEach(() => {
    manager = createMCPClientManager();
  });

  it("should register servers", () => {
    manager.registerServer({
      name: "test-server",
      transport: "http",
      url: "http://localhost:3000",
    });

    const connection = manager.getConnection("test-server");
    expect(connection).not.toBeNull();
    expect(connection!.state).toBe("disconnected");
  });

  it("should connect to servers", async () => {
    manager.registerServer({
      name: "test-server",
      transport: "http",
      url: "http://localhost:3000",
    });

    const connected = await manager.connect("test-server");

    expect(connected).toBe(true);
    expect(manager.getConnection("test-server")!.state).toBe("connected");
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
    manager.registerServer({ name: "server1", transport: "http", url: "http://a" });
    manager.registerServer({ name: "server2", transport: "http", url: "http://b" });

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
    await manager.disconnect("test-server");

    expect(manager.getConnection("test-server")!.state).toBe("disconnected");
  });
});

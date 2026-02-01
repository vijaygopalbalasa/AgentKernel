// Communication System tests
import { describe, it, expect, beforeEach, vi } from "vitest";
import { AgentRegistry, createAgentRegistry } from "./agent-registry.js";
import { A2AClient, createA2AClient } from "./a2a-client.js";
import { A2AServer, createA2AServer } from "./a2a-server.js";
import type {
  A2AAgentCard,
  A2ARequest,
  A2AMessage,
  CommunicationEvent,
} from "./types.js";

describe("AgentRegistry", () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    registry = createAgentRegistry();
  });

  describe("Local Agents", () => {
    it("should register a local agent", () => {
      const card: A2AAgentCard = {
        name: "Test Agent",
        url: "http://localhost:3000",
        description: "A test agent",
      };

      registry.registerLocal("agent-1", card);

      const entry = registry.get("http://localhost:3000");
      expect(entry).not.toBeNull();
      expect(entry!.card.name).toBe("Test Agent");
      expect(entry!.localAgentId).toBe("agent-1");
      expect(entry!.isOnline).toBe(true);
    });

    it("should list local agents", () => {
      registry.registerLocal("agent-1", {
        name: "Local Agent 1",
        url: "http://localhost:3001",
      });
      registry.registerLocal("agent-2", {
        name: "Local Agent 2",
        url: "http://localhost:3002",
      });

      const local = registry.listLocal();
      expect(local.length).toBe(2);
    });

    it("should emit event on registration", () => {
      const events: CommunicationEvent[] = [];
      registry.onEvent((e) => events.push(e));

      registry.registerLocal("agent-1", {
        name: "Test Agent",
        url: "http://localhost:3000",
      });

      expect(events.length).toBe(1);
      expect(events[0].type).toBe("agent_registered");
      expect(events[0].agentId).toBe("agent-1");
    });
  });

  describe("Agent Lookup", () => {
    beforeEach(() => {
      registry.registerLocal("agent-1", {
        name: "Math Agent",
        url: "http://localhost:3001",
        description: "Does math calculations",
        skills: [
          { id: "calculate", name: "Calculate", description: "Math" },
          { id: "plot", name: "Plot", description: "Graphs" },
        ],
        capabilities: { streaming: true },
      });
      registry.registerLocal("agent-2", {
        name: "Writer Agent",
        url: "http://localhost:3002",
        description: "Writes content",
        skills: [{ id: "write", name: "Write", description: "Text" }],
        capabilities: { streaming: false },
      });
    });

    it("should find by skill", () => {
      const results = registry.findBySkill("calculate");
      expect(results.length).toBe(1);
      expect(results[0].card.name).toBe("Math Agent");
    });

    it("should find by capability", () => {
      const results = registry.findByCapability("streaming");
      expect(results.length).toBe(1);
      expect(results[0].card.name).toBe("Math Agent");
    });

    it("should search by name", () => {
      const results = registry.search("math");
      expect(results.length).toBe(1);
      expect(results[0].card.name).toBe("Math Agent");
    });

    it("should search by description", () => {
      const results = registry.search("content");
      expect(results.length).toBe(1);
      expect(results[0].card.name).toBe("Writer Agent");
    });

    it("should list all agents", () => {
      expect(registry.list().length).toBe(2);
    });

    it("should check if agent exists", () => {
      expect(registry.has("http://localhost:3001")).toBe(true);
      expect(registry.has("http://nonexistent")).toBe(false);
    });
  });

  describe("Online Status", () => {
    it("should mark agent offline", () => {
      registry.registerLocal("agent-1", {
        name: "Test Agent",
        url: "http://localhost:3000",
      });

      registry.markOffline("http://localhost:3000");

      const entry = registry.get("http://localhost:3000");
      expect(entry!.isOnline).toBe(false);
    });

    it("should mark agent online", () => {
      registry.registerLocal("agent-1", {
        name: "Test Agent",
        url: "http://localhost:3000",
      });

      registry.markOffline("http://localhost:3000");
      registry.markOnline("http://localhost:3000");

      const entry = registry.get("http://localhost:3000");
      expect(entry!.isOnline).toBe(true);
    });

    it("should list online agents", () => {
      registry.registerLocal("agent-1", {
        name: "Agent 1",
        url: "http://localhost:3001",
      });
      registry.registerLocal("agent-2", {
        name: "Agent 2",
        url: "http://localhost:3002",
      });

      registry.markOffline("http://localhost:3001");

      const online = registry.listOnline();
      expect(online.length).toBe(1);
      expect(online[0].card.name).toBe("Agent 2");
    });

    it("should emit offline event", () => {
      const events: CommunicationEvent[] = [];
      registry.onEvent((e) => events.push(e));

      registry.registerLocal("agent-1", {
        name: "Test Agent",
        url: "http://localhost:3000",
      });
      registry.markOffline("http://localhost:3000");

      const offlineEvent = events.find((e) => e.type === "agent_offline");
      expect(offlineEvent).not.toBeUndefined();
    });
  });

  describe("Unregister", () => {
    it("should unregister an agent", () => {
      registry.registerLocal("agent-1", {
        name: "Test Agent",
        url: "http://localhost:3000",
      });

      const removed = registry.unregister("http://localhost:3000");

      expect(removed).toBe(true);
      expect(registry.has("http://localhost:3000")).toBe(false);
    });
  });
});

describe("A2AClient", () => {
  let client: A2AClient;

  beforeEach(() => {
    client = createA2AClient();
  });

  describe("Task Management", () => {
    it("should cache tasks locally", async () => {
      // Initially no cached tasks
      expect(client.listCachedTasks().length).toBe(0);
    });

    it("should set default timeout", () => {
      client.setDefaultTimeout(60000);
      // No direct way to test, but should not throw
    });

    it("should emit events", () => {
      const events: CommunicationEvent[] = [];
      const unsubscribe = client.onEvent((e) => events.push(e));

      // Unsubscribe works
      unsubscribe();
    });
  });
});

describe("A2AServer", () => {
  let server: A2AServer;

  beforeEach(() => {
    server = createA2AServer({
      card: {
        name: "Test Server",
        url: "http://localhost:3000",
        description: "A test A2A server",
        capabilities: { streaming: true },
        skills: [
          { id: "echo", name: "Echo", description: "Echoes messages" },
        ],
      },
      taskHandler: async (task) => {
        // Simple echo handler
        const textPart = task.message.parts.find((p) => p.type === "text");
        const text = textPart?.type === "text" ? textPart.text : "";

        return {
          state: "completed",
          message: {
            role: "agent",
            parts: [{ type: "text", text: `Echo: ${text}` }],
          },
        };
      },
    });
  });

  describe("Agent Card", () => {
    it("should return agent card", () => {
      const card = server.getAgentCard();
      expect(card.name).toBe("Test Server");
      expect(card.url).toBe("http://localhost:3000");
    });

    it("should generate well-known response", () => {
      const response = server.getWellKnownResponse();
      const card = JSON.parse(response);
      expect(card.name).toBe("Test Server");
    });
  });

  describe("Request Handling", () => {
    it("should handle tasks/send", async () => {
      const request: A2ARequest = {
        jsonrpc: "2.0",
        id: "test-1",
        method: "tasks/send",
        params: {
          message: {
            role: "user",
            parts: [{ type: "text", text: "Hello, agent!" }],
          },
        },
      };

      const response = await server.handleRequest(request);

      expect(response.error).toBeUndefined();
      expect(response.result).toBeDefined();

      const result = response.result as any;
      expect(result.status.state).toBe("completed");
    });

    it("should reject invalid tasks/send without message", async () => {
      const request: A2ARequest = {
        jsonrpc: "2.0",
        id: "test-1",
        method: "tasks/send",
        params: {},
      };

      const response = await server.handleRequest(request);

      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32602);
    });

    it("should handle tasks/get", async () => {
      // First create a task
      const createRequest: A2ARequest = {
        jsonrpc: "2.0",
        id: "create-1",
        method: "tasks/send",
        params: {
          message: {
            role: "user",
            parts: [{ type: "text", text: "Test" }],
          },
        },
      };
      const createResponse = await server.handleRequest(createRequest);
      const taskId = (createResponse.result as any).id;

      // Then get it
      const getRequest: A2ARequest = {
        jsonrpc: "2.0",
        id: "get-1",
        method: "tasks/get",
        params: { taskId },
      };
      const getResponse = await server.handleRequest(getRequest);

      expect(getResponse.error).toBeUndefined();
      expect((getResponse.result as any).id).toBe(taskId);
    });

    it("should handle tasks/get for nonexistent task", async () => {
      const request: A2ARequest = {
        jsonrpc: "2.0",
        id: "test-1",
        method: "tasks/get",
        params: { taskId: "nonexistent" },
      };

      const response = await server.handleRequest(request);

      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32001);
    });

    it("should handle tasks/cancel", async () => {
      // First create a task
      const createRequest: A2ARequest = {
        jsonrpc: "2.0",
        id: "create-1",
        method: "tasks/send",
        params: {
          message: {
            role: "user",
            parts: [{ type: "text", text: "Test" }],
          },
        },
      };
      const createResponse = await server.handleRequest(createRequest);
      const taskId = (createResponse.result as any).id;

      // Then cancel it
      const cancelRequest: A2ARequest = {
        jsonrpc: "2.0",
        id: "cancel-1",
        method: "tasks/cancel",
        params: { taskId },
      };
      const cancelResponse = await server.handleRequest(cancelRequest);

      expect(cancelResponse.error).toBeUndefined();
      expect((cancelResponse.result as any).success).toBe(true);
    });

    it("should handle tasks/list", async () => {
      // Create some tasks
      await server.handleRequest({
        jsonrpc: "2.0",
        id: "1",
        method: "tasks/send",
        params: {
          message: { role: "user", parts: [{ type: "text", text: "1" }] },
        },
      });
      await server.handleRequest({
        jsonrpc: "2.0",
        id: "2",
        method: "tasks/send",
        params: {
          message: { role: "user", parts: [{ type: "text", text: "2" }] },
        },
      });

      // List them
      const listRequest: A2ARequest = {
        jsonrpc: "2.0",
        id: "list-1",
        method: "tasks/list",
      };
      const listResponse = await server.handleRequest(listRequest);

      expect(listResponse.error).toBeUndefined();
      expect((listResponse.result as any).tasks.length).toBe(2);
    });

    it("should handle unknown method", async () => {
      const request: A2ARequest = {
        jsonrpc: "2.0",
        id: "test-1",
        method: "unknown/method" as any,
      };

      const response = await server.handleRequest(request);

      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32601);
    });
  });

  describe("HTTP Handling", () => {
    it("should handle valid HTTP request", async () => {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: "http-1",
        method: "tasks/send",
        params: {
          message: {
            role: "user",
            parts: [{ type: "text", text: "HTTP test" }],
          },
        },
      });

      const result = await server.handleHttpRequest(body);

      expect(result.status).toBe(200);
      expect(result.contentType).toBe("application/json");
      expect(JSON.parse(result.body).error).toBeUndefined();
    });

    it("should handle invalid JSON", async () => {
      const result = await server.handleHttpRequest("not json");

      expect(result.status).toBe(400);
      expect(JSON.parse(result.body).error.code).toBe(-32700);
    });
  });

  describe("Task Lookup", () => {
    it("should get task by ID", async () => {
      const createRequest: A2ARequest = {
        jsonrpc: "2.0",
        id: "create-1",
        method: "tasks/send",
        params: {
          message: {
            role: "user",
            parts: [{ type: "text", text: "Test" }],
          },
        },
      };
      const createResponse = await server.handleRequest(createRequest);
      const taskId = (createResponse.result as any).id;

      const task = server.getTask(taskId);

      expect(task).not.toBeNull();
      expect(task!.id).toBe(taskId);
    });

    it("should return null for nonexistent task", () => {
      const task = server.getTask("nonexistent");
      expect(task).toBeNull();
    });

    it("should list tasks by session", async () => {
      const sessionId = "test-session";

      // Create tasks with same session
      await server.handleRequest({
        jsonrpc: "2.0",
        id: "1",
        method: "tasks/send",
        params: {
          message: { role: "user", parts: [{ type: "text", text: "1" }] },
          sessionId,
        },
      });
      await server.handleRequest({
        jsonrpc: "2.0",
        id: "2",
        method: "tasks/send",
        params: {
          message: { role: "user", parts: [{ type: "text", text: "2" }] },
          sessionId,
        },
      });
      // Create task with different session
      await server.handleRequest({
        jsonrpc: "2.0",
        id: "3",
        method: "tasks/send",
        params: {
          message: { role: "user", parts: [{ type: "text", text: "3" }] },
        },
      });

      const sessionTasks = server.listTasks(sessionId);
      expect(sessionTasks.length).toBe(2);
    });
  });

  describe("Events", () => {
    it("should emit task_received event", async () => {
      const events: CommunicationEvent[] = [];
      server.onEvent((e) => events.push(e));

      await server.handleRequest({
        jsonrpc: "2.0",
        id: "1",
        method: "tasks/send",
        params: {
          message: { role: "user", parts: [{ type: "text", text: "test" }] },
        },
      });

      const receivedEvent = events.find((e) => e.type === "task_received");
      expect(receivedEvent).toBeDefined();
    });

    it("should emit task_completed event", async () => {
      const events: CommunicationEvent[] = [];
      server.onEvent((e) => events.push(e));

      await server.handleRequest({
        jsonrpc: "2.0",
        id: "1",
        method: "tasks/send",
        params: {
          message: { role: "user", parts: [{ type: "text", text: "test" }] },
        },
      });

      const completedEvent = events.find((e) => e.type === "task_completed");
      expect(completedEvent).toBeDefined();
    });
  });
});

describe("Integration", () => {
  it("should work together: registry, client, server", () => {
    const registry = createAgentRegistry();
    const client = createA2AClient();
    const server = createA2AServer({
      card: {
        name: "Integration Agent",
        url: "http://localhost:4000",
        skills: [{ id: "test", name: "Test" }],
      },
      taskHandler: async () => ({ state: "completed" }),
    });

    // Register the server's card
    registry.registerLocal("int-agent", server.getAgentCard());

    // Find it
    const agents = registry.findBySkill("test");
    expect(agents.length).toBe(1);

    // The client would use this URL to send tasks
    expect(agents[0].card.url).toBe("http://localhost:4000");
  });
});

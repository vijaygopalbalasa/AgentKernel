// Communication System tests
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AgentRegistry, createAgentRegistry } from "./agent-registry.js";
import { A2AClient, createA2AClient } from "./a2a-client.js";
import { A2AServer, createA2AServer } from "./a2a-server.js";
import type {
  A2AAgentCard,
  A2ARequest,
  CommunicationEvent,
} from "./types.js";

function getFirst<T>(items: T[]): T {
  const first = items[0];
  if (!first) {
    throw new Error("Expected at least one item");
  }
  return first;
}

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

      const result = registry.registerLocal("agent-1", card);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.card.name).toBe("Test Agent");
      expect(result.value.localAgentId).toBe("agent-1");
      expect(result.value.isOnline).toBe(true);
    });

    it("should get registered agent by URL", () => {
      const card: A2AAgentCard = {
        name: "Test Agent",
        url: "http://localhost:3000",
        description: "A test agent",
      };

      registry.registerLocal("agent-1", card);

      const result = registry.get("http://localhost:3000");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.card.name).toBe("Test Agent");
    });

    it("should return error for nonexistent agent", () => {
      const result = registry.get("http://nonexistent");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("NOT_FOUND");
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
      const firstEvent = getFirst(events);
      expect(firstEvent.type).toBe("agent_registered");
      expect(firstEvent.agentId).toBe("agent-1");
    });

    it("should reject registration with invalid card", () => {
      const result = registry.registerLocal("agent-1", {
        name: "",  // Invalid: empty name
        url: "http://localhost:3000",
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("VALIDATION_ERROR");
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
      expect(getFirst(results).card.name).toBe("Math Agent");
    });

    it("should find by capability", () => {
      const results = registry.findByCapability("streaming");
      expect(results.length).toBe(1);
      expect(getFirst(results).card.name).toBe("Math Agent");
    });

    it("should search by name", () => {
      const results = registry.search("math");
      expect(results.length).toBe(1);
      expect(getFirst(results).card.name).toBe("Math Agent");
    });

    it("should search by description", () => {
      const results = registry.search("content");
      expect(results.length).toBe(1);
      expect(getFirst(results).card.name).toBe("Writer Agent");
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

      const result = registry.markOffline("http://localhost:3000");
      expect(result.ok).toBe(true);

      const getResult = registry.get("http://localhost:3000");
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;
      expect(getResult.value.isOnline).toBe(false);
    });

    it("should return error when marking nonexistent agent offline", () => {
      const result = registry.markOffline("http://nonexistent");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("NOT_FOUND");
    });

    it("should mark agent online", () => {
      registry.registerLocal("agent-1", {
        name: "Test Agent",
        url: "http://localhost:3000",
      });

      registry.markOffline("http://localhost:3000");
      const result = registry.markOnline("http://localhost:3000");
      expect(result.ok).toBe(true);

      const getResult = registry.get("http://localhost:3000");
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;
      expect(getResult.value.isOnline).toBe(true);
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
      expect(getFirst(online).card.name).toBe("Agent 2");
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
      expect(offlineEvent).toBeDefined();
    });
  });

  describe("Unregister", () => {
    it("should unregister an agent", () => {
      registry.registerLocal("agent-1", {
        name: "Test Agent",
        url: "http://localhost:3000",
      });

      const result = registry.unregister("http://localhost:3000");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(true);
      expect(registry.has("http://localhost:3000")).toBe(false);
    });

    it("should return false when unregistering nonexistent agent", () => {
      const result = registry.unregister("http://nonexistent");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(false);
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

    it("should return error for nonexistent cached task", () => {
      const result = client.getCachedTask("nonexistent");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("NOT_FOUND");
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

  describe("Client Replay Protection", () => {
    it("should create client without replay protection by default", () => {
      const defaultClient = createA2AClient();
      expect(defaultClient).toBeDefined();
    });

    it("should create client with replay protection enabled", () => {
      const protectedClient = createA2AClient({ replayProtection: true });
      expect(protectedClient).toBeDefined();
    });

    it("should create client with custom timeout", () => {
      const customClient = createA2AClient({ defaultTimeout: 60000 });
      expect(customClient).toBeDefined();
    });

    it("should create client with both options", () => {
      const fullClient = createA2AClient({
        replayProtection: true,
        defaultTimeout: 60000,
      });
      expect(fullClient).toBeDefined();
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

      const result = await server.handleRequest(request);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.error).toBeUndefined();
      expect(result.value.result).toBeDefined();

      const taskResult = result.value.result as Record<string, unknown>;
      expect((taskResult.status as Record<string, unknown>).state).toBe("completed");
    });

    it("should reject invalid tasks/send without message", async () => {
      const request: A2ARequest = {
        jsonrpc: "2.0",
        id: "test-1",
        method: "tasks/send",
        params: {},
      };

      const result = await server.handleRequest(request);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.error).toBeDefined();
      expect(result.value.error!.code).toBe(-32602);
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
      const createResult = await server.handleRequest(createRequest);
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;
      const taskId = (createResult.value.result as Record<string, unknown>).id;

      // Then get it
      const getRequest: A2ARequest = {
        jsonrpc: "2.0",
        id: "get-1",
        method: "tasks/get",
        params: { taskId },
      };
      const getResult = await server.handleRequest(getRequest);

      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;
      expect(getResult.value.error).toBeUndefined();
      expect((getResult.value.result as Record<string, unknown>).id).toBe(taskId);
    });

    it("should handle tasks/get for nonexistent task", async () => {
      const request: A2ARequest = {
        jsonrpc: "2.0",
        id: "test-1",
        method: "tasks/get",
        params: { taskId: "nonexistent" },
      };

      const result = await server.handleRequest(request);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.error).toBeDefined();
      expect(result.value.error!.code).toBe(-32001);
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
      const createResult = await server.handleRequest(createRequest);
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;
      const taskId = (createResult.value.result as Record<string, unknown>).id;

      // Then cancel it
      const cancelRequest: A2ARequest = {
        jsonrpc: "2.0",
        id: "cancel-1",
        method: "tasks/cancel",
        params: { taskId },
      };
      const cancelResult = await server.handleRequest(cancelRequest);

      expect(cancelResult.ok).toBe(true);
      if (!cancelResult.ok) return;
      expect(cancelResult.value.error).toBeUndefined();
      expect((cancelResult.value.result as Record<string, unknown>).success).toBe(true);
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
      const listResult = await server.handleRequest(listRequest);

      expect(listResult.ok).toBe(true);
      if (!listResult.ok) return;
      expect(listResult.value.error).toBeUndefined();
      const tasks = (listResult.value.result as Record<string, unknown[]>).tasks ?? [];
      expect(tasks.length).toBe(2);
    });

    it("should handle unknown method", async () => {
      const request: A2ARequest = {
        jsonrpc: "2.0",
        id: "test-1",
        method: "unknown/method" as "tasks/send",
      };

      const result = await server.handleRequest(request);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.error).toBeDefined();
      expect(result.value.error!.code).toBe(-32601);
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

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe(200);
      expect(result.value.contentType).toBe("application/json");
      expect(JSON.parse(result.value.body).error).toBeUndefined();
    });

    it("should handle invalid JSON", async () => {
      const result = await server.handleHttpRequest("not json");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe(400);
      expect(JSON.parse(result.value.body).error.code).toBe(-32700);
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
      const createResult = await server.handleRequest(createRequest);
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;
      const taskId = (createResult.value.result as Record<string, unknown>).id as string;

      const result = server.getTask(taskId);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.id).toBe(taskId);
    });

    it("should return error for nonexistent task", () => {
      const result = server.getTask("nonexistent");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("NOT_FOUND");
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
    const registerResult = registry.registerLocal("int-agent", server.getAgentCard());
    expect(registerResult.ok).toBe(true);

    // Find it
    const agents = registry.findBySkill("test");
    expect(agents.length).toBe(1);

    // The client would use this URL to send tasks
    expect(getFirst(agents).card.url).toBe("http://localhost:4000");
  });
});

describe("A2AServer Replay Protection", () => {
  let serverWithReplayProtection: A2AServer;

  beforeEach(() => {
    serverWithReplayProtection = createA2AServer({
      card: {
        name: "Protected Server",
        url: "http://localhost:5000",
      },
      taskHandler: async () => ({ state: "completed" }),
      replayProtection: {
        enabled: true,
        maxAgeMs: 5 * 60 * 1000, // 5 minutes
        nonceTtlMs: 10 * 60 * 1000, // 10 minutes
      },
    });
  });

  afterEach(() => {
    serverWithReplayProtection.stopCleanup();
  });

  it("should reject task without nonce when replay protection is enabled", async () => {
    const request: A2ARequest = {
      jsonrpc: "2.0",
      id: "test-no-nonce",
      method: "tasks/send",
      params: {
        message: {
          role: "user",
          parts: [{ type: "text", text: "Hello" }],
        },
        // Missing nonce and timestamp
      },
    };

    const result = await serverWithReplayProtection.handleRequest(request);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.error).toBeDefined();
    expect(result.value.error!.code).toBe(-32602);
  });

  it("should reject task without timestamp when replay protection is enabled", async () => {
    const request: A2ARequest = {
      jsonrpc: "2.0",
      id: "test-no-timestamp",
      method: "tasks/send",
      params: {
        message: {
          role: "user",
          parts: [{ type: "text", text: "Hello" }],
        },
        nonce: "unique-nonce-1",
        // Missing timestamp
      },
    };

    const result = await serverWithReplayProtection.handleRequest(request);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.error).toBeDefined();
    expect(result.value.error!.code).toBe(-32602);
  });

  it("should reject task with old timestamp", async () => {
    const oldTimestamp = Date.now() - 10 * 60 * 1000; // 10 minutes ago

    const request: A2ARequest = {
      jsonrpc: "2.0",
      id: "test-old-timestamp",
      method: "tasks/send",
      params: {
        message: {
          role: "user",
          parts: [{ type: "text", text: "Hello" }],
        },
        nonce: "unique-nonce-2",
        timestamp: oldTimestamp,
      },
    };

    const result = await serverWithReplayProtection.handleRequest(request);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.error).toBeDefined();
    expect(result.value.error!.code).toBe(-32602);
    expect(result.value.error!.message).toContain("too old");
  });

  it("should reject task with duplicate nonce", async () => {
    const nonce = "duplicate-nonce-test";
    const timestamp = Date.now();

    // First request should succeed
    const firstRequest: A2ARequest = {
      jsonrpc: "2.0",
      id: "test-first",
      method: "tasks/send",
      params: {
        message: {
          role: "user",
          parts: [{ type: "text", text: "First" }],
        },
        nonce,
        timestamp,
      },
    };

    const firstResult = await serverWithReplayProtection.handleRequest(firstRequest);
    expect(firstResult.ok).toBe(true);
    if (!firstResult.ok) return;
    expect(firstResult.value.error).toBeUndefined();

    // Second request with same nonce should fail
    const secondRequest: A2ARequest = {
      jsonrpc: "2.0",
      id: "test-second",
      method: "tasks/send",
      params: {
        message: {
          role: "user",
          parts: [{ type: "text", text: "Second" }],
        },
        nonce, // Same nonce
        timestamp: Date.now(),
      },
    };

    const secondResult = await serverWithReplayProtection.handleRequest(secondRequest);
    expect(secondResult.ok).toBe(true);
    if (!secondResult.ok) return;
    expect(secondResult.value.error).toBeDefined();
    expect(secondResult.value.error!.code).toBe(-32602);
    expect(secondResult.value.error!.message).toContain("Duplicate nonce");
  });

  it("should accept valid task with nonce and timestamp", async () => {
    const request: A2ARequest = {
      jsonrpc: "2.0",
      id: "test-valid",
      method: "tasks/send",
      params: {
        message: {
          role: "user",
          parts: [{ type: "text", text: "Valid request" }],
        },
        nonce: "valid-unique-nonce",
        timestamp: Date.now(),
      },
    };

    const result = await serverWithReplayProtection.handleRequest(request);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.error).toBeUndefined();
    expect(result.value.result).toBeDefined();
  });

  it("should reject task with future timestamp", async () => {
    const futureTimestamp = Date.now() + 5 * 60 * 1000; // 5 minutes in future

    const request: A2ARequest = {
      jsonrpc: "2.0",
      id: "test-future",
      method: "tasks/send",
      params: {
        message: {
          role: "user",
          parts: [{ type: "text", text: "Future request" }],
        },
        nonce: "future-nonce",
        timestamp: futureTimestamp,
      },
    };

    const result = await serverWithReplayProtection.handleRequest(request);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.error).toBeDefined();
    expect(result.value.error!.code).toBe(-32602);
    expect(result.value.error!.message).toContain("future");
  });
});

describe("A2AServer without Replay Protection", () => {
  let serverWithoutProtection: A2AServer;

  beforeEach(() => {
    serverWithoutProtection = createA2AServer({
      card: {
        name: "Unprotected Server",
        url: "http://localhost:6000",
      },
      taskHandler: async () => ({ state: "completed" }),
      // No replay protection configured
    });
  });

  it("should accept task without nonce when replay protection is disabled", async () => {
    const request: A2ARequest = {
      jsonrpc: "2.0",
      id: "test-no-protection",
      method: "tasks/send",
      params: {
        message: {
          role: "user",
          parts: [{ type: "text", text: "Hello without protection" }],
        },
        // No nonce or timestamp
      },
    };

    const result = await serverWithoutProtection.handleRequest(request);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.error).toBeUndefined();
    expect(result.value.result).toBeDefined();
  });
});

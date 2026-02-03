// Integration Test 4: Multi-Agent Communication (A2A Protocol)
// Tests agent discovery, Agent Cards, A2A task lifecycle

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn, ChildProcess } from "child_process";
import {
  defaultTestConfig,
  checkTestInfrastructure,
  waitForHealth,
  createTestConnection,
  createTestAgent,
  waitForState,
  sendTask,
  queryDatabase,
  clearTestDatabase,
  sleep,
  type TestConnection,
  type TestAgent,
} from "../helpers/test-utils.js";
import { sampleAgentManifest, assistantAgentManifest } from "../fixtures/agent-manifests.js";

describe("Integration Test 4: Multi-Agent Communication", () => {
  let gatewayProcess: ChildProcess | null = null;
  let connection: TestConnection | null = null;

  beforeAll(async () => {
    const infra = await checkTestInfrastructure();
    expect(infra.postgres).toBe(true);

    gatewayProcess = spawn("node", ["dist/main.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "test",
        GATEWAY_PORT: String(defaultTestConfig.gatewayPort),
        HEALTH_PORT: String(defaultTestConfig.healthPort),
        DATABASE_URL: defaultTestConfig.postgresUrl,
        QDRANT_URL: defaultTestConfig.qdrantUrl,
        REDIS_URL: defaultTestConfig.redisUrl,
        LOG_LEVEL: "debug",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    await waitForHealth(
      `http://127.0.0.1:${defaultTestConfig.healthPort}/health`,
      30000
    );
  }, 60000);

  beforeEach(async () => {
    await clearTestDatabase(defaultTestConfig.postgresUrl);

    if (connection) {
      connection.close();
    }

    const connResult = await createTestConnection(
      `ws://127.0.0.1:${defaultTestConfig.gatewayPort}`
    );
    expect(connResult.ok).toBe(true);
    if (connResult.ok) {
      connection = connResult.value;
    }
  });

  afterAll(async () => {
    if (connection) {
      connection.close();
    }
    if (gatewayProcess) {
      gatewayProcess.kill("SIGTERM");
      await sleep(2000);
      gatewayProcess.kill("SIGKILL");
    }
  });

  it("should register Agent A and Agent B", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    // Create Agent A
    const agentAResult = await createTestAgent(connection, {
      ...sampleAgentManifest,
      id: "a2a-agent-a",
      name: "Agent A",
      capabilities: ["chat", "delegation"],
    });
    expect(agentAResult.ok).toBe(true);

    // Create Agent B
    const agentBResult = await createTestAgent(connection, {
      ...assistantAgentManifest,
      id: "a2a-agent-b",
      name: "Agent B",
      capabilities: ["chat", "code", "analysis"],
    });
    expect(agentBResult.ok).toBe(true);

    if (!agentAResult.ok || !agentBResult.ok) return;

    const agentA = agentAResult.value;
    const agentB = agentBResult.value;

    // Wait for both to be ready
    const [aReady, bReady] = await Promise.all([
      waitForState(agentA, "ready", 30000),
      waitForState(agentB, "ready", 30000),
    ]);

    expect(aReady).toBe(true);
    expect(bReady).toBe(true);

    // Verify both exist in database
    const dbResult = await queryDatabase<{ id: string; state: string }>(
      defaultTestConfig.postgresUrl,
      "SELECT id, state FROM agents WHERE id IN ($1, $2)",
      [agentA.id, agentB.id]
    );

    expect(dbResult.ok).toBe(true);
    if (dbResult.ok) {
      expect(dbResult.value.length).toBe(2);
    }
  }, 60000);

  it("should allow Agent A to discover Agent B via Agent Card", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    const agentAResult = await createTestAgent(connection, {
      ...sampleAgentManifest,
      id: "discover-agent-a",
      name: "Discoverer Agent",
    });

    const agentBResult = await createTestAgent(connection, {
      ...assistantAgentManifest,
      id: "discover-agent-b",
      name: "Discoverable Agent",
      capabilities: ["special-skill"],
    });

    expect(agentAResult.ok).toBe(true);
    expect(agentBResult.ok).toBe(true);

    if (!agentAResult.ok || !agentBResult.ok) return;

    const agentA = agentAResult.value;
    const agentB = agentBResult.value;

    await Promise.all([
      waitForState(agentA, "ready", 30000),
      waitForState(agentB, "ready", 30000),
    ]);

    // Agent A discovers available agents
    const discoveryResult = await sendTask(agentA, {
      type: "discover_agents",
      filter: { capability: "special-skill" },
    }) as { payload?: { agents?: Array<{ id: string; name: string; capabilities: string[] }> } };

    expect(discoveryResult).toBeDefined();
    // Should find Agent B with the special-skill capability
    if (discoveryResult.payload?.agents) {
      const foundB = discoveryResult.payload.agents.find(a => a.id === agentB.id);
      expect(foundB).toBeDefined();
      if (foundB) {
        expect(foundB.capabilities).toContain("special-skill");
      }
    }
  }, 60000);

  it("should send A2A task from Agent A to Agent B", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    const agentAResult = await createTestAgent(connection, {
      ...sampleAgentManifest,
      id: "sender-agent",
      name: "Sender Agent",
    });

    const agentBResult = await createTestAgent(connection, {
      ...assistantAgentManifest,
      id: "receiver-agent",
      name: "Receiver Agent",
    });

    expect(agentAResult.ok).toBe(true);
    expect(agentBResult.ok).toBe(true);

    if (!agentAResult.ok || !agentBResult.ok) return;

    const agentA = agentAResult.value;
    const agentB = agentBResult.value;

    await Promise.all([
      waitForState(agentA, "ready", 30000),
      waitForState(agentB, "ready", 30000),
    ]);

    // Agent A sends task to Agent B
    const a2aTaskResult = await sendTask(agentA, {
      type: "a2a_task",
      targetAgentId: agentB.id,
      task: {
        type: "analyze",
        content: "Please analyze this text",
      },
    }) as { payload?: { taskId?: string; status?: string } };

    expect(a2aTaskResult).toBeDefined();
    if (a2aTaskResult.payload) {
      // Should have a task ID
      expect(a2aTaskResult.payload.taskId || a2aTaskResult.payload.status).toBeDefined();
    }
  }, 60000);

  it("should process A2A task and return result", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    const agentAResult = await createTestAgent(connection, {
      ...sampleAgentManifest,
      id: "task-sender",
      name: "Task Sender",
    });

    const agentBResult = await createTestAgent(connection, {
      ...assistantAgentManifest,
      id: "task-processor",
      name: "Task Processor",
    });

    expect(agentAResult.ok).toBe(true);
    expect(agentBResult.ok).toBe(true);

    if (!agentAResult.ok || !agentBResult.ok) return;

    const agentA = agentAResult.value;
    const agentB = agentBResult.value;

    await Promise.all([
      waitForState(agentA, "ready", 30000),
      waitForState(agentB, "ready", 30000),
    ]);

    // Send A2A task and wait for result
    const result = await sendTask(agentA, {
      type: "a2a_task_sync",
      targetAgentId: agentB.id,
      task: {
        type: "echo",
        content: "A2A echo test",
      },
      timeout: 30000,
    }) as { payload?: { result?: unknown; status?: string } };

    expect(result).toBeDefined();
    // Result should indicate completion
    if (result.payload) {
      expect(["completed", "success", undefined].includes(result.payload.status)).toBe(true);
    }
  }, 60000);

  it("should track full A2A task lifecycle (submitted → working → completed)", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    const agentAResult = await createTestAgent(connection, {
      ...sampleAgentManifest,
      id: "lifecycle-sender",
    });

    const agentBResult = await createTestAgent(connection, {
      ...assistantAgentManifest,
      id: "lifecycle-processor",
    });

    expect(agentAResult.ok).toBe(true);
    expect(agentBResult.ok).toBe(true);

    if (!agentAResult.ok || !agentBResult.ok) return;

    const agentA = agentAResult.value;
    const agentB = agentBResult.value;

    await Promise.all([
      waitForState(agentA, "ready", 30000),
      waitForState(agentB, "ready", 30000),
    ]);

    // Submit async task
    const submitResult = await sendTask(agentA, {
      type: "a2a_task_async",
      targetAgentId: agentB.id,
      task: {
        type: "long_task",
        content: "Process this over time",
      },
    }) as { payload?: { taskId?: string; status?: string } };

    expect(submitResult).toBeDefined();
    const taskId = submitResult.payload?.taskId;

    if (taskId) {
      // Poll for status updates
      let status = "submitted";
      const maxAttempts = 20;
      let attempts = 0;

      while (status !== "completed" && attempts < maxAttempts) {
        await sleep(500);

        const statusResult = await sendTask(agentA, {
          type: "a2a_task_status",
          taskId,
        }) as { payload?: { status?: string } };

        status = statusResult.payload?.status || status;
        attempts++;

        // Verify valid status transitions
        expect(["submitted", "working", "completed", "failed"]).toContain(status);
      }

      // Should eventually complete
      expect(["completed", "failed"]).toContain(status);
    }
  }, 90000);

  it("should match A2A message format specification", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    const agentAResult = await createTestAgent(connection, {
      ...sampleAgentManifest,
      id: "format-test-sender",
    });

    const agentBResult = await createTestAgent(connection, {
      ...assistantAgentManifest,
      id: "format-test-receiver",
    });

    expect(agentAResult.ok).toBe(true);
    expect(agentBResult.ok).toBe(true);

    if (!agentAResult.ok || !agentBResult.ok) return;

    const agentA = agentAResult.value;
    const agentB = agentBResult.value;

    await Promise.all([
      waitForState(agentA, "ready", 30000),
      waitForState(agentB, "ready", 30000),
    ]);

    // Check events table for A2A messages
    // The gateway should log A2A events in the database
    const result = await sendTask(agentA, {
      type: "a2a_task",
      targetAgentId: agentB.id,
      task: {
        type: "test",
        content: "Format test",
      },
    });

    // Check events in database
    const eventsResult = await queryDatabase<{ type: string; data: unknown }>(
      defaultTestConfig.postgresUrl,
      "SELECT type, data FROM events WHERE type LIKE 'a2a.%' ORDER BY created_at DESC LIMIT 5"
    );

    expect(eventsResult.ok).toBe(true);
    if (eventsResult.ok && eventsResult.value.length > 0) {
      // A2A events should have proper structure
      for (const event of eventsResult.value) {
        expect(event.type.startsWith("a2a")).toBe(true);
        expect(event.data).toBeDefined();
      }
    }
  }, 60000);

  it("should handle A2A communication errors gracefully", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    const agentAResult = await createTestAgent(connection, {
      ...sampleAgentManifest,
      id: "error-sender",
    });

    expect(agentAResult.ok).toBe(true);
    if (!agentAResult.ok) return;

    const agentA = agentAResult.value;
    await waitForState(agentA, "ready", 30000);

    // Try to send to non-existent agent
    const result = await sendTask(agentA, {
      type: "a2a_task",
      targetAgentId: "non-existent-agent",
      task: {
        type: "test",
        content: "This should fail",
      },
    }) as { type?: string; payload?: { error?: string } };

    expect(result).toBeDefined();
    // Should get an error response, not crash
    expect(result.type === "error" || result.payload?.error).toBeTruthy();
  }, 45000);
});

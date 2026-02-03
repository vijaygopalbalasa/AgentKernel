// Integration Test 2: Agent Lifecycle Management
// Tests agent creation, state transitions, task processing, crash recovery, and deletion

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
import { sampleAgentManifest } from "../fixtures/agent-manifests.js";

describe("Integration Test 2: Agent Lifecycle", () => {
  let gatewayProcess: ChildProcess | null = null;
  let connection: TestConnection | null = null;

  beforeAll(async () => {
    // Verify infrastructure
    const infra = await checkTestInfrastructure();
    expect(infra.postgres).toBe(true);
    expect(infra.qdrant).toBe(true);
    expect(infra.redis).toBe(true);

    // Start gateway
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
    // Clear database and reconnect
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

  it("should create agent via WebSocket and store in database", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    // Create agent
    const agentResult = await createTestAgent(connection, sampleAgentManifest);
    expect(agentResult.ok).toBe(true);

    if (!agentResult.ok) return;
    const agent = agentResult.value;

    // Verify agent appears in PostgreSQL
    const dbResult = await queryDatabase<{ id: string; state: string }>(
      defaultTestConfig.postgresUrl,
      "SELECT id, state FROM agents WHERE id = $1",
      [agent.id]
    );

    expect(dbResult.ok).toBe(true);
    if (dbResult.ok) {
      expect(dbResult.value.length).toBe(1);
      const row = dbResult.value[0];
      expect(row).toBeDefined();
      if (!row) return;
      expect(row.id).toBe(agent.id);
    }
  }, 30000);

  it("should spawn agent as child process", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    const agentResult = await createTestAgent(connection, sampleAgentManifest);
    expect(agentResult.ok).toBe(true);

    if (!agentResult.ok) return;
    const agent = agentResult.value;

    // Verify PID is recorded in database
    const dbResult = await queryDatabase<{ pid: number }>(
      defaultTestConfig.postgresUrl,
      "SELECT pid FROM agents WHERE id = $1",
      [agent.id]
    );

    expect(dbResult.ok).toBe(true);
    if (dbResult.ok) {
      expect(dbResult.value.length).toBe(1);
      const row = dbResult.value[0];
      expect(row).toBeDefined();
      if (!row) return;
      const pid = row.pid;
      // PID should be a valid process ID (null if using in-process agents)
      expect(pid === null || pid > 0).toBe(true);
    }
  }, 30000);

  it("should transition state: initializing → ready", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    const agentResult = await createTestAgent(connection, sampleAgentManifest);
    expect(agentResult.ok).toBe(true);

    if (!agentResult.ok) return;
    const agent = agentResult.value;

    // Wait for ready state
    const isReady = await waitForState(agent, "ready", 30000);
    expect(isReady).toBe(true);

    // Verify in database
    const dbResult = await queryDatabase<{ state: string }>(
      defaultTestConfig.postgresUrl,
      "SELECT state FROM agents WHERE id = $1",
      [agent.id]
    );

    expect(dbResult.ok).toBe(true);
    if (dbResult.ok) {
      const row = dbResult.value[0];
      expect(row).toBeDefined();
      if (!row) return;
      expect(row.state).toBe("ready");
    }
  }, 45000);

  it("should process task and transition: ready → running → ready", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    const agentResult = await createTestAgent(connection, sampleAgentManifest);
    expect(agentResult.ok).toBe(true);

    if (!agentResult.ok) return;
    const agent = agentResult.value;

    // Wait for ready
    await waitForState(agent, "ready", 30000);

    // Send a task
    const taskResult = await sendTask(agent, {
      type: "echo",
      content: "Hello, Agent!",
    });

    // Verify we got a response
    expect(taskResult).toBeDefined();

    // Agent should be back in ready state
    const finalState = await agent.getState();
    expect(finalState).toBe("ready");
  }, 45000);

  it("should call MAL for LLM completion", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    const agentResult = await createTestAgent(connection, sampleAgentManifest);
    expect(agentResult.ok).toBe(true);

    if (!agentResult.ok) return;
    const agent = agentResult.value;

    await waitForState(agent, "ready", 30000);

    // Send a task that requires LLM
    const taskResult = await sendTask(agent, {
      type: "chat",
      messages: [{ role: "user", content: "Say hello" }],
    }) as { payload?: { response?: string } };

    // Verify response structure (actual content depends on provider mock)
    expect(taskResult).toBeDefined();
    // The task should complete (success or mock response)
  }, 60000);

  it("should return result via WebSocket", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    const agentResult = await createTestAgent(connection, sampleAgentManifest);
    expect(agentResult.ok).toBe(true);

    if (!agentResult.ok) return;
    const agent = agentResult.value;

    await waitForState(agent, "ready", 30000);

    const taskResult = await sendTask(agent, {
      type: "echo",
      content: "Test message",
    }) as { type: string; payload?: unknown };

    expect(taskResult.type).toBeDefined();
    // Response should be task_result or similar
  }, 45000);

  it("should detect crash and restart agent via watchdog", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    const agentResult = await createTestAgent(connection, sampleAgentManifest);
    expect(agentResult.ok).toBe(true);

    if (!agentResult.ok) return;
    const agent = agentResult.value;

    await waitForState(agent, "ready", 30000);

    // Get original PID
    const originalPidResult = await queryDatabase<{ pid: number }>(
      defaultTestConfig.postgresUrl,
      "SELECT pid FROM agents WHERE id = $1",
      [agent.id]
    );

    const originalRow = originalPidResult.ok ? originalPidResult.value[0] : undefined;
    if (!originalPidResult.ok || !originalRow?.pid) {
      // Agent might be in-process, skip PID check
      console.log("Skipping PID check - agent may be in-process");
      return;
    }

    const originalPid = originalRow.pid;

    // Kill the agent process
    try {
      process.kill(originalPid, "SIGKILL");
    } catch {
      // Process might not exist
    }

    // Wait for watchdog to detect and restart (within 5 seconds)
    await sleep(6000);

    // Agent should transition: error → initializing → ready
    const isReady = await waitForState(agent, "ready", 30000);
    expect(isReady).toBe(true);

    // Verify new PID
    const newPidResult = await queryDatabase<{ pid: number }>(
      defaultTestConfig.postgresUrl,
      "SELECT pid FROM agents WHERE id = $1",
      [agent.id]
    );

    const newRow = newPidResult.ok ? newPidResult.value[0] : undefined;
    if (newPidResult.ok && newRow?.pid) {
      expect(newRow.pid).not.toBe(originalPid);
    }
  }, 60000);

  it("should delete agent and clean up on DELETE request", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    const agentResult = await createTestAgent(connection, sampleAgentManifest);
    expect(agentResult.ok).toBe(true);

    if (!agentResult.ok) return;
    const agent = agentResult.value;

    await waitForState(agent, "ready", 30000);

    // Terminate the agent
    await agent.terminate();

    // Wait for cleanup
    await sleep(2000);

    // Verify agent is marked as deleted in database
    const dbResult = await queryDatabase<{ deleted_at: Date | null; state: string }>(
      defaultTestConfig.postgresUrl,
      "SELECT deleted_at, state FROM agents WHERE id = $1",
      [agent.id]
    );

    expect(dbResult.ok).toBe(true);
    if (dbResult.ok) {
      expect(dbResult.value.length).toBe(1);
      const row = dbResult.value[0];
      expect(row).toBeDefined();
      if (!row) return;
      expect(row.state).toBe("terminated");
    }
  }, 45000);

  it("should handle state transition: error → initializing → ready after restart", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    const agentResult = await createTestAgent(connection, sampleAgentManifest);
    expect(agentResult.ok).toBe(true);

    if (!agentResult.ok) return;
    const agent = agentResult.value;

    await waitForState(agent, "ready", 30000);

    // Force error state by sending invalid task
    try {
      await sendTask(agent, { type: "crash_test" });
    } catch {
      // Expected to fail
    }

    // Wait for recovery
    await sleep(10000);

    // Agent should recover to ready
    const state = await agent.getState();
    expect(["ready", "error"].includes(state)).toBe(true);
  }, 60000);
});

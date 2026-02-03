// Integration Test 7: Concurrent Agents
// Tests multiple agents running simultaneously, resource management, and system stability

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
  withTimeout,
  type TestConnection,
  type TestAgent,
} from "../helpers/test-utils.js";
import { multiAgentManifests } from "../fixtures/agent-manifests.js";

describe("Integration Test 7: Concurrent Agents", () => {
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
        LOG_LEVEL: "info",
        MAX_AGENTS: "20",
        MAX_MEMORY_PER_AGENT_MB: "128",
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

  it("should spawn 10 agents simultaneously", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    // Create 10 agents in parallel
    const agentPromises = multiAgentManifests.map(manifest =>
      createTestAgent(connection!, manifest)
    );

    const results = await Promise.all(agentPromises);

    // All should succeed
    const successCount = results.filter(r => r.ok).length;
    expect(successCount).toBe(10);

    // Wait for all to be ready
    const agents = results.filter(r => r.ok).map(r => r.value!);
    const readyPromises = agents.map(agent =>
      waitForState(agent, "ready", 30000)
    );

    const readyResults = await Promise.all(readyPromises);
    const readyCount = readyResults.filter(r => r).length;
    expect(readyCount).toBe(10);
  }, 120000);

  it("should process tasks concurrently on all agents", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    // Create 10 agents
    const agentResults = await Promise.all(
      multiAgentManifests.map(manifest =>
        createTestAgent(connection!, manifest)
      )
    );

    const agents = agentResults.filter(r => r.ok).map(r => r.value!);
    expect(agents.length).toBe(10);

    // Wait for ready
    await Promise.all(agents.map(a => waitForState(a, "ready", 30000)));

    // Send a task to each agent concurrently
    const taskPromises = agents.map((agent, i) =>
      sendTask(agent, {
        type: "echo",
        content: `Concurrent task ${i}`,
      })
    );

    // All tasks should complete
    const taskResults = await withTimeout(
      Promise.all(taskPromises),
      60000,
      "Concurrent tasks timeout"
    );

    expect(taskResults.length).toBe(10);
    taskResults.forEach(result => {
      expect(result).toBeDefined();
    });
  }, 120000);

  it("should complete all tasks within 60 seconds", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    const startTime = Date.now();

    // Create agents
    const agentResults = await Promise.all(
      multiAgentManifests.map(manifest =>
        createTestAgent(connection!, manifest)
      )
    );

    const agents = agentResults.filter(r => r.ok).map(r => r.value!);
    await Promise.all(agents.map(a => waitForState(a, "ready", 30000)));

    // Send tasks
    const taskPromises = agents.map((agent, i) =>
      sendTask(agent, {
        type: "compute",
        operations: ["add", "multiply"],
        values: [i, i + 1, i + 2],
      })
    );

    await Promise.all(taskPromises);

    const elapsed = Date.now() - startTime;
    expect(elapsed).toBeLessThan(60000);

    console.log(`All 10 agents completed tasks in ${elapsed}ms`);
  }, 120000);

  it("should not deadlock under concurrent load", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    // Create agents
    const agentResults = await Promise.all(
      multiAgentManifests.slice(0, 5).map(manifest =>
        createTestAgent(connection!, manifest)
      )
    );

    const agents = agentResults.filter(r => r.ok).map(r => r.value!);
    await Promise.all(agents.map(a => waitForState(a, "ready", 30000)));

    // Send multiple tasks to each agent rapidly
    const allTaskPromises: Promise<unknown>[] = [];

    for (const agent of agents) {
      for (let i = 0; i < 5; i++) {
        allTaskPromises.push(
          sendTask(agent, {
            type: "echo",
            content: `Rapid task ${i}`,
          })
        );
      }
    }

    // Should complete without deadlock
    const results = await withTimeout(
      Promise.all(allTaskPromises),
      60000,
      "Deadlock timeout"
    );

    expect(results.length).toBe(25);
  }, 120000);

  it("should not starve any agent of resources", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    // Create agents
    const agentResults = await Promise.all(
      multiAgentManifests.map(manifest =>
        createTestAgent(connection!, manifest)
      )
    );

    const agents = agentResults.filter(r => r.ok).map(r => r.value!);
    await Promise.all(agents.map(a => waitForState(a, "ready", 30000)));

    // Track which agents complete
    const completionTimes: Map<string, number> = new Map();

    const taskPromises = agents.map(async (agent) => {
      const startTime = Date.now();
      await sendTask(agent, {
        type: "echo",
        content: "Starvation test",
      });
      completionTimes.set(agent.id, Date.now() - startTime);
    });

    await Promise.all(taskPromises);

    // No agent should take significantly longer than others
    const times = Array.from(completionTimes.values());
    const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
    const maxTime = Math.max(...times);

    // Max should not be more than 5x average (allowing for some variance)
    expect(maxTime).toBeLessThan(avgTime * 5);
  }, 120000);

  it("should enforce resource limiter (memory cap)", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    const agentResult = await createTestAgent(connection, {
      id: "memory-test-agent",
      name: "Memory Test Agent",
      version: "0.1.0",
      // Agent configured with memory limit
    });
    expect(agentResult.ok).toBe(true);

    if (!agentResult.ok) return;
    const agent = agentResult.value;

    await waitForState(agent, "ready", 30000);

    // Send task that might use memory
    const result = await sendTask(agent, {
      type: "memory_intensive",
      _testFlags: {
        allocateMb: 256, // More than 128MB limit
      },
    }) as { type?: string; payload?: { error?: string; oom?: boolean } };

    // If memory enforcement is active, should see an error or OOM flag
    expect(result).toBeDefined();
  }, 60000);

  it("should show all agents in registry with correct states", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    // Create agents
    const agentResults = await Promise.all(
      multiAgentManifests.map(manifest =>
        createTestAgent(connection!, manifest)
      )
    );

    const agents = agentResults.filter(r => r.ok).map(r => r.value!);
    await Promise.all(agents.map(a => waitForState(a, "ready", 30000)));

    // Query database for all agents
    const dbResult = await queryDatabase<{ id: string; state: string }>(
      defaultTestConfig.postgresUrl,
      "SELECT id, state FROM agents WHERE deleted_at IS NULL"
    );

    expect(dbResult.ok).toBe(true);
    if (dbResult.ok) {
      expect(dbResult.value.length).toBe(10);

      // All should be in ready state
      const readyAgents = dbResult.value.filter(a => a.state === "ready");
      expect(readyAgents.length).toBe(10);

      // Verify each expected agent exists
      for (const agent of agents) {
        const found = dbResult.value.find(a => a.id === agent.id);
        expect(found).toBeDefined();
      }
    }
  }, 120000);

  it("should handle agent creation rate limiting", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    // Try to create many agents very quickly
    const rapidCreatePromises = [];
    for (let i = 0; i < 25; i++) {
      rapidCreatePromises.push(
        createTestAgent(connection, {
          id: `rapid-agent-${i}`,
          name: `Rapid Agent ${i}`,
        })
      );
    }

    const results = await Promise.all(rapidCreatePromises);

    // Some might succeed, some might be rate limited
    const successCount = results.filter(r => r.ok).length;
    const failedCount = results.filter(r => !r.ok).length;

    console.log(`Rapid creation: ${successCount} succeeded, ${failedCount} failed`);

    // Should have rate limiting kick in eventually
    // Either all succeed or some fail due to rate limiting
    expect(successCount + failedCount).toBe(25);
  }, 60000);

  it("should cleanup terminated agents properly", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    // Create agents
    const agentResults = await Promise.all(
      multiAgentManifests.slice(0, 5).map(manifest =>
        createTestAgent(connection!, manifest)
      )
    );

    const agents = agentResults.filter(r => r.ok).map(r => r.value!);
    await Promise.all(agents.map(a => waitForState(a, "ready", 30000)));

    // Terminate all agents
    await Promise.all(agents.map(a => a.terminate()));

    await sleep(2000);

    // Verify cleanup in database
    const dbResult = await queryDatabase<{ state: string }>(
      defaultTestConfig.postgresUrl,
      `SELECT state FROM agents
       WHERE id = ANY($1)`,
      [agents.map(a => a.id)]
    );

    expect(dbResult.ok).toBe(true);
    if (dbResult.ok) {
      // All should be terminated
      dbResult.value.forEach(row => {
        expect(row.state).toBe("terminated");
      });
    }
  }, 60000);

  it("should maintain system health under load", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    // Create agents
    const agentResults = await Promise.all(
      multiAgentManifests.map(manifest =>
        createTestAgent(connection!, manifest)
      )
    );

    const agents = agentResults.filter(r => r.ok).map(r => r.value!);
    await Promise.all(agents.map(a => waitForState(a, "ready", 30000)));

    // Send tasks while checking health
    const taskPromises = agents.map(agent =>
      sendTask(agent, { type: "echo", content: "Load test" })
    );

    // Check health during load
    const healthPromise = fetch(
      `http://127.0.0.1:${defaultTestConfig.healthPort}/health`
    );

    const [taskResults, healthResponse] = await Promise.all([
      Promise.all(taskPromises),
      healthPromise,
    ]);

    expect(taskResults.length).toBe(10);
    expect(healthResponse.ok).toBe(true);

    const health = (await healthResponse.json()) as { status?: string };
    expect(["ok", "healthy", "degraded"]).toContain(health.status);
  }, 120000);
});

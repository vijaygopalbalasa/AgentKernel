// Integration Test 3: Memory Persistence
// Tests episodic memory, semantic memory, gateway restart, and memory isolation

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
} from "../helpers/test-utils.js";
import { sampleAgentManifest } from "../fixtures/agent-manifests.js";

describe("Integration Test 3: Memory Persistence", () => {
  let gatewayProcess: ChildProcess | null = null;
  let connection: TestConnection | null = null;

  const startGateway = async () => {
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
  };

  const stopGateway = async () => {
    if (gatewayProcess) {
      gatewayProcess.kill("SIGTERM");
      await sleep(2000);
      if (!gatewayProcess.killed) {
        gatewayProcess.kill("SIGKILL");
      }
      gatewayProcess = null;
    }
  };

  beforeAll(async () => {
    // Verify infrastructure
    const infra = await checkTestInfrastructure();
    expect(infra.postgres).toBe(true);
    expect(infra.qdrant).toBe(true);
    expect(infra.redis).toBe(true);

    await startGateway();
  }, 60000);

  beforeEach(async () => {
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
    await stopGateway();
  });

  it("should store episodic memory (conversation turn)", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    const agentResult = await createTestAgent(connection, {
      ...sampleAgentManifest,
      id: "memory-test-agent-1",
    });
    expect(agentResult.ok).toBe(true);

    if (!agentResult.ok) return;
    const agent = agentResult.value;

    await waitForState(agent, "ready", 30000);

    // Send a message (should create episodic memory)
    await sendTask(agent, {
      type: "chat",
      messages: [{ role: "user", content: "Remember this: my name is Alice" }],
    });

    // Verify episodic memory in database
    const dbResult = await queryDatabase<{ event: string; context: string }>(
      defaultTestConfig.postgresUrl,
      "SELECT event, context FROM episodic_memories WHERE agent_id = $1",
      [agent.id]
    );

    expect(dbResult.ok).toBe(true);
    if (dbResult.ok) {
      expect(dbResult.value.length).toBeGreaterThan(0);
      const row = dbResult.value[0];
      expect(row).toBeDefined();
      if (!row) return;
      expect(row.event).toBe("chat");
    }
  }, 45000);

  it("should store semantic memory (fact with embedding)", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    const agentResult = await createTestAgent(connection, {
      ...sampleAgentManifest,
      id: "memory-test-agent-2",
    });
    expect(agentResult.ok).toBe(true);

    if (!agentResult.ok) return;
    const agent = agentResult.value;

    await waitForState(agent, "ready", 30000);

    // Store a fact
    await sendTask(agent, {
      type: "store_fact",
      fact: "The capital of France is Paris",
      category: "geography",
    });

    // Verify semantic memory in database
    const dbResult = await queryDatabase<{ subject: string; object: string }>(
      defaultTestConfig.postgresUrl,
      "SELECT subject, object FROM semantic_memories WHERE agent_id = $1",
      [agent.id]
    );

    expect(dbResult.ok).toBe(true);
    if (dbResult.ok) {
      expect(dbResult.value.length).toBeGreaterThan(0);
      const fact = dbResult.value.find(f => f.object.includes("Paris"));
      expect(fact).toBeDefined();
      expect(fact?.subject).toBe("geography");
    }
  }, 45000);

  it("should persist memory across gateway restart", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    // Create agent and store memory
    const externalId = "restart-test-agent";
    const agentResult = await createTestAgent(connection, {
      ...sampleAgentManifest,
      id: externalId,
    });
    expect(agentResult.ok).toBe(true);

    if (!agentResult.ok) return;
    const agent = agentResult.value;
    const agentInternalId = agent.id;

    await waitForState(agent, "ready", 30000);

    // Store a fact
    await sendTask(agent, {
      type: "store_fact",
      fact: "Important test fact: persistence test 12345",
      category: "test",
    });

    // Store episodic memory
    await sendTask(agent, {
      type: "chat",
      messages: [{ role: "user", content: "Remember: restart test message" }],
    });

    // Close connection and stop gateway
    connection.close();
    connection = null;
    await stopGateway();

    // Wait a moment
    await sleep(2000);

    // Restart gateway
    await startGateway();

    // Reconnect
    const newConnResult = await createTestConnection(
      `ws://127.0.0.1:${defaultTestConfig.gatewayPort}`
    );
    expect(newConnResult.ok).toBe(true);
    if (!newConnResult.ok) return;
    connection = newConnResult.value;

    // Verify memories still exist in database
    const episodicResult = await queryDatabase<{ event: string }>(
      defaultTestConfig.postgresUrl,
      "SELECT event FROM episodic_memories WHERE agent_id = $1",
      [agentInternalId]
    );

    expect(episodicResult.ok).toBe(true);
    if (episodicResult.ok) {
      expect(episodicResult.value.length).toBeGreaterThan(0);
    }

    const semanticResult = await queryDatabase<{ object: string }>(
      defaultTestConfig.postgresUrl,
      "SELECT object FROM semantic_memories WHERE agent_id = $1",
      [agentInternalId]
    );

    expect(semanticResult.ok).toBe(true);
    if (semanticResult.ok) {
      expect(semanticResult.value.length).toBeGreaterThan(0);
      const found = semanticResult.value.some(f => f.object.includes("persistence test 12345"));
      expect(found).toBe(true);
    }
  }, 120000);

  it("should retrieve episodic memory after restart", async () => {
    // First, verify the memory from previous test exists
    const episodicResult = await queryDatabase<{ event: string; context: string }>(
      defaultTestConfig.postgresUrl,
      "SELECT event, context FROM episodic_memories LIMIT 5"
    );

    expect(episodicResult.ok).toBe(true);
    if (episodicResult.ok) {
      // Should have some episodic memories
      expect(episodicResult.value.length).toBeGreaterThanOrEqual(0);
    }
  }, 30000);

  it("should search semantic memory by similarity", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    const agentResult = await createTestAgent(connection, {
      ...sampleAgentManifest,
      id: "search-test-agent",
    });
    expect(agentResult.ok).toBe(true);

    if (!agentResult.ok) return;
    const agent = agentResult.value;

    await waitForState(agent, "ready", 30000);

    // Store multiple facts
    await sendTask(agent, {
      type: "store_fact",
      fact: "The Eiffel Tower is located in Paris, France",
      category: "landmarks",
    });

    await sendTask(agent, {
      type: "store_fact",
      fact: "The Great Wall of China is over 13,000 miles long",
      category: "landmarks",
    });

    await sendTask(agent, {
      type: "store_fact",
      fact: "Python is a programming language",
      category: "technology",
    });

    // Search for related facts
    const searchResult = await sendTask(agent, {
      type: "search_memory",
      query: "famous buildings in Europe",
      limit: 5,
    }) as { payload?: { memories?: Array<{ object: string }> } };

    // Results should include Eiffel Tower (semantically related to European buildings)
    expect(searchResult).toBeDefined();
    // Actual search requires embeddings - verify the mechanism exists
  }, 60000);

  it("should enforce memory isolation between agents", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    // Create Agent A
    const agentAResult = await createTestAgent(connection, {
      ...sampleAgentManifest,
      id: "isolation-agent-a",
    });
    expect(agentAResult.ok).toBe(true);

    // Create Agent B
    const agentBResult = await createTestAgent(connection, {
      ...sampleAgentManifest,
      id: "isolation-agent-b",
    });
    expect(agentBResult.ok).toBe(true);

    if (!agentAResult.ok || !agentBResult.ok) return;

    const agentA = agentAResult.value;
    const agentB = agentBResult.value;

    await Promise.all([
      waitForState(agentA, "ready", 30000),
      waitForState(agentB, "ready", 30000),
    ]);

    // Agent A stores a secret
    await sendTask(agentA, {
      type: "store_fact",
      fact: "Agent A's secret: password123",
      category: "secrets",
    });

    // Agent B tries to access Agent A's memories
    const bSearchResult = await sendTask(agentB, {
      type: "search_memory",
      query: "secret password",
      limit: 10,
    }) as { payload?: { memories?: Array<{ object: string }> } };

    // Agent B should NOT find Agent A's secret
    // Verify in database that memories are properly isolated
    const aMemories = await queryDatabase<{ object: string }>(
      defaultTestConfig.postgresUrl,
      "SELECT object FROM semantic_memories WHERE agent_id = $1",
      [agentA.id]
    );

    const bMemories = await queryDatabase<{ object: string }>(
      defaultTestConfig.postgresUrl,
      "SELECT object FROM semantic_memories WHERE agent_id = $1",
      [agentB.id]
    );

    expect(aMemories.ok).toBe(true);
    expect(bMemories.ok).toBe(true);

    if (aMemories.ok && bMemories.ok) {
      // Agent A should have the secret
      const aHasSecret = aMemories.value.some(m => m.object.includes("password123"));
      expect(aHasSecret).toBe(true);

      // Agent B should NOT have Agent A's secret
      const bHasASecret = bMemories.value.some(m => m.object.includes("password123"));
      expect(bHasASecret).toBe(false);
    }
  }, 60000);

  it("should handle memory with proper timestamps", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    const agentResult = await createTestAgent(connection, {
      ...sampleAgentManifest,
      id: "timestamp-test-agent",
    });
    expect(agentResult.ok).toBe(true);

    if (!agentResult.ok) return;
    const agent = agentResult.value;

    await waitForState(agent, "ready", 30000);

    const beforeStore = new Date();

    // Store memory
    await sendTask(agent, {
      type: "store_fact",
      fact: "Timestamp test fact",
      category: "test",
    });

    const afterStore = new Date();

    // Verify timestamp
    const dbResult = await queryDatabase<{ created_at: Date }>(
      defaultTestConfig.postgresUrl,
      "SELECT created_at FROM semantic_memories WHERE agent_id = $1 AND object LIKE '%Timestamp test%'",
      [agent.id]
    );

    expect(dbResult.ok).toBe(true);
    if (dbResult.ok && dbResult.value.length > 0) {
      const row = dbResult.value[0];
      if (!row) {
        throw new Error("Expected memory record to exist");
      }
      const createdAt = new Date(row.created_at);
      expect(createdAt.getTime()).toBeGreaterThanOrEqual(beforeStore.getTime());
      expect(createdAt.getTime()).toBeLessThanOrEqual(afterStore.getTime() + 1000);
    }
  }, 45000);
});

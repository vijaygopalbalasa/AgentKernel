// Chaos Test 1: Gateway resilience under connection and agent churn

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import {
  defaultTestConfig,
  waitForHealth,
  createTestConnection,
  createTestAgent,
  waitForState,
  sendTask,
  sleep,
} from "../helpers/test-utils.js";

describe("Chaos Test 1: Resilience", () => {
  let gatewayProcess: ChildProcess | null = null;

  beforeAll(async () => {
    gatewayProcess = spawn("node", ["dist/main.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "test",
        GATEWAY_PORT: String(defaultTestConfig.gatewayPort),
        DATABASE_URL: defaultTestConfig.postgresUrl,
        QDRANT_URL: defaultTestConfig.qdrantUrl,
        REDIS_URL: defaultTestConfig.redisUrl,
        LOG_LEVEL: "warn",
        MAX_AGENTS: "25",
        MAX_MEMORY_PER_AGENT_MB: "128",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    await waitForHealth(
      `http://127.0.0.1:${defaultTestConfig.healthPort}/health`,
      30000
    );
  }, 60000);

  afterAll(async () => {
    if (gatewayProcess) {
      gatewayProcess.kill("SIGTERM");
      await sleep(2000);
      gatewayProcess.kill("SIGKILL");
    }
  });

  it("handles connection churn without becoming unhealthy", async () => {
    const churnCount = 30;
    const connections = await Promise.all(
      Array.from({ length: churnCount }, async () => {
        const result = await createTestConnection(
          `ws://127.0.0.1:${defaultTestConfig.gatewayPort}`
        );
        expect(result.ok).toBe(true);
        return result.ok ? result.value : null;
      })
    );

    for (const conn of connections) {
      if (!conn) continue;
      conn.send({ type: "ping", id: `ping-${Date.now()}` });
      await conn.receive(5000);
      conn.close();
    }

    const health = await fetch(
      `http://127.0.0.1:${defaultTestConfig.healthPort}/health`
    );
    expect(health.ok).toBe(true);
  }, 90000);

  it("survives repeated agent spawn/terminate cycles", async () => {
    const cycles = 3;
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      const connResult = await createTestConnection(
        `ws://127.0.0.1:${defaultTestConfig.gatewayPort}`
      );
      expect(connResult.ok).toBe(true);
      if (!connResult.ok) return;

      const connection = connResult.value;

      const manifests = Array.from({ length: 5 }, (_, i) => ({
        id: `chaos-agent-${cycle}-${i}`,
        name: `Chaos Agent ${cycle}-${i}`,
        version: "0.1.0",
        model: "claude-3-haiku-20240307",
        capabilities: ["chat"],
        permissions: ["memory.read"],
      }));

      const agents = await Promise.all(
        manifests.map((manifest) => createTestAgent(connection, manifest))
      );

      const readyAgents = agents.filter((r) => r.ok).map((r) => r.value!);
      expect(readyAgents.length).toBe(5);

      await Promise.all(readyAgents.map((agent) => waitForState(agent, "ready", 30000)));

      await Promise.all(
        readyAgents.map((agent, i) =>
          sendTask(agent, { type: "echo", content: `chaos-${cycle}-${i}` })
        )
      );

      await Promise.all(readyAgents.map((agent) => agent.terminate()));
      connection.close();
    }

    const health = await fetch(
      `http://127.0.0.1:${defaultTestConfig.healthPort}/health`
    );
    expect(health.ok).toBe(true);
  }, 120000);
});

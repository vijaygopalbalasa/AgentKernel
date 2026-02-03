// Chaos Test 2: Gateway tolerates missing DB when persistence is optional

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import {
  defaultTestConfig,
  waitForHealth,
  createTestConnection,
  createTestAgent,
  sendTask,
  sleep,
} from "../helpers/test-utils.js";

describe("Chaos Test 2: DB Outage", () => {
  let gatewayProcess: ChildProcess | null = null;
  const gatewayPort = defaultTestConfig.gatewayPort + 5;
  const healthPort = defaultTestConfig.healthPort + 5;

  beforeAll(async () => {
    gatewayProcess = spawn("node", ["dist/main.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "test",
        GATEWAY_PORT: String(gatewayPort),
        HEALTH_PORT: String(healthPort),
        DATABASE_URL: "postgresql://invalid:invalid@localhost:9999/invalid",
        REQUIRE_PERSISTENT_STORE: "false",
        REQUIRE_VECTOR_STORE: "false",
        LOG_LEVEL: "warn",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    await waitForHealth(
      `http://127.0.0.1:${healthPort}/health`,
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

  it("reports degraded health but still serves tasks", async () => {
    const health = await fetch(`http://127.0.0.1:${healthPort}/health`);
    expect(health.ok).toBe(true);
    const payload = await health.json();
    expect(payload.status).toBe("degraded");

    const connectionResult = await createTestConnection(
      `ws://127.0.0.1:${gatewayPort}`
    );
    expect(connectionResult.ok).toBe(true);
    if (!connectionResult.ok) return;

    const connection = connectionResult.value;

    const agentResult = await createTestAgent(connection, {
      id: "chaos-db-agent",
      name: "Chaos DB Agent",
      permissions: [],
    });
    expect(agentResult.ok).toBe(true);
    if (!agentResult.ok) return;

    const agent = agentResult.value;
    await sendTask(agent, { type: "echo", content: "db-down" });

    await agent.terminate();
    connection.close();
  }, 60000);
});

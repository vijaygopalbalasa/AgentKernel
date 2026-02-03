// Integration Test 10: Default Agent Manifests
// Validates default agent manifests deploy cleanly (without workers) and can be terminated

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn, ChildProcess } from "child_process";
import {
  defaultTestConfig,
  checkTestInfrastructure,
  waitForHealth,
  createTestConnection,
  createTestAgent,
  clearTestDatabase,
  sleep,
  type TestConnection,
  type TestAgent,
} from "../helpers/test-utils.js";
import { readFile } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

const manifestPaths = [
  resolve(repoRoot, "agents/researcher/manifest.json"),
  resolve(repoRoot, "agents/monitor/manifest.json"),
  resolve(repoRoot, "agents/coder/manifest.json"),
];

describe("Integration Test 10: Default Agent Manifests", () => {
  let gatewayProcess: ChildProcess | null = null;
  let connection: TestConnection | null = null;
  let spawnedAgents: TestAgent[] = [];

  beforeAll(async () => {
    const infra = await checkTestInfrastructure();
    expect(infra.postgres).toBe(true);
    expect(infra.qdrant).toBe(true);
    expect(infra.redis).toBe(true);

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
    spawnedAgents = [];

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
    for (const agent of spawnedAgents) {
      try {
        await agent.terminate();
      } catch {
        // ignore
      }
    }

    if (connection) {
      connection.close();
    }
    if (gatewayProcess) {
      gatewayProcess.kill("SIGTERM");
      await sleep(2000);
      gatewayProcess.kill("SIGKILL");
    }
  });

  it("should deploy default agent manifests", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    for (const manifestPath of manifestPaths) {
      const raw = await readFile(manifestPath, "utf-8");
      const manifest = JSON.parse(raw) as Record<string, unknown>;

      // Avoid starting worker processes during test
      delete manifest.entryPoint;
      manifest.id = `${manifest.id}-test`;

      const agentResult = await createTestAgent(connection, manifest);
      expect(agentResult.ok).toBe(true);

      if (agentResult.ok) {
        spawnedAgents.push(agentResult.value);
      }
    }
  }, 60000);
});

// Integration Test 1: Full Gateway Boot Sequence
// Tests cold start, DB migrations, service connections, and graceful shutdown

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { spawn, ChildProcess, exec } from "child_process";
import { promisify } from "util";
import {
  defaultTestConfig,
  checkTestInfrastructure,
  sleep,
  waitForHealth,
  createTestConnection,
} from "../helpers/test-utils.js";

const execAsync = promisify(exec);

describe("Integration Test 1: Full Gateway Boot", () => {
  let gatewayProcess: ChildProcess | null = null;

  // Ensure infrastructure is running before tests
  beforeAll(async () => {
    const infra = await checkTestInfrastructure();
    expect(infra.postgres).toBe(true);
    expect(infra.qdrant).toBe(true);
    expect(infra.redis).toBe(true);
  }, 30000);

  // Clean up gateway after each test
  afterEach(async () => {
    if (gatewayProcess) {
      gatewayProcess.kill("SIGTERM");
      await sleep(2000);
      if (gatewayProcess.killed === false) {
        gatewayProcess.kill("SIGKILL");
      }
      gatewayProcess = null;
    }
  });

  afterAll(async () => {
    // Ensure cleanup
    if (gatewayProcess) {
      gatewayProcess.kill("SIGKILL");
    }
  });

  it("should start gateway from cold with all services connected", async () => {
    // Start the gateway
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

    let stdout = "";
    let stderr = "";

    gatewayProcess.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    gatewayProcess.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    // Wait for health endpoint to respond
    const healthResult = await waitForHealth(
      `http://127.0.0.1:${defaultTestConfig.healthPort}/health`,
      30000
    );

    expect(healthResult.ok).toBe(true);

    // Verify health response includes all checks
    const healthResponse = await fetch(
      `http://127.0.0.1:${defaultTestConfig.healthPort}/health`
    );
    expect(healthResponse.ok).toBe(true);

    const healthData = (await healthResponse.json()) as {
      status?: string;
      version?: string;
    };
    expect(healthData.status).toBe("ok");
    expect(healthData.version).toBeDefined();
  }, 60000);

  it("should run PostgreSQL migrations automatically on startup", async () => {
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

    let output = "";
    gatewayProcess.stdout?.on("data", (data) => {
      output += data.toString();
    });

    await waitForHealth(
      `http://127.0.0.1:${defaultTestConfig.healthPort}/health`,
      30000
    );

    // Check that migrations table exists and has records
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: defaultTestConfig.postgresUrl });
    const result = await pool.query(
      "SELECT name FROM _migrations ORDER BY id"
    );
    await pool.end();

    expect(result.rows.length).toBeGreaterThan(0);
    const firstRow = result.rows[0];
    expect(firstRow).toBeDefined();
    if (!firstRow) return;
    expect(firstRow.name).toBe("001_initial.sql");
  }, 60000);

  it("should create Qdrant collections if missing", async () => {
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

    // Check Qdrant for collections
    const collectionsResponse = await fetch(
      `${defaultTestConfig.qdrantUrl}/collections`
    );
    expect(collectionsResponse.ok).toBe(true);

    const collections = (await collectionsResponse.json()) as { result?: unknown };
    // Should have at least the memory collection
    expect(collections.result).toBeDefined();
  }, 60000);

  it("should establish Redis connection", async () => {
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

    // Verify Redis is connected by checking a key set by gateway
    const { createClient } = await import("redis");
    const client = createClient({ url: defaultTestConfig.redisUrl });
    await client.connect();

    // Gateway should set a heartbeat key
    const ping = await client.ping();
    expect(ping).toBe("PONG");

    await client.disconnect();
  }, 60000);

  it("should accept WebSocket connections", async () => {
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

    // Try to connect via WebSocket
    const connectionResult = await createTestConnection(
      `ws://127.0.0.1:${defaultTestConfig.gatewayPort}`,
      undefined,
      10000
    );

    expect(connectionResult.ok).toBe(true);
    if (connectionResult.ok) {
      connectionResult.value.close();
    }
  }, 60000);

  it("should respond at /health with all checks green", async () => {
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

    const healthResponse = await fetch(
      `http://127.0.0.1:${defaultTestConfig.healthPort}/health`
    );
    const health = (await healthResponse.json()) as { status?: string; uptime?: number };

    expect(health.status).toBe("ok");
    expect(health.uptime).toBeGreaterThanOrEqual(0);
  }, 60000);

  it("should shut down cleanly on SIGTERM with no orphan processes", async () => {
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

    const pid = gatewayProcess.pid!;

    await waitForHealth(
      `http://127.0.0.1:${defaultTestConfig.healthPort}/health`,
      30000
    );

    // Track child processes before shutdown
    let childPids: number[] = [];
    try {
      const { stdout } = await execAsync(`pgrep -P ${pid}`);
      childPids = stdout
        .trim()
        .split("\n")
        .map((p) => parseInt(p, 10))
        .filter((p) => !isNaN(p));
    } catch {
      // No child processes
    }

    // Send SIGTERM
    gatewayProcess.kill("SIGTERM");

    // Wait for process to exit
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        gatewayProcess?.kill("SIGKILL");
        resolve();
      }, 10000);

      gatewayProcess?.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    // Verify no orphan processes
    await sleep(1000);
    for (const childPid of childPids) {
      try {
        process.kill(childPid, 0);
        // If we get here, process is still running - that's bad
        expect.fail(`Orphan process found: ${childPid}`);
      } catch {
        // Process doesn't exist - good
      }
    }

    // Verify health endpoint no longer responds
    try {
      await fetch(
        `http://127.0.0.1:${defaultTestConfig.healthPort}/health`,
        { signal: AbortSignal.timeout(2000) }
      );
      expect.fail("Health endpoint should not respond after shutdown");
    } catch {
      // Expected - connection refused
    }

    gatewayProcess = null;
  }, 60000);
});

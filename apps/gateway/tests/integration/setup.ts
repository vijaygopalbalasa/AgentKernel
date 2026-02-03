// Integration test setup and teardown
import { beforeAll, afterAll, beforeEach } from "vitest";
import { promises as fs } from "fs";
import { resolve } from "path";
import { createServer, type AddressInfo } from "net";
import type {
  TestConfig,
  checkTestInfrastructure as CheckInfraFn,
  startTestInfrastructure as StartInfraFn,
  clearTestDatabase as ClearDbFn,
} from "../helpers/test-utils.js";

// Ensure test runs don't inherit production auth requirements from .env
process.env.GATEWAY_AUTH_TOKEN = process.env.TEST_GATEWAY_AUTH_TOKEN ?? "";
process.env.INTERNAL_AUTH_TOKEN = process.env.TEST_INTERNAL_AUTH_TOKEN ?? "";
process.env.REQUIRE_MANIFEST_SIGNATURE = "false";
process.env.MANIFEST_SIGNING_SECRET = "";
process.env.MAL_USE_MOCK_PROVIDERS = process.env.MAL_USE_MOCK_PROVIDERS ?? "true";
process.env.REQUIRE_PERSISTENT_STORE = process.env.REQUIRE_PERSISTENT_STORE ?? "true";

const lockPath = resolve(process.cwd(), ".agentos-test-infra.lock");

let defaultTestConfig: TestConfig;
let checkTestInfrastructure: typeof CheckInfraFn;
let startTestInfrastructure: typeof StartInfraFn;
let clearTestDatabase: typeof ClearDbFn;

async function findFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", (error) => reject(error));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });
}

async function ensureTestPorts(): Promise<void> {
  if (!process.env.TEST_GATEWAY_PORT) {
    const port = await findFreePort();
    process.env.TEST_GATEWAY_PORT = String(port);
  }
  if (!process.env.TEST_HEALTH_PORT) {
    const gatewayPort = Number(process.env.TEST_GATEWAY_PORT);
    process.env.TEST_HEALTH_PORT = String(gatewayPort + 1);
  }
}

async function loadHelpers(): Promise<void> {
  if (defaultTestConfig) return;
  await ensureTestPorts();
  const helpers = await import("../helpers/test-utils.js");
  defaultTestConfig = helpers.defaultTestConfig;
  checkTestInfrastructure = helpers.checkTestInfrastructure;
  startTestInfrastructure = helpers.startTestInfrastructure;
  clearTestDatabase = helpers.clearTestDatabase;
}

async function waitForInfrastructure(timeoutMs = 60000): Promise<boolean> {
  await loadHelpers();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await checkTestInfrastructure();
    if (status.postgres && status.qdrant && status.redis) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

async function ensureInfrastructure(): Promise<void> {
  await loadHelpers();
  const status = await checkTestInfrastructure();
  if (status.postgres && status.qdrant && status.redis) {
    return;
  }

  let lockHandle: fs.FileHandle | null = null;
  try {
    lockHandle = await fs.open(lockPath, "wx");
  } catch {
    lockHandle = null;
  }

  if (lockHandle) {
    try {
      const result = await startTestInfrastructure();
      if (!result.ok) {
        throw new Error(`Failed to start infrastructure: ${result.error.message}`);
      }
    } finally {
      await lockHandle.close();
    }

    const ready = await waitForInfrastructure(60000);
    if (!ready) {
      throw new Error("Infrastructure did not become ready in time");
    }
    return;
  }

  const ready = await waitForInfrastructure(60000);
  if (ready) return;

  // Stale lock fallback
  try {
    await fs.unlink(lockPath);
  } catch {
    // ignore
  }

  const result = await startTestInfrastructure();
  if (!result.ok) {
    throw new Error(`Failed to start infrastructure: ${result.error.message}`);
  }

  const readyAfter = await waitForInfrastructure(60000);
  if (!readyAfter) {
    throw new Error("Infrastructure did not become ready in time");
  }
}

// Global setup before all tests
beforeAll(async () => {
  console.log("🔧 Setting up integration test environment...");

  await loadHelpers();

  if (process.env.SKIP_INFRA_CHECK === "true") {
    console.log("⚠️ Skipping infrastructure checks (SKIP_INFRA_CHECK=true)");
    return;
  }

  await ensureInfrastructure();

  console.log("✅ Infrastructure ready:");
  const status = await checkTestInfrastructure();
  console.log(`   PostgreSQL: ${status.postgres ? "✓" : "starting..."}`);
  console.log(`   Qdrant: ${status.qdrant ? "✓" : "starting..."}`);
  console.log(`   Redis: ${status.redis ? "✓" : "starting..."}`);
}, 120000);

// Cleanup after all tests
afterAll(async () => {
  console.log("🧹 Cleaning up integration test environment...");

  console.log("✅ Cleanup complete");
}, 30000);

// Clear database before each test
beforeEach(async () => {
  await loadHelpers();
  const result = await clearTestDatabase(defaultTestConfig.postgresUrl);
  if (!result.ok) {
    console.warn(`Warning: Failed to clear database: ${result.error.message}`);
  }
});

export { defaultTestConfig };

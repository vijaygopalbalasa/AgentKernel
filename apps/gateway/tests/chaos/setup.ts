// Chaos test setup and teardown
import { beforeAll, afterAll, beforeEach } from "vitest";
import {
  checkTestInfrastructure,
  startTestInfrastructure,
  clearTestDatabase,
  defaultTestConfig,
} from "../helpers/test-utils.js";

beforeAll(async () => {
  console.log("🧪 Setting up chaos test environment...");

  const status = await checkTestInfrastructure();
  if (!status.postgres || !status.qdrant || !status.redis) {
    console.log("📦 Starting test infrastructure with Docker Compose...");
    const result = await startTestInfrastructure();
    if (!result.ok) {
      throw new Error(`Failed to start infrastructure: ${result.error.message}`);
    }
  }
}, 120000);

afterAll(async () => {
  console.log("✅ Chaos test cleanup complete");
}, 30000);

beforeEach(async () => {
  const result = await clearTestDatabase(defaultTestConfig.postgresUrl);
  if (!result.ok) {
    console.warn(`Warning: Failed to clear database: ${result.error.message}`);
  }
});

export { defaultTestConfig };

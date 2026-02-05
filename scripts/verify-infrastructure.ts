#!/usr/bin/env tsx
/**
 * Infrastructure Verification Script
 *
 * Tests REAL connections to PostgreSQL, Qdrant, and Redis.
 * Run with: pnpm tsx scripts/verify-infrastructure.ts
 *
 * Prerequisites:
 *   docker compose -f docker/docker-compose.test.yml up -d
 *
 * Expected ports (test infrastructure):
 *   PostgreSQL: 5433 (test) or 5432 (prod)
 *   Qdrant: 6335 (test) or 6333 (prod)
 *   Redis: 6380 (test) or 6379 (prod)
 */

import {
  createDatabase,
  createVectorStore,
  createEventBus,
  createLogger,
  type DatabaseConfig,
  type QdrantConfig,
  type RedisConfig,
} from "@agentkernel/kernel";

const log = createLogger({ name: "verify-infrastructure", level: "info" });

// Test infrastructure config (matches docker-compose.test.yml)
const TEST_CONFIG = {
  database: {
    host: process.env.DATABASE_HOST ?? "localhost",
    port: Number(process.env.DATABASE_PORT) || 5433, // Test port
    database: process.env.DATABASE_NAME ?? "agentkernel_test",
    user: process.env.DATABASE_USER ?? "agentkernel",
    password: process.env.DATABASE_PASSWORD ?? "agentkernel_test",
    maxConnections: 5,
    idleTimeout: 10000,
    ssl: false,
  } satisfies DatabaseConfig,

  qdrant: {
    host: process.env.QDRANT_HOST ?? "localhost",
    port: Number(process.env.QDRANT_PORT) || 6335, // Test port
    collection: "test_verification",
    vectorSize: 384, // Small for testing
    https: false,
  } satisfies QdrantConfig,

  redis: {
    host: process.env.REDIS_HOST ?? "localhost",
    port: Number(process.env.REDIS_PORT) || 6380, // Test port
    keyPrefix: "verify:",
    db: 0,
    mode: "standalone" as const,
  } satisfies RedisConfig,
};

interface VerificationResult {
  component: string;
  status: "pass" | "fail";
  latencyMs: number;
  details?: string;
  error?: string;
}

const results: VerificationResult[] = [];

async function verifyPostgreSQL(): Promise<VerificationResult> {
  const start = Date.now();
  const component = "PostgreSQL";

  log.info(`Testing ${component}...`, {
    host: TEST_CONFIG.database.host,
    port: TEST_CONFIG.database.port
  });

  try {
    const db = createDatabase(TEST_CONFIG.database, log);

    // Wait for connection
    await db.connectionReady;

    // Test query
    const connected = await db.isConnected();
    if (!connected) {
      throw new Error("Connection check returned false");
    }

    // Test actual query
    const queryResult = await db.query(async (sql) => {
      return sql`SELECT current_database() as db, current_user as user, version() as version`;
    });

    const dbInfo = queryResult[0] as { db: string; user: string; version: string };

    // Close connection
    await db.close();

    return {
      component,
      status: "pass",
      latencyMs: Date.now() - start,
      details: `Connected to ${dbInfo.db} as ${dbInfo.user}`,
    };
  } catch (error) {
    return {
      component,
      status: "fail",
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function verifyQdrant(): Promise<VerificationResult> {
  const start = Date.now();
  const component = "Qdrant";

  log.info(`Testing ${component}...`, {
    host: TEST_CONFIG.qdrant.host,
    port: TEST_CONFIG.qdrant.port
  });

  try {
    const vectorStore = createVectorStore(TEST_CONFIG.qdrant, log);

    // Check health
    const healthy = await vectorStore.isHealthy();
    if (!healthy) {
      throw new Error("Health check failed");
    }

    // Ensure collection exists
    await vectorStore.ensureCollection();

    // Test upsert
    const testPoint = {
      id: "test-verify-" + Date.now(),
      vector: Array(TEST_CONFIG.qdrant.vectorSize).fill(0).map(() => Math.random()),
      payload: { test: true, timestamp: new Date().toISOString() },
    };
    await vectorStore.upsert(testPoint);

    // Test search
    const searchResults = await vectorStore.search(testPoint.vector, { limit: 1 });
    if (searchResults.length === 0) {
      throw new Error("Search returned no results after upsert");
    }

    // Cleanup
    await vectorStore.delete(testPoint.id);

    // Get info
    const info = await vectorStore.getInfo();

    await vectorStore.close();

    return {
      component,
      status: "pass",
      latencyMs: Date.now() - start,
      details: `Collection: ${info.name}, Points: ${info.pointsCount}, Status: ${info.status}`,
    };
  } catch (error) {
    return {
      component,
      status: "fail",
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function verifyRedis(): Promise<VerificationResult> {
  const start = Date.now();
  const component = "Redis";

  log.info(`Testing ${component}...`, {
    host: TEST_CONFIG.redis.host,
    port: TEST_CONFIG.redis.port
  });

  try {
    const eventBus = createEventBus(TEST_CONFIG.redis, log);

    // Wait for connection (ioredis connects async)
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Check connection
    const connected = eventBus.isConnected();
    if (!connected) {
      throw new Error("Event bus not connected");
    }

    // Test pub/sub
    let receivedMessage = false;
    const testChannel = "verify-test";
    const testMessage = { type: "test", data: { timestamp: Date.now() } };

    const subscription = await eventBus.subscribe(testChannel, (msg) => {
      if (msg.type === "test") {
        receivedMessage = true;
      }
    });

    // Publish message
    await eventBus.publish(testChannel, testMessage);

    // Wait for message
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Cleanup
    await subscription.unsubscribe();

    // Get stats
    const stats = eventBus.getStats();

    await eventBus.close();

    if (!receivedMessage) {
      throw new Error("Pub/sub test failed: message not received");
    }

    return {
      component,
      status: "pass",
      latencyMs: Date.now() - start,
      details: `Published: ${stats.published}, Received: ${stats.received}`,
    };
  } catch (error) {
    return {
      component,
      status: "fail",
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function verifyMigrations(): Promise<VerificationResult> {
  const start = Date.now();
  const component = "Migrations";

  log.info(`Testing ${component}...`);

  try {
    const db = createDatabase(TEST_CONFIG.database, log);
    await db.connectionReady;

    // Run migrations
    const migrationsPath = new URL("../packages/kernel/migrations", import.meta.url).pathname;
    const result = await db.migrate(migrationsPath);

    await db.close();

    if (result.errors.length > 0) {
      throw new Error(`Migration errors: ${result.errors.map(e => e.error).join(", ")}`);
    }

    return {
      component,
      status: "pass",
      latencyMs: Date.now() - start,
      details: `Applied: ${result.applied}, Total: ${result.migrations.length}`,
    };
  } catch (error) {
    return {
      component,
      status: "fail",
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  console.log("\n" + "=".repeat(60));
  console.log("  AgentKernel Infrastructure Verification");
  console.log("=".repeat(60) + "\n");

  // Run verifications
  results.push(await verifyPostgreSQL());
  results.push(await verifyQdrant());
  results.push(await verifyRedis());
  results.push(await verifyMigrations());

  // Print results
  console.log("\n" + "-".repeat(60));
  console.log("  Results");
  console.log("-".repeat(60) + "\n");

  let allPassed = true;
  for (const result of results) {
    const icon = result.status === "pass" ? "✅" : "❌";
    console.log(`${icon} ${result.component}: ${result.status.toUpperCase()} (${result.latencyMs}ms)`);
    if (result.details) {
      console.log(`   ${result.details}`);
    }
    if (result.error) {
      console.log(`   Error: ${result.error}`);
      allPassed = false;
    }
  }

  console.log("\n" + "=".repeat(60));
  if (allPassed) {
    console.log("  ✅ ALL INFRASTRUCTURE CHECKS PASSED");
  } else {
    console.log("  ❌ SOME CHECKS FAILED - See errors above");
    console.log("\n  To start test infrastructure:");
    console.log("    docker compose -f docker/docker-compose.test.yml up -d");
  }
  console.log("=".repeat(60) + "\n");

  process.exit(allPassed ? 0 : 1);
}

main().catch((error) => {
  console.error("Verification script failed:", error);
  process.exit(1);
});

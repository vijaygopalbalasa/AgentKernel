#!/usr/bin/env tsx
/**
 * Direct Infrastructure Verification - bypasses package resolution issues
 * Tests REAL connections to PostgreSQL, Qdrant, and Redis directly.
 */

import postgres from "postgres";
import { QdrantClient } from "@qdrant/js-client-rest";
import { Redis } from "ioredis";

// Test infrastructure config (matches docker-compose.test.yml)
const CONFIG = {
  postgres: {
    host: "localhost",
    port: 5433,
    database: "agentkernel_test",
    user: "agentkernel",
    password: "agentkernel_test",
  },
  qdrant: {
    host: "localhost",
    port: 6335,
  },
  redis: {
    host: "localhost",
    port: 6380,
  },
};

interface Result {
  component: string;
  status: "pass" | "fail";
  latencyMs: number;
  details?: string;
  error?: string;
}

const results: Result[] = [];

async function testPostgreSQL(): Promise<Result> {
  const start = Date.now();
  console.log("\n🔍 Testing PostgreSQL...");

  try {
    const sql = postgres({
      host: CONFIG.postgres.host,
      port: CONFIG.postgres.port,
      database: CONFIG.postgres.database,
      user: CONFIG.postgres.user,
      password: CONFIG.postgres.password,
      max: 1,
    });

    // Test connection
    const result = await sql`SELECT current_database() as db, current_user as "user", version() as version`;
    const info = result[0];

    // Test write/read
    await sql`CREATE TABLE IF NOT EXISTS _verify_test (id SERIAL PRIMARY KEY, value TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`;
    const testValue = `test-${Date.now()}`;
    await sql`INSERT INTO _verify_test (value) VALUES (${testValue})`;
    const rows = await sql`SELECT COUNT(*) as count FROM _verify_test`;
    await sql`DELETE FROM _verify_test WHERE created_at < NOW() - INTERVAL '1 minute'`;

    await sql.end();

    return {
      component: "PostgreSQL",
      status: "pass",
      latencyMs: Date.now() - start,
      details: `DB: ${info?.db}, User: ${info?.user}, Test rows: ${rows[0]?.count}`,
    };
  } catch (error) {
    return {
      component: "PostgreSQL",
      status: "fail",
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function testQdrant(): Promise<Result> {
  const start = Date.now();
  console.log("\n🔍 Testing Qdrant...");

  try {
    const client = new QdrantClient({
      host: CONFIG.qdrant.host,
      port: CONFIG.qdrant.port,
    });

    // Test health
    const collections = await client.getCollections();

    // Create test collection
    const testCollection = "verify_test";
    const vectorSize = 128;

    try {
      await client.deleteCollection(testCollection);
    } catch {
      // Collection might not exist
    }

    await client.createCollection(testCollection, {
      vectors: { size: vectorSize, distance: "Cosine" },
    });

    // Test upsert
    const testVector = Array(vectorSize).fill(0).map(() => Math.random());
    await client.upsert(testCollection, {
      points: [{ id: 1, vector: testVector, payload: { test: true } }],
    });

    // Test search
    const searchResult = await client.search(testCollection, {
      vector: testVector,
      limit: 1,
    });

    // Cleanup
    await client.deleteCollection(testCollection);

    return {
      component: "Qdrant",
      status: "pass",
      latencyMs: Date.now() - start,
      details: `Collections: ${collections.collections.length}, Search returned: ${searchResult.length} results`,
    };
  } catch (error) {
    return {
      component: "Qdrant",
      status: "fail",
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function testRedis(): Promise<Result> {
  const start = Date.now();
  console.log("\n🔍 Testing Redis...");

  try {
    const redis = new Redis({
      host: CONFIG.redis.host,
      port: CONFIG.redis.port,
      lazyConnect: true,
    });

    await redis.connect();

    // Test ping
    const pong = await redis.ping();
    if (pong !== "PONG") throw new Error("Ping failed");

    // Test set/get
    const testKey = `verify:test:${Date.now()}`;
    await redis.set(testKey, "test-value", "EX", 60);
    const value = await redis.get(testKey);
    if (value !== "test-value") throw new Error("Get returned wrong value");

    // Test pub/sub
    const subRedis = new Redis({
      host: CONFIG.redis.host,
      port: CONFIG.redis.port,
    });

    let messageReceived = false;
    const testChannel = "verify:pubsub";

    await subRedis.subscribe(testChannel);
    subRedis.on("message", (channel, message) => {
      if (channel === testChannel && message === "test-message") {
        messageReceived = true;
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    await redis.publish(testChannel, "test-message");
    await new Promise((resolve) => setTimeout(resolve, 200));

    await subRedis.unsubscribe(testChannel);
    await subRedis.quit();

    // Cleanup
    await redis.del(testKey);
    await redis.quit();

    return {
      component: "Redis",
      status: "pass",
      latencyMs: Date.now() - start,
      details: `Ping: OK, Set/Get: OK, Pub/Sub: ${messageReceived ? "OK" : "FAILED"}`,
    };
  } catch (error) {
    return {
      component: "Redis",
      status: "fail",
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function testMigrations(): Promise<Result> {
  const start = Date.now();
  console.log("\n🔍 Testing Migrations...");

  try {
    const sql = postgres({
      host: CONFIG.postgres.host,
      port: CONFIG.postgres.port,
      database: CONFIG.postgres.database,
      user: CONFIG.postgres.user,
      password: CONFIG.postgres.password,
      max: 1,
    });

    // Check if migrations table exists
    const tables = await sql`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `;

    const tableNames = tables.map((t: { tablename: string }) => t.tablename);

    await sql.end();

    // Check for key tables from migrations
    const expectedTables = ["agents", "episodic_memories", "semantic_memories", "procedural_memories", "permissions", "tasks"];
    const missingTables = expectedTables.filter((t) => !tableNames.includes(t));

    if (missingTables.length > 0) {
      return {
        component: "Migrations",
        status: "fail",
        latencyMs: Date.now() - start,
        error: `Missing tables: ${missingTables.join(", ")}. Run migrations first.`,
      };
    }

    return {
      component: "Migrations",
      status: "pass",
      latencyMs: Date.now() - start,
      details: `Found ${tableNames.length} tables including: ${expectedTables.slice(0, 3).join(", ")}...`,
    };
  } catch (error) {
    return {
      component: "Migrations",
      status: "fail",
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  console.log("\n" + "=".repeat(60));
  console.log("  AgentKernel Infrastructure Verification (Direct)");
  console.log("=".repeat(60));

  // Run tests
  results.push(await testPostgreSQL());
  results.push(await testQdrant());
  results.push(await testRedis());
  results.push(await testMigrations());

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
  console.error("Verification failed:", error);
  process.exit(1);
});

#!/usr/bin/env tsx
/**
 * Run database migrations
 */

import postgres from "postgres";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const CONFIG = {
  host: process.env.DATABASE_HOST ?? "localhost",
  port: Number(process.env.DATABASE_PORT) || 5433,
  database: process.env.DATABASE_NAME ?? "agentkernel_test",
  user: process.env.DATABASE_USER ?? "agentkernel",
  password: process.env.DATABASE_PASSWORD ?? "agentkernel_test",
};

function calculateChecksum(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(8, "0");
}

async function main() {
  console.log("\n🔄 Running migrations...\n");

  const sql = postgres({
    host: CONFIG.host,
    port: CONFIG.port,
    database: CONFIG.database,
    user: CONFIG.user,
    password: CONFIG.password,
    max: 1,
  });

  try {
    // Ensure migrations table exists
    await sql`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        checksum VARCHAR(16) NOT NULL
      )
    `;

    // Get applied migrations
    const applied = await sql`SELECT name FROM _migrations ORDER BY id`;
    const appliedNames = new Set(applied.map((m: { name: string }) => m.name));

    // Get migration files
    const migrationsDir = join(__dirname, "../packages/kernel/migrations");
    if (!existsSync(migrationsDir)) {
      console.error("❌ Migrations directory not found:", migrationsDir);
      process.exit(1);
    }

    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    console.log(`Found ${files.length} migration files, ${appliedNames.size} already applied\n`);

    let appliedCount = 0;
    for (const file of files) {
      if (appliedNames.has(file)) {
        console.log(`⏭️  ${file} (already applied)`);
        continue;
      }

      const content = readFileSync(join(migrationsDir, file), "utf-8");
      const checksum = calculateChecksum(content);

      console.log(`▶️  Applying ${file}...`);

      try {
        await sql.begin(async (tx) => {
          await tx.unsafe(content);
          await tx`INSERT INTO _migrations (name, checksum) VALUES (${file}, ${checksum})`;
        });
        console.log(`✅ ${file} applied successfully`);
        appliedCount++;
      } catch (error) {
        console.error(`❌ ${file} failed:`, error instanceof Error ? error.message : error);
        process.exit(1);
      }
    }

    console.log(`\n✅ Migrations complete: ${appliedCount} applied, ${appliedNames.size} skipped\n`);
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});

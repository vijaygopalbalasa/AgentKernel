// PostgreSQL connection pool with migrations support
// Uses postgres.js for high-performance connection pooling

import postgres from "postgres";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseConfig } from "./config.js";
import type { Logger } from "./logger.js";

/** Re-export postgres types for consumers */
export type Sql = ReturnType<typeof postgres>;

/** Database connection pool */
export interface Database {
  /** Execute a raw SQL query */
  query<T extends object>(queryFn: (sql: Sql) => Promise<T[]>): Promise<T[]>;

  /** Execute a query and return first row */
  queryOne<T extends object>(queryFn: (sql: Sql) => Promise<T[]>): Promise<T | null>;

  /** Execute multiple statements in a transaction */
  transaction<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;

  /** Check if database is connected */
  isConnected(): Promise<boolean>;

  /** Get connection pool stats */
  getStats(): PoolStats;

  /** Close all connections */
  close(): Promise<void>;

  /** Resolves when initial connection is verified (rejects if connection fails) */
  connectionReady: Promise<void>;

  /** Run pending migrations */
  migrate(migrationsDir: string): Promise<MigrationResult>;

  /** Get the raw sql instance for advanced queries */
  sql: Sql;
}

/** Connection pool statistics */
export interface PoolStats {
  /** Total connections in pool */
  total: number;
  /** Idle connections */
  idle: number;
  /** Active connections */
  active: number;
  /** Pending connection requests */
  pending: number;
}

/** Result of running migrations */
export interface MigrationResult {
  /** Number of migrations applied */
  applied: number;
  /** List of applied migration names */
  migrations: string[];
  /** Any errors encountered */
  errors: MigrationError[];
}

/** Migration error */
export interface MigrationError {
  migration: string;
  error: string;
}

/** Migration record in database */
interface MigrationRecord {
  id: number;
  name: string;
  applied_at: Date;
  checksum: string;
}

/** Calculate checksum for migration content */
function calculateChecksum(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16).padStart(8, "0");
}

/** Create a database connection pool */
export function createDatabase(config: DatabaseConfig, logger?: Logger): Database {
  const log = logger ?? {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  const connectionString = config.password
    ? `postgres://${config.user}:${config.password}@${config.host}:${config.port}/${config.database}`
    : `postgres://${config.user}@${config.host}:${config.port}/${config.database}`;

  const sql = postgres(connectionString, {
    max: config.maxConnections,
    idle_timeout: Math.floor(config.idleTimeout / 1000), // Convert ms to seconds
    connect_timeout: 10,
    ssl: config.ssl ? "require" : false,
    onnotice: (notice) => {
      log.debug("PostgreSQL notice", { notice: notice.message });
    },
    onparameter: (key, value) => {
      log.debug("PostgreSQL parameter", { key, value });
    },
  });

  // Track connection stats
  let activeConnections = 0;
  let totalConnections = 0;

  const db: Database = {
    async query<T extends object>(queryFn: (sql: Sql) => Promise<T[]>): Promise<T[]> {
      activeConnections++;
      try {
        const result = await queryFn(sql);
        return result;
      } finally {
        activeConnections--;
      }
    },

    async queryOne<T extends object>(queryFn: (sql: Sql) => Promise<T[]>): Promise<T | null> {
      const rows = await db.query(queryFn);
      return (rows[0] as T | undefined) ?? null;
    },

    async transaction<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
      activeConnections++;
      try {
        const result = await sql.begin(async (tx) => {
          return await fn(tx as unknown as Sql);
        });
        return result as T;
      } finally {
        activeConnections--;
      }
    },

    async isConnected(): Promise<boolean> {
      try {
        await sql`SELECT 1`;
        return true;
      } catch {
        return false;
      }
    },

    getStats(): PoolStats {
      // postgres.js doesn't expose pool stats directly,
      // so we track what we can
      return {
        total: totalConnections,
        idle: Math.max(0, totalConnections - activeConnections),
        active: activeConnections,
        pending: 0, // Not tracked by postgres.js
      };
    },

    async close(): Promise<void> {
      log.info("Closing database connections");
      await sql.end({ timeout: 5 });
      log.info("Database connections closed");
    },

    connectionReady: Promise.resolve(),

    async migrate(migrationsDir: string): Promise<MigrationResult> {
      const result: MigrationResult = {
        applied: 0,
        migrations: [],
        errors: [],
      };

      if (!existsSync(migrationsDir)) {
        log.warn("Migrations directory not found", { path: migrationsDir });
        return result;
      }

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
      const applied = await sql<MigrationRecord[]>`
        SELECT * FROM _migrations ORDER BY id
      `;
      const appliedNames = new Set(applied.map((m) => m.name));

      // Get migration files
      const files = readdirSync(migrationsDir)
        .filter((f) => f.endsWith(".sql"))
        .sort();

      for (const file of files) {
        if (appliedNames.has(file)) {
          // Verify checksum
          const content = readFileSync(join(migrationsDir, file), "utf-8");
          const checksum = calculateChecksum(content);
          const existing = applied.find((m) => m.name === file);

          if (existing && existing.checksum !== checksum) {
            result.errors.push({
              migration: file,
              error: `Checksum mismatch: migration was modified after being applied`,
            });
          }
          continue;
        }

        // Apply migration
        const content = readFileSync(join(migrationsDir, file), "utf-8");
        const checksum = calculateChecksum(content);

        try {
          log.info("Applying migration", { name: file });

          await sql.begin(async (tx) => {
            // Execute migration SQL
            await tx.unsafe(content);

            // Record migration using parameterized unsafe query
            await tx.unsafe(
              `INSERT INTO _migrations (name, checksum) VALUES ($1, $2)`,
              [file, checksum]
            );
          });

          result.applied++;
          result.migrations.push(file);
          log.info("Migration applied", { name: file });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          log.error("Migration failed", { name: file, error: errorMessage });
          result.errors.push({
            migration: file,
            error: errorMessage,
          });
          // Stop on first error
          break;
        }
      }

      return result;
    },

    sql,
  };

  // Verify connection on creation — callers can await db.connectionReady
  db.connectionReady = sql`SELECT 1`.then(() => {
    totalConnections = 1;
    log.info("Database connected", {
      host: config.host,
      port: config.port,
      database: config.database,
    });
  }).catch((error) => {
    log.error("Database connection failed", { error: String(error) });
    // Swallow the rejection to avoid unhandled rejection crashes
    // Callers should await connectionReady and handle failures via isConnected()
  });

  return db;
}

/** Database health check */
export async function checkDatabaseHealth(db: Database): Promise<{
  healthy: boolean;
  latencyMs: number;
  error?: string;
}> {
  const start = Date.now();
  try {
    await db.isConnected();
    return {
      healthy: true,
      latencyMs: Date.now() - start,
    };
  } catch (error) {
    return {
      healthy: false,
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Wait for database to be ready (with retries) */
export async function waitForDatabase(
  db: Database,
  options: {
    maxRetries?: number;
    retryDelayMs?: number;
    logger?: Logger;
  } = {}
): Promise<boolean> {
  const { maxRetries = 30, retryDelayMs = 1000, logger } = options;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const connected = await db.isConnected();
    if (connected) {
      logger?.info("Database ready", { attempt });
      return true;
    }

    logger?.debug("Waiting for database", { attempt, maxRetries });
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }

  logger?.error("Database not ready after max retries", { maxRetries });
  return false;
}

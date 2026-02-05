// PostgreSQL Audit Writer — Connects DatabaseAuditSink to kernel's Database
// This bridges the runtime audit system with persistent PostgreSQL storage

import type { Database, Sql } from "@agentkernel/kernel";
import {
  type AuditLogger,
  type CreateAuditLoggerOptions,
  type DatabaseAuditRecord,
  type DatabaseAuditWriter,
  createAuditLogger,
} from "./audit.js";

// ─── TYPES ─────────────────────────────────────────────────────────────────

/** Options for creating a database audit writer */
export interface DatabaseAuditWriterOptions {
  /** Table name for audit logs (default: "audit_log") */
  tableName?: string;
  /** Whether to use transactions for batch inserts (default: true) */
  useTransaction?: boolean;
}

/** Options for creating an audit logger with database support */
export interface AuditLoggerWithDatabaseOptions
  extends Omit<CreateAuditLoggerOptions, "databaseWriter"> {
  /** Database connection */
  database: Database;
  /** Database writer options */
  dbWriterOptions?: DatabaseAuditWriterOptions;
}

/** Result of a batch audit write operation */
export interface AuditWriteResult {
  /** Number of records written */
  count: number;
  /** Whether the write was successful */
  success: boolean;
  /** Error message if write failed */
  error?: string;
}

// ─── WRITER IMPLEMENTATION ─────────────────────────────────────────────────

/**
 * Create a database audit writer function that inserts records into PostgreSQL.
 *
 * @param db - Database connection from @agentkernel/kernel
 * @param options - Writer configuration options
 * @returns DatabaseAuditWriter function for use with DatabaseAuditSink
 *
 * @example
 * ```typescript
 * const db = await createDatabase(config);
 * const writer = createDatabaseAuditWriter(db);
 * const sink = new DatabaseAuditSink(writer);
 * ```
 */
export function createDatabaseAuditWriter(
  db: Database,
  options: DatabaseAuditWriterOptions = {},
): DatabaseAuditWriter {
  const tableName = options.tableName ?? "audit_log";
  const useTransaction = options.useTransaction ?? true;

  return async (records: DatabaseAuditRecord[]): Promise<void> => {
    if (records.length === 0) return;

    const writeRecords = async (sql: Sql): Promise<void> => {
      // Build values array for batch insert
      const values = records.map((record) => ({
        action: record.action,
        resource_type: record.resource_type,
        resource_id: record.resource_id,
        actor_id: record.actor_id,
        details: record.details,
        outcome: record.outcome,
      }));

      // Use postgres.js tagged template for safe batch insert
      // The sql() helper handles proper escaping and parameterization
      await sql`
        INSERT INTO ${sql(tableName)} (
          action,
          resource_type,
          resource_id,
          actor_id,
          details,
          outcome
        )
        SELECT
          action,
          resource_type,
          resource_id,
          actor_id,
          details::jsonb,
          outcome
        FROM json_to_recordset(${JSON.stringify(values)}::json) AS t(
          action text,
          resource_type text,
          resource_id text,
          actor_id text,
          details jsonb,
          outcome text
        )
      `;
    };

    if (useTransaction) {
      await db.transaction(writeRecords);
    } else {
      await db.query(async (sql) => {
        await writeRecords(sql);
        return [];
      });
    }
  };
}

/**
 * Create a database audit writer with result tracking.
 * Unlike the basic writer, this returns information about the write operation.
 *
 * @param db - Database connection
 * @param options - Writer configuration options
 * @returns Function that writes records and returns result info
 */
export function createDatabaseAuditWriterWithResult(
  db: Database,
  options: DatabaseAuditWriterOptions = {},
): (records: DatabaseAuditRecord[]) => Promise<AuditWriteResult> {
  const writer = createDatabaseAuditWriter(db, options);

  return async (records: DatabaseAuditRecord[]): Promise<AuditWriteResult> => {
    if (records.length === 0) {
      return { count: 0, success: true };
    }

    try {
      await writer(records);
      return { count: records.length, success: true };
    } catch (error) {
      return {
        count: 0,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

// ─── AUDIT LOGGER FACTORY ──────────────────────────────────────────────────

/**
 * Create an audit logger configured with PostgreSQL database persistence.
 *
 * This is the primary way to create a production-ready audit logger that
 * writes events to the database while optionally also logging to console/file.
 *
 * @param options - Configuration options including database connection
 * @returns Configured AuditLogger instance
 *
 * @example
 * ```typescript
 * const db = await createDatabase(config);
 * const auditLogger = createAuditLoggerWithDatabase({
 *   database: db,
 *   includeConsole: true,  // Also log to console
 *   databaseFlushIntervalMs: 5000,
 *   databaseBufferSize: 100,
 * });
 *
 * // Log events
 * auditLogger.tool(agentId, { toolName: "read", action: "invoke" });
 *
 * // Graceful shutdown
 * await auditLogger.close();
 * ```
 */
export function createAuditLoggerWithDatabase(
  options: AuditLoggerWithDatabaseOptions,
): AuditLogger {
  const { database, dbWriterOptions, ...baseOptions } = options;

  // Create the database writer
  const writer = createDatabaseAuditWriter(database, dbWriterOptions);

  // Create the audit logger with the database writer
  return createAuditLogger({
    ...baseOptions,
    databaseWriter: writer,
  });
}

// ─── QUERY HELPERS ─────────────────────────────────────────────────────────

/** Query options for fetching audit logs */
export interface AuditQueryOptions {
  /** Filter by action (e.g., "tool.invoke", "permission.check") */
  action?: string;
  /** Filter by outcome (e.g., "success", "blocked", "denied") */
  outcome?: string;
  /** Filter by resource type (e.g., "tool", "permission") */
  resourceType?: string;
  /** Filter by agent ID */
  agentId?: string;
  /** Filter events after this date */
  since?: Date;
  /** Filter events before this date */
  until?: Date;
  /** Maximum number of records to return (default: 100) */
  limit?: number;
  /** Offset for pagination (default: 0) */
  offset?: number;
  /** Order by (default: "created_at DESC") */
  orderBy?: "created_at ASC" | "created_at DESC";
}

/** Audit log record from database */
export interface AuditLogRecord {
  id: string;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  actor_id: string | null;
  details: Record<string, unknown>;
  outcome: string;
  created_at: Date;
}

/**
 * Query audit logs from the database.
 *
 * @param db - Database connection
 * @param options - Query filters and pagination
 * @returns Array of audit log records
 *
 * @example
 * ```typescript
 * const logs = await queryAuditLogs(db, {
 *   outcome: "blocked",
 *   since: new Date(Date.now() - 24 * 60 * 60 * 1000), // Last 24 hours
 *   limit: 50,
 * });
 * ```
 */
export async function queryAuditLogs(
  db: Database,
  options: AuditQueryOptions = {},
): Promise<AuditLogRecord[]> {
  const {
    action,
    outcome,
    resourceType,
    agentId,
    since,
    until,
    limit = 100,
    offset = 0,
    orderBy = "created_at DESC",
  } = options;

  return await db.query(async (sql) => {
    // Build WHERE conditions dynamically
    const conditions: ReturnType<typeof sql>[] = [];

    if (action) {
      conditions.push(sql`action = ${action}`);
    }
    if (outcome) {
      conditions.push(sql`outcome = ${outcome}`);
    }
    if (resourceType) {
      conditions.push(sql`resource_type = ${resourceType}`);
    }
    if (agentId) {
      conditions.push(sql`actor_id = ${agentId}`);
    }
    if (since) {
      conditions.push(sql`created_at >= ${since}`);
    }
    if (until) {
      conditions.push(sql`created_at <= ${until}`);
    }

    // Combine conditions with AND
    const whereClause =
      conditions.length > 0
        ? sql`WHERE ${conditions.reduce((acc, cond, i) => (i === 0 ? cond : sql`${acc} AND ${cond}`))}`
        : sql``;

    // Order direction
    const orderClause =
      orderBy === "created_at ASC" ? sql`ORDER BY created_at ASC` : sql`ORDER BY created_at DESC`;

    const rows = await sql<AuditLogRecord[]>`
      SELECT
        id,
        action,
        resource_type,
        resource_id,
        actor_id,
        details,
        outcome,
        created_at
      FROM audit_log
      ${whereClause}
      ${orderClause}
      LIMIT ${limit}
      OFFSET ${offset}
    `;

    return rows;
  });
}

/** Audit statistics result */
export interface AuditStats {
  total: number;
  byOutcome: Record<string, number>;
  byAction: Record<string, number>;
  byResourceType: Record<string, number>;
}

/**
 * Get audit log statistics.
 *
 * @param db - Database connection
 * @param options - Time range and filters
 * @returns Statistics about audit events
 */
export async function getAuditStats(
  db: Database,
  options: { since?: Date; until?: Date; agentId?: string } = {},
): Promise<AuditStats> {
  const { since, until, agentId } = options;

  // Build WHERE conditions
  const buildWhereClause = (sql: Sql): ReturnType<typeof sql> => {
    const conditions: ReturnType<typeof sql>[] = [];

    if (since) {
      conditions.push(sql`created_at >= ${since}`);
    }
    if (until) {
      conditions.push(sql`created_at <= ${until}`);
    }
    if (agentId) {
      conditions.push(sql`actor_id = ${agentId}`);
    }

    return conditions.length > 0
      ? sql`WHERE ${conditions.reduce((acc, cond, i) => (i === 0 ? cond : sql`${acc} AND ${cond}`))}`
      : sql``;
  };

  // Get total count
  const totalResult = await db.query(async (sql) => {
    const whereClause = buildWhereClause(sql);
    return await sql<[{ count: number }]>`
      SELECT COUNT(*)::int as count FROM audit_log ${whereClause}
    `;
  });
  const total = totalResult[0]?.count ?? 0;

  // Get counts by outcome
  const outcomeRows = await db.query(async (sql) => {
    const whereClause = buildWhereClause(sql);
    return await sql<{ outcome: string; count: number }[]>`
      SELECT outcome, COUNT(*)::int as count
      FROM audit_log ${whereClause}
      GROUP BY outcome
    `;
  });
  const byOutcome: Record<string, number> = {};
  for (const row of outcomeRows) {
    byOutcome[row.outcome] = row.count;
  }

  // Get counts by action (top 20)
  const actionRows = await db.query(async (sql) => {
    const whereClause = buildWhereClause(sql);
    return await sql<{ action: string; count: number }[]>`
      SELECT action, COUNT(*)::int as count
      FROM audit_log ${whereClause}
      GROUP BY action
      ORDER BY count DESC
      LIMIT 20
    `;
  });
  const byAction: Record<string, number> = {};
  for (const row of actionRows) {
    byAction[row.action] = row.count;
  }

  // Get counts by resource type
  const resourceRows = await db.query(async (sql) => {
    const whereClause = buildWhereClause(sql);
    return await sql<{ resource_type: string | null; count: number }[]>`
      SELECT resource_type, COUNT(*)::int as count
      FROM audit_log ${whereClause}
      GROUP BY resource_type
    `;
  });
  const byResourceType: Record<string, number> = {};
  for (const row of resourceRows) {
    const key = row.resource_type ?? "null";
    byResourceType[key] = row.count;
  }

  return { total, byOutcome, byAction, byResourceType };
}

import type { Database, Sql } from "@agentkernel/kernel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseAuditRecord } from "../audit.js";
import {
  type AuditLoggerWithDatabaseOptions,
  type DatabaseAuditWriterOptions,
  createAuditLoggerWithDatabase,
  createDatabaseAuditWriter,
  createDatabaseAuditWriterWithResult,
  getAuditStats,
  queryAuditLogs,
} from "../db-audit-writer.js";

// ─── MOCK DATABASE ─────────────────────────────────────────────────────────

function createMockDatabase(): Database & {
  mockQuery: ReturnType<typeof vi.fn>;
  mockTransaction: ReturnType<typeof vi.fn>;
  lastQueryFn: ((sql: Sql) => Promise<unknown[]>) | null;
  lastTransactionFn: ((sql: Sql) => Promise<unknown>) | null;
} {
  let lastQueryFn: ((sql: Sql) => Promise<unknown[]>) | null = null;
  let lastTransactionFn: ((sql: Sql) => Promise<unknown>) | null = null;

  const mockSql = vi.fn(() => Promise.resolve([])) as unknown as Sql;

  const mockQuery = vi.fn(async (queryFn: (sql: Sql) => Promise<unknown[]>) => {
    lastQueryFn = queryFn;
    return queryFn(mockSql);
  });

  const mockTransaction = vi.fn(async (fn: (sql: Sql) => Promise<unknown>) => {
    lastTransactionFn = fn;
    return fn(mockSql);
  });

  return {
    query: mockQuery,
    queryOne: vi.fn(),
    transaction: mockTransaction,
    isConnected: vi.fn().mockResolvedValue(true),
    getStats: vi.fn().mockReturnValue({ total: 1, idle: 1, active: 0, pending: 0 }),
    close: vi.fn().mockResolvedValue(undefined),
    connectionReady: Promise.resolve(),
    migrate: vi.fn().mockResolvedValue({ applied: 0, migrations: [], errors: [] }),
    sql: mockSql,
    mockQuery,
    mockTransaction,
    get lastQueryFn() {
      return lastQueryFn;
    },
    get lastTransactionFn() {
      return lastTransactionFn;
    },
  };
}

// ─── TEST DATA ─────────────────────────────────────────────────────────────

const sampleRecords: DatabaseAuditRecord[] = [
  {
    action: "tool.invoke",
    resource_type: "tool",
    resource_id: "file_read",
    actor_id: "agent-1",
    details: { path: "/workspace/app.ts" },
    outcome: "success",
  },
  {
    action: "permission.check",
    resource_type: "permission",
    resource_id: "shell:execute",
    actor_id: null,
    details: { command: "git status" },
    outcome: "denied",
  },
  {
    action: "security.block",
    resource_type: null,
    resource_id: null,
    actor_id: "agent-1",
    details: { reason: "Blocked SSH key access" },
    outcome: "blocked",
  },
];

// ─── TESTS ─────────────────────────────────────────────────────────────────

describe("createDatabaseAuditWriter", () => {
  let db: ReturnType<typeof createMockDatabase>;

  beforeEach(() => {
    db = createMockDatabase();
  });

  it("should create a writer function", () => {
    const writer = createDatabaseAuditWriter(db);
    expect(typeof writer).toBe("function");
  });

  it("should not write when records array is empty", async () => {
    const writer = createDatabaseAuditWriter(db);
    await writer([]);
    expect(db.mockTransaction).not.toHaveBeenCalled();
    expect(db.mockQuery).not.toHaveBeenCalled();
  });

  it("should use transaction by default", async () => {
    const writer = createDatabaseAuditWriter(db);
    await writer(sampleRecords);
    expect(db.mockTransaction).toHaveBeenCalledTimes(1);
    expect(db.mockQuery).not.toHaveBeenCalled();
  });

  it("should use query when useTransaction is false", async () => {
    const writer = createDatabaseAuditWriter(db, { useTransaction: false });
    await writer(sampleRecords);
    expect(db.mockQuery).toHaveBeenCalledTimes(1);
    expect(db.mockTransaction).not.toHaveBeenCalled();
  });

  it("should accept custom table name", async () => {
    const writer = createDatabaseAuditWriter(db, { tableName: "custom_audit" });
    await writer(sampleRecords);
    expect(db.mockTransaction).toHaveBeenCalledTimes(1);
  });

  it("should handle records with null values", async () => {
    const writer = createDatabaseAuditWriter(db);
    const recordsWithNulls: DatabaseAuditRecord[] = [
      {
        action: "test.action",
        resource_type: null,
        resource_id: null,
        actor_id: null,
        details: {},
        outcome: "success",
      },
    ];
    await expect(writer(recordsWithNulls)).resolves.not.toThrow();
  });

  it("should handle records with complex details", async () => {
    const writer = createDatabaseAuditWriter(db);
    const recordsWithComplexDetails: DatabaseAuditRecord[] = [
      {
        action: "test.complex",
        resource_type: "test",
        resource_id: "123",
        actor_id: null,
        details: {
          nested: { deep: { value: 42 } },
          array: [1, 2, 3],
          string: "test",
          boolean: true,
        },
        outcome: "success",
      },
    ];
    await expect(writer(recordsWithComplexDetails)).resolves.not.toThrow();
  });

  it("should batch multiple records in single insert", async () => {
    const writer = createDatabaseAuditWriter(db);
    await writer(sampleRecords);
    // Should only call transaction once for all records
    expect(db.mockTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("createDatabaseAuditWriterWithResult", () => {
  let db: ReturnType<typeof createMockDatabase>;

  beforeEach(() => {
    db = createMockDatabase();
  });

  it("should return success result for empty records", async () => {
    const writer = createDatabaseAuditWriterWithResult(db);
    const result = await writer([]);
    expect(result).toEqual({ count: 0, success: true });
  });

  it("should return count and success on successful write", async () => {
    const writer = createDatabaseAuditWriterWithResult(db);
    const result = await writer(sampleRecords);
    expect(result.count).toBe(3);
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("should return error on write failure", async () => {
    db.mockTransaction.mockRejectedValueOnce(new Error("Database connection failed"));
    const writer = createDatabaseAuditWriterWithResult(db);
    const result = await writer(sampleRecords);
    expect(result.count).toBe(0);
    expect(result.success).toBe(false);
    expect(result.error).toBe("Database connection failed");
  });

  it("should handle non-Error exceptions", async () => {
    db.mockTransaction.mockRejectedValueOnce("String error");
    const writer = createDatabaseAuditWriterWithResult(db);
    const result = await writer(sampleRecords);
    expect(result.success).toBe(false);
    expect(result.error).toBe("String error");
  });
});

describe("createAuditLoggerWithDatabase", () => {
  let db: ReturnType<typeof createMockDatabase>;

  beforeEach(() => {
    db = createMockDatabase();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should create an audit logger", () => {
    const logger = createAuditLoggerWithDatabase({ database: db });
    expect(logger).toBeDefined();
    expect(typeof logger.tool).toBe("function");
    expect(typeof logger.permission).toBe("function");
    expect(typeof logger.security).toBe("function");
  });

  it("should accept custom flush interval", () => {
    const logger = createAuditLoggerWithDatabase({
      database: db,
      databaseFlushIntervalMs: 10000,
    });
    expect(logger).toBeDefined();
  });

  it("should accept custom buffer size", () => {
    const logger = createAuditLoggerWithDatabase({
      database: db,
      databaseBufferSize: 50,
    });
    expect(logger).toBeDefined();
  });

  it("should accept log file option", () => {
    const logger = createAuditLoggerWithDatabase({
      database: db,
      logFile: "/tmp/audit.log",
    });
    expect(logger).toBeDefined();
  });

  it("should accept base options", () => {
    const logger = createAuditLoggerWithDatabase({
      database: db,
      includeConsole: false,
    });
    expect(logger).toBeDefined();
  });

  it("should accept db writer options", () => {
    const logger = createAuditLoggerWithDatabase({
      database: db,
      dbWriterOptions: {
        tableName: "custom_audit",
        useTransaction: false,
      },
    });
    expect(logger).toBeDefined();
  });

  it("should have close method", async () => {
    const logger = createAuditLoggerWithDatabase({ database: db });
    expect(typeof logger.close).toBe("function");
    // Close should work without errors
    await expect(logger.close()).resolves.not.toThrow();
  });
});

describe("queryAuditLogs", () => {
  let db: ReturnType<typeof createMockDatabase>;

  beforeEach(() => {
    db = createMockDatabase();
  });

  it("should query with default options", async () => {
    await queryAuditLogs(db);
    expect(db.mockQuery).toHaveBeenCalledTimes(1);
  });

  it("should apply action filter", async () => {
    await queryAuditLogs(db, { action: "tool.invoke" });
    expect(db.mockQuery).toHaveBeenCalledTimes(1);
  });

  it("should apply outcome filter", async () => {
    await queryAuditLogs(db, { outcome: "blocked" });
    expect(db.mockQuery).toHaveBeenCalledTimes(1);
  });

  it("should apply resource type filter", async () => {
    await queryAuditLogs(db, { resourceType: "tool" });
    expect(db.mockQuery).toHaveBeenCalledTimes(1);
  });

  it("should apply agent ID filter", async () => {
    await queryAuditLogs(db, { agentId: "agent-1" });
    expect(db.mockQuery).toHaveBeenCalledTimes(1);
  });

  it("should apply since filter", async () => {
    await queryAuditLogs(db, { since: new Date("2024-01-01") });
    expect(db.mockQuery).toHaveBeenCalledTimes(1);
  });

  it("should apply until filter", async () => {
    await queryAuditLogs(db, { until: new Date("2024-12-31") });
    expect(db.mockQuery).toHaveBeenCalledTimes(1);
  });

  it("should apply limit", async () => {
    await queryAuditLogs(db, { limit: 50 });
    expect(db.mockQuery).toHaveBeenCalledTimes(1);
  });

  it("should apply offset", async () => {
    await queryAuditLogs(db, { offset: 100 });
    expect(db.mockQuery).toHaveBeenCalledTimes(1);
  });

  it("should apply ascending order", async () => {
    await queryAuditLogs(db, { orderBy: "created_at ASC" });
    expect(db.mockQuery).toHaveBeenCalledTimes(1);
  });

  it("should combine multiple filters", async () => {
    await queryAuditLogs(db, {
      action: "tool.invoke",
      outcome: "success",
      resourceType: "tool",
      since: new Date("2024-01-01"),
      until: new Date("2024-12-31"),
      limit: 50,
      offset: 10,
    });
    expect(db.mockQuery).toHaveBeenCalledTimes(1);
  });
});

describe("getAuditStats", () => {
  let db: ReturnType<typeof createMockDatabase>;

  beforeEach(() => {
    // Create a more sophisticated mock that returns different results per query
    db = createMockDatabase();
    let queryCount = 0;
    db.mockQuery.mockImplementation(async (queryFn: (sql: Sql) => Promise<unknown[]>) => {
      queryCount++;
      const mockSql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = strings.join("?");
        // Return different mock data based on query pattern
        if (query.includes("COUNT(*)::int as count FROM audit_log")) {
          if (query.includes("GROUP BY outcome")) {
            return Promise.resolve([
              { outcome: "success", count: 100 },
              { outcome: "blocked", count: 25 },
              { outcome: "denied", count: 10 },
            ]);
          }
          if (query.includes("GROUP BY action")) {
            return Promise.resolve([
              { action: "tool.invoke", count: 80 },
              { action: "permission.check", count: 55 },
            ]);
          }
          if (query.includes("GROUP BY resource_type")) {
            return Promise.resolve([
              { resource_type: "tool", count: 80 },
              { resource_type: "permission", count: 55 },
              { resource_type: null, count: 10 },
            ]);
          }
          return Promise.resolve([{ count: 135 }]);
        }
        return Promise.resolve([]);
      }) as unknown as Sql;
      return queryFn(mockSql);
    });
  });

  it("should return stats with default options", async () => {
    const stats = await getAuditStats(db);
    expect(stats).toBeDefined();
    expect(typeof stats.total).toBe("number");
    expect(stats.byOutcome).toBeDefined();
    expect(stats.byAction).toBeDefined();
    expect(stats.byResourceType).toBeDefined();
  });

  it("should accept since filter", async () => {
    const stats = await getAuditStats(db, { since: new Date("2024-01-01") });
    expect(stats).toBeDefined();
  });

  it("should accept until filter", async () => {
    const stats = await getAuditStats(db, { until: new Date("2024-12-31") });
    expect(stats).toBeDefined();
  });

  it("should accept agentId filter", async () => {
    const stats = await getAuditStats(db, { agentId: "agent-1" });
    expect(stats).toBeDefined();
  });

  it("should combine all filters", async () => {
    const stats = await getAuditStats(db, {
      since: new Date("2024-01-01"),
      until: new Date("2024-12-31"),
      agentId: "agent-1",
    });
    expect(stats).toBeDefined();
  });
});

describe("Integration scenarios", () => {
  let db: ReturnType<typeof createMockDatabase>;

  beforeEach(() => {
    db = createMockDatabase();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should handle full audit logging workflow", async () => {
    // Create logger
    const logger = createAuditLoggerWithDatabase({
      database: db,
      databaseFlushIntervalMs: 1000,
      databaseBufferSize: 10,
    });

    // Log some events
    logger.tool("agent-1", {
      toolName: "file_read",
      action: "invoke",
      inputSummary: "/workspace/app.ts",
    });

    logger.permission("agent-1", {
      action: "check",
      capability: "filesystem.read",
      allowed: true,
    });

    logger.security("agent-1", {
      type: "policy_block",
      severity: "warning",
      details: "Blocked SSH key access",
      blocked: true,
    });

    // Advance time to trigger flush
    await vi.advanceTimersByTimeAsync(1100);

    // Close logger
    await logger.close();

    // Verify writes occurred
    expect(db.mockTransaction.mock.calls.length).toBeGreaterThan(0);
  });

  it("should handle writer errors gracefully", async () => {
    // Make transaction fail
    db.mockTransaction.mockRejectedValue(new Error("Connection lost"));

    const writer = createDatabaseAuditWriter(db);

    // Should throw but not crash
    await expect(writer(sampleRecords)).rejects.toThrow("Connection lost");
  });

  it("should support concurrent writes", async () => {
    const writer = createDatabaseAuditWriter(db);

    // Fire multiple writes concurrently
    const writes = [
      writer([sampleRecords[0]]),
      writer([sampleRecords[1]]),
      writer([sampleRecords[2]]),
    ];

    await Promise.all(writes);

    // All writes should complete
    expect(db.mockTransaction).toHaveBeenCalledTimes(3);
  });
});

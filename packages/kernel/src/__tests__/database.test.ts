import { describe, it, expect, vi } from "vitest";
import {
  createDatabase,
  checkDatabaseHealth,
  waitForDatabase,
  type Database,
  type PoolStats,
  type MigrationResult,
} from "../database.js";
import type { DatabaseConfig } from "../config.js";

// Note: These tests verify API contracts without requiring a real PostgreSQL connection.
// Integration tests with real database should be in a separate test suite.

describe("Database Module API Contracts", () => {
  const mockConfig: DatabaseConfig = {
    host: "localhost",
    port: 5432,
    database: "test_db",
    user: "test_user",
    password: "test_pass",
    maxConnections: 10,
    idleTimeout: 30000,
    ssl: false,
  };

  describe("createDatabase", () => {
    it("should return a Database object with all required methods", () => {
      // This will attempt a connection but we can still verify the interface
      const db = createDatabase(mockConfig);

      // Verify interface completeness
      expect(db).toHaveProperty("query");
      expect(db).toHaveProperty("queryOne");
      expect(db).toHaveProperty("transaction");
      expect(db).toHaveProperty("isConnected");
      expect(db).toHaveProperty("getStats");
      expect(db).toHaveProperty("close");
      expect(db).toHaveProperty("migrate");
      expect(db).toHaveProperty("sql");

      // Verify types are functions
      expect(typeof db.query).toBe("function");
      expect(typeof db.queryOne).toBe("function");
      expect(typeof db.transaction).toBe("function");
      expect(typeof db.isConnected).toBe("function");
      expect(typeof db.getStats).toBe("function");
      expect(typeof db.close).toBe("function");
      expect(typeof db.migrate).toBe("function");
    });

    it("should accept optional logger parameter", () => {
      const mockLogger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };

      // Should not throw
      expect(() => createDatabase(mockConfig, mockLogger as any)).not.toThrow();
    });
  });

  describe("Database.getStats", () => {
    it("should return PoolStats with all required fields", () => {
      const db = createDatabase(mockConfig);
      const stats = db.getStats();

      expect(stats).toHaveProperty("total");
      expect(stats).toHaveProperty("idle");
      expect(stats).toHaveProperty("active");
      expect(stats).toHaveProperty("pending");

      expect(typeof stats.total).toBe("number");
      expect(typeof stats.idle).toBe("number");
      expect(typeof stats.active).toBe("number");
      expect(typeof stats.pending).toBe("number");
    });

    it("should return non-negative values", () => {
      const db = createDatabase(mockConfig);
      const stats = db.getStats();

      expect(stats.total).toBeGreaterThanOrEqual(0);
      expect(stats.idle).toBeGreaterThanOrEqual(0);
      expect(stats.active).toBeGreaterThanOrEqual(0);
      expect(stats.pending).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Database.isConnected", () => {
    it("should return a Promise<boolean>", async () => {
      const db = createDatabase(mockConfig);

      // Will return false because no real database
      const result = await db.isConnected();
      expect(typeof result).toBe("boolean");
    });

    it("should return false when database is not available", async () => {
      const db = createDatabase({
        ...mockConfig,
        host: "nonexistent-host-12345",
      });

      const connected = await db.isConnected();
      expect(connected).toBe(false);
    });
  });

  describe("Database.migrate", () => {
    it("should handle non-existent migrations directory gracefully", async () => {
      const db = createDatabase(mockConfig);
      const mockLogger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };

      const dbWithLogger = createDatabase(mockConfig, mockLogger as any);
      const result = await dbWithLogger.migrate("/nonexistent/path/migrations");

      expect(result).toHaveProperty("applied");
      expect(result).toHaveProperty("migrations");
      expect(result).toHaveProperty("errors");
      expect(result.applied).toBe(0);
      expect(result.migrations).toEqual([]);
    });
  });

  describe("checkDatabaseHealth", () => {
    it("should return health status object", async () => {
      const db = createDatabase(mockConfig);
      const health = await checkDatabaseHealth(db);

      expect(health).toHaveProperty("healthy");
      expect(health).toHaveProperty("latencyMs");
      expect(typeof health.healthy).toBe("boolean");
      expect(typeof health.latencyMs).toBe("number");
    });

    it("should return boolean healthy status", async () => {
      const db = createDatabase({
        ...mockConfig,
        host: "nonexistent-host-12345",
      });

      const health = await checkDatabaseHealth(db);
      // Whether healthy or not depends on connection attempt
      expect(typeof health.healthy).toBe("boolean");
      expect(typeof health.latencyMs).toBe("number");
    });
  });

  describe("waitForDatabase", () => {
    it("should return false when database never connects", async () => {
      const db = createDatabase({
        ...mockConfig,
        host: "nonexistent-host-12345",
      });

      const result = await waitForDatabase(db, {
        maxRetries: 2,
        retryDelayMs: 10,
      });

      expect(result).toBe(false);
    });

    it("should accept logger option", async () => {
      const mockLogger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };

      const db = createDatabase(mockConfig);

      await waitForDatabase(db, {
        maxRetries: 1,
        retryDelayMs: 10,
        logger: mockLogger as any,
      });

      // Logger should have been called
      expect(mockLogger.debug).toHaveBeenCalled();
    });
  });
});

describe("MigrationResult type", () => {
  it("should have correct structure", () => {
    const result: MigrationResult = {
      applied: 0,
      migrations: [],
      errors: [],
    };

    expect(result.applied).toBe(0);
    expect(Array.isArray(result.migrations)).toBe(true);
    expect(Array.isArray(result.errors)).toBe(true);
  });

  it("should support error entries", () => {
    const result: MigrationResult = {
      applied: 0,
      migrations: [],
      errors: [
        { migration: "001_test.sql", error: "Syntax error" },
      ],
    };

    expect(result.errors[0]?.migration).toBe("001_test.sql");
    expect(result.errors[0]?.error).toBe("Syntax error");
  });
});

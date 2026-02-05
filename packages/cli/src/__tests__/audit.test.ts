import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock database must be defined at module level before vi.mock
const mockDatabase = {
  connectionReady: Promise.resolve(),
  close: vi.fn().mockResolvedValue(undefined),
};

vi.mock("@agentkernel/kernel", () => ({
  createDatabase: vi.fn(() => mockDatabase),
}));

vi.mock("@agentkernel/runtime", () => ({
  queryAuditLogs: vi.fn().mockResolvedValue([
    {
      id: "1",
      action: "tool.invoke",
      resource_type: "tool",
      resource_id: "file_read",
      actor_id: "agent-123",
      details: { path: "/workspace/app.ts" },
      outcome: "success",
      created_at: new Date("2024-01-15T10:30:00Z"),
    },
    {
      id: "2",
      action: "permission.check",
      resource_type: "permission",
      resource_id: "shell:execute",
      actor_id: null,
      details: { command: "rm -rf /" },
      outcome: "blocked",
      created_at: new Date("2024-01-15T10:31:00Z"),
    },
  ]),
  getAuditStats: vi.fn().mockResolvedValue({
    total: 100,
    byOutcome: { success: 80, blocked: 15, denied: 5 },
    byAction: { "tool.invoke": 60, "permission.check": 40 },
    byResourceType: { tool: 60, permission: 40 },
  }),
}));

import { createDatabase } from "@agentkernel/kernel";
import { getAuditStats, queryAuditLogs } from "@agentkernel/runtime";
import { type AuditOptions, queryAudit } from "../commands/audit.js";

describe("queryAudit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = "postgres://localhost/test";
  });

  afterEach(() => {
    Reflect.deleteProperty(process.env, "DATABASE_URL");
  });

  it("should throw error when DATABASE_URL is not set", async () => {
    Reflect.deleteProperty(process.env, "DATABASE_URL");
    const options: AuditOptions = {};

    await expect(queryAudit(options)).rejects.toThrow("DATABASE_URL is required");
  });

  it("should connect to database", async () => {
    const options: AuditOptions = {};
    await queryAudit(options);

    expect(createDatabase).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "localhost",
        database: "test",
      }),
    );
  });

  it("should use custom database URL from options", async () => {
    const options: AuditOptions = {
      databaseUrl: "postgres://custom:5432/db",
    };
    await queryAudit(options);

    expect(createDatabase).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "custom",
        port: 5432,
        database: "db",
      }),
    );
  });

  it("should return logs with default options", async () => {
    const options: AuditOptions = {};
    const result = await queryAudit(options);

    expect(result.logs).toBeDefined();
    expect(result.logs).toHaveLength(2);
    expect(result.stats).toBeUndefined();
  });

  it("should query with default limit of 100", async () => {
    const options: AuditOptions = {};
    await queryAudit(options);

    expect(queryAuditLogs).toHaveBeenCalledWith(
      mockDatabase,
      expect.objectContaining({
        limit: 100,
      }),
    );
  });

  it("should query with custom limit", async () => {
    const options: AuditOptions = { limit: 50 };
    await queryAudit(options);

    expect(queryAuditLogs).toHaveBeenCalledWith(
      mockDatabase,
      expect.objectContaining({
        limit: 50,
      }),
    );
  });

  it("should query with offset", async () => {
    const options: AuditOptions = { offset: 100 };
    await queryAudit(options);

    expect(queryAuditLogs).toHaveBeenCalledWith(
      mockDatabase,
      expect.objectContaining({
        offset: 100,
      }),
    );
  });

  it("should filter by action", async () => {
    const options: AuditOptions = { action: "tool.invoke" };
    await queryAudit(options);

    expect(queryAuditLogs).toHaveBeenCalledWith(
      mockDatabase,
      expect.objectContaining({
        action: "tool.invoke",
      }),
    );
  });

  it("should filter by outcome", async () => {
    const options: AuditOptions = { outcome: "blocked" };
    await queryAudit(options);

    expect(queryAuditLogs).toHaveBeenCalledWith(
      mockDatabase,
      expect.objectContaining({
        outcome: "blocked",
      }),
    );
  });

  it("should filter by resource type", async () => {
    const options: AuditOptions = { resourceType: "tool" };
    await queryAudit(options);

    expect(queryAuditLogs).toHaveBeenCalledWith(
      mockDatabase,
      expect.objectContaining({
        resourceType: "tool",
      }),
    );
  });

  it("should filter by agent ID", async () => {
    const options: AuditOptions = { agentId: "agent-123" };
    await queryAudit(options);

    expect(queryAuditLogs).toHaveBeenCalledWith(
      mockDatabase,
      expect.objectContaining({
        agentId: "agent-123",
      }),
    );
  });

  it("should filter by since date", async () => {
    const options: AuditOptions = { since: "2024-01-01" };
    await queryAudit(options);

    expect(queryAuditLogs).toHaveBeenCalledWith(
      mockDatabase,
      expect.objectContaining({
        since: new Date("2024-01-01"),
      }),
    );
  });

  it("should filter by until date", async () => {
    const options: AuditOptions = { until: "2024-12-31" };
    await queryAudit(options);

    expect(queryAuditLogs).toHaveBeenCalledWith(
      mockDatabase,
      expect.objectContaining({
        until: new Date("2024-12-31"),
      }),
    );
  });

  it("should combine multiple filters", async () => {
    const options: AuditOptions = {
      action: "tool.invoke",
      outcome: "success",
      limit: 50,
      since: "2024-01-01",
    };
    await queryAudit(options);

    expect(queryAuditLogs).toHaveBeenCalledWith(
      mockDatabase,
      expect.objectContaining({
        action: "tool.invoke",
        outcome: "success",
        limit: 50,
        since: new Date("2024-01-01"),
      }),
    );
  });

  it("should return stats when stats option is true", async () => {
    const options: AuditOptions = { stats: true };
    const result = await queryAudit(options);

    expect(result.stats).toBeDefined();
    expect(result.stats?.total).toBe(100);
    expect(result.logs).toBeUndefined();
  });

  it("should pass filters to stats query", async () => {
    const options: AuditOptions = {
      stats: true,
      since: "2024-01-01",
      until: "2024-12-31",
      agentId: "agent-123",
    };
    await queryAudit(options);

    expect(getAuditStats).toHaveBeenCalledWith(mockDatabase, {
      since: new Date("2024-01-01"),
      until: new Date("2024-12-31"),
      agentId: "agent-123",
    });
  });

  it("should close database connection after query", async () => {
    const options: AuditOptions = {};
    await queryAudit(options);

    expect(mockDatabase.close).toHaveBeenCalled();
  });

  it("should close database even on error", async () => {
    (queryAuditLogs as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Query failed"));
    const options: AuditOptions = {};

    await expect(queryAudit(options)).rejects.toThrow("Query failed");
    expect(mockDatabase.close).toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock kernel database
const mockDatabase = {
  connectionReady: Promise.resolve(),
  isConnected: vi.fn().mockResolvedValue(true),
  getStats: vi.fn().mockReturnValue({ total: 5, idle: 3, active: 1, pending: 1 }),
  close: vi.fn().mockResolvedValue(undefined),
};

vi.mock("@agentkernel/kernel", () => ({
  createDatabase: vi.fn(() => mockDatabase),
}));

import { createDatabase } from "@agentkernel/kernel";
import { type StatusOptions, checkStatus } from "../commands/status.js";

describe("checkStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDatabase.isConnected.mockResolvedValue(true);
  });

  afterEach(() => {
    Reflect.deleteProperty(process.env, "DATABASE_URL");
  });

  it("should return healthy status with no services when DATABASE_URL is not set", async () => {
    const options: StatusOptions = {};
    const result = await checkStatus(options);

    expect(result.overall).toBe("healthy");
    expect(result.services).toHaveLength(0);
    expect(result.timestamp).toBeDefined();
  });

  it("should check PostgreSQL when DATABASE_URL is set", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    const options: StatusOptions = {};
    const result = await checkStatus(options);

    expect(createDatabase).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "localhost",
        database: "test",
      }),
    );
    expect(result.services).toHaveLength(1);
    expect(result.services[0].service).toBe("postgresql");
  });

  it("should return healthy when database is connected", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    mockDatabase.isConnected.mockResolvedValue(true);

    const options: StatusOptions = {};
    const result = await checkStatus(options);

    expect(result.overall).toBe("healthy");
    expect(result.services[0].status).toBe("healthy");
    expect(result.services[0].message).toBe("Connected");
    expect(result.services[0].latencyMs).toBeDefined();
  });

  it("should return unhealthy when database connection fails", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    mockDatabase.isConnected.mockResolvedValue(false);

    const options: StatusOptions = {};
    const result = await checkStatus(options);

    expect(result.overall).toBe("unhealthy");
    expect(result.services[0].status).toBe("unhealthy");
    expect(result.services[0].message).toBe("Connection test failed");
  });

  it("should return unhealthy when database throws error", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    mockDatabase.isConnected.mockRejectedValue(new Error("Connection refused"));

    const options: StatusOptions = {};
    const result = await checkStatus(options);

    expect(result.overall).toBe("unhealthy");
    expect(result.services[0].status).toBe("unhealthy");
    expect(result.services[0].message).toBe("Connection refused");
  });

  it("should use custom database URL from options", async () => {
    const options: StatusOptions = {
      databaseUrl: "postgres://custom:5432/db",
    };
    await checkStatus(options);

    expect(createDatabase).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "custom",
        port: 5432,
        database: "db",
      }),
    );
  });

  it("should options override environment variable", async () => {
    process.env.DATABASE_URL = "postgres://env/db";
    const options: StatusOptions = {
      databaseUrl: "postgres://options/db",
    };
    await checkStatus(options);

    expect(createDatabase).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "options",
        database: "db",
      }),
    );
  });

  it("should include connection pool stats in details", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    mockDatabase.isConnected.mockResolvedValue(true);

    const options: StatusOptions = {};
    const result = await checkStatus(options);

    expect(result.services[0].details).toEqual({
      total: 5,
      idle: 3,
      active: 1,
      pending: 1,
    });
  });

  it("should include latency in milliseconds", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    mockDatabase.isConnected.mockResolvedValue(true);

    const options: StatusOptions = {};
    const result = await checkStatus(options);

    expect(result.services[0].latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("should close database connection after check", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    await checkStatus({});

    expect(mockDatabase.close).toHaveBeenCalled();
  });

  it("should include ISO timestamp", async () => {
    const options: StatusOptions = {};
    const result = await checkStatus(options);

    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe("StatusResult types", () => {
  it("should have valid overall status values", async () => {
    const validStatuses = ["healthy", "degraded", "unhealthy"];
    const result = await checkStatus({});

    expect(validStatuses).toContain(result.overall);
  });

  it("should have valid service status values", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    mockDatabase.isConnected.mockResolvedValue(true);

    const validStatuses = ["healthy", "unhealthy", "unknown"];
    const result = await checkStatus({});

    for (const service of result.services) {
      expect(validStatuses).toContain(service.status);
    }

    Reflect.deleteProperty(process.env, "DATABASE_URL");
  });
});

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the external dependencies
vi.mock("@agentkernel/kernel", () => ({
  createDatabase: vi.fn(() => ({
    connectionReady: Promise.resolve(),
    isConnected: vi.fn().mockResolvedValue(true),
    getStats: vi.fn().mockReturnValue({ total: 1, idle: 1, active: 0, pending: 0 }),
    close: vi.fn().mockResolvedValue(undefined),
  })),
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    child: vi.fn(() => ({
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    })),
  })),
  onShutdown: vi.fn(),
}));

vi.mock("@agentkernel/runtime", () => ({
  loadPolicySetFromFile: vi.fn(() => ({
    name: "test-policy",
    defaultDecision: "block",
    fileRules: [],
  })),
  createAuditLoggerWithDatabase: vi.fn(() => ({
    tool: vi.fn(),
    permission: vi.fn(),
    security: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("@agentkernel/agent-kernel", () => ({
  createOpenClawProxy: vi.fn().mockResolvedValue({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  }),
  OpenClawSecurityProxy: vi.fn(),
}));

import { createDatabase, createLogger, onShutdown } from "@agentkernel/kernel";
import { createAuditLoggerWithDatabase, loadPolicySetFromFile } from "@agentkernel/runtime";
import { createOpenClawProxy } from "@agentkernel/agent-kernel";
import { type RunOptions, runProxy } from "../commands/run.js";

describe("runProxy", () => {
  let testDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    testDir = join(tmpdir(), `cli-run-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    // Allow localhost for tests (SSRF validation is ON by default now)
    process.env.AGENTKERNEL_SKIP_SSRF_VALIDATION = "true";
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    Reflect.deleteProperty(process.env, "DATABASE_URL");
    Reflect.deleteProperty(process.env, "OPENCLAW_GATEWAY_URL");
    Reflect.deleteProperty(process.env, "OPENCLAW_AGENT_ID");
    Reflect.deleteProperty(process.env, "AGENTKERNEL_SKIP_SSRF_VALIDATION");
  });

  it("should create logger with default settings", async () => {
    const options: RunOptions = {};
    const context = await runProxy(options);

    expect(createLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "agentkernel",
        level: "info",
        pretty: true,
      }),
    );
    expect(context.logger).toBeDefined();
  });

  it("should create logger with debug level when verbose", async () => {
    const options: RunOptions = { verbose: true };
    await runProxy(options);

    expect(createLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "debug",
      }),
    );
  });

  it("should create proxy with default port", async () => {
    const options: RunOptions = {};
    await runProxy(options);

    expect(createOpenClawProxy).toHaveBeenCalledWith(
      expect.objectContaining({
        listenPort: 18788,
      }),
    );
  });

  it("should create proxy with custom port", async () => {
    const options: RunOptions = { port: 8080 };
    await runProxy(options);

    expect(createOpenClawProxy).toHaveBeenCalledWith(
      expect.objectContaining({
        listenPort: 8080,
      }),
    );
  });

  it("should load policy from config file", async () => {
    const configPath = join(testDir, "policy.yaml");
    writeFileSync(configPath, "name: test\ndefaultDecision: allow\n");

    const options: RunOptions = { config: configPath };
    await runProxy(options);

    expect(loadPolicySetFromFile).toHaveBeenCalledWith(configPath);
    expect(createOpenClawProxy).toHaveBeenCalledWith(
      expect.objectContaining({
        policySet: expect.objectContaining({
          name: "test-policy",
        }),
      }),
    );
  });

  it("should throw error for missing config file", async () => {
    const options: RunOptions = { config: "/nonexistent/config.yaml" };

    await expect(runProxy(options)).rejects.toThrow("Config file not found");
  });

  it("should connect to database when audit-db is enabled", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    const options: RunOptions = { auditDb: true };

    const context = await runProxy(options);

    expect(createDatabase).toHaveBeenCalled();
    expect(createAuditLoggerWithDatabase).toHaveBeenCalled();
    expect(context.database).toBeDefined();
    expect(context.auditLogger).toBeDefined();
  });

  it("should not connect to database when audit-db is disabled", async () => {
    const options: RunOptions = {};
    const context = await runProxy(options);

    expect(context.database).toBeNull();
    expect(context.auditLogger).toBeNull();
  });

  it("should register shutdown handler", async () => {
    const options: RunOptions = {};
    await runProxy(options);

    expect(onShutdown).toHaveBeenCalledWith("agentkernel-proxy", expect.any(Function));
  });

  it("should return proxy in context", async () => {
    const options: RunOptions = {};
    const context = await runProxy(options);

    expect(context.proxy).toBeDefined();
    expect(createOpenClawProxy).toHaveBeenCalled();
  });

  it("should use custom gateway URL", async () => {
    const options: RunOptions = { gateway: "ws://custom:5555" };
    await runProxy(options);

    expect(createOpenClawProxy).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayUrl: "ws://custom:5555",
      }),
    );
  });

  it("should use custom agent ID", async () => {
    const options: RunOptions = { agentId: "my-custom-agent" };
    await runProxy(options);

    expect(createOpenClawProxy).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "my-custom-agent",
      }),
    );
  });

  it("should throw error when audit-db is enabled without DATABASE_URL", async () => {
    const options: RunOptions = { auditDb: true };

    await expect(runProxy(options)).rejects.toThrow(
      "DATABASE_URL environment variable is required",
    );
  });
});

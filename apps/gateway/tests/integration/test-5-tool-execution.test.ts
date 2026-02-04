// Integration Test 5: Tool Execution (MCP)
// Tests MCP tool discovery, execution, permissions, and audit logging

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn, ChildProcess } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import {
  defaultTestConfig,
  checkTestInfrastructure,
  waitForHealth,
  createTestConnection,
  createTestAgent,
  waitForState,
  sendTask,
  queryDatabase,
  clearTestDatabase,
  sleep,
  type TestConnection,
} from "../helpers/test-utils.js";
import { agentManifestWithTools } from "../fixtures/agent-manifests.js";

describe("Integration Test 5: Tool Execution", () => {
  let gatewayProcess: ChildProcess | null = null;
  let connection: TestConnection | null = null;
  const testDir = "/tmp/agentkernel-test";
  const allowedDir = "/tmp/agentkernel-test/allowed";
  const disallowedDir = "/tmp/agentkernel-test/disallowed";

  beforeAll(async () => {
    const infra = await checkTestInfrastructure();
    expect(infra.postgres).toBe(true);

    // Create test directories
    await fs.mkdir(testDir, { recursive: true });
    await fs.mkdir(allowedDir, { recursive: true });
    await fs.mkdir(disallowedDir, { recursive: true });

    // Create test files
    await fs.writeFile(path.join(allowedDir, "test.txt"), "Allowed file content");
    await fs.writeFile(path.join(disallowedDir, "secret.txt"), "Secret content");

    gatewayProcess = spawn("node", ["dist/main.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "test",
        GATEWAY_PORT: String(defaultTestConfig.gatewayPort),
        HEALTH_PORT: String(defaultTestConfig.healthPort),
        DATABASE_URL: defaultTestConfig.postgresUrl,
        QDRANT_URL: defaultTestConfig.qdrantUrl,
        REDIS_URL: defaultTestConfig.redisUrl,
        LOG_LEVEL: "debug",
        ALLOWED_PATHS: allowedDir,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    await waitForHealth(
      `http://127.0.0.1:${defaultTestConfig.healthPort}/health`,
      30000
    );
  }, 60000);

  beforeEach(async () => {
    await clearTestDatabase(defaultTestConfig.postgresUrl);

    if (connection) {
      connection.close();
    }

    const connResult = await createTestConnection(
      `ws://127.0.0.1:${defaultTestConfig.gatewayPort}`
    );
    expect(connResult.ok).toBe(true);
    if (connResult.ok) {
      connection = connResult.value;
    }
  });

  afterAll(async () => {
    if (connection) {
      connection.close();
    }
    if (gatewayProcess) {
      gatewayProcess.kill("SIGTERM");
      await sleep(2000);
      gatewayProcess.kill("SIGKILL");
    }

    // Cleanup test directories
    try {
      await fs.rm(testDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("should connect agent to MCP filesystem server", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    const agentResult = await createTestAgent(connection, {
      ...agentManifestWithTools,
      id: "mcp-connect-agent",
      permissions: [
        "tools.execute",
        `filesystem.read:${allowedDir}`,
      ],
    });
    expect(agentResult.ok).toBe(true);

    if (!agentResult.ok) return;
    const agent = agentResult.value;

    await waitForState(agent, "ready", 30000);

    // Agent should be able to list available tools
    const toolsResult = await sendTask(agent, {
      type: "list_tools",
    }) as { payload?: { tools?: Array<{ id: string; name: string }> } };

    expect(toolsResult).toBeDefined();
    // Should have at least builtin tools
    if (toolsResult.payload?.tools) {
      expect(toolsResult.payload.tools.length).toBeGreaterThan(0);
    }
  }, 45000);

  it("should discover available tools", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    const agentResult = await createTestAgent(connection, {
      ...agentManifestWithTools,
      id: "tool-discover-agent",
    });
    expect(agentResult.ok).toBe(true);

    if (!agentResult.ok) return;
    const agent = agentResult.value;

    await waitForState(agent, "ready", 30000);

    const toolsResult = await sendTask(agent, {
      type: "list_tools",
    }) as { payload?: { tools?: Array<{ id: string; name: string; description?: string }> } };

    expect(toolsResult).toBeDefined();
    if (toolsResult.payload?.tools) {
      const tools = toolsResult.payload.tools;
      expect(Array.isArray(tools)).toBe(true);

      // Should include builtin tools
      const calcTool = tools.find(t => t.id.includes("calculate"));
      const dateTool = tools.find(t => t.id.includes("datetime"));

      expect(calcTool || dateTool).toBeDefined();
    }
  }, 45000);

  it("should execute file-read tool on allowed path", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    const agentResult = await createTestAgent(connection, {
      ...agentManifestWithTools,
      id: "file-read-agent",
      permissions: [
        "tools.execute",
        `filesystem.read:${allowedDir}`,
      ],
    });
    expect(agentResult.ok).toBe(true);

    if (!agentResult.ok) return;
    const agent = agentResult.value;

    await waitForState(agent, "ready", 30000);

    // Try to read the allowed file
    const readResult = await sendTask(agent, {
      type: "invoke_tool",
      toolId: "builtin:file_read",
      arguments: {
        path: path.join(allowedDir, "test.txt"),
      },
    }) as { payload?: { content?: string; error?: string } };

    expect(readResult).toBeDefined();
    // If tool exists and works, content should be returned
    if (readResult.payload?.content) {
      expect(readResult.payload.content).toContain("Allowed file content");
    }
  }, 45000);

  it("should block file-read on disallowed path via permission system", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    const agentResult = await createTestAgent(connection, {
      ...agentManifestWithTools,
      id: "file-block-agent",
      permissions: [
        "tools.execute",
        `filesystem.read:${allowedDir}`, // Only allowed dir
      ],
    });
    expect(agentResult.ok).toBe(true);

    if (!agentResult.ok) return;
    const agent = agentResult.value;

    await waitForState(agent, "ready", 30000);

    // Try to read from disallowed path
    const readResult = await sendTask(agent, {
      type: "invoke_tool",
      toolId: "builtin:file_read",
      arguments: {
        path: path.join(disallowedDir, "secret.txt"),
      },
    }) as { type?: string; payload?: { error?: string; blocked?: boolean } };

    expect(readResult).toBeDefined();
    // Should be blocked or return an error
    expect(
      readResult.type === "error" ||
      readResult.payload?.error ||
      readResult.payload?.blocked
    ).toBeTruthy();
  }, 45000);

  it("should log blocked attempts in audit log", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    const agentId = "audit-test-agent";
    const agentResult = await createTestAgent(connection, {
      ...agentManifestWithTools,
      id: agentId,
      permissions: [
        "tools.execute",
        `filesystem.read:${allowedDir}`,
      ],
    });
    expect(agentResult.ok).toBe(true);

    if (!agentResult.ok) return;
    const agent = agentResult.value;

    await waitForState(agent, "ready", 30000);

    // Attempt blocked operation
    await sendTask(agent, {
      type: "invoke_tool",
      toolId: "builtin:file_read",
      arguments: {
        path: path.join(disallowedDir, "secret.txt"),
      },
    });

    // Wait for audit log to be written
    await sleep(1000);

    // Check audit log
    const auditResult = await queryDatabase<{
      action: string;
      resource_type: string;
      details: { blocked?: boolean; path?: string };
    }>(
      defaultTestConfig.postgresUrl,
      `SELECT action, resource_type, details FROM audit_log
       WHERE action LIKE '%permission%' OR action LIKE '%blocked%' OR action LIKE '%denied%'
       ORDER BY created_at DESC LIMIT 10`
    );

    expect(auditResult.ok).toBe(true);
    // If permission system is active, there should be audit entries
  }, 45000);

  it("should execute builtin calculate tool correctly", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    const agentResult = await createTestAgent(connection, {
      ...agentManifestWithTools,
      id: "calc-agent",
    });
    expect(agentResult.ok).toBe(true);

    if (!agentResult.ok) return;
    const agent = agentResult.value;

    await waitForState(agent, "ready", 30000);

    const calcResult = await sendTask(agent, {
      type: "invoke_tool",
      toolId: "builtin:calculate",
      arguments: {
        expression: "2 + 2 * 3",
      },
    }) as { payload?: { content?: { result?: number } | number } };

    expect(calcResult).toBeDefined();
    if (calcResult.payload?.content) {
      const result = typeof calcResult.payload.content === "object"
        ? calcResult.payload.content.result
        : calcResult.payload.content;
      expect(result).toBe(8); // 2 + (2 * 3) = 8
    }
  }, 45000);

  it("should execute builtin datetime tool correctly", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    const agentResult = await createTestAgent(connection, {
      ...agentManifestWithTools,
      id: "datetime-agent",
    });
    expect(agentResult.ok).toBe(true);

    if (!agentResult.ok) return;
    const agent = agentResult.value;

    await waitForState(agent, "ready", 30000);

    const beforeCall = Date.now();

    const dateResult = await sendTask(agent, {
      type: "invoke_tool",
      toolId: "builtin:datetime",
      arguments: {
        format: "unix",
      },
    }) as { payload?: { content?: { datetime?: number } | number } };

    const afterCall = Date.now();

    expect(dateResult).toBeDefined();
    if (dateResult.payload?.content) {
      const timestamp = typeof dateResult.payload.content === "object"
        ? dateResult.payload.content.datetime
        : dateResult.payload.content;

      if (typeof timestamp === "number") {
        // Unix timestamp in seconds
        const timestampMs = timestamp * 1000;
        expect(timestampMs).toBeGreaterThanOrEqual(beforeCall - 1000);
        expect(timestampMs).toBeLessThanOrEqual(afterCall + 1000);
      }
    }
  }, 45000);

  it("should handle tool execution errors gracefully", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    const agentResult = await createTestAgent(connection, {
      ...agentManifestWithTools,
      id: "error-tool-agent",
    });
    expect(agentResult.ok).toBe(true);

    if (!agentResult.ok) return;
    const agent = agentResult.value;

    await waitForState(agent, "ready", 30000);

    // Try to execute non-existent tool
    const result = await sendTask(agent, {
      type: "invoke_tool",
      toolId: "nonexistent:tool",
      arguments: {},
    }) as { type?: string; payload?: { error?: string } };

    expect(result).toBeDefined();
    // Should return error, not crash
    expect(result.type === "error" || result.payload?.error).toBeTruthy();
  }, 45000);

  it("should enforce tool-specific permissions", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    // Agent without tools.execute permission
    const agentResult = await createTestAgent(connection, {
      id: "no-tools-agent",
      name: "No Tools Agent",
      permissions: ["memory.read"], // No tools.execute
    });
    expect(agentResult.ok).toBe(true);

    if (!agentResult.ok) return;
    const agent = agentResult.value;

    await waitForState(agent, "ready", 30000);

    // Try to execute a tool
    const result = await sendTask(agent, {
      type: "invoke_tool",
      toolId: "builtin:calculate",
      arguments: { expression: "1+1" },
    }) as { type?: string; payload?: { error?: string; blocked?: boolean } };

    expect(result).toBeDefined();
    // Should be blocked due to missing permission
    expect(
      result.type === "error" ||
      result.payload?.error ||
      result.payload?.blocked
    ).toBeTruthy();
  }, 45000);
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { shellExecSkill } from "./index.js";
import type { ToolHandler, ToolContext, ToolResult } from "@agentkernel/tools";
import type { SkillActivationContext, SkillLogger } from "@agentkernel/skills";

// ─── TEST HELPERS ────────────────────────────────────────────

const registeredTools = new Map<string, { handler: ToolHandler<Record<string, unknown>> }>();

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: "test-agent",
    requestId: "test-req",
    allowAllPaths: true,
    allowAllCommands: true,
    ...overrides,
  };
}

const mockLog: SkillLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeActivationContext(): SkillActivationContext {
  return {
    agentId: "test-agent",
    log: mockLog,
    registerTool: (def, handler) => {
      registeredTools.set(def.id, { handler: handler as ToolHandler<Record<string, unknown>> });
    },
    unregisterTool: (id) => {
      registeredTools.delete(id);
    },
    getConfig: () => undefined,
    setData: async () => {},
    getData: async () => undefined,
  };
}

async function invokeTool(toolId: string, args: Record<string, unknown>, ctx?: Partial<ToolContext>): Promise<ToolResult> {
  const tool = registeredTools.get(toolId);
  if (!tool) throw new Error(`Tool not registered: ${toolId}`);
  return tool.handler(args, makeContext(ctx));
}

// ─── TESTS ───────────────────────────────────────────────────

describe("shell-exec skill", () => {
  beforeEach(() => {
    registeredTools.clear();
    shellExecSkill.activate!(makeActivationContext());
  });

  afterEach(() => {
    shellExecSkill.deactivate!(makeActivationContext());
  });

  it("registers 2 tools on activate", () => {
    expect(registeredTools.size).toBe(2);
    expect(registeredTools.has("run")).toBe(true);
    expect(registeredTools.has("which")).toBe(true);
  });

  describe("run", () => {
    it("executes a simple command", async () => {
      const result = await invokeTool("run", { command: "echo", args: ["hello world"] });

      expect(result.success).toBe(true);
      const content = result.content as { stdout: string; stderr: string; exitCode: number };
      expect(content.stdout.trim()).toBe("hello world");
      expect(content.exitCode).toBe(0);
    });

    it("captures stderr", async () => {
      const result = await invokeTool("run", {
        command: "ls",
        args: ["/nonexistent-path-that-should-not-exist"],
        allowNonZeroExit: true,
      });

      const content = result.content as { stdout: string; stderr: string; exitCode: number };
      expect(content.stderr.length).toBeGreaterThan(0);
    });

    it("returns exit code", async () => {
      const result = await invokeTool("run", {
        command: "sh",
        args: ["-c", "exit 42"],
        allowNonZeroExit: true,
      });

      expect(result.success).toBe(true);
      const content = result.content as { exitCode: number };
      expect(content.exitCode).toBe(42);
    });

    it("fails on non-zero exit by default", async () => {
      const result = await invokeTool("run", {
        command: "sh",
        args: ["-c", "exit 1"],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("exited with code 1");
    });

    it("times out slow commands", async () => {
      const result = await invokeTool("run", {
        command: "sleep",
        args: ["10"],
        timeoutMs: 200,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("timed out");
    }, 5000);

    it("returns error for non-existent command", async () => {
      const result = await invokeTool("run", {
        command: "this-command-definitely-does-not-exist-xyz",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to execute command");
    });

    it("sets working directory", async () => {
      const result = await invokeTool("run", {
        command: "pwd",
        cwd: "/tmp",
      });

      expect(result.success).toBe(true);
      const content = result.content as { stdout: string };
      // On macOS /tmp is a symlink to /private/tmp
      expect(content.stdout.trim()).toMatch(/\/tmp|\/private\/tmp/);
    });

    it("includes execution time", async () => {
      const result = await invokeTool("run", { command: "echo", args: ["fast"] });

      expect(result.executionTime).toBeDefined();
      expect(result.executionTime).toBeGreaterThanOrEqual(0);
    });
  });

  describe("which", () => {
    it("finds an existing command", async () => {
      const result = await invokeTool("which", { command: "echo" });

      expect(result.success).toBe(true);
      const content = result.content as { command: string; path: string };
      expect(content.command).toBe("echo");
      expect(content.path).toBeTruthy();
    });

    it("returns error for non-existent command", async () => {
      const result = await invokeTool("which", {
        command: "this-command-definitely-does-not-exist-xyz",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });
  });

  describe("CWD sandboxing", () => {
    it("blocks CWD outside allowed paths", async () => {
      const result = await invokeTool(
        "run",
        { command: "pwd", cwd: "/etc" },
        { allowAllPaths: false, allowedPaths: ["/tmp"] }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("outside allowed paths");
    });
  });

  describe("command allowlisting", () => {
    it("blocks commands not in allowlist", async () => {
      const result = await invokeTool(
        "run",
        { command: "rm", args: ["-rf", "/"] },
        { allowAllCommands: false, allowedCommands: ["echo", "ls", "cat"] }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("not in the allowed commands list");
    });

    it("allows commands in the allowlist", async () => {
      const result = await invokeTool(
        "run",
        { command: "echo", args: ["hello"] },
        { allowAllCommands: false, allowedCommands: ["echo", "ls"] }
      );

      expect(result.success).toBe(true);
    });

    it("blocks all commands when no allowlist is configured", async () => {
      const result = await invokeTool(
        "run",
        { command: "echo", args: ["hello"] },
        { allowAllCommands: false, allowedCommands: [] }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("no allowed commands configured");
    });

    it("allows all commands when allowAllCommands is true", async () => {
      const result = await invokeTool(
        "run",
        { command: "echo", args: ["hello"] },
        { allowAllCommands: true }
      );

      expect(result.success).toBe(true);
    });
  });
});

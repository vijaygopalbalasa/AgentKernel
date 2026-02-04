import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileSystemSkill } from "./index.js";
import type { ToolHandler, ToolContext, ToolResult } from "@agentkernel/tools";
import type { SkillActivationContext, SkillLogger } from "@agentkernel/skills";

// ─── TEST HELPERS ────────────────────────────────────────────

let tempDir: string;
const registeredTools = new Map<string, { handler: ToolHandler<Record<string, unknown>> }>();

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: "test-agent",
    requestId: "test-req",
    allowedPaths: [tempDir],
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

describe("file-system skill", () => {
  beforeEach(async () => {
    tempDir = await realpath(await mkdtemp(join(tmpdir(), "ak-fs-test-")));
    registeredTools.clear();
    fileSystemSkill.activate!(makeActivationContext());
  });

  afterEach(async () => {
    fileSystemSkill.deactivate!(makeActivationContext());
    await rm(tempDir, { recursive: true, force: true });
  });

  it("registers all 6 tools on activate", () => {
    expect(registeredTools.size).toBe(6);
    expect(registeredTools.has("read")).toBe(true);
    expect(registeredTools.has("write")).toBe(true);
    expect(registeredTools.has("list")).toBe(true);
    expect(registeredTools.has("delete")).toBe(true);
    expect(registeredTools.has("stat")).toBe(true);
    expect(registeredTools.has("mkdir")).toBe(true);
  });

  it("unregisters all tools on deactivate", () => {
    fileSystemSkill.deactivate!(makeActivationContext());
    expect(registeredTools.size).toBe(0);
  });

  describe("read", () => {
    it("reads a file", async () => {
      const filePath = join(tempDir, "test.txt");
      await writeFile(filePath, "hello world");

      const result = await invokeTool("read", { path: filePath });

      expect(result.success).toBe(true);
      expect(result.content).toBe("hello world");
    });

    it("returns error for non-existent file", async () => {
      const result = await invokeTool("read", { path: join(tempDir, "nope.txt") });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to read file");
    });

    it("blocks paths outside allowed directories", async () => {
      const result = await invokeTool("read", { path: "/etc/passwd" });

      expect(result.success).toBe(false);
      expect(result.error).toContain("outside allowed directories");
    });
  });

  describe("write", () => {
    it("writes a file", async () => {
      const filePath = join(tempDir, "output.txt");

      const result = await invokeTool("write", { path: filePath, content: "test data" });

      expect(result.success).toBe(true);
      const content = await readFile(filePath, "utf-8");
      expect(content).toBe("test data");
    });

    it("appends to a file", async () => {
      const filePath = join(tempDir, "append.txt");
      await writeFile(filePath, "first ");

      await invokeTool("write", { path: filePath, content: "second", append: true });

      const content = await readFile(filePath, "utf-8");
      expect(content).toBe("first second");
    });

    it("blocks writes outside allowed directories", async () => {
      const result = await invokeTool("write", { path: "/tmp/evil.txt", content: "bad" });

      expect(result.success).toBe(false);
      expect(result.error).toContain("outside allowed directories");
    });
  });

  describe("list", () => {
    it("lists directory contents", async () => {
      await writeFile(join(tempDir, "a.txt"), "a");
      await writeFile(join(tempDir, "b.txt"), "b");
      await mkdir(join(tempDir, "subdir"));

      const result = await invokeTool("list", { path: tempDir });

      expect(result.success).toBe(true);
      const items = result.content as Array<{ name: string; type: string }>;
      expect(items.length).toBe(3);
      expect(items.some((i) => i.name === "a.txt" && i.type === "file")).toBe(true);
      expect(items.some((i) => i.name === "subdir" && i.type === "directory")).toBe(true);
    });
  });

  describe("delete", () => {
    it("deletes a file", async () => {
      const filePath = join(tempDir, "delete-me.txt");
      await writeFile(filePath, "bye");

      const result = await invokeTool("delete", { path: filePath });

      expect(result.success).toBe(true);
      await expect(readFile(filePath)).rejects.toThrow();
    });

    it("deletes an empty directory", async () => {
      const dirPath = join(tempDir, "empty-dir");
      await mkdir(dirPath);

      const result = await invokeTool("delete", { path: dirPath });

      expect(result.success).toBe(true);
    });

    it("deletes a directory recursively", async () => {
      const dirPath = join(tempDir, "full-dir");
      await mkdir(dirPath);
      await writeFile(join(dirPath, "file.txt"), "content");

      const result = await invokeTool("delete", { path: dirPath, recursive: true });

      expect(result.success).toBe(true);
    });
  });

  describe("stat", () => {
    it("returns file metadata", async () => {
      const filePath = join(tempDir, "statme.txt");
      await writeFile(filePath, "hello");

      const result = await invokeTool("stat", { path: filePath });

      expect(result.success).toBe(true);
      const info = result.content as Record<string, unknown>;
      expect(info.type).toBe("file");
      expect(info.size).toBe(5);
      expect(info.created).toBeDefined();
      expect(info.modified).toBeDefined();
    });

    it("identifies directories", async () => {
      const result = await invokeTool("stat", { path: tempDir });

      expect(result.success).toBe(true);
      const info = result.content as Record<string, unknown>;
      expect(info.type).toBe("directory");
    });
  });

  describe("mkdir", () => {
    it("creates a directory", async () => {
      const dirPath = join(tempDir, "new-dir");

      const result = await invokeTool("mkdir", { path: dirPath });

      expect(result.success).toBe(true);
      const info = await import("node:fs/promises").then((fs) => fs.stat(dirPath));
      expect(info.isDirectory()).toBe(true);
    });

    it("creates nested directories", async () => {
      const dirPath = join(tempDir, "a", "b", "c");

      const result = await invokeTool("mkdir", { path: dirPath, recursive: true });

      expect(result.success).toBe(true);
    });
  });

  describe("path sandboxing", () => {
    it("allows access when allowAllPaths is true", async () => {
      const result = await invokeTool(
        "stat",
        { path: "/tmp" },
        { allowAllPaths: true, allowedPaths: undefined }
      );

      expect(result.success).toBe(true);
    });

    it("denies access when no allowed paths configured", async () => {
      const result = await invokeTool(
        "stat",
        { path: "/tmp" },
        { allowedPaths: [] }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("No allowed paths");
    });
  });
});

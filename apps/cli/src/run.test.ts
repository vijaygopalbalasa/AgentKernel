import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sanitizeEnv, resolveAgentModule, runAgent } from "./run.js";

// ─── sanitizeEnv ────────────────────────────────────────────

describe("sanitizeEnv", () => {
  it("should pass through safe environment variables", () => {
    const env = {
      PATH: "/usr/bin",
      HOME: "/home/user",
      CUSTOM_VAR: "safe-value",
      NODE_ENV: "development",
    } as NodeJS.ProcessEnv;

    const result = sanitizeEnv(env);
    expect(result.PATH).toBe("/usr/bin");
    expect(result.HOME).toBe("/home/user");
    expect(result.CUSTOM_VAR).toBe("safe-value");
    expect(result.NODE_ENV).toBe("development");
  });

  it("should block sensitive API keys", () => {
    const env = {
      ANTHROPIC_API_KEY: "sk-ant-secret",
      OPENAI_API_KEY: "sk-secret",
      GOOGLE_AI_API_KEY: "google-secret",
      SAFE_KEY: "ok",
    } as NodeJS.ProcessEnv;

    const result = sanitizeEnv(env);
    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.OPENAI_API_KEY).toBeUndefined();
    expect(result.GOOGLE_AI_API_KEY).toBeUndefined();
    expect(result.SAFE_KEY).toBe("ok");
  });

  it("should block gateway and infrastructure secrets", () => {
    const env = {
      GATEWAY_AUTH_TOKEN: "auth-token",
      INTERNAL_AUTH_TOKEN: "internal-token",
      PERMISSION_SECRET: "perm-secret",
      MANIFEST_SIGNING_SECRET: "sign-secret",
      MEMORY_ENCRYPTION_KEY: "enc-key",
      DATABASE_URL: "postgresql://host/db",
      REDIS_URL: "redis://localhost:6379",
      QDRANT_URL: "http://localhost:6333",
    } as NodeJS.ProcessEnv;

    const result = sanitizeEnv(env);
    expect(result.GATEWAY_AUTH_TOKEN).toBeUndefined();
    expect(result.INTERNAL_AUTH_TOKEN).toBeUndefined();
    expect(result.PERMISSION_SECRET).toBeUndefined();
    expect(result.MANIFEST_SIGNING_SECRET).toBeUndefined();
    expect(result.MEMORY_ENCRYPTION_KEY).toBeUndefined();
    expect(result.DATABASE_URL).toBeUndefined();
    expect(result.REDIS_URL).toBeUndefined();
    expect(result.QDRANT_URL).toBeUndefined();
  });

  it("should skip undefined values", () => {
    const env = {
      PRESENT: "yes",
      ABSENT: undefined,
    } as NodeJS.ProcessEnv;

    const result = sanitizeEnv(env);
    expect(result.PRESENT).toBe("yes");
    expect("ABSENT" in result).toBe(false);
  });

  it("should return empty object for empty env", () => {
    const result = sanitizeEnv({} as NodeJS.ProcessEnv);
    expect(Object.keys(result)).toHaveLength(0);
  });
});

// ─── resolveAgentModule ─────────────────────────────────────

describe("resolveAgentModule", () => {
  it("should resolve default export with handleTask", () => {
    const agent = { handleTask: vi.fn(), manifest: { id: "test" } };
    const module = { default: agent };
    expect(resolveAgentModule(module)).toBe(agent);
  });

  it("should resolve named handleTask export", () => {
    const module = { handleTask: vi.fn(), manifest: { id: "test" } };
    expect(resolveAgentModule(module as Record<string, unknown>)).toBe(module);
  });

  it("should resolve nested default.default (ESM interop)", () => {
    const inner = { handleTask: vi.fn() };
    const module = { default: { default: inner } };
    expect(resolveAgentModule(module)).toBe(inner);
  });

  it("should return null for module without handleTask", () => {
    expect(resolveAgentModule({ foo: "bar" })).toBeNull();
  });

  it("should return null for module with non-function handleTask", () => {
    expect(resolveAgentModule({ handleTask: "not-a-function" })).toBeNull();
  });

  it("should return null for empty module", () => {
    expect(resolveAgentModule({})).toBeNull();
  });

  it("should return null when default export has no handleTask", () => {
    expect(resolveAgentModule({ default: { name: "test" } })).toBeNull();
  });

  it("should prefer default export over named export", () => {
    const defaultAgent = { handleTask: vi.fn() };
    const module = { default: defaultAgent, handleTask: vi.fn() };
    expect(resolveAgentModule(module as Record<string, unknown>)).toBe(defaultAgent);
  });
});

// ─── runAgent error paths ───────────────────────────────────

describe("runAgent", () => {
  const defaultOpts = {
    host: "127.0.0.1",
    port: "18800",
    policy: "strict",
  };

  let exitSpy: ReturnType<typeof vi.spyOn>;
  const tmpFiles: string[] = [];

  function createTmpFile(name: string, content: string = ""): string {
    const filePath = join(tmpdir(), `agentrun-test-${Date.now()}-${name}`);
    writeFileSync(filePath, content);
    tmpFiles.push(filePath);
    return filePath;
  }

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as () => never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const f of tmpFiles) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
    tmpFiles.length = 0;
  });

  it("should exit with 1 if agent file not found", async () => {
    await expect(
      runAgent("/tmp/nonexistent-agent-file-99999.ts", defaultOpts)
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("should exit with 1 for unsupported file extension", async () => {
    const pyFile = createTmpFile("agent.py", "print('hello')");
    await expect(
      runAgent(pyFile, defaultOpts)
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("should suggest --adapter when given a yaml file without adapter flag", async () => {
    const yamlFile = createTmpFile("config.yaml", "name: test");
    await expect(
      runAgent(yamlFile, defaultOpts)
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalled();
  });

  it("should suggest --adapter when given a json config file without adapter flag", async () => {
    const jsonFile = createTmpFile("config.json", '{"name":"test"}');
    await expect(
      runAgent(jsonFile, defaultOpts)
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

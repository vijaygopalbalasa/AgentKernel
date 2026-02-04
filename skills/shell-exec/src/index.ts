// @agentkernel/skill-shell-exec — Sandboxed command execution skill
// Executes commands via child_process.spawn (no shell interpolation)
// Enforces: command allowlisting, safe env, timeout, output limits, CWD sandboxing

import { z } from "zod";
import { spawn } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import type { SkillModule, SkillActivationContext } from "@agentkernel/skills";
import type { ToolHandler, ToolContext, ToolDefinition } from "@agentkernel/tools";

// ─── SAFE ENVIRONMENT ────────────────────────────────────────

const SAFE_ENV_KEYS = [
  "PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "LC_ALL",
  "LC_CTYPE", "TZ", "TMPDIR", "NODE_ENV",
];

function buildSafeEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key]) {
      env[key] = process.env[key]!;
    }
  }
  if (extra) {
    Object.assign(env, extra);
  }
  return env;
}

// ─── PATH VALIDATION ─────────────────────────────────────────

function validateCwd(cwd: string, context: ToolContext): string | null {
  if (context.allowAllPaths) return null;

  if (!context.allowedPaths || context.allowedPaths.length === 0) {
    return "No allowed paths configured. Cannot set working directory.";
  }

  const resolved = resolvePath(cwd);
  const isAllowed = context.allowedPaths.some(
    (allowed) => resolved === allowed || resolved.startsWith(allowed + "/")
  );

  if (!isAllowed) {
    return `Working directory '${resolved}' is outside allowed paths.`;
  }

  return null;
}

// ─── COMMAND VALIDATION ──────────────────────────────────────

function validateCommand(command: string, context: ToolContext): string | null {
  if (context.allowAllCommands) return null;

  if (!context.allowedCommands || context.allowedCommands.length === 0) {
    return `Command '${command}' blocked: no allowed commands configured.`;
  }

  // Extract the binary name (strip path prefixes like /usr/bin/git → git)
  const binary = command.includes("/") ? command.split("/").pop()! : command;

  const isAllowed = context.allowedCommands.some(
    (allowed) => binary === allowed || command === allowed
  );

  if (!isAllowed) {
    return `Command '${binary}' is not in the allowed commands list: [${context.allowedCommands.join(", ")}]`;
  }

  return null;
}

// ─── RUN TOOL ────────────────────────────────────────────────

const runSchema = z.object({
  command: z.string().min(1).describe("Command to execute (no shell interpolation)"),
  args: z.array(z.string()).optional().describe("Arguments to pass to the command"),
  cwd: z.string().optional().describe("Working directory"),
  env: z.record(z.string()).optional().describe("Additional environment variables"),
  timeoutMs: z.number().int().min(100).max(300000).optional().describe("Execution timeout in ms (default 30000)"),
  maxBytes: z.number().int().min(1).max(10 * 1024 * 1024).optional().describe("Max output bytes (default 1MB)"),
  allowNonZeroExit: z.boolean().optional().describe("Treat non-zero exit as success"),
});

const runHandler: ToolHandler<z.infer<typeof runSchema>> = async (args, context) => {
  const cmdError = validateCommand(args.command, context);
  if (cmdError) {
    return { success: false, error: cmdError };
  }

  if (args.cwd) {
    const cwdError = validateCwd(args.cwd, context);
    if (cwdError) {
      return { success: false, error: cwdError };
    }
  }

  const start = Date.now();
  const maxBytes = args.maxBytes ?? 1024 * 1024;
  const timeoutMs = args.timeoutMs ?? 30000;

  return new Promise((resolve) => {
    const child = spawn(args.command, args.args ?? [], {
      cwd: args.cwd,
      env: buildSafeEnv(args.env),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    const onData = (chunk: Buffer, target: "stdout" | "stderr") => {
      outputBytes += chunk.length;
      if (outputBytes > maxBytes) {
        child.kill("SIGTERM");
        return;
      }
      if (target === "stdout") {
        stdout += chunk.toString("utf-8");
      } else {
        stderr += chunk.toString("utf-8");
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => onData(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => onData(chunk, "stderr"));

    if (context.signal) {
      context.signal.addEventListener("abort", () => {
        child.kill("SIGTERM");
      });
    }

    child.on("error", (err) => {
      clearTimeout(timeout);
      resolve({
        success: false,
        error: `Failed to execute command: ${err.message}`,
        executionTime: Date.now() - start,
      });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timeout);

      if (timedOut) {
        resolve({
          success: false,
          error: `Command timed out after ${timeoutMs}ms`,
          executionTime: Date.now() - start,
          content: { stdout, stderr, exitCode: code, signal },
        });
        return;
      }

      if (outputBytes > maxBytes) {
        resolve({
          success: false,
          error: `Output exceeded limit (${maxBytes} bytes)`,
          executionTime: Date.now() - start,
          content: { stdout, stderr, exitCode: code, signal },
        });
        return;
      }

      const success = code === 0 || args.allowNonZeroExit === true;
      resolve({
        success,
        executionTime: Date.now() - start,
        content: { stdout, stderr, exitCode: code, signal },
        error: success ? undefined : `Command exited with code ${code ?? "unknown"}`,
      });
    });
  });
};

// ─── WHICH TOOL ──────────────────────────────────────────────

const whichSchema = z.object({
  command: z.string().min(1).describe("Command name to locate"),
});

const whichHandler: ToolHandler<z.infer<typeof whichSchema>> = async (args) => {
  return new Promise((resolve) => {
    const child = spawn("which", [args.command], {
      env: buildSafeEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });

    child.on("error", () => {
      resolve({ success: false, error: `Command not found: ${args.command}` });
    });

    child.on("close", (code) => {
      if (code === 0 && stdout.trim()) {
        resolve({ success: true, content: { command: args.command, path: stdout.trim() } });
      } else {
        resolve({ success: false, error: `Command not found: ${args.command}` });
      }
    });
  });
};

// ─── TOOL DEFINITIONS ────────────────────────────────────────

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler<Record<string, unknown>> }> = [
  {
    definition: {
      id: "run",
      name: "Run Command",
      description:
        "Execute a command with arguments. Uses spawn (no shell interpolation). " +
        "Enforces timeout, output limits, and safe environment variable filtering.",
      inputSchema: runSchema,
      category: "system",
      tags: ["shell", "exec", "command"],
      requiredPermissions: ["shell:execute"],
      requiresConfirmation: true,
    },
    handler: runHandler as ToolHandler<Record<string, unknown>>,
  },
  {
    definition: {
      id: "which",
      name: "Which Command",
      description: "Check if a command exists and return its full path.",
      inputSchema: whichSchema,
      category: "system",
      tags: ["shell", "which", "command"],
      requiredPermissions: ["shell:execute"],
    },
    handler: whichHandler as ToolHandler<Record<string, unknown>>,
  },
];

// ─── SKILL MODULE ────────────────────────────────────────────

export const shellExecSkill: SkillModule = {
  manifest: {
    id: "shell-exec",
    name: "Shell Exec",
    description:
      "Execute commands in a sandboxed environment. Uses child_process.spawn with no shell " +
      "interpolation, safe environment filtering, timeout enforcement, and output limits.",
    version: "0.1.0",
    author: "AgentKernel",
    license: "MIT",
    categories: ["system"],
    tags: ["shell", "exec", "command", "process"],
    permissions: [
      { id: "shell:execute", reason: "Execute shell commands", required: true },
    ],
    tools: tools.map((t) => t.definition),
  },

  activate(context: SkillActivationContext): void {
    context.log.info("Activating shell-exec skill");

    for (const { definition, handler } of tools) {
      context.registerTool(definition, handler);
      context.log.debug(`Registered tool: ${definition.id}`);
    }
  },

  deactivate(context: SkillActivationContext): void {
    context.log.info("Deactivating shell-exec skill");

    for (const { definition } of tools) {
      context.unregisterTool(definition.id);
    }
  },
};

// @agentkernel/skill-file-system — Filesystem operations skill
// Provides sandboxed file read, write, list, delete, stat, and mkdir tools

import { z } from "zod";
import {
  readFile,
  writeFile,
  appendFile,
  readdir,
  unlink,
  rm,
  rmdir,
  stat,
  mkdir,
  realpath,
} from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import type { SkillModule, SkillActivationContext } from "@agentkernel/skills";
import type { ToolHandler, ToolContext, ToolDefinition } from "@agentkernel/tools";

// ─── PATH VALIDATION ─────────────────────────────────────────

/**
 * Validate that a path is within allowed directories.
 * Resolves symlinks to prevent traversal via symlink chains.
 */
async function validatePath(rawPath: string, context: ToolContext): Promise<string | null> {
  if (context.allowAllPaths) return null;

  if (!context.allowedPaths || context.allowedPaths.length === 0) {
    return "No allowed paths configured. Filesystem access denied.";
  }

  const resolved = resolvePath(rawPath);

  let real: string;
  try {
    real = await realpath(resolved);
  } catch {
    // File may not exist yet (e.g. write/mkdir); fall back to resolved path
    real = resolved;
  }

  const resolvedAllowed = await Promise.all(
    context.allowedPaths.map(async (p) => {
      try {
        return await realpath(resolvePath(p));
      } catch {
        return resolvePath(p);
      }
    })
  );

  const isAllowed = resolvedAllowed.some(
    (allowed) => real === allowed || real.startsWith(allowed + "/")
  );

  if (!isAllowed) {
    return `Path '${real}' is outside allowed directories.`;
  }

  return null;
}

// ─── READ TOOL ───────────────────────────────────────────────

const readSchema = z.object({
  path: z.string().min(1).describe("Absolute or relative path to read"),
  encoding: z
    .enum(["utf-8", "utf8", "base64", "hex", "latin1", "binary", "ascii"])
    .optional()
    .describe("File encoding (default utf-8)"),
});

const readHandler: ToolHandler<z.infer<typeof readSchema>> = async (args, context) => {
  const pathError = await validatePath(args.path, context);
  if (pathError) {
    return { success: false, error: pathError };
  }

  try {
    const encoding = (args.encoding ?? "utf-8") as BufferEncoding;
    const content = await readFile(args.path, encoding);
    return {
      success: true,
      content,
      metadata: { path: resolvePath(args.path), bytes: Buffer.byteLength(content, encoding) },
    };
  } catch (err) {
    return {
      success: false,
      error: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

// ─── WRITE TOOL ──────────────────────────────────────────────

const writeSchema = z.object({
  path: z.string().min(1).describe("Absolute or relative path to write"),
  content: z.string().describe("Content to write"),
  append: z.boolean().optional().describe("Append instead of overwrite"),
  encoding: z
    .enum(["utf-8", "utf8", "base64", "hex", "latin1", "binary", "ascii"])
    .optional()
    .describe("File encoding (default utf-8)"),
});

const writeHandler: ToolHandler<z.infer<typeof writeSchema>> = async (args, context) => {
  const pathError = await validatePath(args.path, context);
  if (pathError) {
    return { success: false, error: pathError };
  }

  try {
    const encoding = (args.encoding ?? "utf-8") as BufferEncoding;
    if (args.append) {
      await appendFile(args.path, args.content, encoding);
    } else {
      await writeFile(args.path, args.content, encoding);
    }
    return {
      success: true,
      content: {
        path: resolvePath(args.path),
        bytes: Buffer.byteLength(args.content, encoding),
        append: args.append ?? false,
      },
    };
  } catch (err) {
    return {
      success: false,
      error: `Failed to write file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

// ─── LIST TOOL ───────────────────────────────────────────────

const listSchema = z.object({
  path: z.string().min(1).describe("Directory path to list"),
  recursive: z.boolean().optional().describe("List recursively"),
});

const listHandler: ToolHandler<z.infer<typeof listSchema>> = async (args, context) => {
  const pathError = await validatePath(args.path, context);
  if (pathError) {
    return { success: false, error: pathError };
  }

  try {
    const entries = await readdir(args.path, {
      withFileTypes: true,
      recursive: args.recursive ?? false,
    });

    const items = entries.map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file",
      path: entry.parentPath
        ? resolvePath(entry.parentPath, entry.name)
        : resolvePath(args.path, entry.name),
    }));

    return {
      success: true,
      content: items,
      metadata: { path: resolvePath(args.path), count: items.length },
    };
  } catch (err) {
    return {
      success: false,
      error: `Failed to list directory: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

// ─── DELETE TOOL ─────────────────────────────────────────────

const deleteSchema = z.object({
  path: z.string().min(1).describe("Path to delete"),
  recursive: z.boolean().optional().describe("Delete directories recursively"),
});

const deleteHandler: ToolHandler<z.infer<typeof deleteSchema>> = async (args, context) => {
  const pathError = await validatePath(args.path, context);
  if (pathError) {
    return { success: false, error: pathError };
  }

  try {
    const info = await stat(args.path);

    if (info.isDirectory()) {
      if (args.recursive) {
        await rm(args.path, { recursive: true, force: false });
      } else {
        await rmdir(args.path);
      }
    } else {
      await unlink(args.path);
    }

    return {
      success: true,
      content: { path: resolvePath(args.path), type: info.isDirectory() ? "directory" : "file" },
    };
  } catch (err) {
    return {
      success: false,
      error: `Failed to delete: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

// ─── STAT TOOL ───────────────────────────────────────────────

const statSchema = z.object({
  path: z.string().min(1).describe("Path to inspect"),
});

const statHandler: ToolHandler<z.infer<typeof statSchema>> = async (args, context) => {
  const pathError = await validatePath(args.path, context);
  if (pathError) {
    return { success: false, error: pathError };
  }

  try {
    const info = await stat(args.path);

    return {
      success: true,
      content: {
        path: resolvePath(args.path),
        type: info.isDirectory() ? "directory" : info.isSymbolicLink() ? "symlink" : "file",
        size: info.size,
        created: info.birthtime.toISOString(),
        modified: info.mtime.toISOString(),
        accessed: info.atime.toISOString(),
        mode: info.mode.toString(8),
      },
    };
  } catch (err) {
    return {
      success: false,
      error: `Failed to stat: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

// ─── MKDIR TOOL ──────────────────────────────────────────────

const mkdirSchema = z.object({
  path: z.string().min(1).describe("Directory path to create"),
  recursive: z.boolean().optional().describe("Create parent directories if needed"),
});

const mkdirHandler: ToolHandler<z.infer<typeof mkdirSchema>> = async (args, context) => {
  const pathError = await validatePath(args.path, context);
  if (pathError) {
    return { success: false, error: pathError };
  }

  try {
    await mkdir(args.path, { recursive: args.recursive ?? true });
    return {
      success: true,
      content: { path: resolvePath(args.path) },
    };
  } catch (err) {
    return {
      success: false,
      error: `Failed to create directory: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

// ─── TOOL DEFINITIONS ────────────────────────────────────────

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler<Record<string, unknown>> }> = [
  {
    definition: {
      id: "read",
      name: "Read File",
      description: "Read the contents of a file from disk.",
      inputSchema: readSchema,
      category: "filesystem",
      tags: ["file", "read"],
      requiredPermissions: ["file:read"],
    },
    handler: readHandler as ToolHandler<Record<string, unknown>>,
  },
  {
    definition: {
      id: "write",
      name: "Write File",
      description: "Write content to a file on disk. Can overwrite or append.",
      inputSchema: writeSchema,
      category: "filesystem",
      tags: ["file", "write"],
      requiredPermissions: ["file:write"],
      requiresConfirmation: true,
    },
    handler: writeHandler as ToolHandler<Record<string, unknown>>,
  },
  {
    definition: {
      id: "list",
      name: "List Directory",
      description: "List files and directories at a given path.",
      inputSchema: listSchema,
      category: "filesystem",
      tags: ["file", "list", "directory"],
      requiredPermissions: ["file:read"],
    },
    handler: listHandler as ToolHandler<Record<string, unknown>>,
  },
  {
    definition: {
      id: "delete",
      name: "Delete File or Directory",
      description: "Delete a file or directory. Use recursive for non-empty directories.",
      inputSchema: deleteSchema,
      category: "filesystem",
      tags: ["file", "delete"],
      requiredPermissions: ["file:delete"],
      requiresConfirmation: true,
    },
    handler: deleteHandler as ToolHandler<Record<string, unknown>>,
  },
  {
    definition: {
      id: "stat",
      name: "File Info",
      description: "Get file or directory metadata: size, dates, type, permissions.",
      inputSchema: statSchema,
      category: "filesystem",
      tags: ["file", "stat", "info"],
      requiredPermissions: ["file:read"],
    },
    handler: statHandler as ToolHandler<Record<string, unknown>>,
  },
  {
    definition: {
      id: "mkdir",
      name: "Create Directory",
      description: "Create a directory. Creates parent directories by default.",
      inputSchema: mkdirSchema,
      category: "filesystem",
      tags: ["file", "mkdir", "directory"],
      requiredPermissions: ["file:write"],
    },
    handler: mkdirHandler as ToolHandler<Record<string, unknown>>,
  },
];

// ─── SKILL MODULE ────────────────────────────────────────────

export const fileSystemSkill: SkillModule = {
  manifest: {
    id: "file-system",
    name: "File System",
    description: "Read, write, list, delete, stat, and create files and directories with path sandboxing.",
    version: "0.1.0",
    author: "AgentKernel",
    license: "MIT",
    categories: ["filesystem"],
    tags: ["file", "read", "write", "directory", "fs"],
    permissions: [
      { id: "file:read", reason: "Read files and list directories", required: true },
      { id: "file:write", reason: "Write files and create directories" },
      { id: "file:delete", reason: "Delete files and directories" },
    ],
    tools: tools.map((t) => t.definition),
  },

  activate(context: SkillActivationContext): void {
    context.log.info("Activating file-system skill");

    for (const { definition, handler } of tools) {
      context.registerTool(definition, handler);
      context.log.debug(`Registered tool: ${definition.id}`);
    }
  },

  deactivate(context: SkillActivationContext): void {
    context.log.info("Deactivating file-system skill");

    for (const { definition } of tools) {
      context.unregisterTool(definition.id);
    }
  },
};

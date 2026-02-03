// Built-in Tools — common tools that ship with Agent OS
// These are registered by default for all agents

import { z } from "zod";
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { ToolDefinition, ToolHandler, ToolResult, ToolContext } from "./types.js";
import { ToolRegistry } from "./registry.js";
import type { Browser } from "playwright";
import { ProxyAgent } from "undici";

// ─── ECHO TOOL (for testing) ─────────────────────────────────

const echoSchema = z.object({
  message: z.string().describe("Message to echo back"),
});

const echoDefinition: ToolDefinition = {
  id: "builtin:echo",
  name: "Echo",
  description: "Echoes back the input message. Useful for testing.",
  inputSchema: echoSchema,
  category: "utility",
  tags: ["test", "debug"],
};

const echoHandler: ToolHandler<z.infer<typeof echoSchema>> = async (args) => {
  return {
    success: true,
    content: { echo: args.message, timestamp: new Date().toISOString() },
  };
};

// ─── DATETIME TOOL ───────────────────────────────────────────

const datetimeSchema = z.object({
  timezone: z.string().optional().describe("Timezone (e.g., 'America/New_York')"),
  format: z.enum(["iso", "unix", "readable"]).optional().describe("Output format"),
});

const datetimeDefinition: ToolDefinition = {
  id: "builtin:datetime",
  name: "DateTime",
  description: "Get the current date and time.",
  inputSchema: datetimeSchema,
  category: "utility",
  tags: ["time", "date"],
};

const datetimeHandler: ToolHandler<z.infer<typeof datetimeSchema>> = async (args) => {
  const now = new Date();

  let result: string | number;
  switch (args.format) {
    case "unix":
      result = Math.floor(now.getTime() / 1000);
      break;
    case "readable":
      result = now.toLocaleString("en-US", {
        timeZone: args.timezone ?? "UTC",
        dateStyle: "full",
        timeStyle: "long",
      });
      break;
    case "iso":
    default:
      result = now.toISOString();
  }

  return {
    success: true,
    content: {
      datetime: result,
      timezone: args.timezone ?? "UTC",
      format: args.format ?? "iso",
    },
  };
};

// ─── CALCULATE TOOL ──────────────────────────────────────────

const calculateSchema = z.object({
  expression: z.string().describe("Mathematical expression to evaluate"),
});

const calculateDefinition: ToolDefinition = {
  id: "builtin:calculate",
  name: "Calculate",
  description: "Evaluate a mathematical expression. Supports basic arithmetic.",
  inputSchema: calculateSchema,
  category: "utility",
  tags: ["math", "calculate"],
};

const calculateHandler: ToolHandler<z.infer<typeof calculateSchema>> = async (args) => {
  try {
    // Safe evaluation using Function (only allows numbers and operators)
    const sanitized = args.expression.replace(/[^0-9+\-*/().%\s]/g, "");
    if (sanitized !== args.expression) {
      return {
        success: false,
        error: "Expression contains invalid characters. Only numbers and basic operators are allowed.",
      };
    }

    // Evaluate (in a sandbox this would be safer)
    const result = Function(`"use strict"; return (${sanitized})`)();

    if (typeof result !== "number" || !Number.isFinite(result)) {
      return {
        success: false,
        error: "Expression did not evaluate to a valid number",
      };
    }

    return {
      success: true,
      content: {
        expression: args.expression,
        result,
      },
    };
  } catch (err) {
    return {
      success: false,
      error: `Failed to evaluate expression: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

// ─── FILE READ TOOL ─────────────────────────────────────────

const fileReadSchema = z.object({
  path: z.string().min(1).describe("Absolute or relative path to read"),
});

const fileReadDefinition: ToolDefinition = {
  id: "builtin:file_read",
  name: "File Read",
  description: "Read the contents of a file from disk.",
  inputSchema: fileReadSchema,
  category: "filesystem",
  tags: ["file", "read"],
  requiredPermissions: ["filesystem.read"],
};

const fileReadHandler: ToolHandler<z.infer<typeof fileReadSchema>> = async (args) => {
  try {
    const content = await readFile(args.path, "utf-8");
    return {
      success: true,
      content,
      metadata: {
        path: args.path,
        bytes: content.length,
      },
    };
  } catch (err) {
    return {
      success: false,
      error: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

// ─── FILE WRITE TOOL ────────────────────────────────────────

const fileWriteSchema = z.object({
  path: z.string().min(1).describe("Absolute or relative path to write"),
  content: z.string().describe("Content to write to the file"),
  append: z.boolean().optional().describe("Append instead of overwrite"),
  encoding: z.enum([
    "utf-8", "utf8", "utf16le", "ucs2", "ucs-2", "base64", "base64url",
    "latin1", "binary", "hex", "ascii"
  ]).optional().describe("Text encoding (default utf-8)"),
});

const fileWriteDefinition: ToolDefinition = {
  id: "builtin:file_write",
  name: "File Write",
  description: "Write content to a file on disk.",
  inputSchema: fileWriteSchema,
  category: "filesystem",
  tags: ["file", "write"],
  requiredPermissions: ["filesystem.write"],
  requiresConfirmation: true, // Destructive operation requires approval
};

const fileWriteHandler: ToolHandler<z.infer<typeof fileWriteSchema>> = async (args) => {
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
        path: args.path,
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

// ─── SHELL EXEC TOOL ────────────────────────────────────────

const shellExecSchema = z.object({
  command: z.string().min(1).describe("Command to execute (no shell)"),
  args: z.array(z.string()).optional().describe("Arguments to pass"),
  cwd: z.string().optional().describe("Working directory"),
  env: z.record(z.string()).optional().describe("Environment variables"),
  timeoutMs: z.number().int().min(100).max(60000).optional().describe("Execution timeout"),
  maxBytes: z.number().int().min(1).max(5 * 1024 * 1024).optional().describe("Max output bytes"),
  allowNonZeroExit: z.boolean().optional().describe("Allow non-zero exit codes"),
});

const shellExecDefinition: ToolDefinition = {
  id: "builtin:shell_exec",
  name: "Shell Exec",
  description: "Execute a command with strict allowlisting (no shell interpolation).",
  inputSchema: shellExecSchema,
  category: "system",
  tags: ["shell", "exec", "command"],
  requiredPermissions: ["shell.execute"],
  requiresConfirmation: true,
};

const shellExecHandler: ToolHandler<z.infer<typeof shellExecSchema>> = async (args, context) => {
  const start = Date.now();
  const maxBytes = args.maxBytes ?? 1024 * 1024;
  const timeoutMs = args.timeoutMs ?? 30000;

  return new Promise((resolve) => {
    const child = spawn(args.command, args.args ?? [], {
      cwd: args.cwd,
      env: {
        ...process.env,
        ...(args.env ?? {}),
      },
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

    context.signal?.addEventListener("abort", () => {
      child.kill("SIGTERM");
    });

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
          error: "Command timed out",
          executionTime: Date.now() - start,
          content: { stdout, stderr, exitCode: code, signal },
        });
        return;
      }

      if (outputBytes > maxBytes) {
        resolve({
          success: false,
          error: `Output exceeded maxBytes (${maxBytes})`,
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

// ─── HTTP FETCH TOOL ────────────────────────────────────────

const httpFetchSchema = z.object({
  url: z.string().url().describe("URL to fetch"),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]).optional(),
  headers: z.record(z.string()).optional(),
  body: z.union([z.string(), z.record(z.unknown())]).optional(),
  timeoutMs: z.number().int().min(100).max(60000).optional(),
  maxBytes: z.number().int().min(1).max(5 * 1024 * 1024).optional(),
});

const httpFetchDefinition: ToolDefinition = {
  id: "builtin:http_fetch",
  name: "HTTP Fetch",
  description: "Fetch a URL over HTTP(S).",
  inputSchema: httpFetchSchema,
  category: "network",
  tags: ["http", "fetch", "network"],
  requiredPermissions: ["network.fetch"],
};

let cachedProxyUrl: string | undefined;
let cachedProxyAgent: unknown;

const resolveProxyAgent = (): unknown => {
  const proxyUrl = process.env.AGENT_EGRESS_PROXY_URL?.trim();
  if (!proxyUrl) {
    cachedProxyUrl = undefined;
    cachedProxyAgent = undefined;
    return undefined;
  }
  if (!cachedProxyAgent || cachedProxyUrl !== proxyUrl) {
    cachedProxyUrl = proxyUrl;
    cachedProxyAgent = new ProxyAgent(proxyUrl);
  }
  return cachedProxyAgent;
};

const httpFetchHandler: ToolHandler<z.infer<typeof httpFetchSchema>> = async (args, context) => {
  const controller = new AbortController();
  const timeoutMs = args.timeoutMs ?? 10000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  if (context.signal) {
    context.signal.addEventListener("abort", () => controller.abort());
  }

  try {
    const body = args.body && typeof args.body === "object"
      ? JSON.stringify(args.body)
      : args.body;

    const dispatcher = resolveProxyAgent();
    const fetchInit: Record<string, unknown> = {
      method: args.method ?? "GET",
      headers: args.headers,
      body,
      signal: controller.signal,
    };
    if (dispatcher) {
      fetchInit.dispatcher = dispatcher;
    }

    const response = await fetch(args.url, fetchInit as RequestInit);

    const text = await response.text();
    const maxBytes = args.maxBytes ?? 1024 * 1024;
    if (Buffer.byteLength(text, "utf-8") > maxBytes) {
      return {
        success: false,
        error: `Response exceeded maxBytes (${maxBytes})`,
      };
    }

    const headers = Object.fromEntries(response.headers.entries());

    return {
      success: response.ok,
      content: {
        status: response.status,
        statusText: response.statusText,
        headers,
        body: text,
      },
      error: response.ok ? undefined : `HTTP ${response.status}`,
    };
  } catch (err) {
    return {
      success: false,
      error: `Failed to fetch URL: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timeout);
  }
};

// ─── BROWSER SNAPSHOT TOOL ──────────────────────────────────

const browserSnapshotSchema = z.object({
  url: z.string().url().describe("URL to open in a headless browser"),
  actions: z.array(z.object({
    action: z.enum([
      "click",
      "fill",
      "press",
      "select",
      "wait_for_selector",
      "wait_ms",
    ]),
    selector: z.string().optional(),
    value: z.union([z.string(), z.number()]).optional(),
    timeoutMs: z.number().int().min(0).max(60000).optional(),
  })).optional().describe("Optional automation steps to run after navigation"),
  waitMs: z.number().int().min(0).max(30000).optional().describe("Wait after load (ms)"),
  timeoutMs: z.number().int().min(1000).max(60000).optional().describe("Navigation timeout (ms)"),
  maxHtmlBytes: z.number().int().min(1024).max(2 * 1024 * 1024).optional().describe("Max HTML bytes"),
  screenshot: z.boolean().optional().describe("Include a PNG screenshot"),
  fullPage: z.boolean().optional().describe("Capture full page screenshot"),
  viewport: z.object({
    width: z.number().int().min(100).max(1920),
    height: z.number().int().min(100).max(1080),
  }).optional(),
  userAgent: z.string().optional(),
  headers: z.record(z.string()).optional(),
});

const browserSnapshotDefinition: ToolDefinition = {
  id: "builtin:browser_snapshot",
  name: "Browser Snapshot",
  description: "Load a URL in a headless browser, run optional actions, and return HTML (and optional screenshot).",
  inputSchema: browserSnapshotSchema,
  category: "browser",
  tags: ["browser", "web", "automation"],
  requiredPermissions: ["network.execute"],
};

const browserSnapshotHandler: ToolHandler<z.infer<typeof browserSnapshotSchema>> = async (args, context) => {
  const timeoutMs = args.timeoutMs ?? 30000;
  const waitMs = args.waitMs ?? 0;
  const maxHtmlBytes = args.maxHtmlBytes ?? 500000;

  let browser: Browser | null = null;
  try {
    const { chromium } = await import("playwright");
    const proxyUrl = process.env.AGENT_EGRESS_PROXY_URL?.trim();
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      proxy: proxyUrl ? { server: proxyUrl } : undefined,
    });
    const pageContext = await browser.newContext({
      viewport: args.viewport,
      userAgent: args.userAgent,
    });
    if (args.headers) {
      await pageContext.setExtraHTTPHeaders(args.headers);
    }
    const page = await pageContext.newPage();

    if (context.signal) {
      context.signal.addEventListener("abort", () => {
        void page.close().catch(() => {});
      });
    }

    await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: timeoutMs });

    if (waitMs > 0) {
      await page.waitForTimeout(waitMs);
    }

    const actionResults: Array<Record<string, unknown>> = [];
    if (args.actions && args.actions.length > 0) {
      for (const [index, step] of args.actions.entries()) {
        const stepTimeout = step.timeoutMs ?? timeoutMs;
        switch (step.action) {
          case "click": {
            if (!step.selector) {
              throw new Error(`browser_snapshot action ${index} missing selector`);
            }
            await page.click(step.selector, { timeout: stepTimeout });
            actionResults.push({ index, action: "click", selector: step.selector });
            break;
          }
          case "fill": {
            if (!step.selector) {
              throw new Error(`browser_snapshot action ${index} missing selector`);
            }
            if (step.value === undefined) {
              throw new Error(`browser_snapshot action ${index} missing value`);
            }
            await page.fill(step.selector, String(step.value), { timeout: stepTimeout });
            actionResults.push({ index, action: "fill", selector: step.selector });
            break;
          }
          case "press": {
            if (!step.selector) {
              throw new Error(`browser_snapshot action ${index} missing selector`);
            }
            if (step.value === undefined) {
              throw new Error(`browser_snapshot action ${index} missing value`);
            }
            await page.press(step.selector, String(step.value), { timeout: stepTimeout });
            actionResults.push({ index, action: "press", selector: step.selector });
            break;
          }
          case "select": {
            if (!step.selector) {
              throw new Error(`browser_snapshot action ${index} missing selector`);
            }
            if (step.value === undefined) {
              throw new Error(`browser_snapshot action ${index} missing value`);
            }
            await page.selectOption(step.selector, String(step.value));
            actionResults.push({ index, action: "select", selector: step.selector });
            break;
          }
          case "wait_for_selector": {
            if (!step.selector) {
              throw new Error(`browser_snapshot action ${index} missing selector`);
            }
            await page.waitForSelector(step.selector, { timeout: stepTimeout });
            actionResults.push({ index, action: "wait_for_selector", selector: step.selector });
            break;
          }
          case "wait_ms": {
            const value = typeof step.value === "number" ? step.value : Number(step.value);
            if (!Number.isFinite(value)) {
              throw new Error(`browser_snapshot action ${index} requires numeric value`);
            }
            await page.waitForTimeout(Math.max(0, value));
            actionResults.push({ index, action: "wait_ms", value });
            break;
          }
          default:
            break;
        }
      }
    }

    const title = await page.title();
    const html = await page.content();
    let htmlOut = html;
    let htmlBytes = Buffer.byteLength(htmlOut, "utf8");
    if (htmlBytes > maxHtmlBytes) {
      htmlOut = htmlOut.slice(0, maxHtmlBytes);
      htmlBytes = Buffer.byteLength(htmlOut, "utf8");
    }

    let screenshotBase64: string | undefined;
    let screenshotBytes: number | undefined;
    if (args.screenshot) {
      const buffer = await page.screenshot({ fullPage: args.fullPage ?? true, type: "png" });
      screenshotBase64 = buffer.toString("base64");
      screenshotBytes = buffer.byteLength;
    }

    await page.close();
    await pageContext.close();

    return {
      success: true,
      content: {
        url: args.url,
        title,
        html: htmlOut,
        screenshotBase64,
        actions: actionResults.length > 0 ? actionResults : undefined,
      },
      metadata: {
        htmlBytes,
        screenshotBytes,
      },
    };
  } catch (err) {
    return {
      success: false,
      error: `Browser snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
};

// ─── JSON PARSE TOOL ─────────────────────────────────────────

const jsonParseSchema = z.object({
  json: z.string().describe("JSON string to parse"),
  path: z.string().optional().describe("JSONPath expression to extract (e.g., '$.data.items')"),
});

const jsonParseDefinition: ToolDefinition = {
  id: "builtin:json_parse",
  name: "JSON Parse",
  description: "Parse a JSON string and optionally extract a specific path.",
  inputSchema: jsonParseSchema,
  category: "data",
  tags: ["json", "parse", "data"],
};

const jsonParseHandler: ToolHandler<z.infer<typeof jsonParseSchema>> = async (args) => {
  try {
    const parsed = JSON.parse(args.json);

    if (args.path) {
      // Simple path extraction (e.g., "data.items" or "$.data.items")
      const path = args.path.replace(/^\$\.?/, "");
      const keys = path.split(".");
      let value = parsed;

      for (const key of keys) {
        if (value && typeof value === "object" && key in value) {
          value = value[key];
        } else {
          return {
            success: false,
            error: `Path not found: ${args.path}`,
          };
        }
      }

      return { success: true, content: value };
    }

    return { success: true, content: parsed };
  } catch (err) {
    return {
      success: false,
      error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

// ─── STRING TRANSFORM TOOL ───────────────────────────────────

const stringTransformSchema = z.object({
  input: z.string().describe("Input string"),
  operation: z.enum([
    "uppercase",
    "lowercase",
    "trim",
    "reverse",
    "length",
    "base64_encode",
    "base64_decode",
    "url_encode",
    "url_decode",
  ]).describe("Transformation operation"),
});

const stringTransformDefinition: ToolDefinition = {
  id: "builtin:string_transform",
  name: "String Transform",
  description: "Transform a string using various operations.",
  inputSchema: stringTransformSchema,
  category: "data",
  tags: ["string", "transform", "text"],
};

const stringTransformHandler: ToolHandler<z.infer<typeof stringTransformSchema>> = async (args) => {
  try {
    let result: string | number;

    switch (args.operation) {
      case "uppercase":
        result = args.input.toUpperCase();
        break;
      case "lowercase":
        result = args.input.toLowerCase();
        break;
      case "trim":
        result = args.input.trim();
        break;
      case "reverse":
        result = args.input.split("").reverse().join("");
        break;
      case "length":
        result = args.input.length;
        break;
      case "base64_encode":
        result = Buffer.from(args.input).toString("base64");
        break;
      case "base64_decode":
        result = Buffer.from(args.input, "base64").toString("utf-8");
        break;
      case "url_encode":
        result = encodeURIComponent(args.input);
        break;
      case "url_decode":
        result = decodeURIComponent(args.input);
        break;
    }

    return {
      success: true,
      content: {
        input: args.input,
        operation: args.operation,
        result,
      },
    };
  } catch (err) {
    return {
      success: false,
      error: `Transform failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

// ─── RANDOM TOOL ─────────────────────────────────────────────

const randomSchema = z.object({
  type: z.enum(["number", "uuid", "string", "choice"]).describe("Type of random value"),
  min: z.number().optional().describe("Minimum value (for number)"),
  max: z.number().optional().describe("Maximum value (for number)"),
  length: z.number().optional().describe("Length (for string)"),
  choices: z.array(z.string()).optional().describe("Options to choose from (for choice)"),
});

const randomDefinition: ToolDefinition = {
  id: "builtin:random",
  name: "Random",
  description: "Generate random values (numbers, UUIDs, strings, or pick from choices).",
  inputSchema: randomSchema,
  category: "utility",
  tags: ["random", "generate"],
};

const randomHandler: ToolHandler<z.infer<typeof randomSchema>> = async (args) => {
  let result: string | number = "";

  switch (args.type) {
    case "number": {
      const min = args.min ?? 0;
      const max = args.max ?? 100;
      result = Math.floor(Math.random() * (max - min + 1)) + min;
      break;
    }
    case "uuid":
      result = crypto.randomUUID();
      break;
    case "string": {
      const length = args.length ?? 16;
      const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
      result = Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
      break;
    }
    case "choice": {
      if (!args.choices || args.choices.length === 0) {
        return { success: false, error: "No choices provided" };
      }
      result = args.choices[Math.floor(Math.random() * args.choices.length)]!;
      break;
    }
  }

  return {
    success: true,
    content: { type: args.type, result },
  };
};

// ─── SLEEP TOOL ──────────────────────────────────────────────

const sleepSchema = z.object({
  ms: z.number().min(0).max(30000).describe("Milliseconds to sleep (max 30 seconds)"),
});

const sleepDefinition: ToolDefinition = {
  id: "builtin:sleep",
  name: "Sleep",
  description: "Wait for a specified duration. Useful for rate limiting or delays.",
  inputSchema: sleepSchema,
  category: "utility",
  tags: ["wait", "delay", "sleep"],
};

const sleepHandler: ToolHandler<z.infer<typeof sleepSchema>> = async (args, context) => {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, args.ms);

    // Support cancellation
    if (context.signal) {
      context.signal.addEventListener("abort", () => {
        clearTimeout(timeout);
        reject(new Error("Sleep cancelled"));
      });
    }
  });

  return {
    success: true,
    content: { sleptMs: args.ms },
  };
};

// ─── REGISTER ALL BUILT-IN TOOLS ─────────────────────────────

/** All built-in tool definitions and handlers */
export const BUILTIN_TOOLS: Array<{
  definition: ToolDefinition;
  handler: ToolHandler<Record<string, unknown>>;
}> = [
  { definition: echoDefinition, handler: echoHandler as ToolHandler<Record<string, unknown>> },
  { definition: datetimeDefinition, handler: datetimeHandler as ToolHandler<Record<string, unknown>> },
  { definition: calculateDefinition, handler: calculateHandler as ToolHandler<Record<string, unknown>> },
  { definition: fileReadDefinition, handler: fileReadHandler as ToolHandler<Record<string, unknown>> },
  { definition: fileWriteDefinition, handler: fileWriteHandler as ToolHandler<Record<string, unknown>> },
  { definition: shellExecDefinition, handler: shellExecHandler as ToolHandler<Record<string, unknown>> },
  { definition: httpFetchDefinition, handler: httpFetchHandler as ToolHandler<Record<string, unknown>> },
  { definition: browserSnapshotDefinition, handler: browserSnapshotHandler as ToolHandler<Record<string, unknown>> },
  { definition: jsonParseDefinition, handler: jsonParseHandler as ToolHandler<Record<string, unknown>> },
  { definition: stringTransformDefinition, handler: stringTransformHandler as ToolHandler<Record<string, unknown>> },
  { definition: randomDefinition, handler: randomHandler as ToolHandler<Record<string, unknown>> },
  { definition: sleepDefinition, handler: sleepHandler as ToolHandler<Record<string, unknown>> },
];

/**
 * Register all built-in tools with a registry.
 */
export function registerBuiltinTools(registry: ToolRegistry): void {
  for (const { definition, handler } of BUILTIN_TOOLS) {
    registry.register(definition, handler);
  }
}

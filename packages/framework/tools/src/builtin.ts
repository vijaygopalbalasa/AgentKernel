// Built-in Tools — common tools that ship with Agent OS
// These are registered by default for all agents

import { z } from "zod";
import type { ToolDefinition, ToolHandler, ToolResult, ToolContext } from "./types.js";
import { ToolRegistry } from "./registry.js";

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

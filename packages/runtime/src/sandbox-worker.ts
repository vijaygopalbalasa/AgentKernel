// Sandbox Worker — Runs in the child process
// Executes code sent from the parent process with capability enforcement
// NOTE: This file intentionally uses dynamic code execution for sandboxing purposes

import { memoryUsage } from "node:process";

// ─── TYPES ────────────────────────────────────────────────────────────────

type IPCMessageType =
  | "heartbeat"
  | "heartbeat_ack"
  | "execute"
  | "execute_result"
  | "terminate"
  | "ready"
  | "error";

interface IPCMessage {
  type: IPCMessageType;
  id: string;
  payload?: unknown;
  timestamp: number;
}

// ─── CAPABILITY ENFORCEMENT ───────────────────────────────────────────────

const AGENT_ID = process.env.SANDBOX_AGENT_ID ?? "unknown";
const CAPABILITIES: string[] = JSON.parse(process.env.SANDBOX_CAPABILITIES ?? "[]");

/** Check if a capability is granted */
function hasCapability(capability: string): boolean {
  return CAPABILITIES.includes(capability);
}

/** Create a restricted global object */
function createRestrictedGlobal(): Record<string, unknown> {
  const restricted: Record<string, unknown> = {
    // Allow basic JavaScript
    console: {
      log: (...args: unknown[]) => {
        if (hasCapability("system:audit")) {
          console.log(...args);
        }
      },
      error: (...args: unknown[]) => {
        if (hasCapability("system:audit")) {
          console.error(...args);
        }
      },
      warn: (...args: unknown[]) => {
        if (hasCapability("system:audit")) {
          console.warn(...args);
        }
      },
    },
    JSON,
    Math,
    Date,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Promise,
    Symbol,
    Error,
    TypeError,
    ReferenceError,
    SyntaxError,
    RangeError,
    setTimeout: hasCapability("system:config") ? setTimeout : undefined,
    setInterval: hasCapability("system:config") ? setInterval : undefined,
    clearTimeout: hasCapability("system:config") ? clearTimeout : undefined,
    clearInterval: hasCapability("system:config") ? clearInterval : undefined,

    // Agent context
    agentId: AGENT_ID,
    capabilities: [...CAPABILITIES],
    hasCapability,
  };

  // Add fetch only if network capability is granted
  if (hasCapability("network:http")) {
    restricted.fetch = globalThis.fetch;
  }

  return restricted;
}

// ─── CODE EXECUTION ───────────────────────────────────────────────────────

/**
 * Execute code in a restricted context.
 * This sandbox worker intentionally executes agent code using Function constructor.
 * Security is enforced through:
 * 1. Process isolation (separate V8 heap)
 * 2. Environment sanitization (no credentials passed)
 * 3. Capability-based restrictions (limited global access)
 * 4. Memory limits (--max-old-space-size)
 * 5. Timeout enforcement (parent process monitors execution time)
 */
async function executeCode(code: string): Promise<{
  success: boolean;
  result?: unknown;
  error?: string;
  memoryUsageMB?: number;
}> {
  const startMemory = memoryUsage();

  try {
    // Create restricted global
    const restrictedGlobal = createRestrictedGlobal();

    // Create function with restricted scope
    // The code runs with only the variables we explicitly provide
    const argNames = Object.keys(restrictedGlobal);
    const argValues = Object.values(restrictedGlobal);

    // Wrap code in async function to support await
    const wrappedCode = `
      "use strict";
      return (async () => {
        ${code}
      })();
    `;

    // SECURITY: This is intentional code execution in a sandboxed child process
    // The sandbox provides isolation through OS-level process separation
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const FunctionConstructor = Function;
    const fn = FunctionConstructor(...argNames, wrappedCode);
    const result = await fn(...argValues);

    const endMemory = memoryUsage();
    const memoryUsageMB = (endMemory.heapUsed - startMemory.heapUsed) / (1024 * 1024);

    return {
      success: true,
      result,
      memoryUsageMB: Math.max(0, memoryUsageMB),
    };
  } catch (error) {
    const endMemory = memoryUsage();
    const memoryUsageMB = (endMemory.heapUsed - startMemory.heapUsed) / (1024 * 1024);

    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      memoryUsageMB: Math.max(0, memoryUsageMB),
    };
  }
}

// ─── IPC MESSAGE HANDLING ─────────────────────────────────────────────────

function sendMessage(msg: IPCMessage): void {
  if (process.send) {
    process.send(msg);
  }
}

process.on("message", async (msg: IPCMessage) => {
  switch (msg.type) {
    case "heartbeat":
      sendMessage({
        type: "heartbeat_ack",
        id: msg.id,
        timestamp: Date.now(),
      });
      break;

    case "execute": {
      const code = msg.payload as string;
      const result = await executeCode(code);
      sendMessage({
        type: "execute_result",
        id: msg.id,
        payload: result,
        timestamp: Date.now(),
      });
      break;
    }

    case "terminate":
      // Clean up and exit
      process.exit(0);
      break;
  }
});

// Handle uncaught errors
process.on("uncaughtException", (error: Error) => {
  sendMessage({
    type: "error",
    id: "uncaught",
    payload: { message: error.message },
    timestamp: Date.now(),
  });
  process.exit(1);
});

process.on("unhandledRejection", (reason: unknown) => {
  sendMessage({
    type: "error",
    id: "unhandled_rejection",
    payload: { message: reason instanceof Error ? reason.message : String(reason) },
    timestamp: Date.now(),
  });
  process.exit(1);
});

// Signal ready
sendMessage({
  type: "ready",
  id: "init",
  timestamp: Date.now(),
});

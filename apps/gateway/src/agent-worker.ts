// Agent Worker — isolated process for agent task execution

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

type InitMessage = {
  type: "init";
  agentId: string;
  entryPoint: string;
  name?: string;
};

type TaskMessage = {
  type: "task";
  taskId: string;
  task: Record<string, unknown>;
};

type ShutdownMessage = {
  type: "shutdown";
};

type IncomingMessage = InitMessage | TaskMessage | ShutdownMessage;

type AgentModule = {
  handleTask?: (task: Record<string, unknown>, context: { agentId: string; log: Logger }) => Promise<unknown> | unknown;
  initialize?: (context: { agentId: string; log: Logger }) => Promise<void> | void;
  terminate?: (context: { agentId: string; log: Logger }) => Promise<void> | void;
};

type Logger = {
  info: (text: string) => void;
  warn: (text: string) => void;
  error: (text: string) => void;
};

const state = {
  agentId: "",
  entryPoint: "",
  agent: null as AgentModule | null,
  initialized: false,
};

function sendMessage(message: unknown): void {
  if (process.send) {
    process.send(message);
    return;
  }
  try {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  } catch {
    // ignore
  }
}

const log: Logger = {
  info: (text) => sendMessage({ type: "log", level: "info", text }),
  warn: (text) => sendMessage({ type: "log", level: "warn", text }),
  error: (text) => sendMessage({ type: "log", level: "error", text }),
};

async function loadAgent(entryPoint: string): Promise<AgentModule> {
  const specifier = entryPoint.startsWith("file://")
    ? entryPoint
    : pathToFileURL(resolve(entryPoint)).href;

  const module = (await import(specifier)) as Record<string, unknown>;
  const candidate = (module.default ?? module.agent ?? module) as AgentModule;

  if (!candidate || typeof candidate.handleTask !== "function") {
    throw new Error("Agent entry point must export handleTask");
  }

  return candidate;
}

async function handleInit(message: InitMessage): Promise<void> {
  state.agentId = message.agentId;
  state.entryPoint = message.entryPoint;
  state.agent = await loadAgent(message.entryPoint);

  if (state.agent.initialize) {
    await state.agent.initialize({ agentId: state.agentId, log });
  }

  state.initialized = true;
  sendMessage({ type: "ready" });
}

async function handleTask(message: TaskMessage): Promise<void> {
  if (!state.agent || !state.initialized) {
    throw new Error("Agent not initialized");
  }

  try {
    const result = await state.agent.handleTask?.(message.task, {
      agentId: state.agentId,
      log,
    });

    sendMessage({
      type: "result",
      taskId: message.taskId,
      status: "ok",
      result,
    });
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    sendMessage({
      type: "result",
      taskId: message.taskId,
      status: "error",
      error: messageText,
    });
  }
}

async function handleShutdown(): Promise<void> {
  try {
    if (state.agent?.terminate) {
      await state.agent.terminate({ agentId: state.agentId, log });
    }
  } finally {
    process.exit(0);
  }
}

function handleIncomingMessage(raw: unknown): void {
  const message = raw as IncomingMessage;
  if (!message || typeof message !== "object") return;

  switch (message.type) {
    case "init":
      void handleInit(message).catch((error) => {
        log.error(`Agent init failed: ${error instanceof Error ? error.message : String(error)}`);
        sendMessage({ type: "result", taskId: "init", status: "error", error: String(error) });
        process.exit(1);
      });
      break;
    case "task":
      void handleTask(message).catch((error) => {
        log.error(`Agent task failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      break;
    case "shutdown":
      void handleShutdown();
      break;
    default:
      break;
  }
}

if (process.send) {
  process.on("message", (raw) => handleIncomingMessage(raw));
} else {
  process.stdin.setEncoding("utf-8");
  let buffer = "";
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let idx = buffer.indexOf("\n");
    while (idx >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line.length > 0) {
        try {
          const parsed = JSON.parse(line);
          handleIncomingMessage(parsed);
        } catch (error) {
          log.warn(`Failed to parse worker input: ${String(error)}`);
        }
      }
      idx = buffer.indexOf("\n");
    }
  });
}

const heartbeat = setInterval(() => {
  sendMessage({ type: "heartbeat", timestamp: Date.now() });
}, 10000);

process.on("exit", () => {
  clearInterval(heartbeat);
});

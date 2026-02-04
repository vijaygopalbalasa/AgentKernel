// Worker Manager — Worker transport creation, agent worker lifecycle, monitoring

import { fork, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { z } from "zod";
import { createLogger } from "@agentkernel/kernel";
import { responseToStream, type ModelRouter } from "@agentkernel/mal";
import { ok, err, type Result } from "@agentkernel/shared";
import type { JobRunner } from "@agentkernel/runtime";
import { type AgentEntry, type WorkerTransport, type WorkerRuntime } from "./gateway-types.js";
import type { TaskHandlerContext } from "./task-handler.js";
import { type ClientConnection, type WsMessage, ChatPayloadSchema, GatewayError } from "./types.js";
import { parseBoolean } from "./security-utils.js";
import {
  resolveWorkerRuntime,
  resolveDockerWorkerImage,
  resolveDockerWorkerNetwork,
  resolveDockerWorkerMount,
  resolveDockerTmpfs,
  resolveDockerSecurityOpts,
  resolveDockerCapDrop,
  resolveDockerUlimits,
  resolveDockerBlkioWeight,
  resolveDockerStorageOpts,
  applyDiskQuota,
  resolveStreamChunkSize,
  resolveWorkerScriptPath,
  resolveMaxAgentRestarts,
} from "./gateway-utils.js";

export function sendClientMessage(
  client: ClientConnection,
  message: WsMessage,
  log: ReturnType<typeof createLogger>
): void {
  const ws = client.ws as { send?: (data: string) => void; readyState?: number } | undefined;
  if (!ws || typeof ws.send !== "function") {
    log.warn("Unable to send message to client", { clientId: client.id, type: message.type });
    return;
  }
  if (typeof ws.readyState === "number" && ws.readyState !== 1) {
    log.warn("Client connection not open", { clientId: client.id, state: ws.readyState });
    return;
  }
  try {
    ws.send(JSON.stringify(message));
  } catch (error) {
    log.warn("Failed to send message to client", {
      clientId: client.id,
      type: message.type,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function streamChatToClient(
  client: ClientConnection,
  messageId: string | undefined,
  payload: z.infer<typeof ChatPayloadSchema>,
  router: ModelRouter,
  log: ReturnType<typeof createLogger>
): Promise<Result<void, GatewayError>> {
  const result = await router.route({
    model: payload.model ?? "claude-3-haiku-20240307",
    messages: payload.messages,
    maxTokens: payload.maxTokens ?? 1024,
    temperature: payload.temperature,
    stream: true,
  });

  if (!result.ok) {
    return err(new GatewayError(result.error.message, "PROVIDER_ERROR", client.id));
  }

  const chunkSize = resolveStreamChunkSize();
  let index = 0;
  for await (const chunk of responseToStream(result.value.content, result.value.model, chunkSize)) {
    sendClientMessage(client, {
      type: "chat_stream",
      id: messageId,
      payload: {
        delta: chunk.content,
        index,
      },
    }, log);
    index += 1;
  }

  sendClientMessage(client, {
    type: "chat_stream_end",
    id: messageId,
    payload: {
      content: result.value.content,
      model: result.value.model,
      usage: result.value.usage,
      finishReason: result.value.finishReason,
    },
  }, log);

  return ok(undefined);
}

export function resolveWorkerGatewayHost(runtime: WorkerRuntime): string {
  const override = process.env.AGENT_WORKER_GATEWAY_HOST?.trim();
  if (override) return override;
  if (runtime === "docker") {
    return "host.docker.internal";
  }
  return process.env.GATEWAY_HOST ?? "127.0.0.1";
}

export function resolveWorkerGatewayUrl(runtime: WorkerRuntime, host: string, port: string): string {
  const override = process.env.AGENT_WORKER_GATEWAY_URL?.trim();
  if (override) return override;
  if (runtime === "docker") {
    return `ws://${host}:${port}`;
  }
  return process.env.GATEWAY_URL ?? `ws://${host}:${port}`;
}

export function createIpcTransport(child: ChildProcess): WorkerTransport {
  const messageHandlers = new Set<(message: unknown) => void>();
  const exitHandlers = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>();

  child.on("message", (message: unknown) => {
    for (const handler of messageHandlers) {
      handler(message);
    }
  });

  child.on("exit", (code, signal) => {
    for (const handler of exitHandlers) {
      handler(code, signal);
    }
  });

  return {
    send: (message: unknown) => child.send?.(message as import("node:child_process").Serializable),
    onMessage: (handler) => {
      messageHandlers.add(handler);
    },
    onExit: (handler) => {
      exitHandlers.add(handler);
    },
    kill: (signal?: NodeJS.Signals) => {
      child.kill(signal);
    },
  };
}

export function createStdioTransport(child: ChildProcess, log: ReturnType<typeof createLogger>): WorkerTransport {
  const messageHandlers = new Set<(message: unknown) => void>();
  const exitHandlers = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>();
  let buffer = "";

  if (child.stdout) {
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let idx = buffer.indexOf("\n");
      while (idx >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line.length > 0) {
          try {
            const parsed = JSON.parse(line);
            for (const handler of messageHandlers) {
              handler(parsed);
            }
          } catch (error) {
            log.debug("Worker stdout parse error", { line, error: String(error) });
          }
        }
        idx = buffer.indexOf("\n");
      }
    });
  }

  if (child.stderr) {
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      const text = chunk.trim();
      if (text.length > 0) {
        log.warn("Worker stderr", { text });
      }
    });
  }

  child.on("exit", (code, signal) => {
    for (const handler of exitHandlers) {
      handler(code, signal);
    }
  });

  return {
    send: (message: unknown) => {
      if (child.stdin && child.stdin.writable) {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      }
    },
    onMessage: (handler) => {
      messageHandlers.add(handler);
    },
    onExit: (handler) => {
      exitHandlers.add(handler);
    },
    kill: (signal?: NodeJS.Signals) => {
      child.kill(signal);
    },
  };
}

export function resolveWorkerHeartbeatTimeoutMs(): number {
  const raw = process.env.AGENT_WORKER_HEARTBEAT_TIMEOUT_MS;
  if (!raw) return 30000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30000;
}

export function attachWorkerHandlers(
  agent: AgentEntry,
  transport: WorkerTransport,
  log: ReturnType<typeof createLogger>,
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void
): void {
  transport.onMessage((message: unknown) => {
    if (!message || typeof message !== "object") return;
    const payload = message as {
      type?: string;
      taskId?: string;
      status?: "ok" | "error";
      result?: unknown;
      error?: string;
      level?: string;
      text?: string;
      timestamp?: number;
    };

    switch (payload.type) {
      case "ready":
        agent.workerReady = true;
        agent.lastHeartbeatAt = Date.now();
        log.info("Agent worker ready", { agentId: agent.id });
        break;
      case "heartbeat":
        agent.lastHeartbeatAt = Date.now();
        break;
      case "log":
        if (payload.level === "error") {
          log.error(payload.text ?? "Agent worker error", { agentId: agent.id });
        } else if (payload.level === "warn") {
          log.warn(payload.text ?? "Agent worker warning", { agentId: agent.id });
        } else {
          log.info(payload.text ?? "Agent worker log", { agentId: agent.id });
        }
        break;
      case "result": {
        const taskId = payload.taskId;
        if (!taskId) return;
        const pending = agent.workerTasks.get(taskId);
        if (!pending) return;
        clearTimeout(pending.timeoutId);
        agent.workerTasks.delete(taskId);
        if (payload.status === "ok") {
          pending.resolve(payload.result);
        } else {
          pending.reject(new Error(payload.error ?? "Worker task failed"));
        }
        break;
      }
      default:
        break;
    }
  });

  transport.onExit((code, signal) => onExit(code, signal));
}

export function startAgentWorker(
  agent: AgentEntry,
  entryPoint: string,
  log: ReturnType<typeof createLogger>,
  defaultMemoryLimitMb: number
): void {
  const runtime = resolveWorkerRuntime();
  const maxMemoryMb = agent.limits.maxMemoryMB ?? defaultMemoryLimitMb;
  const gatewayHost = resolveWorkerGatewayHost(runtime);
  const gatewayPort = process.env.GATEWAY_PORT ?? "18800";
  const gatewayUrl = resolveWorkerGatewayUrl(runtime, gatewayHost, gatewayPort);

  const workerEnv = {
    AGENT_ID: agent.id,
    NODE_ENV: process.env.NODE_ENV ?? "production",
    LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
    GATEWAY_HOST: gatewayHost,
    GATEWAY_PORT: gatewayPort,
    GATEWAY_URL: gatewayUrl,
    GATEWAY_AUTH_TOKEN: process.env.GATEWAY_AUTH_TOKEN,
    INTERNAL_AUTH_TOKEN: process.env.INTERNAL_AUTH_TOKEN,
  } as Record<string, string | undefined>;

  let child: ChildProcess;
  let transport: WorkerTransport;

  if (runtime === "docker") {
    const image = resolveDockerWorkerImage();
    const network = resolveDockerWorkerNetwork();
    const disableNetwork = parseBoolean(process.env.AGENT_WORKER_DISABLE_NETWORK, false);
    const mountPath = resolveDockerWorkerMount();
    const workDir = mountPath ? "/agentkernel" : (process.env.AGENT_WORKER_DOCKER_WORKDIR?.trim() || "/app");
    const scriptPath = process.env.AGENT_WORKER_SCRIPT_PATH?.trim() || "apps/gateway/dist/agent-worker.js";
    const tmpfsEntries = resolveDockerTmpfs();
    const securityOpts = resolveDockerSecurityOpts();
    const capDrop = resolveDockerCapDrop();
    const ulimits = resolveDockerUlimits();
    const storageOpts = applyDiskQuota(resolveDockerStorageOpts(), agent.limits.diskQuotaMB);
    const blkioWeight = resolveDockerBlkioWeight();
    const cpuLimit = agent.limits.cpuCores !== undefined
      ? String(agent.limits.cpuCores)
      : process.env.AGENT_WORKER_DOCKER_CPUS?.trim();
    const readOnly = parseBoolean(process.env.AGENT_WORKER_DOCKER_READONLY, false);

    const args: string[] = ["run", "--rm", "-i", "--name", `agentos-worker-${agent.id}`];
    if (disableNetwork) {
      args.push("--network", "none");
    } else if (network) {
      args.push("--network", network);
    }
    if (mountPath) {
      args.push("-v", `${mountPath}:${workDir}:ro`);
    }
    if (maxMemoryMb && Number.isFinite(maxMemoryMb)) {
      args.push("--memory", `${maxMemoryMb}m`);
    }
    if (cpuLimit) {
      args.push("--cpus", cpuLimit);
    }
    const pidsLimit = process.env.AGENT_WORKER_DOCKER_PIDS_LIMIT?.trim();
    if (pidsLimit) {
      args.push("--pids-limit", pidsLimit);
    }
    if (readOnly) {
      args.push("--read-only");
    }
    const effectiveTmpfs = tmpfsEntries.length > 0
      ? tmpfsEntries
      : readOnly
        ? ["/tmp:rw,size=64m", "/var/tmp:rw,size=64m"]
        : [];
    for (const entry of effectiveTmpfs) {
      args.push("--tmpfs", entry);
    }
    for (const cap of capDrop) {
      args.push("--cap-drop", cap);
    }
    for (const limit of ulimits) {
      args.push("--ulimit", limit);
    }
    if (blkioWeight) {
      args.push("--blkio-weight", blkioWeight);
    }
    for (const opt of storageOpts) {
      args.push("--storage-opt", opt);
    }
    for (const opt of securityOpts) {
      args.push("--security-opt", opt);
    }
    args.push("-w", workDir);

    for (const [key, value] of Object.entries(workerEnv)) {
      if (value !== undefined && value !== "") {
        args.push("-e", `${key}=${value}`);
      }
    }

    const nodeArgs: string[] = ["node"];
    if (maxMemoryMb && Number.isFinite(maxMemoryMb)) {
      nodeArgs.push(`--max-old-space-size=${maxMemoryMb}`);
    }
    nodeArgs.push(scriptPath);

    args.push(image, ...nodeArgs);

    child = spawn("docker", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    transport = createStdioTransport(child, log);
  } else {
    const scriptPath = resolveWorkerScriptPath();
    if (!scriptPath) {
      log.warn("Agent worker script not found; running without process isolation", { agentId: agent.id });
      return;
    }

    const filteredExecArgs = process.execArgv.filter(
      (arg) => !arg.startsWith("--max-old-space-size")
    );
    const execArgv = maxMemoryMb && Number.isFinite(maxMemoryMb)
      ? [...filteredExecArgs, `--max-old-space-size=${maxMemoryMb}`]
      : filteredExecArgs;

    child = fork(scriptPath, [], {
      env: {
        ...process.env,
        ...workerEnv,
        AGENT_MAX_MEMORY_MB: maxMemoryMb ? String(maxMemoryMb) : undefined,
      },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      execArgv,
    });
    transport = createIpcTransport(child);
  }

  agent.worker = child;
  agent.workerTransport = transport;
  agent.workerReady = false;
  agent.shutdownRequested = false;

  attachWorkerHandlers(agent, transport, log, (code, signal) => {
    const message = signal ? `signal ${signal}` : `code ${code}`;
    log.warn("Agent worker exited", { agentId: agent.id, message });

    for (const pending of agent.workerTasks.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error("Worker exited"));
    }
    agent.workerTasks.clear();

    agent.worker = undefined;
    agent.workerTransport = undefined;
    agent.workerReady = false;

    if (agent.shutdownRequested || agent.state === "terminated") {
      return;
    }

    agent.restartAttempts += 1;
    const maxRestarts = resolveMaxAgentRestarts();
    if (agent.restartAttempts > maxRestarts) {
      agent.state = "error";
      log.error("Agent worker restart limit exceeded", {
        agentId: agent.id,
        restartAttempts: agent.restartAttempts,
      });
      return;
    }

    agent.restartBackoffMs = Math.min(30000, 1000 * 2 ** (agent.restartAttempts - 1));
    setTimeout(() => {
      if (agent.state === "terminated") return;
      startAgentWorker(agent, entryPoint, log, defaultMemoryLimitMb);
    }, agent.restartBackoffMs);
  });

  transport.send({
    type: "init",
    agentId: agent.id,
    entryPoint,
    name: agent.name,
  });
}

export async function sendTaskToWorker(
  agent: AgentEntry,
  task: Record<string, unknown>,
  timeoutMs: number,
  log: ReturnType<typeof createLogger>
): Promise<unknown> {
  if (!agent.worker || !agent.workerTransport || !agent.workerReady) {
    throw new Error("Agent worker not ready");
  }

  const taskId = randomUUID();
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      agent.workerTasks.delete(taskId);
      reject(new Error("Agent task timed out"));
      log.warn("Agent worker task timeout", { agentId: agent.id, taskId });
    }, timeoutMs);

    agent.workerTasks.set(taskId, { resolve, reject, timeoutId });
    if (!agent.workerTransport) {
      agent.workerTasks.delete(taskId);
      clearTimeout(timeoutId);
      reject(new Error("Agent worker not available"));
      return;
    }
    agent.workerTransport.send({ type: "task", taskId, task });
  });
}

export function unscheduleMonitorAgent(
  agentId: string,
  jobRunner: JobRunner
): void {
  jobRunner.unregister(`monitor:${agentId}`);
}

/** Context for scheduleMonitorAgent — extends TaskHandlerContext with monitor-specific fields */
export type MonitorContext = TaskHandlerContext & {
  handleTask: (task: Record<string, unknown>, agent: AgentEntry, ctx: TaskHandlerContext) => Promise<Record<string, unknown>>;
  updateState: (
    db: import("@agentkernel/kernel").Database,
    agentId: string,
    state: AgentEntry["state"],
    log: ReturnType<typeof createLogger>,
    options?: { fromState?: AgentEntry["state"]; reason?: string; event?: string }
  ) => Promise<void>;
};

export function scheduleMonitorAgent(
  agent: AgentEntry,
  intervalMs: number,
  jobRunner: JobRunner,
  ctx: MonitorContext
): void {
  if (!intervalMs || intervalMs <= 0) return;

  jobRunner.register(
    {
      id: `monitor:${agent.id}`,
      name: `Monitor ${agent.name}`,
      intervalMs,
      runImmediately: false,
      maxConsecutiveFailures: 5,
    },
    async () => {
      if (agent.state !== "ready" || !agent.workerReady) return;
      const previousState = agent.state;
      agent.state = "running";

      if (ctx.db) {
        await ctx.updateState(ctx.db, agent.id, "running", ctx.log, { fromState: previousState });
      }

      try {
        await ctx.handleTask(
          { type: "monitor_check" },
          agent,
          ctx
        );
        agent.state = "ready";
        if (ctx.db) {
          await ctx.updateState(ctx.db, agent.id, "ready", ctx.log, { fromState: "running" });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.log.warn("Scheduled monitor check failed", { agentId: agent.id, error: message });
        agent.state = previousState;
        if (ctx.db) {
          await ctx.updateState(ctx.db, agent.id, agent.state, ctx.log, {
            fromState: "running",
            reason: message,
          });
        }
        throw error;
      }
    }
  );
}

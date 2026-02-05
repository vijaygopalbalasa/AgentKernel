// Process Sandbox — Real OS-level isolation using child_process
// Provides true process isolation with memory limits, heartbeat monitoring, and IPC

import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Capability } from "./sandbox.js";

// ─── TYPES ────────────────────────────────────────────────────────────────

/** Configuration for spawning a sandboxed process */
export interface ProcessSandboxConfig {
  /** Unique agent identifier */
  agentId: string;
  /** Maximum memory in MB (enforced via --max-old-space-size) */
  maxMemoryMB: number;
  /** Execution timeout in milliseconds */
  timeoutMs: number;
  /** Isolated working directory (auto-created if not exists) */
  workDir?: string;
  /** Capabilities granted to the sandboxed process */
  capabilities: Capability[];
  /** Heartbeat interval in milliseconds (default: 5000) */
  heartbeatIntervalMs?: number;
  /** Path to the worker script (default: built-in worker) */
  workerScript?: string;
}

/** Result of executing code in the sandbox */
export interface SandboxExecutionResult {
  /** Whether execution succeeded */
  success: boolean;
  /** Return value from the code (if any) */
  result?: unknown;
  /** Error message (if failed) */
  error?: string;
  /** Execution duration in milliseconds */
  durationMs: number;
  /** Memory usage at end of execution */
  memoryUsageMB?: number;
}

/** Sandbox state */
export type SandboxState = "idle" | "starting" | "ready" | "executing" | "terminated" | "error";

/** IPC message types */
type IPCMessageType =
  | "heartbeat"
  | "heartbeat_ack"
  | "execute"
  | "execute_result"
  | "terminate"
  | "ready"
  | "error";

/** IPC message structure */
interface IPCMessage {
  type: IPCMessageType;
  id: string;
  payload?: unknown;
  timestamp: number;
}

// ─── ENVIRONMENT SANITIZATION ─────────────────────────────────────────────

/** Environment variables that should NOT be passed to sandboxed processes */
const BLOCKED_ENV_VARS = [
  // Credentials and API keys
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "GITHUB_TOKEN",
  "NPM_TOKEN",
  "DATABASE_URL",
  "REDIS_URL",
  // Security-sensitive
  "SSH_AUTH_SOCK",
  "GPG_AGENT_INFO",
  "GNUPGHOME",
  // Process control
  "NODE_OPTIONS",
  "NODE_ENV",
];

/** Get sanitized environment for child process */
function getSanitizedEnv(
  agentId: string,
  capabilities: Capability[],
  additionalEnv?: Record<string, string>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  // Copy only safe environment variables
  for (const [key, value] of Object.entries(process.env)) {
    if (!BLOCKED_ENV_VARS.includes(key) && !key.startsWith("_")) {
      env[key] = value;
    }
  }

  // Add sandbox-specific environment
  env.SANDBOX_AGENT_ID = agentId;
  env.SANDBOX_CAPABILITIES = JSON.stringify(capabilities);
  env.SANDBOX_MODE = "true";
  env.NODE_ENV = "sandbox";

  // Add any additional environment (also sanitized)
  if (additionalEnv) {
    for (const [key, value] of Object.entries(additionalEnv)) {
      if (!BLOCKED_ENV_VARS.includes(key)) {
        env[key] = value;
      }
    }
  }

  return env;
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

function resolveDefaultWorkerScript(): string {
  const jsWorkerScript = join(MODULE_DIR, "sandbox-worker.js");
  if (existsSync(jsWorkerScript)) {
    return jsWorkerScript;
  }

  // Fallback for source/test environments where TypeScript sources are executed directly.
  return join(MODULE_DIR, "sandbox-worker.ts");
}

// ─── PROCESS SANDBOX ──────────────────────────────────────────────────────

/**
 * ProcessSandbox — Real OS-level isolation using child_process.
 *
 * Key security features:
 * - **Memory isolation**: Each agent runs in a separate V8 heap with --max-old-space-size
 * - **Process isolation**: Crashes in agent code don't affect the parent process
 * - **Environment sanitization**: Credentials are not passed to child processes
 * - **Heartbeat monitoring**: Detect and terminate hung processes
 * - **Timeout enforcement**: Kill processes that exceed execution time
 * - **Working directory isolation**: Each agent has its own temp directory
 */
export class ProcessSandbox {
  private process: ChildProcess | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastHeartbeat = 0;
  private state: SandboxState = "idle";
  private pendingExecutions: Map<
    string,
    {
      resolve: (result: SandboxExecutionResult) => void;
      reject: (error: Error) => void;
      startTime: number;
      timeoutTimer: NodeJS.Timeout;
    }
  > = new Map();
  private workDir: string;
  private readonly config: Required<ProcessSandboxConfig>;

  constructor(config: ProcessSandboxConfig) {
    this.config = {
      heartbeatIntervalMs: 5000,
      workerScript: resolveDefaultWorkerScript(),
      workDir: config.workDir ?? join(tmpdir(), "agentkernel-sandbox", config.agentId),
      ...config,
    };
    this.workDir = this.config.workDir;
  }

  /** Get current sandbox state */
  getState(): SandboxState {
    return this.state;
  }

  /** Get the agent ID */
  getAgentId(): string {
    return this.config.agentId;
  }

  /** Get the process PID (if running) */
  getPid(): number | undefined {
    return this.process?.pid;
  }

  /**
   * Spawn the sandboxed child process.
   */
  async spawn(): Promise<void> {
    if (this.state !== "idle") {
      throw new Error(`Cannot spawn: sandbox is in state "${this.state}"`);
    }

    this.state = "starting";

    // Ensure working directory exists
    if (!existsSync(this.workDir)) {
      mkdirSync(this.workDir, { recursive: true });
    }
    if (!existsSync(this.config.workerScript)) {
      throw new Error(`Sandbox worker script not found: ${this.config.workerScript}`);
    }

    return new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.state = "error";
        reject(new Error("Sandbox spawn timeout"));
      }, 30000);

      try {
        // Fork with memory limit
        this.process = fork(this.config.workerScript, [], {
          execArgv: [`--max-old-space-size=${this.config.maxMemoryMB}`, "--no-warnings"],
          cwd: this.workDir,
          env: getSanitizedEnv(this.config.agentId, this.config.capabilities),
          stdio: ["pipe", "pipe", "pipe", "ipc"],
          detached: false,
        });

        // Handle process events
        this.process.on("message", (msg: IPCMessage) => {
          this.handleMessage(msg);
          if (msg.type === "ready") {
            clearTimeout(timeoutId);
            this.state = "ready";
            this.startHeartbeatMonitor();
            resolve();
          }
        });

        this.process.on("error", (error: Error) => {
          clearTimeout(timeoutId);
          this.state = "error";
          this.cleanup();
          reject(error);
        });

        this.process.on("exit", (code: number | null, signal: string | null) => {
          this.handleExit(code, signal);
        });

        // Capture stdout/stderr for debugging
        this.process.stdout?.on("data", (data: Buffer) => {
          // In production, this would be logged to the audit system
          process.env.SANDBOX_DEBUG &&
            console.log(`[Sandbox ${this.config.agentId}] stdout:`, data.toString());
        });

        this.process.stderr?.on("data", (data: Buffer) => {
          process.env.SANDBOX_DEBUG &&
            console.error(`[Sandbox ${this.config.agentId}] stderr:`, data.toString());
        });
      } catch (error) {
        clearTimeout(timeoutId);
        this.state = "error";
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Execute code in the sandbox.
   */
  async execute(code: string): Promise<SandboxExecutionResult> {
    if (this.state !== "ready") {
      return {
        success: false,
        error: `Cannot execute: sandbox is in state "${this.state}"`,
        durationMs: 0,
      };
    }

    const executionId = randomUUID();
    const startTime = Date.now();

    return new Promise<SandboxExecutionResult>((resolve, reject) => {
      const timeoutTimer = setTimeout(() => {
        this.pendingExecutions.delete(executionId);
        resolve({
          success: false,
          error: `Execution timeout after ${this.config.timeoutMs}ms`,
          durationMs: Date.now() - startTime,
        });
        // Terminate the sandbox on timeout
        this.terminate().catch(() => {});
      }, this.config.timeoutMs);

      this.pendingExecutions.set(executionId, {
        resolve,
        reject,
        startTime,
        timeoutTimer,
      });

      this.state = "executing";
      this.sendMessage({
        type: "execute",
        id: executionId,
        payload: code,
        timestamp: Date.now(),
      });
    });
  }

  /**
   * Terminate the sandbox gracefully.
   */
  async terminate(): Promise<void> {
    if (this.state === "terminated" || !this.process) {
      return;
    }

    this.state = "terminated";

    // Send terminate message first (graceful)
    this.sendMessage({
      type: "terminate",
      id: randomUUID(),
      timestamp: Date.now(),
    });

    // Give it a moment to clean up
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Force kill if still running
    if (this.process && !this.process.killed) {
      this.process.kill("SIGTERM");

      // Force kill after 5 seconds
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill("SIGKILL");
        }
      }, 5000);
    }

    this.cleanup();
  }

  /**
   * Force kill the sandbox immediately.
   */
  forceKill(): void {
    if (this.process && !this.process.killed) {
      this.process.kill("SIGKILL");
    }
    this.state = "terminated";
    this.cleanup();
  }

  /** Handle incoming IPC message */
  private handleMessage(msg: IPCMessage): void {
    switch (msg.type) {
      case "heartbeat_ack":
        this.lastHeartbeat = Date.now();
        break;

      case "execute_result": {
        const pending = this.pendingExecutions.get(msg.id);
        if (pending) {
          clearTimeout(pending.timeoutTimer);
          this.pendingExecutions.delete(msg.id);
          this.state = "ready";

          const payload = msg.payload as {
            success: boolean;
            result?: unknown;
            error?: string;
            memoryUsageMB?: number;
          };

          pending.resolve({
            success: payload.success,
            result: payload.result,
            error: payload.error,
            durationMs: Date.now() - pending.startTime,
            memoryUsageMB: payload.memoryUsageMB,
          });
        }
        break;
      }

      case "error": {
        const errorPayload = msg.payload as { message: string };
        // Reject all pending executions
        for (const [id, pending] of this.pendingExecutions) {
          clearTimeout(pending.timeoutTimer);
          pending.resolve({
            success: false,
            error: errorPayload.message,
            durationMs: Date.now() - pending.startTime,
          });
        }
        this.pendingExecutions.clear();
        this.state = "error";
        break;
      }
    }
  }

  /** Handle process exit */
  private handleExit(code: number | null, signal: string | null): void {
    // Reject all pending executions
    for (const [_id, pending] of this.pendingExecutions) {
      clearTimeout(pending.timeoutTimer);
      pending.resolve({
        success: false,
        error: `Process exited with code ${code}, signal ${signal}`,
        durationMs: Date.now() - pending.startTime,
      });
    }
    this.pendingExecutions.clear();
    this.state = "terminated";
    this.cleanup();
  }

  /** Send IPC message to child process */
  private sendMessage(msg: IPCMessage): boolean {
    if (!this.process || !this.process.connected) {
      return false;
    }
    try {
      this.process.send(msg);
      return true;
    } catch {
      return false;
    }
  }

  /** Start heartbeat monitoring */
  private startHeartbeatMonitor(): void {
    this.lastHeartbeat = Date.now();

    this.heartbeatTimer = setInterval(() => {
      // Send heartbeat
      this.sendMessage({
        type: "heartbeat",
        id: randomUUID(),
        timestamp: Date.now(),
      });

      // Check if we missed too many heartbeats
      const timeSinceLastHeartbeat = Date.now() - this.lastHeartbeat;
      if (timeSinceLastHeartbeat > this.config.heartbeatIntervalMs * 3) {
        // Process is hung, terminate it
        console.error(`[Sandbox ${this.config.agentId}] Heartbeat timeout, terminating`);
        this.forceKill();
      }
    }, this.config.heartbeatIntervalMs);
  }

  /** Clean up resources */
  private cleanup(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Clean up working directory
    try {
      if (existsSync(this.workDir) && this.workDir.includes("agentkernel-sandbox")) {
        rmSync(this.workDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }

    this.process = null;
  }
}

// ─── SANDBOX REGISTRY ─────────────────────────────────────────────────────

/**
 * Registry for managing multiple sandboxed processes.
 */
export class ProcessSandboxRegistry {
  private sandboxes: Map<string, ProcessSandbox> = new Map();

  /** Create and spawn a new sandbox */
  async create(config: ProcessSandboxConfig): Promise<ProcessSandbox> {
    if (this.sandboxes.has(config.agentId)) {
      throw new Error(`Sandbox for agent ${config.agentId} already exists`);
    }

    const sandbox = new ProcessSandbox(config);
    await sandbox.spawn();
    this.sandboxes.set(config.agentId, sandbox);
    return sandbox;
  }

  /** Get an existing sandbox */
  get(agentId: string): ProcessSandbox | undefined {
    return this.sandboxes.get(agentId);
  }

  /** Terminate and remove a sandbox */
  async terminate(agentId: string): Promise<boolean> {
    const sandbox = this.sandboxes.get(agentId);
    if (!sandbox) {
      return false;
    }

    await sandbox.terminate();
    this.sandboxes.delete(agentId);
    return true;
  }

  /** Terminate all sandboxes */
  async terminateAll(): Promise<void> {
    const promises = Array.from(this.sandboxes.values()).map((sandbox) => sandbox.terminate());
    await Promise.all(promises);
    this.sandboxes.clear();
  }

  /** Get all sandbox agent IDs */
  getAgentIds(): string[] {
    return Array.from(this.sandboxes.keys());
  }

  /** Get count of active sandboxes */
  get count(): number {
    return this.sandboxes.size;
  }
}

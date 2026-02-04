// WorkerSandbox — Real process isolation using Node.js worker_threads
// Provides memory limits, CPU timeout, and isolated code execution

import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

/** Resource limits for the sandbox */
export interface SandboxResourceLimits {
  /** Max heap size in MB (default: 64MB) */
  maxHeapSizeMB: number;
  /** Max execution time in ms (default: 30000) */
  timeoutMs: number;
  /** Max stack size in MB (default: 4MB) */
  maxStackSizeMB: number;
}

/** Default resource limits */
export const DEFAULT_SANDBOX_LIMITS: SandboxResourceLimits = {
  maxHeapSizeMB: 64,
  timeoutMs: 30000,
  maxStackSizeMB: 4,
};

/** Execution request sent to worker */
interface ExecutionRequest {
  id: string;
  code: string;
  context: Record<string, unknown>;
}

/** Execution response from worker */
interface ExecutionResponse {
  id: string;
  success: boolean;
  result?: unknown;
  error?: string;
  executionTimeMs: number;
}

/** Sandbox execution result */
export interface SandboxResult {
  success: boolean;
  result?: unknown;
  error?: string;
  executionTimeMs: number;
  terminated: boolean;
}

/** Worker state */
type WorkerState = "idle" | "executing" | "terminated";

/**
 * WorkerSandbox — isolated code execution using worker_threads.
 * 
 * Features:
 * - Memory limits via V8 resourceLimits
 * - Execution timeout enforcement
 * - Isolated global scope (no access to parent's globals)
 * - Clean IPC via structured clone
 * - Graceful and forced termination
 */
export class WorkerSandbox {
  private worker: Worker | null = null;
  private state: WorkerState = "idle";
  private limits: SandboxResourceLimits;
  private pendingExecutions: Map<string, {
    resolve: (result: SandboxResult) => void;
    timer: NodeJS.Timeout;
    startTime: number;
  }> = new Map();

  constructor(limits: Partial<SandboxResourceLimits> = {}) {
    this.limits = { ...DEFAULT_SANDBOX_LIMITS, ...limits };
  }

  /** Start the worker thread */
  async start(): Promise<void> {
    if (this.worker) {
      throw new Error("Sandbox already started");
    }

    // Get the path to this file for the worker
    const workerPath = fileURLToPath(import.meta.url);

    this.worker = new Worker(workerPath, {
      workerData: { isSandboxWorker: true },
      resourceLimits: {
        maxYoungGenerationSizeMb: Math.ceil(this.limits.maxHeapSizeMB / 4),
        maxOldGenerationSizeMb: this.limits.maxHeapSizeMB,
        stackSizeMb: this.limits.maxStackSizeMB,
      },
    });

    this.state = "idle";

    // Handle messages from worker
    this.worker.on("message", (response: ExecutionResponse) => {
      const pending = this.pendingExecutions.get(response.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingExecutions.delete(response.id);
        this.state = "idle";

        pending.resolve({
          success: response.success,
          result: response.result,
          error: response.error,
          executionTimeMs: response.executionTimeMs,
          terminated: false,
        });
      }
    });

    // Handle worker errors
    this.worker.on("error", (error: Error) => {
      this.handleWorkerError(error);
    });

    // Handle worker exit
    this.worker.on("exit", (code) => {
      this.handleWorkerExit(code);
    });

    // Wait for worker to be ready
    await new Promise<void>((resolve, reject) => {
      const readyTimeout = setTimeout(() => {
        reject(new Error("Worker failed to start within 5 seconds"));
      }, 5000);

      const onMessage = (msg: unknown) => {
        if (msg === "ready") {
          clearTimeout(readyTimeout);
          this.worker?.off("message", onMessage);
          resolve();
        }
      };

      this.worker!.on("message", onMessage);
    });
  }

  /** Execute code in the sandbox */
  async execute(code: string, context: Record<string, unknown> = {}): Promise<SandboxResult> {
    if (!this.worker || this.state === "terminated") {
      throw new Error("Sandbox not started or terminated");
    }

    if (this.state === "executing") {
      throw new Error("Sandbox is already executing code");
    }

    const id = randomUUID();
    const startTime = Date.now();
    this.state = "executing";

    return new Promise<SandboxResult>((resolve) => {
      // Set up timeout
      const timer = setTimeout(() => {
        this.pendingExecutions.delete(id);
        this.terminate();

        resolve({
          success: false,
          error: `Execution timeout (${this.limits.timeoutMs}ms exceeded)`,
          executionTimeMs: Date.now() - startTime,
          terminated: true,
        });
      }, this.limits.timeoutMs);

      // Store pending execution
      this.pendingExecutions.set(id, { resolve, timer, startTime });

      // Send execution request to worker
      const request: ExecutionRequest = { id, code, context };
      this.worker!.postMessage(request);
    });
  }

  /** Terminate the worker */
  terminate(): void {
    if (this.worker && this.state !== "terminated") {
      // Reject all pending executions
      for (const [, pending] of this.pendingExecutions) {
        clearTimeout(pending.timer);
        pending.resolve({
          success: false,
          error: "Sandbox terminated",
          executionTimeMs: Date.now() - pending.startTime,
          terminated: true,
        });
      }
      this.pendingExecutions.clear();

      this.worker.terminate();
      this.worker = null;
      this.state = "terminated";
    }
  }

  /** Check if sandbox is available for execution */
  isAvailable(): boolean {
    return this.worker !== null && this.state === "idle";
  }

  /** Check if sandbox is terminated */
  isTerminated(): boolean {
    return this.state === "terminated";
  }

  /** Get current state */
  getState(): WorkerState {
    return this.state;
  }

  private handleWorkerError(error: Error): void {
    // Reject all pending executions with the error
    for (const [, pending] of this.pendingExecutions) {
      clearTimeout(pending.timer);
      pending.resolve({
        success: false,
        error: `Worker error: ${error.message}`,
        executionTimeMs: Date.now() - pending.startTime,
        terminated: true,
      });
    }
    this.pendingExecutions.clear();
    this.state = "terminated";
    this.worker = null;
  }

  private handleWorkerExit(code: number): void {
    if (code !== 0) {
      // Reject any pending executions
      for (const [, pending] of this.pendingExecutions) {
        clearTimeout(pending.timer);
        pending.resolve({
          success: false,
          error: `Worker exited with code ${code}`,
          executionTimeMs: Date.now() - pending.startTime,
          terminated: true,
        });
      }
      this.pendingExecutions.clear();
    }
    this.state = "terminated";
    this.worker = null;
  }
}

/**
 * SandboxPool — manages multiple sandbox workers for concurrent execution.
 */
export class SandboxPool {
  private sandboxes: WorkerSandbox[] = [];
  private limits: SandboxResourceLimits;
  private poolSize: number;
  private initialized = false;

  constructor(poolSize: number = 4, limits: Partial<SandboxResourceLimits> = {}) {
    this.poolSize = poolSize;
    this.limits = { ...DEFAULT_SANDBOX_LIMITS, ...limits };
  }

  /** Initialize the pool */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const startPromises = [];
    for (let i = 0; i < this.poolSize; i++) {
      const sandbox = new WorkerSandbox(this.limits);
      this.sandboxes.push(sandbox);
      startPromises.push(sandbox.start());
    }

    await Promise.all(startPromises);
    this.initialized = true;
  }

  /** Execute code in an available sandbox */
  async execute(code: string, context: Record<string, unknown> = {}): Promise<SandboxResult> {
    if (!this.initialized) {
      await this.initialize();
    }

    // Find an available sandbox
    let sandbox = this.sandboxes.find((s) => s.isAvailable());

    // If none available, replace a terminated one or wait
    if (!sandbox) {
      const terminatedIndex = this.sandboxes.findIndex((s) => s.isTerminated());
      if (terminatedIndex >= 0) {
        const newSandbox = new WorkerSandbox(this.limits);
        await newSandbox.start();
        this.sandboxes[terminatedIndex] = newSandbox;
        sandbox = newSandbox;
      } else {
        // Wait for one to become available (simple polling)
        for (let i = 0; i < 100; i++) {
          await new Promise((r) => setTimeout(r, 100));
          sandbox = this.sandboxes.find((s) => s.isAvailable());
          if (sandbox) break;
        }
      }
    }

    if (!sandbox) {
      return {
        success: false,
        error: "No sandbox available",
        executionTimeMs: 0,
        terminated: false,
      };
    }

    const result = await sandbox.execute(code, context);

    // Replace terminated sandboxes
    if (sandbox.isTerminated()) {
      const index = this.sandboxes.indexOf(sandbox);
      if (index >= 0) {
        const newSandbox = new WorkerSandbox(this.limits);
        newSandbox.start().catch(() => {});
        this.sandboxes[index] = newSandbox;
      }
    }

    return result;
  }

  /** Shutdown all sandboxes */
  shutdown(): void {
    for (const sandbox of this.sandboxes) {
      sandbox.terminate();
    }
    this.sandboxes = [];
    this.initialized = false;
  }

  /** Get pool statistics */
  getStats(): { total: number; available: number; executing: number; terminated: number } {
    return {
      total: this.sandboxes.length,
      available: this.sandboxes.filter((s) => s.isAvailable()).length,
      executing: this.sandboxes.filter((s) => s.getState() === "executing").length,
      terminated: this.sandboxes.filter((s) => s.isTerminated()).length,
    };
  }
}

// ─── WORKER CODE ─────────────────────────────────────────────
// This code runs inside the worker thread

if (!isMainThread && workerData?.isSandboxWorker) {
  // Minimal sandbox context - only safe globals
  const safeGlobals = {
    console: {
      log: (..._args: unknown[]) => {},
      warn: (..._args: unknown[]) => {},
      error: (..._args: unknown[]) => {},
      info: (..._args: unknown[]) => {},
      debug: (..._args: unknown[]) => {},
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
    RegExp,
    Error,
    TypeError,
    RangeError,
    SyntaxError,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURI,
    decodeURI,
    encodeURIComponent,
    decodeURIComponent,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, Math.min(ms, 30000)),
    clearTimeout,
    setInterval: (fn: () => void, ms: number) => setInterval(fn, Math.max(ms, 100)),
    clearInterval,
  };

  // Signal ready
  parentPort!.postMessage("ready");

  // Handle execution requests
  parentPort!.on("message", (request: ExecutionRequest) => {
    const startTime = Date.now();

    try {
      // Create sandbox context with user-provided context merged
      const context = { ...safeGlobals, ...request.context };

      // Create function from code and execute
      // Using Function constructor to avoid eval (slightly safer)
      const fn = new Function(
        ...Object.keys(context),
        `"use strict"; return (async () => { ${request.code} })();`
      );

      // Execute with context values
      const resultPromise = fn(...Object.values(context));

      // Handle both sync and async results
      Promise.resolve(resultPromise)
        .then((result) => {
          const response: ExecutionResponse = {
            id: request.id,
            success: true,
            result,
            executionTimeMs: Date.now() - startTime,
          };
          parentPort!.postMessage(response);
        })
        .catch((error) => {
          const response: ExecutionResponse = {
            id: request.id,
            success: false,
            error: error instanceof Error ? error.message : String(error),
            executionTimeMs: Date.now() - startTime,
          };
          parentPort!.postMessage(response);
        });
    } catch (error) {
      const response: ExecutionResponse = {
        id: request.id,
        success: false,
        error: error instanceof Error ? error.message : String(error),
        executionTimeMs: Date.now() - startTime,
      };
      parentPort!.postMessage(response);
    }
  });
}

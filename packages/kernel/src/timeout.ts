// Timeout Enforcement Utilities
// Every external call must have an explicit timeout

import { z } from "zod";

// ─── TYPES ──────────────────────────────────────────────────

export class TimeoutError extends Error {
  constructor(
    public readonly operation: string,
    public readonly target: string,
    public readonly durationMs: number,
  ) {
    super(`Timeout after ${durationMs}ms for ${operation} on ${target}`);
    this.name = "TimeoutError";
  }
}

export const TimeoutConfigSchema = z.object({
  dbQuery: z.number().min(100).default(10000), // 10s
  llmApi: z.number().min(1000).default(120000), // 120s
  llmStreaming: z.number().min(1000).default(300000), // 5min for streaming
  mcpTool: z.number().min(100).default(30000), // 30s
  a2aTask: z.number().min(1000).default(60000), // 60s
  agentTask: z.number().min(1000).default(300000), // 5min
  httpRequest: z.number().min(100).default(30000), // 30s
  wsConnection: z.number().min(100).default(10000), // 10s
});

export type TimeoutConfig = z.infer<typeof TimeoutConfigSchema>;

// ─── DEFAULT TIMEOUTS ───────────────────────────────────────

export const defaultTimeouts: TimeoutConfig = {
  dbQuery: 10000,
  llmApi: 120000,
  llmStreaming: 300000,
  mcpTool: 30000,
  a2aTask: 60000,
  agentTask: 300000,
  httpRequest: 30000,
  wsConnection: 10000,
};

let currentTimeouts = { ...defaultTimeouts };

/**
 * Configure timeout values.
 */
export function configureTimeouts(config: Partial<TimeoutConfig>): void {
  currentTimeouts = { ...currentTimeouts, ...config };
}

/**
 * Get current timeout configuration.
 */
export function getTimeouts(): TimeoutConfig {
  return { ...currentTimeouts };
}

// ─── TIMEOUT WRAPPER ────────────────────────────────────────

/**
 * Execute a promise with a timeout.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string,
  target: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(operation, target, timeoutMs));
    }, timeoutMs);

    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

/**
 * Create an AbortController with timeout.
 */
export function createTimeoutController(timeoutMs: number): {
  controller: AbortController;
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  return {
    controller,
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  };
}

// ─── TYPED TIMEOUT WRAPPERS ─────────────────────────────────

/**
 * Execute a database query with timeout.
 */
export function withDbTimeout<T>(
  promise: Promise<T>,
  target: string,
  customTimeout?: number,
): Promise<T> {
  return withTimeout(promise, customTimeout ?? currentTimeouts.dbQuery, "database query", target);
}

/**
 * Execute an LLM API call with timeout.
 */
export function withLlmTimeout<T>(
  promise: Promise<T>,
  target: string,
  streaming = false,
  customTimeout?: number,
): Promise<T> {
  const timeout =
    customTimeout ?? (streaming ? currentTimeouts.llmStreaming : currentTimeouts.llmApi);
  return withTimeout(promise, timeout, "LLM API call", target);
}

/**
 * Execute an MCP tool call with timeout.
 */
export function withMcpTimeout<T>(
  promise: Promise<T>,
  toolName: string,
  customTimeout?: number,
): Promise<T> {
  return withTimeout(promise, customTimeout ?? currentTimeouts.mcpTool, "MCP tool", toolName);
}

/**
 * Execute an A2A task with timeout.
 */
export function withA2aTimeout<T>(
  promise: Promise<T>,
  targetAgent: string,
  customTimeout?: number,
): Promise<T> {
  return withTimeout(promise, customTimeout ?? currentTimeouts.a2aTask, "A2A task", targetAgent);
}

/**
 * Execute an agent task with timeout.
 */
export function withAgentTaskTimeout<T>(
  promise: Promise<T>,
  agentId: string,
  customTimeout?: number,
): Promise<T> {
  return withTimeout(promise, customTimeout ?? currentTimeouts.agentTask, "agent task", agentId);
}

/**
 * Execute an HTTP request with timeout.
 */
export function withHttpTimeout<T>(
  promise: Promise<T>,
  url: string,
  customTimeout?: number,
): Promise<T> {
  return withTimeout(promise, customTimeout ?? currentTimeouts.httpRequest, "HTTP request", url);
}

// ─── DEADLINE UTILITY ───────────────────────────────────────

/**
 * Create a deadline tracker for multi-step operations.
 */
export class Deadline {
  private readonly deadline: number;
  private readonly operation: string;

  constructor(timeoutMs: number, operation: string) {
    this.deadline = Date.now() + timeoutMs;
    this.operation = operation;
  }

  /**
   * Check if deadline has passed.
   */
  isExpired(): boolean {
    return Date.now() >= this.deadline;
  }

  /**
   * Get remaining time in ms.
   */
  remaining(): number {
    return Math.max(0, this.deadline - Date.now());
  }

  /**
   * Throw if deadline has passed.
   */
  check(): void {
    if (this.isExpired()) {
      throw new TimeoutError(this.operation, "deadline", this.deadline - Date.now());
    }
  }

  /**
   * Execute a promise with remaining deadline time.
   */
  async run<T>(promise: Promise<T>, stepName: string): Promise<T> {
    const remaining = this.remaining();
    if (remaining <= 0) {
      throw new TimeoutError(this.operation, stepName, 0);
    }
    return withTimeout(promise, remaining, this.operation, stepName);
  }
}

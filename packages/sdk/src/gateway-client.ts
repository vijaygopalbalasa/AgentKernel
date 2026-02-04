import { WebSocket } from "ws";
import { z } from "zod";

type RawData = WebSocket.RawData;

/** Zod schema for validating gateway client options */
export const GatewayClientOptionsSchema = z.object({
  url: z.string().min(1).url(),
  agentId: z.string().min(1),
  authToken: z.string().optional(),
  internalToken: z.string().optional(),
  timeoutMs: z.number().int().min(1000).max(300000).optional(),
  /** Number of retry attempts on connection failure (default: 3) */
  retries: z.number().int().min(0).max(10).optional(),
  /** Base delay in ms between retries, doubled each attempt (default: 1000) */
  retryDelayMs: z.number().int().min(100).max(30000).optional(),
});

export interface GatewayClientOptions {
  url: string;
  agentId: string;
  authToken?: string;
  internalToken?: string;
  timeoutMs?: number;
  /** Number of retry attempts on connection failure (default: 3) */
  retries?: number;
  /** Base delay in ms between retries, doubled each attempt (default: 1000) */
  retryDelayMs?: number;
}

export interface GatewayTaskResult<T = unknown> {
  ok: boolean;
  result?: T;
  error?: string;
}

/** Error returned when gateway client options validation fails */
export class GatewayValidationError extends Error {
  constructor(public readonly issues: z.ZodIssue[]) {
    super(`Invalid gateway client options: ${issues.map(i => i.message).join(", ")}`);
    this.name = "GatewayValidationError";
  }
}

/** Sleep utility for retry backoff */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Execute a single WebSocket task attempt */
function attemptGatewayTask<T>(
  options: GatewayClientOptions,
  task: Record<string, unknown>,
  internal: boolean,
): Promise<GatewayTaskResult<T>> {
  const timeoutMs = options.timeoutMs ?? 30000;
  const messageId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const authId = options.authToken ? `auth-${messageId}` : undefined;

  return new Promise((resolve) => {
    const ws = new WebSocket(options.url);
    let taskSent = false;
    let settled = false;

    function finish(result: GatewayTaskResult<T>): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      try { ws.close(); } catch { /* ignore close errors */ }
      resolve(result);
    }

    const timeoutId = setTimeout(() => {
      finish({ ok: false, error: "Gateway request timed out" });
    }, timeoutMs);

    ws.on("open", () => {
      if (options.authToken) {
        ws.send(JSON.stringify({
          type: "auth",
          id: authId,
          payload: { token: options.authToken },
        }));
      } else {
        sendTask();
      }
    });

    ws.on("message", (data: RawData) => {
      try {
        const message = JSON.parse(data.toString());
        if (authId && message.id === authId) {
          if (message.type === "auth_success") {
            sendTask();
            return;
          }
          if (message.type === "auth_failed") {
            finish({ ok: false, error: message.payload?.message ?? "Gateway auth failed" });
            return;
          }
        }

        if (message.id !== messageId) return;

        if (message.type === "agent_task_result" && message.payload?.status === "ok") {
          finish({ ok: true, result: message.payload.result as T });
        } else if (message.type === "agent_task_result") {
          finish({ ok: false, error: message.payload?.error ?? "Agent task failed" });
        } else if (message.type === "error") {
          finish({ ok: false, error: message.payload?.message ?? "Gateway error" });
        }
      } catch (error) {
        finish({ ok: false, error: String(error) });
      }
    });

    ws.on("error", (error: Error) => {
      finish({ ok: false, error: error.message });
    });

    function sendTask() {
      if (taskSent) return;
      taskSent = true;
      ws.send(JSON.stringify({
        type: "agent_task",
        id: messageId,
        payload: {
          agentId: options.agentId,
          task,
          internal,
          internalToken: options.internalToken,
        },
      }));
    }
  });
}

/** Whether an error is retryable (connection failures, timeouts, server errors) */
function isRetryableError(error: string): boolean {
  const retryable = [
    "ECONNREFUSED",
    "ECONNRESET",
    "ENOTFOUND",
    "ETIMEDOUT",
    "timed out",
    "WebSocket was closed",
    "connect EHOSTUNREACH",
  ];
  return retryable.some((pattern) => error.includes(pattern));
}

/**
 * Send a task to the gateway via WebSocket with automatic retry on connection failures.
 * Uses exponential backoff with jitter between retry attempts.
 */
export async function sendGatewayTask<T = unknown>(
  options: GatewayClientOptions,
  task: Record<string, unknown>,
  internal: boolean = true
): Promise<GatewayTaskResult<T>> {
  const parsed = GatewayClientOptionsSchema.safeParse(options);
  if (!parsed.success) {
    return { ok: false, error: `Invalid options: ${parsed.error.message}` };
  }

  const maxRetries = options.retries ?? 3;
  const baseDelay = options.retryDelayMs ?? 1000;
  let lastResult: GatewayTaskResult<T> = { ok: false, error: "No attempts made" };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    lastResult = await attemptGatewayTask<T>(options, task, internal);

    if (lastResult.ok) {
      return lastResult;
    }

    // Don't retry auth failures or non-retryable errors
    if (lastResult.error && !isRetryableError(lastResult.error)) {
      return lastResult;
    }

    // Don't retry after the last attempt
    if (attempt < maxRetries) {
      // Exponential backoff with jitter: delay * 2^attempt + random(0..delay)
      const delay = baseDelay * Math.pow(2, attempt) + Math.floor(Math.random() * baseDelay);
      await sleep(delay);
    }
  }

  return lastResult;
}

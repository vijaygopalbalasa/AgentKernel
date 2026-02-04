// A2A Server — handles incoming requests from other agents
// Implements the Agent-to-Agent Protocol server side

import { type Result, ok, err } from "@agentkernel/shared";
import { type Logger, createLogger } from "@agentkernel/kernel";
import type {
  A2AAgentCard,
  A2ATask,
  A2ATaskState,
  A2AMessage,
  A2AArtifact,
  A2ARequest,
  A2AResponse,
  CommunicationEvent,
} from "./types.js";
import {
  CommunicationError,
  A2ARequestSchema,
  TaskSendParamsSchema,
  TaskSendParamsWithReplayProtectionSchema,
} from "./types.js";

/** Task handler function */
export type TaskHandler = (
  task: A2ATask
) => Promise<TaskHandlerResult> | TaskHandlerResult;

/** Task handler result */
export interface TaskHandlerResult {
  /** New task state */
  state: A2ATaskState;
  /** Response message */
  message?: A2AMessage;
  /** Artifacts produced */
  artifacts?: A2AArtifact[];
  /** Status message */
  statusMessage?: string;
}

/** Replay protection configuration */
export interface ReplayProtectionConfig {
  /** Enable replay protection (default: false for backward compatibility) */
  enabled: boolean;
  /** Maximum age of requests in milliseconds (default: 5 minutes) */
  maxAgeMs?: number;
  /** How long to keep nonces in memory in milliseconds (default: 10 minutes) */
  nonceTtlMs?: number;
}

/** Server configuration */
export interface A2AServerConfig {
  /** Agent Card for this server */
  card: A2AAgentCard;
  /** Task handler */
  taskHandler: TaskHandler;
  /** Maximum concurrent tasks */
  maxConcurrentTasks?: number;
  /** Session timeout in ms */
  sessionTimeout?: number;
  /** Replay protection configuration */
  replayProtection?: ReplayProtectionConfig;
}

/**
 * A2A Server — handles incoming task requests.
 *
 * Features:
 * - JSON-RPC request handling
 * - Task lifecycle management
 * - Session support for multi-turn
 * - Streaming responses via SSE
 */
/** Default replay protection settings */
const DEFAULT_REPLAY_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_NONCE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const NONCE_CLEANUP_INTERVAL_MS = 60 * 1000; // 1 minute

export class A2AServer {
  private config: A2AServerConfig;
  private tasks: Map<string, A2ATask> = new Map();
  private sessions: Map<string, string[]> = new Map(); // sessionId -> taskIds
  private eventListeners: Array<(event: CommunicationEvent) => void> = [];
  private log: Logger;
  /** Tracks used nonces with their timestamps for replay protection */
  private usedNonces: Map<string, number> = new Map();
  private nonceCleanupTimer?: ReturnType<typeof setInterval>;

  constructor(config: A2AServerConfig) {
    this.config = config;
    this.log = createLogger({ name: "a2a-server" });
    this.log.debug("A2A Server initialized", { agentName: config.card.name });

    // Start nonce cleanup timer if replay protection is enabled
    if (config.replayProtection?.enabled) {
      this.startNonceCleanup();
    }
  }

  /** Start periodic cleanup of expired nonces */
  private startNonceCleanup(): void {
    const ttlMs = this.config.replayProtection?.nonceTtlMs ?? DEFAULT_NONCE_TTL_MS;
    this.nonceCleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [nonce, timestamp] of this.usedNonces) {
        if (now - timestamp > ttlMs) {
          this.usedNonces.delete(nonce);
        }
      }
    }, NONCE_CLEANUP_INTERVAL_MS);
  }

  /** Stop the nonce cleanup timer */
  stopCleanup(): void {
    if (this.nonceCleanupTimer) {
      clearInterval(this.nonceCleanupTimer);
      this.nonceCleanupTimer = undefined;
    }
  }

  /** Validate replay protection fields */
  private validateReplayProtection(
    nonce: string | undefined,
    timestamp: number | undefined
  ): { valid: boolean; error?: string } {
    const replayConfig = this.config.replayProtection;
    if (!replayConfig?.enabled) {
      return { valid: true };
    }

    // Check required fields
    if (!nonce || !timestamp) {
      return {
        valid: false,
        error: "Replay protection enabled: nonce and timestamp are required",
      };
    }

    // Check timestamp age
    const maxAgeMs = replayConfig.maxAgeMs ?? DEFAULT_REPLAY_MAX_AGE_MS;
    const now = Date.now();
    if (now - timestamp > maxAgeMs) {
      this.log.warn("Replay protection: request too old", {
        timestamp,
        ageMs: now - timestamp,
        maxAgeMs,
      });
      return {
        valid: false,
        error: `Request timestamp too old (max age: ${maxAgeMs}ms)`,
      };
    }

    // Check for future timestamps (with 30s tolerance for clock skew)
    if (timestamp > now + 30000) {
      this.log.warn("Replay protection: future timestamp rejected", {
        timestamp,
        now,
      });
      return {
        valid: false,
        error: "Request timestamp is in the future",
      };
    }

    // Check for nonce reuse
    if (this.usedNonces.has(nonce)) {
      this.log.warn("Replay protection: duplicate nonce rejected", { nonce });
      return {
        valid: false,
        error: "Duplicate nonce: potential replay attack",
      };
    }

    // Record nonce
    this.usedNonces.set(nonce, timestamp);
    return { valid: true };
  }

  /**
   * Get the Agent Card for this server.
   */
  getAgentCard(): A2AAgentCard {
    return this.config.card;
  }

  /**
   * Handle an incoming A2A request.
   */
  async handleRequest(
    request: A2ARequest
  ): Promise<Result<A2AResponse, CommunicationError>> {
    // Validate request format
    const requestResult = A2ARequestSchema.safeParse(request);
    if (!requestResult.success) {
      this.log.warn("Invalid request format", { error: requestResult.error.message });
      return ok(this.errorResponse(request.id ?? 0, -32600, `Invalid request: ${requestResult.error.message}`));
    }

    try {
      let response: A2AResponse;

      switch (request.method) {
        case "tasks/send":
          response = await this.handleTaskSend(request);
          break;
        case "tasks/sendSubscribe":
          response = await this.handleTaskSendSubscribe(request);
          break;
        case "tasks/get":
          response = this.handleTaskGet(request);
          break;
        case "tasks/cancel":
          response = await this.handleTaskCancel(request);
          break;
        case "tasks/list":
          response = this.handleTaskList(request);
          break;
        default:
          response = this.errorResponse(request.id, -32601, "Method not found");
      }

      return ok(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error("Request handling failed", { method: request.method, error: message });
      return ok(this.errorResponse(request.id, -32603, `Internal error: ${message}`));
    }
  }

  /**
   * Handle HTTP request (for integration with web servers).
   */
  async handleHttpRequest(
    body: string,
    acceptHeader?: string
  ): Promise<Result<{ body: string; contentType: string; status: number }, CommunicationError>> {
    let request: A2ARequest;

    try {
      request = JSON.parse(body) as A2ARequest;
    } catch {
      this.log.warn("Parse error in HTTP request");
      return ok({
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        }),
        contentType: "application/json",
        status: 400,
      });
    }

    // Check if client wants streaming
    if (
      request.method === "tasks/sendSubscribe" &&
      acceptHeader?.includes("text/event-stream")
    ) {
      // Return SSE stream marker - actual streaming handled separately
      this.log.debug("Streaming request received", { requestId: request.id });
      return ok({
        body: "",
        contentType: "text/event-stream",
        status: 200,
      });
    }

    const result = await this.handleRequest(request);
    if (!result.ok) {
      return ok({
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32603, message: result.error.message },
        }),
        contentType: "application/json",
        status: 500,
      });
    }

    const response = result.value;
    return ok({
      body: JSON.stringify(response),
      contentType: "application/json",
      status: response.error ? 400 : 200,
    });
  }

  /**
   * Generate the well-known agent.json response.
   */
  getWellKnownResponse(): string {
    return JSON.stringify(this.config.card, null, 2);
  }

  /**
   * Get a task by ID.
   */
  getTask(taskId: string): Result<A2ATask, CommunicationError> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return err(
        new CommunicationError(
          `Task not found: ${taskId}`,
          "NOT_FOUND",
          undefined,
          taskId
        )
      );
    }
    return ok(task);
  }

  /**
   * List all tasks.
   */
  listTasks(sessionId?: string): A2ATask[] {
    if (sessionId) {
      const taskIds = this.sessions.get(sessionId) ?? [];
      return taskIds
        .map((id) => this.tasks.get(id))
        .filter((t): t is A2ATask => t !== undefined);
    }
    return Array.from(this.tasks.values());
  }

  /**
   * Subscribe to server events.
   */
  onEvent(listener: (event: CommunicationEvent) => void): () => void {
    this.eventListeners.push(listener);
    return () => {
      const index = this.eventListeners.indexOf(listener);
      if (index > -1) {
        this.eventListeners.splice(index, 1);
      }
    };
  }

  /** Handle tasks/send */
  private async handleTaskSend(request: A2ARequest): Promise<A2AResponse> {
    // Validate params - use stricter schema if replay protection is enabled
    const schema = this.config.replayProtection?.enabled
      ? TaskSendParamsWithReplayProtectionSchema
      : TaskSendParamsSchema;
    const paramsResult = schema.safeParse(request.params);
    if (!paramsResult.success) {
      this.log.warn("Invalid task params", { error: paramsResult.error.message });
      return this.errorResponse(request.id, -32602, `Invalid params: ${paramsResult.error.message}`);
    }

    const params = request.params as {
      message: A2AMessage;
      sessionId?: string;
      nonce?: string;
      timestamp?: number;
    };

    if (!params?.message) {
      return this.errorResponse(request.id, -32602, "Invalid params: message required");
    }

    // Validate replay protection if enabled
    const replayValidation = this.validateReplayProtection(params.nonce, params.timestamp);
    if (!replayValidation.valid) {
      this.log.warn("Replay protection validation failed", {
        error: replayValidation.error,
        nonce: params.nonce,
      });
      return this.errorResponse(request.id, -32602, replayValidation.error ?? "Replay protection validation failed");
    }

    const task = this.createTask(params.message, params.sessionId);

    this.emit({
      type: "task_received",
      taskId: task.id,
      timestamp: new Date(),
      data: { message: params.message },
    });

    this.log.debug("Task received", { taskId: task.id });

    // Execute the task handler
    const result = await this.config.taskHandler(task);
    this.updateTask(task, result);

    return {
      jsonrpc: "2.0",
      id: request.id,
      result: this.taskToResponse(task),
    };
  }

  /** Handle tasks/sendSubscribe (streaming) */
  private async handleTaskSendSubscribe(
    request: A2ARequest
  ): Promise<A2AResponse> {
    // For non-streaming fallback, behave like tasks/send
    this.log.debug("Handling sendSubscribe as non-streaming", { requestId: request.id });
    return this.handleTaskSend(request);
  }

  /** Handle tasks/get */
  private handleTaskGet(request: A2ARequest): A2AResponse {
    const params = request.params as { taskId: string };

    if (!params?.taskId) {
      return this.errorResponse(request.id, -32602, "Invalid params: taskId required");
    }

    const task = this.tasks.get(params.taskId);
    if (!task) {
      this.log.debug("Task not found", { taskId: params.taskId });
      return this.errorResponse(request.id, -32001, "Task not found");
    }

    return {
      jsonrpc: "2.0",
      id: request.id,
      result: this.taskToResponse(task),
    };
  }

  /** Handle tasks/cancel */
  private async handleTaskCancel(request: A2ARequest): Promise<A2AResponse> {
    const params = request.params as { taskId: string };

    if (!params?.taskId) {
      return this.errorResponse(request.id, -32602, "Invalid params: taskId required");
    }

    const task = this.tasks.get(params.taskId);
    if (!task) {
      return this.errorResponse(request.id, -32001, "Task not found");
    }

    // Update task status to canceled
    task.status = {
      state: "canceled",
      message: "Task canceled by request",
      timestamp: new Date(),
    };
    task.updatedAt = new Date();

    this.log.debug("Task canceled", { taskId: params.taskId });

    return {
      jsonrpc: "2.0",
      id: request.id,
      result: { success: true },
    };
  }

  /** Handle tasks/list */
  private handleTaskList(request: A2ARequest): A2AResponse {
    const params = request.params as { sessionId?: string } | undefined;
    const tasks = this.listTasks(params?.sessionId);

    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        tasks: tasks.map((t) => ({
          id: t.id,
          sessionId: t.sessionId,
          status: t.status,
        })),
      },
    };
  }

  /** Create a new task */
  private createTask(message: A2AMessage, sessionId?: string): A2ATask {
    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const actualSessionId = sessionId ?? taskId;

    const task: A2ATask = {
      id: taskId,
      sessionId: actualSessionId,
      status: {
        state: "submitted",
        timestamp: new Date(),
      },
      message,
      history: [message],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.tasks.set(taskId, task);

    // Track session
    const sessionTasks = this.sessions.get(actualSessionId) ?? [];
    sessionTasks.push(taskId);
    this.sessions.set(actualSessionId, sessionTasks);

    this.log.debug("Task created", { taskId, sessionId: actualSessionId });

    return task;
  }

  /** Update task with handler result */
  private updateTask(task: A2ATask, result: TaskHandlerResult): void {
    task.status = {
      state: result.state,
      message: result.statusMessage,
      timestamp: new Date(),
    };
    task.updatedAt = new Date();

    if (result.message) {
      task.history = task.history ?? [];
      task.history.push(result.message);
    }

    if (result.artifacts) {
      task.artifacts = task.artifacts ?? [];
      task.artifacts.push(...result.artifacts);
    }

    if (result.state === "completed") {
      this.emit({
        type: "task_completed",
        taskId: task.id,
        timestamp: new Date(),
        data: { task },
      });
      this.log.debug("Task completed", { taskId: task.id });
    } else if (result.state === "failed") {
      this.emit({
        type: "task_failed",
        taskId: task.id,
        timestamp: new Date(),
        data: { task },
      });
      this.log.warn("Task failed", { taskId: task.id });
    }
  }

  /** Convert task to response format */
  private taskToResponse(task: A2ATask): Record<string, unknown> {
    return {
      id: task.id,
      sessionId: task.sessionId,
      status: task.status,
      artifacts: task.artifacts,
      history: task.history,
    };
  }

  /** Create an error response */
  private errorResponse(
    id: string | number,
    code: number,
    message: string
  ): A2AResponse {
    return {
      jsonrpc: "2.0",
      id,
      error: { code, message },
    };
  }

  /** Emit an event */
  private emit(event: CommunicationEvent): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }
}

/** Create a new A2A server */
export function createA2AServer(config: A2AServerConfig): A2AServer {
  return new A2AServer(config);
}

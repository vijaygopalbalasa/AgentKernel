// A2A Server — handles incoming requests from other agents
// Implements the Agent-to-Agent Protocol server side

import type {
  A2AAgentCard,
  A2ATask,
  A2ATaskState,
  A2AMessage,
  A2AArtifact,
  A2ARequest,
  A2AResponse,
  A2AError,
  CommunicationEvent,
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
export class A2AServer {
  private config: A2AServerConfig;
  private tasks: Map<string, A2ATask> = new Map();
  private sessions: Map<string, string[]> = new Map(); // sessionId -> taskIds
  private eventListeners: Array<(event: CommunicationEvent) => void> = [];

  constructor(config: A2AServerConfig) {
    this.config = config;
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
  async handleRequest(request: A2ARequest): Promise<A2AResponse> {
    try {
      switch (request.method) {
        case "tasks/send":
          return this.handleTaskSend(request);
        case "tasks/sendSubscribe":
          return this.handleTaskSendSubscribe(request);
        case "tasks/get":
          return this.handleTaskGet(request);
        case "tasks/cancel":
          return this.handleTaskCancel(request);
        case "tasks/list":
          return this.handleTaskList(request);
        default:
          return this.errorResponse(request.id, -32601, "Method not found");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.errorResponse(request.id, -32603, `Internal error: ${message}`);
    }
  }

  /**
   * Handle HTTP request (for integration with web servers).
   */
  async handleHttpRequest(
    body: string,
    acceptHeader?: string
  ): Promise<{ body: string; contentType: string; status: number }> {
    let request: A2ARequest;

    try {
      request = JSON.parse(body) as A2ARequest;
    } catch {
      return {
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        }),
        contentType: "application/json",
        status: 400,
      };
    }

    // Check if client wants streaming
    if (
      request.method === "tasks/sendSubscribe" &&
      acceptHeader?.includes("text/event-stream")
    ) {
      // Return SSE stream marker - actual streaming handled separately
      return {
        body: "",
        contentType: "text/event-stream",
        status: 200,
      };
    }

    const response = await this.handleRequest(request);
    return {
      body: JSON.stringify(response),
      contentType: "application/json",
      status: response.error ? 400 : 200,
    };
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
  getTask(taskId: string): A2ATask | null {
    return this.tasks.get(taskId) ?? null;
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
    const params = request.params as { message: A2AMessage; sessionId?: string };

    if (!params?.message) {
      return this.errorResponse(request.id, -32602, "Invalid params: message required");
    }

    const task = this.createTask(params.message, params.sessionId);

    this.emit({
      type: "task_received",
      taskId: task.id,
      timestamp: new Date(),
      data: { message: params.message },
    });

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
    } else if (result.state === "failed") {
      this.emit({
        type: "task_failed",
        taskId: task.id,
        timestamp: new Date(),
        data: { task },
      });
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

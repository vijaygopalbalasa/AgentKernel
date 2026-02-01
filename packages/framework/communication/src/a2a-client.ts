// A2A Client — sends tasks to other agents
// Implements the Agent-to-Agent Protocol client side

import type {
  A2ATask,
  A2ATaskState,
  A2AMessage,
  A2AArtifact,
  A2ARequest,
  A2AResponse,
  TaskDelegationRequest,
  TaskDelegationResult,
  CommunicationEvent,
} from "./types.js";

/**
 * A2A Client — sends tasks to remote agents.
 *
 * Features:
 * - Send tasks to agents via JSON-RPC
 * - Support for streaming responses (SSE)
 * - Task lifecycle management
 * - Timeout and retry handling
 */
export class A2AClient {
  private eventListeners: Array<(event: CommunicationEvent) => void> = [];
  private defaultTimeout: number = 30000;
  private tasks: Map<string, A2ATask> = new Map();

  /**
   * Send a task to an agent.
   */
  async sendTask(request: TaskDelegationRequest): Promise<TaskDelegationResult> {
    const {
      agentUrl,
      message,
      sessionId,
      streaming = false,
      timeout = this.defaultTimeout,
    } = request;

    const taskId = this.generateTaskId();

    try {
      const rpcRequest: A2ARequest = {
        jsonrpc: "2.0",
        id: taskId,
        method: streaming ? "tasks/sendSubscribe" : "tasks/send",
        params: {
          message,
          sessionId,
        },
      };

      this.emit({
        type: "task_sent",
        agentUrl,
        taskId,
        timestamp: new Date(),
        data: { message },
      });

      if (streaming) {
        return this.sendStreamingTask(agentUrl, rpcRequest, timeout);
      }

      const response = await this.sendRpcRequest(agentUrl, rpcRequest, timeout);

      if (response.error) {
        this.emit({
          type: "task_failed",
          agentUrl,
          taskId,
          timestamp: new Date(),
          data: { error: response.error },
        });
        return {
          success: false,
          error: response.error.message,
        };
      }

      const task = this.parseTaskResponse(taskId, response.result);
      this.tasks.set(taskId, task);

      if (task.status.state === "completed") {
        this.emit({
          type: "task_completed",
          agentUrl,
          taskId,
          timestamp: new Date(),
          data: { task },
        });
      }

      return { success: true, task };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.emit({
        type: "task_failed",
        agentUrl,
        taskId,
        timestamp: new Date(),
        data: { error },
      });
      return { success: false, error };
    }
  }

  /**
   * Get the status of a task.
   */
  async getTask(agentUrl: string, taskId: string): Promise<A2ATask | null> {
    try {
      const rpcRequest: A2ARequest = {
        jsonrpc: "2.0",
        id: this.generateTaskId(),
        method: "tasks/get",
        params: { taskId },
      };

      const response = await this.sendRpcRequest(
        agentUrl,
        rpcRequest,
        this.defaultTimeout
      );

      if (response.error || !response.result) {
        return null;
      }

      return this.parseTaskResponse(taskId, response.result);
    } catch {
      return null;
    }
  }

  /**
   * Cancel a task.
   */
  async cancelTask(agentUrl: string, taskId: string): Promise<boolean> {
    try {
      const rpcRequest: A2ARequest = {
        jsonrpc: "2.0",
        id: this.generateTaskId(),
        method: "tasks/cancel",
        params: { taskId },
      };

      const response = await this.sendRpcRequest(
        agentUrl,
        rpcRequest,
        this.defaultTimeout
      );

      return !response.error;
    } catch {
      return false;
    }
  }

  /**
   * Get a locally cached task.
   */
  getCachedTask(taskId: string): A2ATask | null {
    return this.tasks.get(taskId) ?? null;
  }

  /**
   * List all cached tasks.
   */
  listCachedTasks(): A2ATask[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Set the default timeout.
   */
  setDefaultTimeout(timeout: number): void {
    this.defaultTimeout = timeout;
  }

  /**
   * Subscribe to client events.
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

  /** Send an RPC request to an agent */
  private async sendRpcRequest(
    agentUrl: string,
    request: A2ARequest,
    timeout: number
  ): Promise<A2AResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(agentUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      if (!response.ok) {
        return {
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: response.status,
            message: `HTTP ${response.status}: ${response.statusText}`,
          },
        };
      }

      return (await response.json()) as A2AResponse;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** Send a streaming task and handle SSE */
  private async sendStreamingTask(
    agentUrl: string,
    request: A2ARequest,
    timeout: number
  ): Promise<TaskDelegationResult> {
    const taskId = String(request.id);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(agentUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        return {
          success: false,
          error: `HTTP ${response.status}: ${response.statusText}`,
        };
      }

      // Create initial task
      const task: A2ATask = {
        id: taskId,
        status: {
          state: "working",
          timestamp: new Date(),
        },
        message: request.params as A2AMessage,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      this.tasks.set(taskId, task);

      // Process SSE stream
      await this.processSSEStream(response.body, task, agentUrl);

      return { success: true, task: this.tasks.get(taskId)! };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** Process Server-Sent Events stream */
  private async processSSEStream(
    body: ReadableStream<Uint8Array>,
    task: A2ATask,
    agentUrl: string
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            this.handleSSEData(data, task, agentUrl);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /** Handle SSE data event */
  private handleSSEData(data: string, task: A2ATask, agentUrl: string): void {
    try {
      const event = JSON.parse(data);

      if (event.status) {
        task.status = {
          state: event.status.state as A2ATaskState,
          message: event.status.message,
          timestamp: new Date(),
        };
        task.updatedAt = new Date();

        if (task.status.state === "completed") {
          this.emit({
            type: "task_completed",
            agentUrl,
            taskId: task.id,
            timestamp: new Date(),
            data: { task },
          });
        } else if (task.status.state === "failed") {
          this.emit({
            type: "task_failed",
            agentUrl,
            taskId: task.id,
            timestamp: new Date(),
            data: { status: task.status },
          });
        }
      }

      if (event.artifact) {
        task.artifacts = task.artifacts ?? [];
        task.artifacts.push(event.artifact as A2AArtifact);
      }

      if (event.message) {
        task.history = task.history ?? [];
        task.history.push(event.message as A2AMessage);

        this.emit({
          type: "message_received",
          agentUrl,
          taskId: task.id,
          timestamp: new Date(),
          data: { message: event.message },
        });
      }

      this.tasks.set(task.id, task);
    } catch {
      // Invalid JSON, ignore
    }
  }

  /** Parse task from RPC response */
  private parseTaskResponse(taskId: string, result: unknown): A2ATask {
    const data = result as Record<string, unknown>;
    return {
      id: taskId,
      sessionId: data.sessionId as string | undefined,
      status: {
        state: (data.status as any)?.state ?? "completed",
        message: (data.status as any)?.message,
        timestamp: new Date(),
      },
      message: data.message as A2AMessage,
      artifacts: data.artifacts as A2AArtifact[] | undefined,
      history: data.history as A2AMessage[] | undefined,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  /** Generate a unique task ID */
  private generateTaskId(): string {
    return `task-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  /** Emit an event */
  private emit(event: CommunicationEvent): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }
}

/** Create a new A2A client */
export function createA2AClient(): A2AClient {
  return new A2AClient();
}

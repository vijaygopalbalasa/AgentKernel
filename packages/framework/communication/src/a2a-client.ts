// A2A Client — sends tasks to other agents
// Implements the Agent-to-Agent Protocol client side

import { type Result, ok, err } from "@agentkernel/shared";
import { type Logger, createLogger } from "@agentkernel/kernel";
import { randomBytes } from "crypto";
import type {
  A2ATask,
  A2ATaskState,
  A2AMessage,
  A2AArtifact,
  A2ARequest,
  A2AResponse,
  TaskDelegationRequest,
  CommunicationEvent,
} from "./types.js";
import {
  CommunicationError,
  TaskDelegationRequestSchema,
} from "./types.js";

/** Client configuration options */
export interface A2AClientConfig {
  /** Enable replay protection (adds nonce + timestamp to requests) */
  replayProtection?: boolean;
  /** Default request timeout in milliseconds */
  defaultTimeout?: number;
}

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
  private log: Logger;
  private replayProtection: boolean = false;

  constructor(config?: A2AClientConfig) {
    this.log = createLogger({ name: "a2a-client" });
    if (config?.replayProtection) {
      this.replayProtection = true;
    }
    if (config?.defaultTimeout) {
      this.defaultTimeout = config.defaultTimeout;
    }
  }

  /**
   * Generate a cryptographically secure nonce for replay protection.
   */
  private generateNonce(): string {
    return randomBytes(16).toString("hex");
  }

  /**
   * Send a task to an agent.
   */
  async sendTask(
    request: TaskDelegationRequest
  ): Promise<Result<A2ATask, CommunicationError>> {
    // Validate input
    const inputResult = TaskDelegationRequestSchema.safeParse(request);
    if (!inputResult.success) {
      return err(
        new CommunicationError(
          `Invalid task request: ${inputResult.error.message}`,
          "VALIDATION_ERROR",
          request.agentUrl
        )
      );
    }

    const {
      agentUrl,
      message,
      sessionId,
      streaming = false,
      timeout = this.defaultTimeout,
    } = request;

    const taskId = this.generateTaskId();

    try {
      // Build params with optional replay protection
      const params: Record<string, unknown> = {
        message,
        sessionId,
      };

      // Add replay protection fields if enabled
      if (this.replayProtection) {
        params.nonce = this.generateNonce();
        params.timestamp = Date.now();
        this.log.debug("Replay protection enabled", { taskId, nonce: params.nonce });
      }

      const rpcRequest: A2ARequest = {
        jsonrpc: "2.0",
        id: taskId,
        method: streaming ? "tasks/sendSubscribe" : "tasks/send",
        params,
      };

      this.emit({
        type: "task_sent",
        agentUrl,
        taskId,
        timestamp: new Date(),
        data: { message },
      });

      this.log.debug("Sending task", { agentUrl, taskId, streaming });

      if (streaming) {
        return this.sendStreamingTask(agentUrl, rpcRequest, timeout);
      }

      const responseResult = await this.sendRpcRequest(agentUrl, rpcRequest, timeout);
      if (!responseResult.ok) return responseResult;

      const response = responseResult.value;

      if (response.error) {
        this.emit({
          type: "task_failed",
          agentUrl,
          taskId,
          timestamp: new Date(),
          data: { error: response.error },
        });
        this.log.warn("Task failed", { taskId, error: response.error.message });
        return err(
          new CommunicationError(
            response.error.message,
            "TASK_ERROR",
            agentUrl,
            taskId
          )
        );
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
        this.log.debug("Task completed", { taskId });
      }

      return ok(task);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({
        type: "task_failed",
        agentUrl,
        taskId,
        timestamp: new Date(),
        data: { error: message },
      });

      if (message.includes("aborted")) {
        this.log.warn("Task timed out", { taskId, agentUrl });
        return err(
          new CommunicationError(
            `Task timed out: ${agentUrl}`,
            "TIMEOUT_ERROR",
            agentUrl,
            taskId
          )
        );
      }

      this.log.error("Task send failed", { taskId, error: message });
      return err(
        new CommunicationError(
          `Failed to send task: ${message}`,
          "NETWORK_ERROR",
          agentUrl,
          taskId
        )
      );
    }
  }

  /**
   * Get the status of a task.
   */
  async getTask(
    agentUrl: string,
    taskId: string
  ): Promise<Result<A2ATask, CommunicationError>> {
    try {
      const rpcRequest: A2ARequest = {
        jsonrpc: "2.0",
        id: this.generateTaskId(),
        method: "tasks/get",
        params: { taskId },
      };

      const responseResult = await this.sendRpcRequest(
        agentUrl,
        rpcRequest,
        this.defaultTimeout
      );

      if (!responseResult.ok) return responseResult;

      const response = responseResult.value;

      if (response.error || !response.result) {
        return err(
          new CommunicationError(
            response.error?.message ?? "Task not found",
            "NOT_FOUND",
            agentUrl,
            taskId
          )
        );
      }

      return ok(this.parseTaskResponse(taskId, response.result));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn("Failed to get task", { taskId, error: message });
      return err(
        new CommunicationError(
          `Failed to get task: ${message}`,
          "NETWORK_ERROR",
          agentUrl,
          taskId
        )
      );
    }
  }

  /**
   * Cancel a task.
   */
  async cancelTask(
    agentUrl: string,
    taskId: string
  ): Promise<Result<boolean, CommunicationError>> {
    try {
      const rpcRequest: A2ARequest = {
        jsonrpc: "2.0",
        id: this.generateTaskId(),
        method: "tasks/cancel",
        params: { taskId },
      };

      const responseResult = await this.sendRpcRequest(
        agentUrl,
        rpcRequest,
        this.defaultTimeout
      );

      if (!responseResult.ok) return responseResult;

      const response = responseResult.value;

      if (response.error) {
        return err(
          new CommunicationError(
            response.error.message,
            "TASK_ERROR",
            agentUrl,
            taskId
          )
        );
      }

      this.log.debug("Task canceled", { taskId });
      return ok(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn("Failed to cancel task", { taskId, error: message });
      return err(
        new CommunicationError(
          `Failed to cancel task: ${message}`,
          "NETWORK_ERROR",
          agentUrl,
          taskId
        )
      );
    }
  }

  /**
   * Get a locally cached task.
   */
  getCachedTask(taskId: string): Result<A2ATask, CommunicationError> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return err(
        new CommunicationError(
          `Task not found in cache: ${taskId}`,
          "NOT_FOUND",
          undefined,
          taskId
        )
      );
    }
    return ok(task);
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
    this.log.debug("Default timeout updated", { timeout });
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
  ): Promise<Result<A2AResponse, CommunicationError>> {
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
        return err(
          new CommunicationError(
            `HTTP ${response.status}: ${response.statusText}`,
            "NETWORK_ERROR",
            agentUrl
          )
        );
      }

      return ok((await response.json()) as A2AResponse);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** Send a streaming task and handle SSE */
  private async sendStreamingTask(
    agentUrl: string,
    request: A2ARequest,
    timeout: number
  ): Promise<Result<A2ATask, CommunicationError>> {
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
        return err(
          new CommunicationError(
            `HTTP ${response.status}: ${response.statusText}`,
            "NETWORK_ERROR",
            agentUrl,
            taskId
          )
        );
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

      const finalTask = this.tasks.get(taskId);
      if (!finalTask) {
        return err(
          new CommunicationError(
            "Task lost during streaming",
            "TASK_ERROR",
            agentUrl,
            taskId
          )
        );
      }

      return ok(finalTask);
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
          this.log.debug("Streaming task completed", { taskId: task.id });
        } else if (task.status.state === "failed") {
          this.emit({
            type: "task_failed",
            agentUrl,
            taskId: task.id,
            timestamp: new Date(),
            data: { status: task.status },
          });
          this.log.warn("Streaming task failed", { taskId: task.id });
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
      this.log.debug("Invalid SSE data received", { taskId: task.id });
    }
  }

  /** Parse task from RPC response */
  private parseTaskResponse(taskId: string, result: unknown): A2ATask {
    const data = result as Record<string, unknown>;
    return {
      id: taskId,
      sessionId: data.sessionId as string | undefined,
      status: {
        state: ((data.status as Record<string, unknown>)?.state as A2ATaskState) ?? "completed",
        message: (data.status as Record<string, unknown>)?.message as string | undefined,
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
export function createA2AClient(config?: A2AClientConfig): A2AClient {
  return new A2AClient(config);
}

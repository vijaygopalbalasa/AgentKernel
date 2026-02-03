// Tool Registry — manages tool registration and discovery
// Central registry for all tools available to agents

import { z } from "zod";
import { type Result, ok, err } from "@agent-os/shared";
import { type Logger, createLogger } from "@agent-os/kernel";
import {
  type ToolId,
  type ToolDefinition,
  type ToolHandler,
  type ToolInvocation,
  type ToolResult,
  type ToolContext,
  type ToolExecutionEvent,
  type ToolSchema,
  type RegisterToolOptions,
  ToolError,
  ToolDefinitionSchema,
  ToolInvocationSchema,
  RegisterToolOptionsSchema,
} from "./types.js";

/** Registered tool with handler */
interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

/**
 * Tool Registry — central registry for all tools.
 *
 * Features:
 * - Register/unregister tools dynamically
 * - Tool discovery by ID, category, or tag
 * - Input validation using Zod schemas
 * - Execution tracking and events
 */
export class ToolRegistry {
  private tools: Map<ToolId, RegisteredTool> = new Map();
  private eventListeners: Array<(event: ToolExecutionEvent) => void> = [];
  private log: Logger;

  constructor() {
    this.log = createLogger({ name: "tool-registry" });
  }

  /**
   * Register a tool with the registry.
   */
  register<T extends z.ZodRawShape>(
    definition: Omit<ToolDefinition, "inputSchema"> & { inputSchema: z.ZodObject<T> },
    handler: ToolHandler<z.infer<z.ZodObject<T>>>,
    options: RegisterToolOptions = {}
  ): Result<ToolId, ToolError> {
    // Validate options
    const optionsResult = RegisterToolOptionsSchema.safeParse(options);
    if (!optionsResult.success) {
      return err(
        new ToolError(
          `Invalid registration options: ${optionsResult.error.message}`,
          "VALIDATION_ERROR"
        )
      );
    }

    // Validate definition
    const defResult = ToolDefinitionSchema.safeParse(definition);
    if (!defResult.success) {
      return err(
        new ToolError(
          `Invalid tool definition: ${defResult.error.message}`,
          "VALIDATION_ERROR",
          definition.id
        )
      );
    }

    if (this.tools.has(definition.id) && !options.overwrite) {
      return err(
        new ToolError(
          `Tool already exists: ${definition.id}`,
          "VALIDATION_ERROR",
          definition.id
        )
      );
    }

    this.tools.set(definition.id, {
      definition,
      handler: handler as ToolHandler,
    });

    this.log.debug("Tool registered", {
      toolId: definition.id,
      name: definition.name,
      category: definition.category,
    });

    return ok(definition.id);
  }

  /**
   * Unregister a tool.
   */
  unregister(toolId: ToolId): Result<void, ToolError> {
    if (!this.tools.has(toolId)) {
      return err(new ToolError(`Tool not found: ${toolId}`, "NOT_FOUND", toolId));
    }

    this.tools.delete(toolId);
    this.log.debug("Tool unregistered", { toolId });
    return ok(undefined);
  }

  /**
   * Get a tool definition by ID.
   */
  get(toolId: ToolId): Result<ToolDefinition, ToolError> {
    const tool = this.tools.get(toolId);
    if (!tool) {
      return err(new ToolError(`Tool not found: ${toolId}`, "NOT_FOUND", toolId));
    }
    return ok(tool.definition);
  }

  /**
   * Check if a tool exists.
   */
  has(toolId: ToolId): boolean {
    return this.tools.has(toolId);
  }

  /**
   * List all registered tools.
   */
  list(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  /**
   * Find tools by category.
   */
  findByCategory(category: string): ToolDefinition[] {
    return this.list().filter((t) => t.category === category);
  }

  /**
   * Find tools by tag.
   */
  findByTag(tag: string): ToolDefinition[] {
    return this.list().filter((t) => t.tags?.includes(tag));
  }

  /**
   * Search tools by name or description.
   */
  search(query: string): ToolDefinition[] {
    const q = query.toLowerCase();
    return this.list().filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q)
    );
  }

  /**
   * Invoke a tool with arguments.
   */
  async invoke(invocation: ToolInvocation): Promise<Result<ToolResult, ToolError>> {
    const startTime = Date.now();

    // Validate invocation
    const invocationResult = ToolInvocationSchema.safeParse(invocation);
    if (!invocationResult.success) {
      return err(
        new ToolError(
          `Invalid invocation: ${invocationResult.error.message}`,
          "VALIDATION_ERROR",
          invocation.toolId
        )
      );
    }

    const requestId = invocation.requestId ?? `req-${Date.now()}`;

    const tool = this.tools.get(invocation.toolId);
    if (!tool) {
      return err(
        new ToolError(`Tool not found: ${invocation.toolId}`, "NOT_FOUND", invocation.toolId)
      );
    }

    // Emit start event
    this.emitEvent({
      type: "start",
      toolId: invocation.toolId,
      agentId: invocation.agentId,
      requestId,
      timestamp: new Date(),
    });

    try {
      // Validate input
      const validation = tool.definition.inputSchema.safeParse(invocation.arguments);
      if (!validation.success) {
        const errorMsg = `Invalid arguments: ${validation.error.message}`;
        this.emitEvent({
          type: "error",
          toolId: invocation.toolId,
          agentId: invocation.agentId,
          requestId,
          timestamp: new Date(),
          duration: Date.now() - startTime,
          success: false,
          error: errorMsg,
        });
        return err(
          new ToolError(errorMsg, "VALIDATION_ERROR", invocation.toolId)
        );
      }

      // Create context
      const context: ToolContext = {
        agentId: invocation.agentId,
        requestId,
      };

      // Execute handler
      const result = await tool.handler(validation.data, context);

      // Add execution time
      result.executionTime = Date.now() - startTime;

      // Emit complete event
      this.emitEvent({
        type: "complete",
        toolId: invocation.toolId,
        agentId: invocation.agentId,
        requestId,
        timestamp: new Date(),
        duration: result.executionTime,
        success: result.success,
      });

      this.log.debug("Tool invoked", {
        toolId: invocation.toolId,
        success: result.success,
        executionTime: result.executionTime,
      });

      return ok(result);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const duration = Date.now() - startTime;

      // Emit error event
      this.emitEvent({
        type: "error",
        toolId: invocation.toolId,
        agentId: invocation.agentId,
        requestId,
        timestamp: new Date(),
        duration,
        success: false,
        error: errorMsg,
      });

      this.log.error("Tool invocation failed", {
        toolId: invocation.toolId,
        error: errorMsg,
        duration,
      });

      return err(
        new ToolError(errorMsg, "INVOCATION_ERROR", invocation.toolId)
      );
    }
  }

  /**
   * Get tool definitions in MCP format.
   */
  toMCPFormat(): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }> {
    return this.list().map((tool) => ({
      name: tool.id,
      description: tool.description,
      inputSchema: this.zodToJsonSchema(tool.inputSchema),
    }));
  }

  /**
   * Register an event listener.
   */
  onEvent(listener: (event: ToolExecutionEvent) => void): () => void {
    this.eventListeners.push(listener);
    return () => {
      const index = this.eventListeners.indexOf(listener);
      if (index > -1) {
        this.eventListeners.splice(index, 1);
      }
    };
  }

  /**
   * Clear all registered tools.
   */
  clear(): void {
    this.tools.clear();
    this.log.debug("All tools cleared");
  }

  /**
   * Get the count of registered tools.
   */
  count(): number {
    return this.tools.size;
  }

  /** Emit an event to all listeners */
  private emitEvent(event: ToolExecutionEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (error) {
        this.log.error("Event listener error", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** Convert Zod schema to JSON Schema (simplified) */
  private zodToJsonSchema(schema: ToolSchema): Record<string, unknown> {
    // This is a simplified conversion — production would use zod-to-json-schema
    const shape = schema.shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      const zodType = value as z.ZodTypeAny;
      properties[key] = this.zodTypeToJsonSchema(zodType);

      // Check if required (not optional)
      if (!zodType.isOptional()) {
        required.push(key);
      }
    }

    return {
      type: "object",
      properties,
      required: required.length > 0 ? required : undefined,
    };
  }

  /** Convert individual Zod type to JSON Schema type */
  private zodTypeToJsonSchema(zodType: z.ZodTypeAny): Record<string, unknown> {
    const typeName = zodType._def.typeName;

    switch (typeName) {
      case "ZodString":
        return { type: "string" };
      case "ZodNumber":
        return { type: "number" };
      case "ZodBoolean":
        return { type: "boolean" };
      case "ZodArray":
        return {
          type: "array",
          items: this.zodTypeToJsonSchema(zodType._def.type),
        };
      case "ZodObject":
        return this.zodToJsonSchema(zodType as ToolSchema);
      case "ZodOptional":
        return this.zodTypeToJsonSchema(zodType._def.innerType);
      case "ZodEnum":
        return { type: "string", enum: zodType._def.values };
      default:
        return { type: "string" }; // Fallback
    }
  }
}

/** Create a default global registry */
export function createToolRegistry(): ToolRegistry {
  return new ToolRegistry();
}

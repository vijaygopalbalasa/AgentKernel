// Tool Registry — manages tool registration and discovery
// Central registry for all tools available to agents

import { z } from "zod";
import type {
  ToolId,
  ToolDefinition,
  ToolHandler,
  ToolInvocation,
  ToolResult,
  ToolContext,
  ToolExecutionEvent,
  ToolSchema,
} from "./types.js";

/** Registered tool with handler */
interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

/** Tool registration options */
export interface RegisterToolOptions {
  /** Override existing tool */
  overwrite?: boolean;
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

  /**
   * Register a tool with the registry.
   */
  register<T extends z.ZodRawShape>(
    definition: ToolDefinition & { inputSchema: z.ZodObject<T> },
    handler: ToolHandler<z.infer<z.ZodObject<T>>>,
    options: RegisterToolOptions = {}
  ): boolean {
    if (this.tools.has(definition.id) && !options.overwrite) {
      return false;
    }

    this.tools.set(definition.id, {
      definition,
      handler: handler as ToolHandler,
    });

    return true;
  }

  /**
   * Unregister a tool.
   */
  unregister(toolId: ToolId): boolean {
    return this.tools.delete(toolId);
  }

  /**
   * Get a tool definition by ID.
   */
  get(toolId: ToolId): ToolDefinition | null {
    return this.tools.get(toolId)?.definition ?? null;
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
  async invoke(invocation: ToolInvocation): Promise<ToolResult> {
    const startTime = Date.now();
    const requestId = invocation.requestId ?? `req-${Date.now()}`;

    const tool = this.tools.get(invocation.toolId);
    if (!tool) {
      return {
        success: false,
        error: `Tool not found: ${invocation.toolId}`,
      };
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
        const error = `Invalid arguments: ${validation.error.message}`;
        this.emitEvent({
          type: "error",
          toolId: invocation.toolId,
          agentId: invocation.agentId,
          requestId,
          timestamp: new Date(),
          duration: Date.now() - startTime,
          success: false,
          error,
        });
        return { success: false, error };
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

      return result;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
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
        error,
      });

      return {
        success: false,
        error,
        executionTime: duration,
      };
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

  /** Emit an event to all listeners */
  private emitEvent(event: ToolExecutionEvent): void {
    for (const listener of this.eventListeners) {
      listener(event);
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

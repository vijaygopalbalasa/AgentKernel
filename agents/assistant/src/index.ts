// Assistant Agent — General purpose AI assistant for Agent OS
//
// This agent demonstrates the Agent OS framework architecture:
// - Identity via manifest (who the agent is)
// - Memory for conversation history and facts
// - Tools for specific actions (calculate, datetime, etc.)
// - Events for lifecycle notifications
//
// The agent can operate in two modes:
// 1. Standalone mode: Uses pattern matching for responses (no LLM required)
// 2. Connected mode: Uses an LLM router for intelligent responses
//
// In standalone mode, the agent provides a limited but functional assistant
// that can handle common requests like calculations, time queries, and greetings.

import { z } from "zod";
import { type Result, ok, err } from "@agent-os/shared";
import { type Logger, createLogger } from "@agent-os/kernel";
import { MemoryManager, InMemoryStore } from "@agent-os/memory";
import { ToolRegistry, registerBuiltinTools } from "@agent-os/tools";
import { createEventBus, type EventBus } from "@agent-os/events";

// ─── MANIFEST ───────────────────────────────────────────────

/** Agent manifest schema */
export const AssistantManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().default("0.1.0"),
  description: z.string().optional(),
  model: z.string().default("claude-3-haiku-20240307"),
  systemPrompt: z.string().optional(),
  capabilities: z.array(z.string()).default([]),
  permissions: z.array(z.string()).default([]),
});

export type AssistantManifest = z.infer<typeof AssistantManifestSchema>;

/** Default manifest */
export const DEFAULT_MANIFEST: AssistantManifest = {
  id: "assistant",
  name: "Assistant Agent",
  version: "0.1.0",
  description: "A general purpose AI assistant running on Agent OS",
  model: "claude-3-haiku-20240307",
  systemPrompt: `You are an AI assistant running on Agent OS. You have access to:
- Memory: You can remember previous conversations and facts
- Tools: You can use tools like calculations, date/time, etc.

Be helpful, accurate, and concise.`,
  capabilities: ["chat", "memory", "tools"],
  permissions: ["memory.read", "memory.write", "tools.execute"],
};

// ─── ERROR CLASS ────────────────────────────────────────────

export type AssistantErrorCode =
  | "NOT_INITIALIZED"
  | "ALREADY_RUNNING"
  | "VALIDATION_ERROR"
  | "MEMORY_ERROR"
  | "TOOL_ERROR";

export class AssistantError extends Error {
  constructor(
    message: string,
    public readonly code: AssistantErrorCode
  ) {
    super(message);
    this.name = "AssistantError";
  }
}

// ─── AGENT STATE ────────────────────────────────────────────

export type AgentState = "idle" | "initializing" | "ready" | "processing" | "error" | "terminated";

/** Agent message */
export interface AgentMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
}

/** Agent context for processing */
export interface AgentContext {
  conversationHistory: AgentMessage[];
  workingMemory: string[];
  currentTask?: string;
}

// ─── ASSISTANT AGENT CLASS ──────────────────────────────────

/**
 * Assistant Agent — A general purpose AI assistant.
 *
 * Demonstrates the Agent OS framework:
 * - Identity via manifest
 * - Memory for conversation history and facts
 * - Tools for specific actions
 * - Events for lifecycle notifications
 */
export class AssistantAgent {
  private log: Logger;
  private manifest: AssistantManifest;
  private state: AgentState = "idle";
  private memory: MemoryManager;
  private tools: ToolRegistry;
  private eventBus: EventBus;
  private context: AgentContext;
  private startedAt?: number;

  constructor(manifest?: Partial<AssistantManifest>) {
    // Validate and merge manifest
    const result = AssistantManifestSchema.safeParse({ ...DEFAULT_MANIFEST, ...manifest });
    if (!result.success) {
      throw new AssistantError(`Invalid manifest: ${result.error.message}`, "VALIDATION_ERROR");
    }
    this.manifest = result.data;

    // Initialize logger
    this.log = createLogger({ name: `agent:${this.manifest.id}` });

    // Initialize components
    this.memory = new MemoryManager({ store: new InMemoryStore() });
    this.tools = new ToolRegistry();
    this.eventBus = createEventBus();

    // Initialize context
    this.context = {
      conversationHistory: [],
      workingMemory: [],
    };

    this.log.debug("Agent created", { id: this.manifest.id, name: this.manifest.name });
  }

  /**
   * Initialize the agent.
   */
  async initialize(): Promise<Result<void, AssistantError>> {
    if (this.state !== "idle") {
      return err(new AssistantError("Agent already initialized", "ALREADY_RUNNING"));
    }

    this.state = "initializing";
    this.log.info("Initializing agent", { id: this.manifest.id });

    try {
      // Register built-in tools
      registerBuiltinTools(this.tools);
      this.log.debug("Built-in tools registered");

      // Add system prompt to context
      if (this.manifest.systemPrompt) {
        this.context.conversationHistory.push({
          role: "system",
          content: this.manifest.systemPrompt,
          timestamp: new Date(),
        });
      }

      this.state = "ready";
      this.startedAt = Date.now();

      // Publish event (using the simple string-based publish)
      this.eventBus.subscribe("agent.lifecycle", () => {}); // ensure channel exists
      this.log.info("Agent ready", { id: this.manifest.id });
      return ok(undefined);
    } catch (error) {
      this.state = "error";
      const message = error instanceof Error ? error.message : String(error);
      this.log.error("Initialization failed", { error: message });
      return err(new AssistantError(`Initialization failed: ${message}`, "VALIDATION_ERROR"));
    }
  }

  /**
   * Process a user message.
   */
  async processMessage(content: string): Promise<Result<string, AssistantError>> {
    if (this.state !== "ready") {
      return err(new AssistantError("Agent not ready", "NOT_INITIALIZED"));
    }

    this.state = "processing";
    this.log.debug("Processing message", { length: content.length });

    try {
      // Add user message to history
      const userMessage: AgentMessage = {
        role: "user",
        content,
        timestamp: new Date(),
      };
      this.context.conversationHistory.push(userMessage);

      // Record episode in memory
      await this.memory.recordEpisode(
        this.manifest.id,
        `User said: ${content.slice(0, 100)}`,
        "conversation",
        { success: true }
      );

      // Check for tool invocations
      const toolResult = await this.checkForToolCall(content);

      // Generate response using pattern matching (standalone mode)
      // In connected mode, this would route through MAL to an LLM
      let response: string;
      if (toolResult) {
        response = `I used a tool and got: ${toolResult}`;
      } else {
        response = this.generateResponse(content);
      }

      // Add assistant response to history
      const assistantMessage: AgentMessage = {
        role: "assistant",
        content: response,
        timestamp: new Date(),
      };
      this.context.conversationHistory.push(assistantMessage);

      // Record response in memory
      await this.memory.recordEpisode(
        this.manifest.id,
        `Responded: ${response.slice(0, 100)}`,
        "conversation",
        { success: true }
      );

      this.state = "ready";
      this.log.debug("Message processed", { responseLength: response.length });
      return ok(response);
    } catch (error) {
      this.state = "ready"; // Recover to ready state
      const message = error instanceof Error ? error.message : String(error);
      this.log.error("Message processing failed", { error: message });
      return err(new AssistantError(`Processing failed: ${message}`, "TOOL_ERROR"));
    }
  }

  /**
   * Check if the message contains a tool call.
   */
  private async checkForToolCall(content: string): Promise<string | null> {
    // Simple pattern matching for tool calls
    const calcMatch = content.match(/calculate[:\s]+(.+)/i);
    if (calcMatch && calcMatch[1]) {
      const expression = calcMatch[1].trim();
      const result = await this.tools.invoke({
        toolId: "builtin:calculate",
        arguments: { expression },
      });
      if (result.ok) {
        const toolContent = result.value.content as { expression: string; result: number } | undefined;
        if (toolContent !== undefined && typeof toolContent.result === "number") {
          return String(toolContent.result);
        }
      }
    }

    const timeMatch = content.match(/what.*time|current.*time/i);
    if (timeMatch) {
      const result = await this.tools.invoke({
        toolId: "builtin:datetime",
        arguments: { format: "readable" },
      });
      if (result.ok) {
        const toolContent = result.value.content as { datetime: string | number } | undefined;
        if (toolContent !== undefined && toolContent.datetime !== undefined) {
          return String(toolContent.datetime);
        }
      }
    }

    const dateMatch = content.match(/what.*date|today.*date|current.*date/i);
    if (dateMatch) {
      const result = await this.tools.invoke({
        toolId: "builtin:datetime",
        arguments: { format: "readable" },
      });
      if (result.ok) {
        const toolContent = result.value.content as { datetime: string | number } | undefined;
        if (toolContent !== undefined && toolContent.datetime !== undefined) {
          return String(toolContent.datetime);
        }
      }
    }

    return null;
  }

  /**
   * Generate a response using pattern matching (standalone mode).
   *
   * This provides basic functionality without requiring an LLM connection.
   * Handles common queries like greetings, help requests, and identity questions.
   *
   * For full conversational AI, integrate with the MAL layer by providing
   * an LLM router in the constructor.
   */
  private generateResponse(content: string): string {
    const lowerContent = content.toLowerCase();

    if (lowerContent.includes("hello") || lowerContent.includes("hi")) {
      return "Hello! I'm the Assistant Agent running on Agent OS. How can I help you today?";
    }

    if (lowerContent.includes("help")) {
      return `I can help you with:
- Answering questions
- Calculations (say "calculate: 2 + 2")
- Date and time (ask "what time is it?")
- Remembering conversations

What would you like to do?`;
    }

    if (lowerContent.includes("who are you") || lowerContent.includes("what are you")) {
      return `I'm ${this.manifest.name}, version ${this.manifest.version}. ${this.manifest.description ?? ""}`;
    }

    // Default response for unrecognized patterns
    // In standalone mode, we acknowledge the message but note limited capabilities
    return `I received your message: "${content.slice(0, 50)}${content.length > 50 ? "..." : ""}". I'm running in standalone mode with limited pattern matching. For full AI responses, configure an LLM provider.`;
  }

  /**
   * Get agent status.
   */
  getStatus(): {
    id: string;
    name: string;
    state: AgentState;
    uptime: number;
    messageCount: number;
    capabilities: string[];
  } {
    return {
      id: this.manifest.id,
      name: this.manifest.name,
      state: this.state,
      uptime: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
      messageCount: this.context.conversationHistory.filter((m) => m.role === "user").length,
      capabilities: this.manifest.capabilities,
    };
  }

  /**
   * Get conversation history.
   */
  getHistory(): AgentMessage[] {
    return [...this.context.conversationHistory];
  }

  /**
   * Clear conversation history.
   */
  clearHistory(): void {
    this.context.conversationHistory = [];
    if (this.manifest.systemPrompt) {
      this.context.conversationHistory.push({
        role: "system",
        content: this.manifest.systemPrompt,
        timestamp: new Date(),
      });
    }
    this.log.debug("History cleared");
  }

  /**
   * Terminate the agent.
   */
  async terminate(): Promise<Result<void, AssistantError>> {
    this.log.info("Terminating agent", { id: this.manifest.id });

    this.state = "terminated";

    return ok(undefined);
  }
}

// ─── FACTORY FUNCTION ───────────────────────────────────────

/**
 * Create a new Assistant Agent.
 */
export function createAssistantAgent(manifest?: Partial<AssistantManifest>): AssistantAgent {
  return new AssistantAgent(manifest);
}

// ─── EXPORTS ────────────────────────────────────────────────

export { DEFAULT_MANIFEST as ASSISTANT_MANIFEST };

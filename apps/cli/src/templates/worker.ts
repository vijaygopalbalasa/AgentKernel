// Template: Worker Agent — Background worker that processes tasks
// Workers handle structured tasks like data processing, file operations, etc.

export function getWorkerTemplate(slug: string, name: string): { indexTs: string; manifestJson: string; testTs: string } {
  const indexTs = `import { defineAgent, type AgentContext } from "@agentkernel/sdk";

/**
 * ${name} Worker — A background task processing agent.
 *
 * Workers receive structured tasks, process them (optionally using LLM),
 * and return typed results. They're ideal for:
 * - Data processing pipelines
 * - File transformations
 * - Batch operations
 * - Scheduled jobs
 *
 * Key APIs used:
 * - context.client.chat()          — Use LLM for reasoning about tasks
 * - context.client.invokeTool()    — Call tools (HTTP fetch, file ops, etc.)
 * - context.client.recordEpisode() — Track task completion history
 * - context.client.emit()          — Emit events when tasks complete
 */

interface WorkerTask {
  type: string;
  payload?: Record<string, unknown>;
}

interface WorkerResult {
  status: "completed" | "failed";
  output?: unknown;
  error?: string;
}

const agent = defineAgent<WorkerTask, WorkerResult>({
  manifest: {
    id: "${slug}",
    name: "${name} Worker",
    version: "0.1.0",
    description: "Background worker that processes structured tasks",
    permissions: ["llm.execute", "tools.execute"],
    trustLevel: "semi-autonomous",
    limits: {
      maxTokensPerRequest: 4096,
      requestsPerMinute: 60,
    },
  },

  async initialize(context: AgentContext) {
    context.log?.info("${name} worker ready to process tasks");
  },

  async handleTask(task: WorkerTask, context: AgentContext): Promise<WorkerResult> {
    const { client } = context;

    try {
      switch (task.type) {
        case "process": {
          // Example: use LLM to process/transform data
          const response = await client.chat([
            { role: "system", content: "You are a data processing assistant. Process the input and return structured output." },
            { role: "user", content: JSON.stringify(task.payload) },
          ], { maxTokens: 2048 });

          await client.emit("agent.tasks", "task.completed", {
            agentId: "${slug}",
            taskType: task.type,
          });

          await client.recordEpisode({
            event: "worker.task.completed",
            context: JSON.stringify({ type: task.type }),
            success: true,
          });

          return { status: "completed", output: response.content };
        }

        case "fetch": {
          // Example: fetch data from a URL using the HTTP tool
          const url = typeof task.payload?.url === "string" ? task.payload.url : "";
          if (!url) {
            return { status: "failed", error: "No URL provided" };
          }

          const result = await client.invokeTool("builtin:http_fetch", {
            url,
            timeoutMs: 10000,
          });

          if (!result.success) {
            return { status: "failed", error: result.error ?? "Fetch failed" };
          }

          return { status: "completed", output: result.content };
        }

        default:
          return { status: "failed", error: \`Unknown task type: \${task.type}\` };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      await client.recordEpisode({
        event: "worker.task.failed",
        context: JSON.stringify({ type: task.type, error: message }),
        success: false,
      });

      return { status: "failed", error: message };
    }
  },

  async terminate(context: AgentContext) {
    context.log?.info("${name} worker shutting down");
  },
});

export default agent;
`;

  const manifestJson = JSON.stringify({
    id: slug,
    name: `${name} Worker`,
    version: "0.1.0",
    description: "Background worker that processes structured tasks",
    permissions: ["llm.execute", "tools.execute"],
    trustLevel: "semi-autonomous",
    limits: {
      maxTokensPerRequest: 4096,
      requestsPerMinute: 60,
    },
  }, null, 2);

  const testTs = `import { describe, it, expect, vi } from "vitest";

describe("${name} Worker", () => {
  const mockClient = {
    chat: vi.fn().mockResolvedValue({ content: "Processed result", model: "gpt-4o-mini" }),
    storeFact: vi.fn(),
    searchMemory: vi.fn(),
    recordEpisode: vi.fn().mockResolvedValue(undefined),
    invokeTool: vi.fn().mockResolvedValue({ success: true, content: { data: "fetched" } }),
    listTools: vi.fn(),
    callAgent: vi.fn(),
    discoverAgents: vi.fn(),
    emit: vi.fn().mockResolvedValue(undefined),
    sendTask: vi.fn(),
  };

  const mockContext = {
    agentId: "${slug}",
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    client: mockClient,
  };

  it("should process a task", async () => {
    const { default: agent } = await import("./index.js");
    const result = await agent.handleTask(
      { type: "process", payload: { data: "test" } },
      mockContext,
    );
    expect(result.status).toBe("completed");
    expect(result.output).toBeDefined();
  });

  it("should fetch from a URL", async () => {
    const { default: agent } = await import("./index.js");
    const result = await agent.handleTask(
      { type: "fetch", payload: { url: "https://example.com" } },
      mockContext,
    );
    expect(result.status).toBe("completed");
    expect(mockClient.invokeTool).toHaveBeenCalledWith("builtin:http_fetch", expect.objectContaining({ url: "https://example.com" }));
  });

  it("should fail for unknown task types", async () => {
    const { default: agent } = await import("./index.js");
    const result = await agent.handleTask({ type: "unknown" }, mockContext);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Unknown task type");
  });

  it("should record episodes on completion", async () => {
    const { default: agent } = await import("./index.js");
    await agent.handleTask({ type: "process", payload: {} }, mockContext);
    expect(mockClient.recordEpisode).toHaveBeenCalledWith(
      expect.objectContaining({ event: "worker.task.completed", success: true }),
    );
  });
});
`;

  return { indexTs, manifestJson, testTs };
}

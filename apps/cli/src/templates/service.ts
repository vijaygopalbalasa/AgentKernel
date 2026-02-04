// Template: Service Agent — Exposes A2A skills for other agents to call
// Services are building blocks that other agents use via agent-to-agent communication.

export function getServiceTemplate(slug: string, name: string): { indexTs: string; manifestJson: string; testTs: string } {
  const indexTs = `import { defineAgent, type AgentContext } from "@agentrun/sdk";

/**
 * ${name} Service — Exposes skills for other agents via A2A.
 *
 * Service agents provide reusable capabilities that other agents
 * can call through the A2A (Agent-to-Agent) protocol. They act as
 * microservices within the AgentRun ecosystem.
 *
 * Other agents call this service with:
 *   await context.client.callAgent("${slug}", { type: "summarize", text: "..." });
 *
 * Key APIs used:
 * - context.client.chat()          — Use LLM for processing
 * - context.client.invokeTool()    — Use tools for extended capabilities
 * - context.client.storeFact()     — Cache results in memory
 * - context.client.searchMemory()  — Check cache before processing
 * - context.client.emit()          — Emit events for observability
 */

interface ServiceTask {
  type: string;
  [key: string]: unknown;
}

const agent = defineAgent({
  manifest: {
    id: "${slug}",
    name: "${name} Service",
    version: "0.1.0",
    description: "Reusable service agent that other agents can call via A2A",
    permissions: ["memory.read", "memory.write", "llm.execute"],
    trustLevel: "semi-autonomous",
    limits: {
      maxTokensPerRequest: 2048,
      requestsPerMinute: 120,
    },
    a2aSkills: [
      {
        id: "summarize",
        name: "Summarize Text",
        description: "Summarize a block of text to key points",
        inputSchema: {
          type: "object",
          properties: {
            type: { const: "summarize" },
            text: { type: "string", description: "Text to summarize" },
            maxLength: { type: "number", description: "Max words in summary" },
          },
          required: ["type", "text"],
        },
      },
      {
        id: "classify",
        name: "Classify Text",
        description: "Classify text into provided categories",
        inputSchema: {
          type: "object",
          properties: {
            type: { const: "classify" },
            text: { type: "string", description: "Text to classify" },
            categories: { type: "array", items: { type: "string" }, description: "Possible categories" },
          },
          required: ["type", "text", "categories"],
        },
      },
    ],
  },

  async initialize(context: AgentContext) {
    context.log?.info("${name} service ready to accept A2A requests");
  },

  async handleTask(task: ServiceTask, context: AgentContext) {
    const { client } = context;

    switch (task.type) {
      case "summarize": {
        const text = typeof task.text === "string" ? task.text : "";
        if (!text) {
          return { error: "No text provided" };
        }

        const maxLength = typeof task.maxLength === "number" ? task.maxLength : 100;

        const response = await client.chat([
          {
            role: "system",
            content: \`Summarize the following text in no more than \${maxLength} words. Return only the summary.\`,
          },
          { role: "user", content: text },
        ], { maxTokens: 512 });

        await client.emit("agent.tasks", "service.summarize.completed", {
          agentId: "${slug}",
          inputLength: text.length,
        });

        return { summary: response.content };
      }

      case "classify": {
        const text = typeof task.text === "string" ? task.text : "";
        const categories = Array.isArray(task.categories)
          ? (task.categories as string[])
          : [];

        if (!text || categories.length === 0) {
          return { error: "Text and categories are required" };
        }

        const response = await client.chat([
          {
            role: "system",
            content: \`Classify the following text into exactly one of these categories: \${categories.join(", ")}. Return ONLY the category name, nothing else.\`,
          },
          { role: "user", content: text },
        ], { maxTokens: 50, temperature: 0 });

        const category = response.content.trim();

        return {
          category,
          confidence: categories.includes(category) ? "high" : "low",
        };
      }

      default:
        return { error: \`Unknown skill: \${task.type}. Available: summarize, classify\` };
    }
  },

  async terminate(context: AgentContext) {
    context.log?.info("${name} service shutting down");
  },
});

export default agent;
`;

  const manifestJson = JSON.stringify({
    id: slug,
    name: `${name} Service`,
    version: "0.1.0",
    description: "Reusable service agent that other agents can call via A2A",
    permissions: ["memory.read", "memory.write", "llm.execute"],
    trustLevel: "semi-autonomous",
    limits: {
      maxTokensPerRequest: 2048,
      requestsPerMinute: 120,
    },
    a2aSkills: [
      {
        id: "summarize",
        name: "Summarize Text",
        description: "Summarize a block of text to key points",
        inputSchema: {
          type: "object",
          properties: {
            type: { const: "summarize" },
            text: { type: "string" },
            maxLength: { type: "number" },
          },
          required: ["type", "text"],
        },
      },
      {
        id: "classify",
        name: "Classify Text",
        description: "Classify text into provided categories",
        inputSchema: {
          type: "object",
          properties: {
            type: { const: "classify" },
            text: { type: "string" },
            categories: { type: "array", items: { type: "string" } },
          },
          required: ["type", "text", "categories"],
        },
      },
    ],
  }, null, 2);

  const testTs = `import { describe, it, expect, vi } from "vitest";

describe("${name} Service", () => {
  const mockClient = {
    chat: vi.fn().mockResolvedValue({ content: "Summary of the text", model: "gpt-4o-mini" }),
    storeFact: vi.fn(),
    searchMemory: vi.fn(),
    recordEpisode: vi.fn(),
    invokeTool: vi.fn(),
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

  it("should summarize text", async () => {
    const { default: agent } = await import("./index.js");
    const result = await agent.handleTask(
      { type: "summarize", text: "This is a long text that needs summarizing." },
      mockContext,
    );
    expect(result).toHaveProperty("summary");
  });

  it("should classify text into categories", async () => {
    mockClient.chat.mockResolvedValueOnce({ content: "bug-report", model: "gpt-4o-mini" });
    const { default: agent } = await import("./index.js");
    const result = await agent.handleTask(
      { type: "classify", text: "The button is broken", categories: ["bug-report", "feature-request", "question"] },
      mockContext,
    );
    expect(result).toHaveProperty("category", "bug-report");
    expect(result).toHaveProperty("confidence", "high");
  });

  it("should error on unknown skill", async () => {
    const { default: agent } = await import("./index.js");
    const result = await agent.handleTask({ type: "unknown" }, mockContext);
    expect(result).toHaveProperty("error");
  });

  it("should error on empty text for summarize", async () => {
    const { default: agent } = await import("./index.js");
    const result = await agent.handleTask({ type: "summarize", text: "" }, mockContext);
    expect(result).toHaveProperty("error");
  });
});
`;

  return { indexTs, manifestJson, testTs };
}

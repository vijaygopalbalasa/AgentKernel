// Template: Chat Agent — Conversational agent with LLM + memory
// This is the default template for agentkernel new-agent.

export function getChatTemplate(slug: string, name: string): { indexTs: string; manifestJson: string; testTs: string } {
  const indexTs = `import { defineAgent, type AgentContext } from "@agentkernel/sdk";

/**
 * ${name} Agent — A conversational agent with LLM and memory.
 *
 * This agent handles natural language conversations, remembers facts
 * across sessions, and can use tools for extended capabilities.
 *
 * Key APIs used:
 * - context.client.chat()         — Send messages to an LLM
 * - context.client.storeFact()    — Store knowledge in semantic memory
 * - context.client.searchMemory() — Recall past knowledge
 * - context.client.recordEpisode()— Record events in episodic memory
 */
const agent = defineAgent({
  manifest: {
    id: "${slug}",
    name: "${name} Agent",
    version: "0.1.0",
    description: "Conversational agent with LLM and memory",
    permissions: ["memory.read", "memory.write", "llm.execute"],
    trustLevel: "supervised",
    limits: {
      maxTokensPerRequest: 2048,
      requestsPerMinute: 30,
    },
  },

  async initialize(context: AgentContext) {
    context.log?.info("${name} agent initialized");
  },

  async handleTask(task: Record<string, unknown>, context: AgentContext) {
    const { client } = context;
    const userMessage = typeof task.message === "string" ? task.message : String(task.message ?? "");

    if (!userMessage) {
      return { error: "No message provided" };
    }

    // Search memory for relevant context
    const memories = await client.searchMemory(userMessage, { limit: 3 });
    const memoryContext = memories.length > 0
      ? "\\nRelevant context from memory:\\n" + memories.map((m) => \`- \${m.content}\`).join("\\n")
      : "";

    // Send to LLM with memory context
    const response = await client.chat([
      { role: "system", content: \`You are the ${name} agent. Be helpful and concise.\${memoryContext}\` },
      { role: "user", content: userMessage },
    ], { maxTokens: 1024 });

    // Store important facts from the conversation
    if (response.content.length > 50) {
      await client.storeFact({
        category: "conversations",
        fact: \`User asked: "\${userMessage.slice(0, 100)}" — Answered about \${response.content.slice(0, 100)}\`,
        tags: ["conversation"],
      });
    }

    // Record the interaction as an episode
    await client.recordEpisode({
      event: "chat.completed",
      context: JSON.stringify({ userMessage: userMessage.slice(0, 200) }),
      tags: ["chat"],
      success: true,
    });

    return {
      content: response.content,
      model: response.model,
      usage: response.usage,
    };
  },

  async terminate(context: AgentContext) {
    context.log?.info("${name} agent shutting down");
  },
});

export default agent;
`;

  const manifestJson = JSON.stringify({
    id: slug,
    name: `${name} Agent`,
    version: "0.1.0",
    description: "Conversational agent with LLM and memory",
    permissions: ["memory.read", "memory.write", "llm.execute"],
    trustLevel: "supervised",
    limits: {
      maxTokensPerRequest: 2048,
      requestsPerMinute: 30,
    },
  }, null, 2);

  const testTs = `import { describe, it, expect, vi } from "vitest";

// Test the ${name} Agent
// These tests mock the AgentClient to test agent logic without a live gateway.

describe("${name} Agent", () => {
  const mockClient = {
    chat: vi.fn().mockResolvedValue({
      content: "Hello! How can I help you?",
      model: "gpt-4o-mini",
    }),
    storeFact: vi.fn().mockResolvedValue(undefined),
    searchMemory: vi.fn().mockResolvedValue([]),
    recordEpisode: vi.fn().mockResolvedValue(undefined),
    invokeTool: vi.fn(),
    listTools: vi.fn(),
    callAgent: vi.fn(),
    discoverAgents: vi.fn(),
    emit: vi.fn(),
    sendTask: vi.fn(),
  };

  const mockContext = {
    agentId: "${slug}",
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    client: mockClient,
  };

  it("should respond to a user message", async () => {
    const { default: agent } = await import("./index.js");
    const result = await agent.handleTask({ message: "Hello" }, mockContext);
    expect(result).toHaveProperty("content");
    expect(mockClient.chat).toHaveBeenCalled();
  });

  it("should return error for empty message", async () => {
    const { default: agent } = await import("./index.js");
    const result = await agent.handleTask({}, mockContext);
    expect(result).toHaveProperty("error");
  });

  it("should search memory for context", async () => {
    mockClient.searchMemory.mockResolvedValueOnce([
      { type: "semantic", content: "User likes TypeScript", score: 0.9 },
    ]);
    const { default: agent } = await import("./index.js");
    await agent.handleTask({ message: "What do I like?" }, mockContext);
    expect(mockClient.searchMemory).toHaveBeenCalledWith("What do I like?", { limit: 3 });
  });

  it("should record conversation episodes", async () => {
    const { default: agent } = await import("./index.js");
    await agent.handleTask({ message: "Test message" }, mockContext);
    expect(mockClient.recordEpisode).toHaveBeenCalledWith(
      expect.objectContaining({ event: "chat.completed", success: true })
    );
  });
});
`;

  return { indexTs, manifestJson, testTs };
}

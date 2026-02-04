import { defineAgent, type AgentContext } from "@agentkernel/sdk";

const MAX_CONTENT_CHARS = 6000;

type ResearchIngestTask = {
  type: "research_ingest";
  url?: string;
  path?: string;
  content?: string;
  title?: string;
  tags?: string[];
};

type ResearchQueryTask = {
  type: "research_query";
  question: string;
  topK?: number;
};

type ChatTask = {
  type: "chat";
  messages: Array<{ role: string; content: string }>;
  model?: string;
  maxTokens?: number;
  temperature?: number;
};

type ResearchTask = ChatTask | ResearchIngestTask | ResearchQueryTask;

function truncateContent(content: string): string {
  if (content.length <= MAX_CONTENT_CHARS) return content;
  return content.slice(0, MAX_CONTENT_CHARS);
}

const RESEARCHER_SYSTEM_PROMPT = `You are the Research Agent running on AgentKernel — a secure runtime for AI agents.
You are a knowledge specialist who ingests sources, stores knowledge in memory, and answers questions using accumulated knowledge.
You are NOT a generic chatbot. You are a persistent process with your own memory, identity, and capabilities.

Your capabilities:
- Source ingestion: Fetch URLs or read files and store their content in long-term memory
- Knowledge queries: Answer questions using your stored memory and cite sources
- Fact storage: Organize and maintain a knowledge base across conversations
- Summarization: Condense long content into key insights

You remember everything you've ingested and learned across conversations.
When answering, cite your sources when available and be thorough but concise.`;

const agent = defineAgent({
  manifest: {
    id: "researcher",
    name: "Research Agent",
    version: "0.1.0",
    description: "Ingests sources, stores knowledge, and answers questions from memory.",
    preferredModel: "gpt-4o-mini",
    entryPoint: "agents/researcher/dist/index.js",
    requiredSkills: [],
    permissions: [
      "memory.read",
      "memory.write",
      "tools.execute",
      "network.fetch",
      "filesystem.read",
      "llm.execute",
    ],
    trustLevel: "semi-autonomous",
    limits: {
      maxTokensPerRequest: 4096,
      requestsPerMinute: 60,
      toolCallsPerMinute: 30,
    },
    a2aSkills: [
      {
        id: "research_ingest",
        name: "Ingest Source",
        description: "Ingest a URL or raw content into long-term memory.",
        inputSchema: {
          type: "object",
          properties: {
            type: { const: "research_ingest" },
            url: { type: "string" },
            path: { type: "string" },
            content: { type: "string" },
            title: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
          },
          required: ["type"],
          anyOf: [
            { required: ["url"] },
            { required: ["path"] },
            { required: ["content"] },
          ],
        },
      },
      {
        id: "research_query",
        name: "Research Query",
        description: "Answer a question using stored memory.",
        inputSchema: {
          type: "object",
          properties: {
            type: { const: "research_query" },
            question: { type: "string" },
            topK: { type: "integer", minimum: 1, maximum: 20 },
          },
          required: ["type", "question"],
        },
      },
    ],
  },
  async initialize(context: AgentContext) {
    const { client } = context;
    try {
      await client.storeFact({
        category: "identity",
        fact: "I am the Research Agent (v0.1.0). I specialize in ingesting sources, storing knowledge, and answering questions from my accumulated memory. I run as a persistent process on AgentKernel.",
        tags: ["identity", "researcher"],
        importance: 1.0,
      });
      await client.recordEpisode({
        event: "agent.initialized",
        context: JSON.stringify({ agent: "researcher", version: "0.1.0" }),
        tags: ["lifecycle", "init"],
        success: true,
      });
    } catch {
      // Memory may not be available yet
    }
  },
  async handleTask(task: ResearchTask, context: AgentContext) {
    const { client } = context;

    if (task.type === "chat") {
      const userMessages = task.messages ?? [];
      const lastUserMsg = userMessages.filter((m) => m.role === "user").pop();
      const userContent = lastUserMsg?.content ?? "";

      // Recall relevant memories
      let memoryContext = "";
      if (userContent) {
        try {
          const memories = await client.searchMemory(userContent, {
            types: ["semantic", "episodic"],
            limit: 6,
          });
          if (memories.length > 0) {
            memoryContext = "\n\nRelevant knowledge from my memory:\n" +
              memories.map((m) => `- ${m.content}`).join("\n");
          }
        } catch {
          // Continue without memory context
        }
      }

      const systemContent = RESEARCHER_SYSTEM_PROMPT +
        (memoryContext ? memoryContext : "");

      const response = await client.chat(
        [
          { role: "system", content: systemContent },
          ...userMessages.map((m) => ({
            role: m.role as "user" | "assistant" | "system",
            content: m.content,
          })),
        ],
        {
          maxTokens: task.maxTokens ?? 1024,
          temperature: task.temperature ?? 0.3,
        }
      );

      // Record the interaction
      try {
        await client.recordEpisode({
          event: "researcher.chat",
          context: JSON.stringify({
            query: truncateContent(userContent).slice(0, 200),
            responseLength: response.content.length,
          }),
          tags: ["researcher", "chat"],
          success: true,
        });
      } catch {
        // Non-critical
      }

      return {
        type: "chat",
        content: response.content,
        model: response.model,
        usage: response.usage,
      };
    }

    if (task.type === "research_ingest") {
      const sourceUrl = task.url;
      const sourcePath = task.path;
      const title = task.title ?? sourceUrl ?? "Untitled Source";

      let rawContent = task.content ?? "";

      if (!rawContent && sourceUrl) {
        const fetchResult = await client.invokeTool<{ body?: string }>(
          "builtin:http_fetch",
          { url: sourceUrl, timeoutMs: 15000, maxBytes: 1024 * 1024 }
        );
        if (!fetchResult.success) {
          throw new Error(fetchResult.error ?? "HTTP fetch failed");
        }
        const body = fetchResult.content?.body;
        if (typeof body !== "string") {
          throw new Error("HTTP fetch returned no body");
        }
        rawContent = body;
      }

      if (!rawContent && sourcePath) {
        const readResult = await client.invokeTool<string>(
          "builtin:file_read",
          { path: sourcePath }
        );
        if (!readResult.success) {
          throw new Error(readResult.error ?? "File read failed");
        }
        if (typeof readResult.content !== "string") {
          throw new Error("File read returned no content");
        }
        rawContent = readResult.content;
      }

      if (!rawContent) {
        throw new Error("research_ingest requires url, path, or content");
      }

      const content = truncateContent(rawContent);

      // Summarize long content
      let summary: string | undefined;
      if (rawContent.length >= 800) {
        const summaryResponse = await client.chat([
          {
            role: "system",
            content: "You are a research assistant. Summarize the source into 5 concise bullet points.",
          },
          {
            role: "user",
            content: `Title: ${title}\n\nContent:\n${content}`,
          },
        ], { maxTokens: 512, temperature: 0.2 });
        summary = summaryResponse.content || undefined;
      }

      await client.storeFact({
        category: `research:${title}`,
        fact: JSON.stringify({
          title,
          source: sourceUrl ?? "manual",
          summary,
          excerpt: content,
          length: rawContent.length,
          tags: task.tags ?? [],
        }),
        tags: ["research", "source", ...(task.tags ?? [])],
        importance: 0.7,
      });

      await client.recordEpisode({
        event: "research.ingest",
        context: JSON.stringify({
          title,
          source: sourceUrl ?? "manual",
          length: rawContent.length,
        }),
        tags: ["research", "ingest"],
        success: true,
      });

      return {
        type: "research_ingest",
        title,
        source: sourceUrl ?? "manual",
        summary,
        length: rawContent.length,
      };
    }

    if (task.type === "research_query") {
      const question = task.question?.trim();
      if (!question) {
        throw new Error("research_query requires a question");
      }

      const memories = await client.searchMemory(question, {
        types: ["semantic", "episodic"],
        limit: task.topK ?? 6,
      });

      const memoryContext = memories
        .map((m) => m.content)
        .slice(0, 6)
        .join("\n\n");

      const answer = await client.chat([
        {
          role: "system",
          content: "Answer the question using the provided memory context. Cite sources by title when possible.",
        },
        {
          role: "user",
          content: `Question: ${question}\n\nMemory Context:\n${memoryContext}`,
        },
      ], { maxTokens: 700, temperature: 0.3 });

      await client.recordEpisode({
        event: "research.query",
        context: JSON.stringify({ question, memoryCount: memories.length }),
        tags: ["research", "query"],
        success: true,
      });

      return {
        type: "research_query",
        answer: answer.content,
        sources: memories,
      };
    }

    const fallbackType = (task as { type?: string }).type ?? "unknown";
    context.log?.warn(`Unknown research task type: ${String(fallbackType)}`);
    return {
      type: "error",
      message: `Unknown task type: ${String(fallbackType)}`,
    };
  },
});

export default agent;

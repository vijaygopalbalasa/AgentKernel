import { defineAgent, sendGatewayTask } from "@agent-os/sdk";

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

type ResearchTask = ResearchIngestTask | ResearchQueryTask;

type GatewayTaskResult<T> = {
  type?: string;
  content?: T;
  success?: boolean;
  error?: string;
  memories?: unknown[];
  total?: number;
};

function resolveGatewayUrl(): string {
  const host = process.env.GATEWAY_HOST ?? "127.0.0.1";
  const port = process.env.GATEWAY_PORT ?? "18800";
  return process.env.GATEWAY_URL ?? `ws://${host}:${port}`;
}

async function callGateway<T>(agentId: string, task: Record<string, unknown>): Promise<T> {
  const result = await sendGatewayTask<T>(
    {
      url: resolveGatewayUrl(),
      agentId,
      authToken: process.env.GATEWAY_AUTH_TOKEN,
      internalToken: process.env.INTERNAL_AUTH_TOKEN,
    },
    task,
    true
  );

  if (!result.ok) {
    throw new Error(result.error ?? "Gateway task failed");
  }

  return result.result as T;
}

function truncateContent(content: string): string {
  if (content.length <= MAX_CONTENT_CHARS) return content;
  return content.slice(0, MAX_CONTENT_CHARS);
}

async function fetchUrl(agentId: string, url: string): Promise<string> {
  const response = await callGateway<GatewayTaskResult<{ body?: string }>>(agentId, {
    type: "invoke_tool",
    toolId: "builtin:http_fetch",
    arguments: {
      url,
      timeoutMs: 15000,
      maxBytes: 1024 * 1024,
    },
  });

  if (!response.success) {
    throw new Error(response.error ?? "HTTP fetch failed");
  }

  const body = response.content?.body;
  if (typeof body !== "string") {
    throw new Error("HTTP fetch returned no body");
  }

  return body;
}

async function fetchFile(agentId: string, path: string): Promise<string> {
  const response = await callGateway<GatewayTaskResult<string>>(agentId, {
    type: "invoke_tool",
    toolId: "builtin:file_read",
    arguments: { path },
  });

  if (!response.success) {
    throw new Error(response.error ?? "File read failed");
  }

  if (typeof response.content !== "string") {
    throw new Error("File read returned no content");
  }

  return response.content;
}

async function summarize(agentId: string, title: string, content: string): Promise<string | undefined> {
  if (content.length < 800) return undefined;

  const response = await callGateway<{ content?: string }>(agentId, {
    type: "chat",
    messages: [
      {
        role: "system",
        content: "You are a research assistant. Summarize the source into 5 concise bullet points.",
      },
      {
        role: "user",
        content: `Title: ${title}\n\nContent:\n${truncateContent(content)}`,
      },
    ],
    maxTokens: 512,
    temperature: 0.2,
  });

  return typeof response.content === "string" ? response.content : undefined;
}

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
  async handleTask(task: ResearchTask, context) {
    if (task.type === "research_ingest") {
      const sourceUrl = task.url;
      const sourcePath = task.path;
      const title = task.title ?? sourceUrl ?? "Untitled Source";
      const rawContent = task.content
        ?? (sourceUrl ? await fetchUrl(context.agentId, sourceUrl) : "")
        ?? (sourcePath ? await fetchFile(context.agentId, sourcePath) : "");

      if (!rawContent) {
        throw new Error("research_ingest requires url, path, or content");
      }

      const content = truncateContent(rawContent);
      const summary = await summarize(context.agentId, title, rawContent);

      await callGateway(context.agentId, {
        type: "store_fact",
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

      await callGateway(context.agentId, {
        type: "record_episode",
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

      const searchResult = await callGateway<GatewayTaskResult<unknown>>(context.agentId, {
        type: "search_memory",
        query: question,
        types: ["semantic", "episodic"],
        limit: task.topK ?? 6,
      });

      const memories = Array.isArray(searchResult.memories) ? searchResult.memories : [];
      const memoryContext = memories
        .map((memory) => JSON.stringify(memory))
        .slice(0, 6)
        .join("\n\n");

      const answer = await callGateway<{ content?: string }>(context.agentId, {
        type: "chat",
        messages: [
          {
            role: "system",
            content: "Answer the question using the provided memory context. Cite sources by title when possible.",
          },
          {
            role: "user",
            content: `Question: ${question}\n\nMemory Context:\n${memoryContext}`,
          },
        ],
        maxTokens: 700,
        temperature: 0.3,
      });

      await callGateway(context.agentId, {
        type: "record_episode",
        event: "research.query",
        context: JSON.stringify({ question, memoryCount: memories.length }),
        tags: ["research", "query"],
        success: true,
      });

      return {
        type: "research_query",
        answer: answer.content ?? "No answer generated",
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

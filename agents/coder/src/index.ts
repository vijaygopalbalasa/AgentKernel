import { defineAgent, type AgentContext } from "@agentkernel/sdk";

type CodeReviewTask = {
  type: "code_review";
  diff: string;
  context?: string;
  guidelines?: string[];
};

type TestSuggestTask = {
  type: "test_suggest";
  code: string;
  filePath?: string;
  framework?: string;
};

type RefactorSuggestTask = {
  type: "refactor_suggest";
  code: string;
  goal?: string;
};

type RunCommandTask = {
  type: "run_command";
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  allowNonZeroExit?: boolean;
};

type RepoSummaryTask = {
  type: "repo_summary";
  root?: string;
};

type ChatTask = {
  type: "chat";
  messages: Array<{ role: string; content: string }>;
  model?: string;
  maxTokens?: number;
  temperature?: number;
};

type CoderTask =
  | ChatTask
  | CodeReviewTask
  | TestSuggestTask
  | RefactorSuggestTask
  | RunCommandTask
  | RepoSummaryTask;

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...truncated...`;
}

const CODER_SYSTEM_PROMPT = `You are the Coder Agent running on AgentKernel — a secure runtime for AI agents.
You are a senior software engineer specializing in code review, testing, refactoring, and repository analysis.
You are NOT a generic chatbot. You are a persistent process with your own memory, identity, and capabilities.

Your capabilities:
- Code review: Analyze diffs and code snippets for bugs, risks, and improvements
- Test suggestions: Recommend test cases and edge cases for code
- Refactoring: Propose maintainability and safety improvements
- Shell commands: Execute allowlisted commands for analysis
- Repository analysis: Summarize codebases using directory listings and READMEs

You remember past conversations and build context over time.
When discussing code, be specific, practical, and concise.`;

const agent = defineAgent({
  manifest: {
    id: "coder",
    name: "Coder Agent",
    version: "0.1.0",
    description: "Reviews code, suggests tests, and proposes refactors.",
    preferredModel: "gpt-4o-mini",
    entryPoint: "agents/coder/dist/index.js",
    requiredSkills: [],
    permissions: [
      "memory.read",
      "memory.write",
      "llm.execute",
      "tools.execute",
      "filesystem.read",
      "shell.execute",
    ],
    trustLevel: "semi-autonomous",
    limits: {
      maxTokensPerRequest: 4096,
      requestsPerMinute: 60,
    },
    a2aSkills: [
      {
        id: "code_review",
        name: "Code Review",
        description: "Review a diff or code snippet and return findings.",
        inputSchema: {
          type: "object",
          properties: {
            type: { const: "code_review" },
            diff: { type: "string" },
            context: { type: "string" },
            guidelines: { type: "array", items: { type: "string" } },
          },
          required: ["type", "diff"],
        },
      },
      {
        id: "test_suggest",
        name: "Test Suggestions",
        description: "Suggest tests for a given file or snippet.",
        inputSchema: {
          type: "object",
          properties: {
            type: { const: "test_suggest" },
            code: { type: "string" },
            filePath: { type: "string" },
            framework: { type: "string" },
          },
          required: ["type", "code"],
        },
      },
      {
        id: "refactor_suggest",
        name: "Refactor Suggestions",
        description: "Recommend refactors for a code snippet.",
        inputSchema: {
          type: "object",
          properties: {
            type: { const: "refactor_suggest" },
            code: { type: "string" },
            goal: { type: "string" },
          },
          required: ["type", "code"],
        },
      },
      {
        id: "run_command",
        name: "Run Command",
        description: "Execute a shell command (allowlisted) and return output.",
        inputSchema: {
          type: "object",
          properties: {
            type: { const: "run_command" },
            command: { type: "string" },
            args: { type: "array", items: { type: "string" } },
            cwd: { type: "string" },
            timeoutMs: { type: "integer", minimum: 100, maximum: 60000 },
            allowNonZeroExit: { type: "boolean" },
          },
          required: ["type", "command"],
        },
      },
      {
        id: "repo_summary",
        name: "Repository Summary",
        description: "Summarize a repository using README and directory listing.",
        inputSchema: {
          type: "object",
          properties: {
            type: { const: "repo_summary" },
            root: { type: "string" },
          },
          required: ["type"],
        },
      },
    ],
  },
  async initialize(context: AgentContext) {
    const { client } = context;
    try {
      await client.storeFact({
        category: "identity",
        fact: "I am the Coder Agent (v0.1.0). I specialize in code review, test suggestions, refactoring, shell commands, and repository analysis. I run as a persistent process on AgentKernel with my own memory and permissions.",
        tags: ["identity", "coder"],
        importance: 1.0,
      });
      await client.recordEpisode({
        event: "agent.initialized",
        context: JSON.stringify({ agent: "coder", version: "0.1.0" }),
        tags: ["lifecycle", "init"],
        success: true,
      });
    } catch {
      // Memory may not be available yet; continue without it
    }
  },
  async handleTask(task: CoderTask, context: AgentContext) {
    const { client } = context;

    if (task.type === "chat") {
      const userMessages = task.messages ?? [];
      const lastUserMsg = userMessages.filter((m) => m.role === "user").pop();
      const userContent = lastUserMsg?.content ?? "";

      // Recall relevant memories for context
      let memoryContext = "";
      if (userContent) {
        try {
          const memories = await client.searchMemory(userContent, {
            types: ["semantic", "episodic"],
            limit: 5,
          });
          if (memories.length > 0) {
            memoryContext = "\n\nRelevant memories from past interactions:\n" +
              memories.map((m) => `- ${m.content}`).join("\n");
          }
        } catch {
          // Memory search may fail; continue without context
        }
      }

      const systemContent = CODER_SYSTEM_PROMPT +
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
          temperature: task.temperature ?? 0.4,
        }
      );

      // Record this interaction in episodic memory
      try {
        await client.recordEpisode({
          event: "coder.chat",
          context: JSON.stringify({
            query: truncate(userContent, 200),
            responseLength: response.content.length,
          }),
          tags: ["coder", "chat"],
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

    if (task.type === "code_review") {
      const guidelines = task.guidelines?.length
        ? `Guidelines:\n- ${task.guidelines.join("\n- ")}`
        : "";

      const response = await client.chat([
        {
          role: "system",
          content: "You are a senior software engineer. Provide a structured code review with risks, bugs, and test gaps.",
        },
        {
          role: "user",
          content: `Context:\n${task.context ?? "No extra context."}\n\n${guidelines}\n\nDiff:\n${task.diff}`,
        },
      ], { maxTokens: 900, temperature: 0.2 });

      await client.recordEpisode({
        event: "coder.review",
        context: JSON.stringify({ diffLength: task.diff.length }),
        tags: ["coder", "review"],
        success: true,
      });

      return { type: "code_review", review: response.content };
    }

    if (task.type === "test_suggest") {
      const response = await client.chat([
        {
          role: "system",
          content: "You are a testing expert. Suggest test cases and edge cases for the provided code.",
        },
        {
          role: "user",
          content: `File: ${task.filePath ?? "unknown"}\nFramework: ${task.framework ?? "unspecified"}\n\nCode:\n${task.code}`,
        },
      ], { maxTokens: 700, temperature: 0.3 });

      await client.recordEpisode({
        event: "coder.tests",
        context: JSON.stringify({ filePath: task.filePath ?? "unknown" }),
        tags: ["coder", "tests"],
        success: true,
      });

      return { type: "test_suggest", suggestions: response.content };
    }

    if (task.type === "refactor_suggest") {
      const response = await client.chat([
        {
          role: "system",
          content: "You are a refactoring assistant. Suggest improvements focused on maintainability and safety.",
        },
        {
          role: "user",
          content: `Goal: ${task.goal ?? "General improvements"}\n\nCode:\n${task.code}`,
        },
      ], { maxTokens: 700, temperature: 0.3 });

      await client.recordEpisode({
        event: "coder.refactor",
        context: JSON.stringify({ goal: task.goal ?? "general" }),
        tags: ["coder", "refactor"],
        success: true,
      });

      return { type: "refactor_suggest", suggestions: response.content };
    }

    if (task.type === "run_command") {
      const result = await client.invokeTool<{
        stdout?: string;
        stderr?: string;
        exitCode?: number | null;
        signal?: string | null;
      }>("builtin:shell_exec", {
        command: task.command,
        args: task.args ?? [],
        cwd: task.cwd,
        timeoutMs: task.timeoutMs ?? 30000,
        allowNonZeroExit: task.allowNonZeroExit ?? false,
      });

      if (!result.success) {
        throw new Error(result.error ?? "Command failed");
      }

      await client.recordEpisode({
        event: "coder.run_command",
        context: JSON.stringify({ command: task.command, cwd: task.cwd }),
        tags: ["coder", "command"],
        success: true,
      });

      return { type: "run_command", output: result.content ?? {} };
    }

    if (task.type === "repo_summary") {
      const root = task.root ?? ".";
      let listing = "";
      let readme = "";

      try {
        const listResult = await client.invokeTool<{ stdout?: string }>(
          "builtin:shell_exec",
          { command: "ls", args: ["-la", root], cwd: root, timeoutMs: 10000, allowNonZeroExit: true }
        );
        if (listResult.success) {
          listing = listResult.content?.stdout ?? "";
        }
      } catch {
        // best-effort
      }

      try {
        const readmeResult = await client.invokeTool<string>(
          "builtin:file_read",
          { path: `${root.replace(/[\\\/]$/, "")}/README.md` }
        );
        if (readmeResult.success && typeof readmeResult.content === "string") {
          readme = readmeResult.content;
        }
      } catch {
        // best-effort
      }

      const response = await client.chat([
        {
          role: "system",
          content: "You are a senior engineer. Summarize the repo structure and purpose in 6 bullets.",
        },
        {
          role: "user",
          content: `Repo root: ${root}\n\nDirectory listing:\n${truncate(listing, 4000)}\n\nREADME:\n${truncate(readme, 6000)}`,
        },
      ], { maxTokens: 600, temperature: 0.2 });

      await client.recordEpisode({
        event: "coder.repo_summary",
        context: JSON.stringify({ root }),
        tags: ["coder", "summary"],
        success: true,
      });

      return { type: "repo_summary", summary: response.content };
    }

    const fallbackType = (task as { type?: string }).type ?? "unknown";
    context.log?.warn(`Unknown coder task type: ${String(fallbackType)}`);
    return { type: "error", message: `Unknown task type: ${String(fallbackType)}` };
  },
});

export default agent;

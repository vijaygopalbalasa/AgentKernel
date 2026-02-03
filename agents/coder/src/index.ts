import { defineAgent, sendGatewayTask } from "@agent-os/sdk";

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

type CoderTask =
  | CodeReviewTask
  | TestSuggestTask
  | RefactorSuggestTask
  | RunCommandTask
  | RepoSummaryTask;

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

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...truncated...`;
}

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
  async handleTask(task: CoderTask, context) {
    if (task.type === "code_review") {
      const guidelines = task.guidelines?.length
        ? `Guidelines:\n- ${task.guidelines.join("\n- ")}`
        : "";

      const response = await callGateway<{ content?: string }>(context.agentId, {
        type: "chat",
        messages: [
          {
            role: "system",
            content: "You are a senior software engineer. Provide a structured code review with risks, bugs, and test gaps.",
          },
          {
            role: "user",
            content: `Context:\n${task.context ?? "No extra context."}\n\n${guidelines}\n\nDiff:\n${task.diff}`,
          },
        ],
        maxTokens: 900,
        temperature: 0.2,
      });

      await callGateway(context.agentId, {
        type: "record_episode",
        event: "coder.review",
        context: JSON.stringify({ diffLength: task.diff.length }),
        tags: ["coder", "review"],
        success: true,
      });

      return {
        type: "code_review",
        review: response.content ?? "No review generated",
      };
    }

    if (task.type === "test_suggest") {
      const response = await callGateway<{ content?: string }>(context.agentId, {
        type: "chat",
        messages: [
          {
            role: "system",
            content: "You are a testing expert. Suggest test cases and edge cases for the provided code.",
          },
          {
            role: "user",
            content: `File: ${task.filePath ?? "unknown"}\nFramework: ${task.framework ?? "unspecified"}\n\nCode:\n${task.code}`,
          },
        ],
        maxTokens: 700,
        temperature: 0.3,
      });

      await callGateway(context.agentId, {
        type: "record_episode",
        event: "coder.tests",
        context: JSON.stringify({ filePath: task.filePath ?? "unknown" }),
        tags: ["coder", "tests"],
        success: true,
      });

      return {
        type: "test_suggest",
        suggestions: response.content ?? "No suggestions generated",
      };
    }

    if (task.type === "refactor_suggest") {
      const response = await callGateway<{ content?: string }>(context.agentId, {
        type: "chat",
        messages: [
          {
            role: "system",
            content: "You are a refactoring assistant. Suggest improvements focused on maintainability and safety.",
          },
          {
            role: "user",
            content: `Goal: ${task.goal ?? "General improvements"}\n\nCode:\n${task.code}`,
          },
        ],
        maxTokens: 700,
        temperature: 0.3,
      });

      await callGateway(context.agentId, {
        type: "record_episode",
        event: "coder.refactor",
        context: JSON.stringify({ goal: task.goal ?? "general" }),
        tags: ["coder", "refactor"],
        success: true,
      });

      return {
        type: "refactor_suggest",
        suggestions: response.content ?? "No suggestions generated",
      };
    }

    if (task.type === "run_command") {
      const response = await callGateway<{
        success?: boolean;
        content?: { stdout?: string; stderr?: string; exitCode?: number | null; signal?: string | null };
        error?: string;
      }>(context.agentId, {
        type: "invoke_tool",
        toolId: "builtin:shell_exec",
        arguments: {
          command: task.command,
          args: task.args ?? [],
          cwd: task.cwd,
          timeoutMs: task.timeoutMs ?? 30000,
          allowNonZeroExit: task.allowNonZeroExit ?? false,
        },
      });

      if (!response.success) {
        throw new Error(response.error ?? "Command failed");
      }

      await callGateway(context.agentId, {
        type: "record_episode",
        event: "coder.run_command",
        context: JSON.stringify({ command: task.command, cwd: task.cwd }),
        tags: ["coder", "command"],
        success: true,
      });

      return {
        type: "run_command",
        output: response.content ?? {},
      };
    }

    if (task.type === "repo_summary") {
      const root = task.root ?? ".";
      let listing = "";
      let readme = "";

      try {
        const listResult = await callGateway<{
          success?: boolean;
          content?: { stdout?: string };
        }>(context.agentId, {
          type: "invoke_tool",
          toolId: "builtin:shell_exec",
          arguments: {
            command: "ls",
            args: ["-la", root],
            cwd: root,
            timeoutMs: 10000,
            allowNonZeroExit: true,
          },
        });
        if (listResult.success) {
          listing = listResult.content?.stdout ?? "";
        }
      } catch {
        // best-effort
      }

      try {
        const readmeResult = await callGateway<{
          success?: boolean;
          content?: string;
        }>(context.agentId, {
          type: "invoke_tool",
          toolId: "builtin:file_read",
          arguments: { path: `${root.replace(/[\\\/]$/, "")}/README.md` },
        });
        if (readmeResult.success && typeof readmeResult.content === "string") {
          readme = readmeResult.content;
        }
      } catch {
        // best-effort
      }

      const response = await callGateway<{ content?: string }>(context.agentId, {
        type: "chat",
        messages: [
          {
            role: "system",
            content: "You are a senior engineer. Summarize the repo structure and purpose in 6 bullets.",
          },
          {
            role: "user",
            content: `Repo root: ${root}\n\nDirectory listing:\n${truncate(listing, 4000)}\n\nREADME:\n${truncate(readme, 6000)}`,
          },
        ],
        maxTokens: 600,
        temperature: 0.2,
      });

      await callGateway(context.agentId, {
        type: "record_episode",
        event: "coder.repo_summary",
        context: JSON.stringify({ root }),
        tags: ["coder", "summary"],
        success: true,
      });

      return {
        type: "repo_summary",
        summary: response.content ?? "No summary generated",
      };
    }

    const fallbackType = (task as { type?: string }).type ?? "unknown";
    context.log?.warn(`Unknown coder task type: ${String(fallbackType)}`);
    return { type: "error", message: `Unknown task type: ${String(fallbackType)}` };
  },
});

export default agent;

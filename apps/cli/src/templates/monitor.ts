// Template: Monitor Agent — Watches resources and reports changes
// Monitors check URLs, APIs, files, etc. on a schedule and alert on changes.

export function getMonitorTemplate(slug: string, name: string): { indexTs: string; manifestJson: string; testTs: string } {
  const indexTs = `import { defineAgent, type AgentContext } from "@agentkernel/sdk";

/**
 * ${name} Monitor — Watches resources and reports changes.
 *
 * Monitors periodically check URLs, APIs, or other resources,
 * compare against previous state, and emit events on changes.
 * Ideal for:
 * - Uptime monitoring
 * - Price/content change detection
 * - API health checks
 * - Log watching
 *
 * Key APIs used:
 * - context.client.invokeTool()    — Fetch URLs, read files, etc.
 * - context.client.storeFact()     — Store last-known state
 * - context.client.searchMemory()  — Retrieve last-known state
 * - context.client.chat()          — Analyze changes with LLM
 * - context.client.emit()          — Emit alerts on change detection
 * - context.client.callAgent()     — Notify other agents of changes
 */

interface MonitorTask {
  type: "check" | "configure" | "status";
  url?: string;
  targets?: Array<{ url: string; label?: string }>;
}

const agent = defineAgent({
  manifest: {
    id: "${slug}",
    name: "${name} Monitor",
    version: "0.1.0",
    description: "Watches resources and reports changes",
    permissions: ["memory.read", "memory.write", "tools.execute", "llm.execute"],
    trustLevel: "semi-autonomous",
    limits: {
      maxTokensPerRequest: 1024,
      requestsPerMinute: 120,
    },
  },

  async initialize(context: AgentContext) {
    context.log?.info("${name} monitor started");
  },

  async handleTask(task: MonitorTask, context: AgentContext) {
    const { client } = context;

    switch (task.type) {
      case "check": {
        const url = task.url;
        if (!url) {
          return { error: "No URL provided for check" };
        }

        // Fetch the resource
        const fetchResult = await client.invokeTool<{ body?: string; status?: number }>(
          "builtin:http_fetch",
          { url, timeoutMs: 15000 },
        );

        if (!fetchResult.success) {
          await client.emit("monitor.alerts", "monitor.check.failed", {
            url,
            error: fetchResult.error,
          });
          return { status: "error", url, error: fetchResult.error };
        }

        const currentContent = typeof fetchResult.content?.body === "string"
          ? fetchResult.content.body.slice(0, 2000)
          : JSON.stringify(fetchResult.content).slice(0, 2000);

        // Retrieve previous snapshot from memory
        const previousSnapshots = await client.searchMemory(\`monitor snapshot \${url}\`, {
          types: ["semantic"],
          limit: 1,
        });

        const previousContent = previousSnapshots.length > 0
          ? previousSnapshots[0].content
          : null;

        // Compare
        const changed = previousContent !== null && previousContent !== currentContent;

        // Store current snapshot
        await client.storeFact({
          category: "monitor-snapshots",
          fact: currentContent,
          tags: ["monitor", "snapshot", url],
          importance: 0.3,
        });

        if (changed) {
          // Use LLM to summarize the change
          const analysis = await client.chat([
            { role: "system", content: "Briefly describe what changed between these two snapshots. Be concise (1-2 sentences)." },
            { role: "user", content: \`Previous:\\n\${previousContent?.slice(0, 500)}\\n\\nCurrent:\\n\${currentContent.slice(0, 500)}\` },
          ], { maxTokens: 200 });

          await client.emit("monitor.alerts", "monitor.change.detected", {
            url,
            summary: analysis.content,
          });

          await client.recordEpisode({
            event: "monitor.change.detected",
            context: JSON.stringify({ url, summary: analysis.content }),
            tags: ["monitor", "change"],
            success: true,
          });

          return { status: "changed", url, summary: analysis.content };
        }

        return { status: "unchanged", url, httpStatus: fetchResult.content?.status };
      }

      case "status": {
        return { status: "running", agentId: "${slug}" };
      }

      default:
        return { error: \`Unknown monitor task type: \${task.type}\` };
    }
  },

  async terminate(context: AgentContext) {
    context.log?.info("${name} monitor stopped");
  },
});

export default agent;
`;

  const manifestJson = JSON.stringify({
    id: slug,
    name: `${name} Monitor`,
    version: "0.1.0",
    description: "Watches resources and reports changes",
    permissions: ["memory.read", "memory.write", "tools.execute", "llm.execute"],
    trustLevel: "semi-autonomous",
    limits: {
      maxTokensPerRequest: 1024,
      requestsPerMinute: 120,
    },
  }, null, 2);

  const testTs = `import { describe, it, expect, vi } from "vitest";

describe("${name} Monitor", () => {
  const mockClient = {
    chat: vi.fn().mockResolvedValue({ content: "Content changed significantly", model: "gpt-4o-mini" }),
    storeFact: vi.fn().mockResolvedValue(undefined),
    searchMemory: vi.fn().mockResolvedValue([]),
    recordEpisode: vi.fn().mockResolvedValue(undefined),
    invokeTool: vi.fn().mockResolvedValue({
      success: true,
      content: { body: "page content", status: 200 },
    }),
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

  it("should check a URL and report unchanged", async () => {
    const { default: agent } = await import("./index.js");
    const result = await agent.handleTask(
      { type: "check", url: "https://example.com" },
      mockContext,
    );
    expect(result).toHaveProperty("status", "unchanged");
  });

  it("should detect changes when content differs", async () => {
    mockClient.searchMemory.mockResolvedValueOnce([
      { type: "semantic", content: "old content", score: 0.9 },
    ]);
    const { default: agent } = await import("./index.js");
    const result = await agent.handleTask(
      { type: "check", url: "https://example.com" },
      mockContext,
    );
    expect(result).toHaveProperty("status", "changed");
    expect(mockClient.emit).toHaveBeenCalledWith(
      "monitor.alerts",
      "monitor.change.detected",
      expect.objectContaining({ url: "https://example.com" }),
    );
  });

  it("should report error when fetch fails", async () => {
    mockClient.invokeTool.mockResolvedValueOnce({ success: false, error: "Timeout" });
    const { default: agent } = await import("./index.js");
    const result = await agent.handleTask(
      { type: "check", url: "https://down.example.com" },
      mockContext,
    );
    expect(result).toHaveProperty("status", "error");
  });

  it("should return status", async () => {
    const { default: agent } = await import("./index.js");
    const result = await agent.handleTask({ type: "status" }, mockContext);
    expect(result).toHaveProperty("status", "running");
  });
});
`;

  return { indexTs, manifestJson, testTs };
}

import { defineAgent, sendGatewayTask } from "@agentrun/sdk";
import { createHash } from "node:crypto";

const MAX_BODY_BYTES = 1024 * 1024;

type MonitorAddTask = {
  type: "monitor_add";
  url: string;
  name?: string;
  notifyUrl?: string;
};

type MonitorRemoveTask = {
  type: "monitor_remove";
  id: string;
};

type MonitorCheckTask = {
  type: "monitor_check";
  id?: string;
};

type MonitorListTask = {
  type: "monitor_list";
};

type ChatTask = {
  type: "chat";
  messages: Array<{ role: string; content: string }>;
  model?: string;
  maxTokens?: number;
  temperature?: number;
};

type MonitorTask = ChatTask | MonitorAddTask | MonitorRemoveTask | MonitorCheckTask | MonitorListTask;

type WatchConfig = {
  id: string;
  url: string;
  name?: string;
  notifyUrl?: string;
  lastHash?: string;
  lastChecked?: string;
  active: boolean;
};

type GatewayToolResult = {
  success?: boolean;
  content?: { body?: string; status?: number };
  error?: string;
};

type GatewaySearchResult = {
  memories?: Array<{ type?: string; object?: unknown }>;
};

const watchState = new Map<string, WatchConfig>();

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

function hashBody(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

async function persistWatch(agentId: string, config: WatchConfig): Promise<void> {
  await callGateway(agentId, {
    type: "store_fact",
    category: `monitor:${config.id}`,
    fact: JSON.stringify(config),
    tags: ["monitor", "watch"],
    importance: 0.5,
  });
}

async function loadWatches(agentId: string): Promise<void> {
  const result = await callGateway<GatewaySearchResult>(agentId, {
    type: "search_memory",
    tags: ["monitor", "watch"],
    types: ["semantic"],
    limit: 200,
  });

  const memories = Array.isArray(result.memories) ? result.memories : [];
  for (const memory of memories) {
    if (memory.type !== "semantic") continue;
    if (typeof memory.object !== "string") continue;

    try {
      const parsed = JSON.parse(memory.object) as WatchConfig;
      if (!parsed.id || !parsed.url) continue;
      watchState.set(parsed.id, parsed);
    } catch {
      continue;
    }
  }
}

async function fetchUrl(agentId: string, url: string): Promise<string> {
  const response = await callGateway<GatewayToolResult>(agentId, {
    type: "invoke_tool",
    toolId: "builtin:http_fetch",
    arguments: {
      url,
      timeoutMs: 15000,
      maxBytes: MAX_BODY_BYTES,
    },
  });

  if (!response.success) {
    throw new Error(response.error ?? "Monitor fetch failed");
  }

  const body = response.content?.body;
  if (typeof body !== "string") {
    throw new Error("Monitor fetch returned no body");
  }

  return body;
}

const agent = defineAgent({
  manifest: {
    id: "monitor",
    name: "Monitor Agent",
    version: "0.1.0",
    description: "Tracks URLs or feeds and emits alerts when content changes.",
    preferredModel: "gpt-4o-mini",
    entryPoint: "agents/monitor/dist/index.js",
    requiredSkills: [],
    permissions: [
      "memory.read",
      "memory.write",
      "tools.execute",
      "network.fetch",
    ],
    trustLevel: "monitored-autonomous",
    limits: {
      requestsPerMinute: 30,
      toolCallsPerMinute: 60,
    },
    a2aSkills: [
      {
        id: "monitor_add",
        name: "Add Monitor",
        description: "Add a URL to the monitoring list.",
        inputSchema: {
          type: "object",
          properties: {
            type: { const: "monitor_add" },
            url: { type: "string" },
            name: { type: "string" },
            notifyUrl: { type: "string" },
          },
          required: ["type", "url"],
        },
      },
      {
        id: "monitor_remove",
        name: "Remove Monitor",
        description: "Remove a watcher by id.",
        inputSchema: {
          type: "object",
          properties: {
            type: { const: "monitor_remove" },
            id: { type: "string" },
          },
          required: ["type", "id"],
        },
      },
      {
        id: "monitor_check",
        name: "Check Monitors",
        description: "Check all watchers (or a specific watcher).",
        inputSchema: {
          type: "object",
          properties: {
            type: { const: "monitor_check" },
            id: { type: "string" },
          },
          required: ["type"],
        },
      },
      {
        id: "monitor_list",
        name: "List Monitors",
        description: "List current watchers.",
        inputSchema: {
          type: "object",
          properties: {
            type: { const: "monitor_list" },
          },
          required: ["type"],
        },
      },
    ],
  },
  async initialize(context) {
    await loadWatches(context.agentId);
    context.log?.info(`Loaded ${watchState.size} watch configs`);
    try {
      await callGateway(context.agentId, {
        type: "store_fact",
        category: "identity",
        fact: "I am the Monitor Agent (v0.1.0). I track URLs and feeds, detecting content changes and emitting alerts. I run as a persistent autonomous process on AgentRun with scheduled periodic checks.",
        tags: ["identity", "monitor"],
        importance: 1.0,
      });
    } catch {
      // Continue without storing identity
    }
  },
  async handleTask(task: MonitorTask, context) {
    if (task.type === "chat") {
      const userMessages = task.messages ?? [];
      const lastUserMsg = userMessages.filter((m) => m.role === "user").pop();
      const userContent = lastUserMsg?.content ?? "";

      const watcherSummary = watchState.size > 0
        ? `\nCurrently monitoring ${watchState.size} URL(s):\n` +
          Array.from(watchState.values())
            .filter((w) => w.active)
            .map((w) => `- ${w.name ?? w.url} (${w.lastChecked ? `last checked: ${w.lastChecked}` : "not yet checked"})`)
            .join("\n")
        : "\nNo URLs currently being monitored.";

      const systemPrompt = `You are the Monitor Agent running on AgentRun — a secure runtime for AI agents.
You track URLs and feeds, detecting content changes and emitting alerts when things change.
You are NOT a generic chatbot. You are a persistent autonomous process with scheduled checks.

Your capabilities:
- Add URL monitors: Track any URL for content changes
- Remove monitors: Stop tracking a URL
- Check monitors: Manually trigger a check on all or specific URLs
- List monitors: Show all active watchers
- Automatic periodic checks: The OS scheduler runs checks at regular intervals
${watcherSummary}

Guide users on how to use your monitoring capabilities.`;

      const chatResponse = await callGateway<{ content?: string; model?: string }>(context.agentId, {
        type: "chat",
        messages: [
          { role: "system", content: systemPrompt },
          ...userMessages,
        ],
        maxTokens: task.maxTokens ?? 1024,
        temperature: task.temperature ?? 0.4,
      });

      try {
        await callGateway(context.agentId, {
          type: "record_episode",
          event: "monitor.chat",
          context: JSON.stringify({ query: userContent.slice(0, 200) }),
          tags: ["monitor", "chat"],
          success: true,
        });
      } catch {
        // Non-critical
      }

      return {
        type: "chat",
        content: chatResponse.content ?? "",
        model: chatResponse.model,
      };
    }

    if (task.type === "monitor_add") {
      const id = `watch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const config: WatchConfig = {
        id,
        url: task.url,
        name: task.name,
        notifyUrl: task.notifyUrl,
        active: true,
      };

      watchState.set(id, config);
      await persistWatch(context.agentId, config);

      await callGateway(context.agentId, {
        type: "record_episode",
        event: "monitor.add",
        context: JSON.stringify({ id, url: task.url, name: task.name }),
        tags: ["monitor", "add"],
        success: true,
      });

      return { type: "monitor_add", id, url: task.url, name: task.name };
    }

    if (task.type === "monitor_remove") {
      const existing = watchState.get(task.id);
      if (!existing) {
        return { type: "monitor_remove", id: task.id, removed: false };
      }

      const updated = { ...existing, active: false };
      watchState.set(task.id, updated);
      await persistWatch(context.agentId, updated);

      await callGateway(context.agentId, {
        type: "record_episode",
        event: "monitor.remove",
        context: JSON.stringify({ id: task.id, url: existing.url }),
        tags: ["monitor", "remove"],
        success: true,
      });

      return { type: "monitor_remove", id: task.id, removed: true };
    }

    if (task.type === "monitor_list") {
      return {
        type: "monitor_list",
        watchers: Array.from(watchState.values()),
      };
    }

    if (task.type === "monitor_check") {
      const targets = task.id ? [watchState.get(task.id)].filter(Boolean) : Array.from(watchState.values());
      const changes: Array<{ id: string; url: string; name?: string }> = [];

      for (const watch of targets) {
        if (!watch || !watch.active) continue;

        try {
          const body = await fetchUrl(context.agentId, watch.url);
          const digest = hashBody(body);
          const changed = watch.lastHash && watch.lastHash !== digest;

          const updated: WatchConfig = {
            ...watch,
            lastHash: digest,
            lastChecked: new Date().toISOString(),
          };
          watchState.set(watch.id, updated);
          await persistWatch(context.agentId, updated);

          if (changed) {
            changes.push({ id: watch.id, url: watch.url, name: watch.name });

            if (watch.notifyUrl) {
              await callGateway(context.agentId, {
                type: "invoke_tool",
                toolId: "builtin:http_fetch",
                arguments: {
                  url: watch.notifyUrl,
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: {
                    id: watch.id,
                    url: watch.url,
                    name: watch.name,
                    timestamp: new Date().toISOString(),
                  },
                },
              });
            }

            await callGateway(context.agentId, {
              type: "record_episode",
              event: "monitor.change",
              context: JSON.stringify({ id: watch.id, url: watch.url }),
              tags: ["monitor", "change"],
              success: true,
            });
          } else {
            await callGateway(context.agentId, {
              type: "record_episode",
              event: "monitor.check",
              context: JSON.stringify({ id: watch.id, url: watch.url }),
              tags: ["monitor", "check"],
              success: true,
            });
          }
        } catch (error) {
          await callGateway(context.agentId, {
            type: "record_episode",
            event: "monitor.error",
            context: JSON.stringify({
              id: watch.id,
              url: watch.url,
              error: error instanceof Error ? error.message : String(error),
            }),
            tags: ["monitor", "error"],
            success: false,
          });
        }
      }

      return {
        type: "monitor_check",
        checked: targets.length,
        changes,
      };
    }

    const fallbackType = (task as { type?: string }).type ?? "unknown";
    context.log?.warn(`Unknown monitor task type: ${String(fallbackType)}`);
    return { type: "error", message: `Unknown task type: ${String(fallbackType)}` };
  },
});

export default agent;

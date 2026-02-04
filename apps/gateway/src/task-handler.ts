// Task Handler — Agent task dispatch for all task types

import { randomUUID } from "crypto";
import { z } from "zod";
import { createLogger, type Database } from "@agentrun/kernel";
import { type ModelRouter } from "@agentrun/mal";
import { ok, err, type ChatRequest } from "@agentrun/shared";
import { createEventBus, type EventBus } from "@agentrun/events";
import { MemoryManager } from "@agentrun/memory";
import {
  createCapabilityManager,
  type Permission,
  type PermissionAction,
  type PermissionCategory,
} from "@agentrun/permissions";
import { createToolRegistry, type ToolDefinition, type ToolResult } from "@agentrun/tools";
import { estimateCost } from "@agentrun/runtime";
import {
  type AgentEntry,
  type A2ATaskEntry,
  isUuid,
} from "./gateway-types.js";
import { type WsMessage, GatewayError } from "./types.js";
import { sanitizeUserInput } from "./input-sanitizer.js";
import {
  isPathAllowed,
  isDomainAllowed,
  isCommandAllowed,
  parseBoolean,
  escapeILikePattern,
} from "./security-utils.js";
import {
  createEventId,
  createA2aTaskId,
  checkPermissionAny,
  getEnabledToolIds,
  findAgentById,
  resolveMaxAgentErrors,
  parsePermissionString,
  dedupePermissions,
  ajv,
} from "./gateway-utils.js";
import { listAgentsFromDatabase } from "./cluster.js";
import {
  toJsonValue,
  EchoTaskSchema,
  ChatTestFlagsSchema,
  type ChatTestFlags,
  ChatTaskSchema,
  StoreFactTaskSchema,
  RecordEpisodeTaskSchema,
  SearchMemoryTaskSchema,
  ListToolsTaskSchema,
  InvokeToolTaskSchema,
  DiscoverAgentsTaskSchema,
  AgentDirectoryTaskSchema,
  ForumCreateTaskSchema,
  ForumListTaskSchema,
  ForumPostTaskSchema,
  ForumPostsTaskSchema,
  JobPostTaskSchema,
  JobListTaskSchema,
  JobApplyTaskSchema,
  ReputationGetTaskSchema,
  ReputationListTaskSchema,
  ReputationAdjustTaskSchema,
  AuditQueryTaskSchema,
  CapabilityListTaskSchema,
  CapabilityGrantTaskSchema,
  CapabilityRevokeTaskSchema,
  CapabilityRevokeAllTaskSchema,
  PolicyCreateTaskSchema,
  PolicyListTaskSchema,
  PolicySetStatusTaskSchema,
  ModerationCaseOpenTaskSchema,
  ModerationCaseListTaskSchema,
  ModerationCaseResolveTaskSchema,
  AppealOpenTaskSchema,
  AppealListTaskSchema,
  AppealResolveTaskSchema,
  SanctionApplyTaskSchema,
  SanctionListTaskSchema,
  SanctionLiftTaskSchema,
  A2ATaskSchema,
  A2ATaskSyncSchema,
  A2ATaskAsyncSchema,
  A2ATaskStatusSchema,
  ListSkillsTaskSchema,
  InvokeSkillTaskSchema,
  StoreProcedureTaskSchema,
  GetProcedureTaskSchema,
  FindProceduresTaskSchema,
  RecordProcedureExecutionTaskSchema,
  ComputeTaskSchema,
  MemoryIntensiveTaskSchema,
} from "./task-schemas.js";
import {
  updateAgentUsage,
  recordProviderUsage,
  recordAuditLog,
  recordEvent,
} from "./db-operations.js";
import { generateEmbedding } from "@agentrun/provider-openai";

/** Try to generate an embedding vector for text. Returns undefined on failure or if OpenAI is unavailable. */
async function tryGenerateEmbedding(text: string, log: ReturnType<typeof createLogger>): Promise<number[] | undefined> {
  try {
    const embedding = await generateEmbedding(text);
    return embedding ?? undefined;
  } catch (error) {
    log.debug("Embedding generation skipped", { error: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}

/** Context required by the task handler */
export interface TaskHandlerContext {
  router: ModelRouter;
  memory: MemoryManager;
  log: ReturnType<typeof createLogger>;
  db?: Database;
  eventBus: ReturnType<typeof createEventBus>;
  agents: Map<string, AgentEntry>;
  toolRegistry: ReturnType<typeof createToolRegistry>;
  permissionManager: ReturnType<typeof createCapabilityManager>;
  a2aTasks: Map<string, A2ATaskEntry>;
  allowedPaths: string[];
  allowedDomains: string[];
  allowedCommands: string[];
  allowAllPaths: boolean;
  allowAllDomains: boolean;
  allowAllCommands: boolean;
  memoryLimitMb: number;
  clusterNodeId?: string | null;
}

export async function handleAgentTask(
  task: Record<string, unknown>,
  agent: AgentEntry,
  ctx: TaskHandlerContext
): Promise<Record<string, unknown>> {
  const {
    router,
    memory,
    log,
    db,
    eventBus,
    agents,
    toolRegistry,
    permissionManager,
    a2aTasks,
    allowedPaths,
    allowedDomains,
    allowedCommands,
    allowAllPaths,
    allowAllDomains,
    allowAllCommands,
    memoryLimitMb,
    clusterNodeId,
  } = ctx;
  const taskContext = {
    router,
    memory,
    log,
    db,
    eventBus,
    agents,
    toolRegistry,
    permissionManager,
    a2aTasks,
    allowedPaths,
    allowedDomains,
    allowedCommands,
    allowAllPaths,
    allowAllDomains,
    allowAllCommands,
    memoryLimitMb,
    clusterNodeId,
  };

  const baseResult = z.object({ type: z.string().min(1) }).safeParse(task);
  if (!baseResult.success) {
    throw new Error(`Invalid task: ${baseResult.error.message}`);
  }
  const taskType = baseResult.data.type;

  if (db) {
    const sanctions = await db.query((sql) => sql`
      SELECT id, type, status
      FROM sanctions
      WHERE subject_agent_id = ${agent.id} AND status = 'active'
    `);
    if (sanctions.length > 0) {
      const types = sanctions.map((s: { type?: string }) => s.type).filter(Boolean);
      const isAppealTask = taskType === "appeal_open" || taskType === "appeal_list";
      if (!isAppealTask) {
        throw new Error(`Agent sanctioned: ${types.join(", ") || "active"}`);
      }
    }
  }

  if (agent.state === "terminated") {
    throw new Error("Agent is terminated");
  }
  if (agent.state === "error") {
    throw new Error("Agent is in error state");
  }
  if (agent.state === "paused") {
    throw new Error("Agent is paused");
  }

  const ensureApproval = async (
    approval: { approvedBy: string; approvedAt?: Date; reason?: string } | undefined,
    action: string,
    force: boolean = false
  ): Promise<void> => {
    if (!force && agent.trustLevel !== "supervised") return;

    if (!approval?.approvedBy) {
      if (db) {
        await recordAuditLog(
          db,
          {
            action: "approval.required",
            resourceType: "policy",
            resourceId: action,
            actorId: agent.id,
            details: { trustLevel: agent.trustLevel },
            outcome: "failure",
          },
          log
        );
      }
      throw new Error(`Approval required for ${action}`);
    }

    if (db) {
      await recordAuditLog(
        db,
        {
          action: "approval.granted",
          resourceType: "policy",
          resourceId: action,
          actorId: agent.id,
          details: {
            approvedBy: approval.approvedBy,
            approvedAt: approval.approvedAt?.toISOString(),
            reason: approval.reason,
          },
          outcome: "success",
        },
        log
      );
    }
  };

  const ensurePermission = async (
    category: PermissionCategory,
    action: PermissionAction,
    resource?: string,
    fallbackActions: PermissionAction[] = []
  ): Promise<void> => {
    const result = checkPermissionAny(
      permissionManager,
      agent,
      category,
      [action, ...fallbackActions],
      resource ?? undefined
    );

    if (result.allowed) return;

    if (db) {
      await recordAuditLog(
        db,
        {
          action: "permission.denied",
          resourceType: category,
          resourceId: resource ?? undefined,
          actorId: agent.id,
          details: { action },
          outcome: "failure",
        },
        log
      );
    }

    throw new Error(`Permission denied: ${category}.${action}`);
  };

  const resetUsageWindowIfNeeded = (): void => {
    const now = Date.now();
    if (now - agent.usageWindow.windowStart >= 60_000) {
      agent.usageWindow.windowStart = now;
      agent.usageWindow.requestsThisMinute = 0;
      agent.usageWindow.toolCallsThisMinute = 0;
      agent.usageWindow.tokensThisMinute = 0;
    }
  };

  const ensureRateLimit = async (
    kind: "requests" | "toolCalls",
    actionLabel: string
  ): Promise<void> => {
    resetUsageWindowIfNeeded();

    const limit = kind === "requests"
      ? agent.limits.requestsPerMinute
      : agent.limits.toolCallsPerMinute;

    if (!limit) return;

    const current = kind === "requests"
      ? agent.usageWindow.requestsThisMinute
      : agent.usageWindow.toolCallsThisMinute;

    if (current >= limit) {
      if (db) {
        await recordAuditLog(
          db,
          {
            action: "rate_limit.exceeded",
            resourceType: "policy",
            resourceId: actionLabel,
            actorId: agent.id,
            details: { limit, current, kind },
            outcome: "failure",
          },
          log
        );
      }
      await eventBus.publish({
        id: createEventId(),
        channel: "alerts",
        type: "rate_limit.exceeded",
        timestamp: new Date(),
        agentId: agent.id,
        data: { limit, current, kind, action: actionLabel },
      });
      throw new Error(`Rate limit exceeded: ${kind} per minute`);
    }

    if (kind === "requests") {
      agent.usageWindow.requestsThisMinute += 1;
    } else {
      agent.usageWindow.toolCallsThisMinute += 1;
    }
  };

  const ensureTokenRateLimit = async (actionLabel: string): Promise<void> => {
    resetUsageWindowIfNeeded();
    const limit = agent.limits.tokensPerMinute;
    if (!limit) return;

    if (agent.usageWindow.tokensThisMinute >= limit) {
      if (db) {
        await recordAuditLog(
          db,
          {
            action: "rate_limit.exceeded",
            resourceType: "policy",
            resourceId: actionLabel,
            actorId: agent.id,
            details: { limit, current: agent.usageWindow.tokensThisMinute, kind: "tokens" },
            outcome: "failure",
          },
          log
        );
      }
      await eventBus.publish({
        id: createEventId(),
        channel: "alerts",
        type: "rate_limit.exceeded",
        timestamp: new Date(),
        agentId: agent.id,
        data: { limit, current: agent.usageWindow.tokensThisMinute, kind: "tokens", action: actionLabel },
      });
      throw new Error("Token rate limit exceeded");
    }
  };

  const ensureCostBudget = async (actionLabel: string): Promise<void> => {
    const budget = agent.limits.costBudgetUSD;
    if (!budget || budget <= 0) return;

    if (agent.costUsageUSD >= budget) {
      if (db) {
        await recordAuditLog(
          db,
          {
            action: "budget.exceeded",
            resourceType: "policy",
            resourceId: actionLabel,
            actorId: agent.id,
            details: { budget, spent: agent.costUsageUSD },
            outcome: "failure",
          },
          log
        );
      }
      await eventBus.publish({
        id: createEventId(),
        channel: "alerts",
        type: "budget.exceeded",
        timestamp: new Date(),
        agentId: agent.id,
        data: { budget, spent: agent.costUsageUSD, action: actionLabel },
      });
      throw new Error("Cost budget exceeded");
    }
  };

  const validateA2ATask = (target: AgentEntry, payload: Record<string, unknown>): void => {
    // Enforce payload size limit to prevent resource exhaustion
    const payloadStr = JSON.stringify(payload);
    if (payloadStr.length > 1_048_576) { // 1 MB
      throw new Error("A2A task payload exceeds maximum size (1 MB)");
    }

    // If agent has declared A2A skills, validate against them
    if (target.a2aSkills.length > 0) {
      const payloadType = payload.type;
      const payloadSkill = (payload as { skillId?: unknown }).skillId;
      const skillId = typeof payloadSkill === "string"
        ? payloadSkill
        : typeof payloadType === "string"
          ? payloadType
          : undefined;

      if (!skillId) {
        throw new Error("A2A task missing skill identifier");
      }

      const skill = target.a2aSkills.find((entry) => entry.id === skillId);
      if (!skill) {
        throw new Error(`Target agent does not support skill: ${skillId}`);
      }

      const validator = target.a2aValidators.get(skillId);
      if (validator && !validator(payload)) {
        const errorText = ajv.errorsText(validator.errors, { separator: "; " });
        throw new Error(`A2A task validation failed: ${errorText}`);
      }
    }
  };

  switch (baseResult.data.type) {
    case "echo": {
      const parsed = EchoTaskSchema.parse(task);
      return { type: "echo", content: parsed.content };
    }

    case "chat": {
      const parsed = ChatTaskSchema.parse(task);
      const model = parsed.model ?? agent.model ?? router.listModels()[0];

      if (!model) {
        throw new Error("No model available for chat task");
      }

      // Check user messages for prompt injection patterns
      for (const msg of parsed.messages) {
        if (msg.role === "user" && typeof msg.content === "string") {
          const sanitizeResult = sanitizeUserInput(msg.content, agent.id);
          if (!sanitizeResult.safe) {
            log.warn("Prompt injection blocked in chat", {
              agentId: agent.id,
              warnings: sanitizeResult.warnings,
            });
            if (eventBus) {
              await eventBus.publish({
                id: createEventId(),
                channel: "alerts",
                type: "security.prompt_injection",
                timestamp: new Date(),
                agentId: agent.id,
                data: { warnings: sanitizeResult.warnings },
              });
            }
            throw new Error("Input rejected: potential prompt injection detected");
          }
        }
      }

      const maxTokens = parsed.maxTokens ?? 1024;
      if (agent.limits.maxTokensPerRequest && maxTokens > agent.limits.maxTokensPerRequest) {
        throw new Error(`Token limit exceeded: maxTokensPerRequest=${agent.limits.maxTokensPerRequest}`);
      }

      await ensureCostBudget("llm.chat");
      await ensureRateLimit("requests", "llm.chat");
      await ensureTokenRateLimit("llm.chat");
      await ensurePermission("llm", "execute");

      const requestStart = Date.now();
      const request = {
        model,
        messages: parsed.messages,
        maxTokens,
        temperature: parsed.temperature,
        _testFlags: parsed._testFlags,
      } as ChatRequest & { _testFlags?: ChatTestFlags };

      const result = await router.route(request);
      const latencyMs = Date.now() - requestStart;

      if (!result.ok) {
        throw new Error(result.error.message);
      }

      agent.tokenUsage.input += result.value.usage.inputTokens;
      agent.tokenUsage.output += result.value.usage.outputTokens;
      agent.usageWindow.tokensThisMinute +=
        result.value.usage.inputTokens + result.value.usage.outputTokens;
      if (agent.limits.tokensPerMinute && agent.usageWindow.tokensThisMinute > agent.limits.tokensPerMinute) {
        log.warn("Agent token rate limit exceeded after request", {
          agentId: agent.id,
          limit: agent.limits.tokensPerMinute,
          current: agent.usageWindow.tokensThisMinute,
        });
      }
      const costUsd = estimateCost(
        result.value.model,
        result.value.usage.inputTokens,
        result.value.usage.outputTokens
      );
      agent.costUsageUSD += costUsd;

      if (agent.limits.costBudgetUSD && agent.costUsageUSD >= agent.limits.costBudgetUSD) {
        log.warn("Agent cost budget reached", {
          agentId: agent.id,
          budget: agent.limits.costBudgetUSD,
          spent: agent.costUsageUSD,
        });
        await eventBus.publish({
          id: createEventId(),
          channel: "alerts",
          type: "budget.reached",
          timestamp: new Date(),
          agentId: agent.id,
          data: { budget: agent.limits.costBudgetUSD, spent: agent.costUsageUSD },
        });
        if (db) {
          await recordAuditLog(
            db,
            {
              action: "budget.reached",
              resourceType: "policy",
              resourceId: "llm.chat",
              actorId: agent.id,
              details: { budget: agent.limits.costBudgetUSD, spent: agent.costUsageUSD },
              outcome: "success",
            },
            log
          );
        }
      }

      if (db) {
        await recordAuditLog(
          db,
          {
            action: "llm.request",
            resourceType: "llm",
            resourceId: result.value.model,
            actorId: agent.id,
            details: {
              inputTokens: result.value.usage.inputTokens,
              outputTokens: result.value.usage.outputTokens,
              costUsd,
            },
            outcome: "success",
          },
          log
        );
        await updateAgentUsage(db, agent.id, result.value.usage, log);
        await recordProviderUsage(
          db,
          agent.id,
          result.value.model,
          result.value.usage,
          log,
          result.value.providerId ?? "unknown",
          result.value.latencyMs ?? latencyMs
        );
      }

      const contextPayload = JSON.stringify({
        messages: parsed.messages,
        response: result.value.content,
      });

      const episodeResult = await memory.recordEpisode(
        agent.id,
        "chat",
        contextPayload,
        {
          success: true,
          tags: ["chat"],
        }
      );

      if (!episodeResult.ok) {
        log.warn("Failed to record chat episode", { agentId: agent.id, error: episodeResult.error.message });
      }

      return {
        type: "chat",
        content: result.value.content,
        model: result.value.model,
        usage: result.value.usage,
      };
    }

    case "store_fact": {
      const parsed = StoreFactTaskSchema.parse(task);
      await ensurePermission("memory", "write");
      const tags = Array.from(
        new Set([parsed.category, ...(parsed.tags ?? [])].filter((tag): tag is string => Boolean(tag)))
      );

      const embedding = parsed.embedding ?? await tryGenerateEmbedding(parsed.fact, log);

      const factResult = await memory.storeFact(
        agent.id,
        parsed.category ?? "fact",
        "fact",
        parsed.fact,
        {
          importance: parsed.importance,
          tags,
          embedding,
          source: "agent_task",
        }
      );

      if (!factResult.ok) {
        throw new Error(factResult.error.message);
      }

      if (db) {
        await recordAuditLog(
          db,
          {
            action: "memory.write",
            resourceType: "memory",
            resourceId: factResult.value,
            actorId: agent.id,
            details: { category: parsed.category ?? "fact" },
            outcome: "success",
          },
          log
        );
      }

      return {
        type: "store_fact",
        memoryId: factResult.value,
        fact: parsed.fact,
        category: parsed.category ?? "fact",
      };
    }

    case "record_episode": {
      const parsed = RecordEpisodeTaskSchema.parse(task);
      await ensurePermission("memory", "write");
      const episodeEmbedding = parsed.embedding ?? await tryGenerateEmbedding(
        `${parsed.event}: ${parsed.context}`.slice(0, 8000),
        log
      );

      const episodeResult = await memory.recordEpisode(agent.id, parsed.event, parsed.context, {
        outcome: parsed.outcome,
        success: parsed.success,
        importance: parsed.importance,
        tags: parsed.tags,
        sessionId: parsed.sessionId,
        relatedEpisodes: parsed.relatedEpisodes,
        embedding: episodeEmbedding,
      });

      if (!episodeResult.ok) {
        throw new Error(episodeResult.error.message);
      }

      if (db) {
        await recordAuditLog(
          db,
          {
            action: "memory.write",
            resourceType: "memory",
            resourceId: episodeResult.value,
            actorId: agent.id,
            details: { event: parsed.event },
            outcome: "success",
          },
          log
        );
      }

      return {
        type: "record_episode",
        memoryId: episodeResult.value,
      };
    }

    case "search_memory": {
      const parsed = SearchMemoryTaskSchema.parse(task);

      await ensurePermission("memory", "read");

      if (!parsed.query && !parsed.embedding) {
        throw new Error("search_memory task requires query or embedding");
      }

      const searchEmbedding = parsed.embedding ?? (parsed.query
        ? await tryGenerateEmbedding(parsed.query, log)
        : undefined);

      const searchResult = await memory.search(agent.id, {
        query: parsed.query,
        embedding: searchEmbedding,
        types: parsed.types,
        tags: parsed.tags,
        minImportance: parsed.minImportance,
        minStrength: parsed.minStrength,
        minSimilarity: parsed.minSimilarity,
        after: parsed.after,
        before: parsed.before,
        limit: parsed.limit,
        includeEmbeddings: parsed.includeEmbeddings,
      });

      if (!searchResult.ok) {
        throw new Error(searchResult.error.message);
      }

      if (db) {
        await recordAuditLog(
          db,
          {
            action: "memory.read",
            resourceType: "memory",
            resourceId: undefined,
            actorId: agent.id,
            details: { query: parsed.query, types: parsed.types },
            outcome: "success",
          },
          log
        );
      }

      return {
        type: "search_memory",
        ...searchResult.value,
      };
    }

    case "list_tools": {
      const parsed = ListToolsTaskSchema.parse(task);
      await ensurePermission("tools", "read", undefined, ["execute"]);
      const allowedToolIds = getEnabledToolIds(agent);
      let tools = toolRegistry.list();

      if (allowedToolIds) {
        tools = tools.filter((tool) => allowedToolIds.has(tool.id));
      }

      tools = tools.filter((tool) => {
        if (!tool.requiredPermissions || tool.requiredPermissions.length === 0) {
          return true;
        }

        for (const required of tool.requiredPermissions) {
          const parsedPermissions = parsePermissionString(required);
          if (!parsedPermissions) return false;

          for (const permission of parsedPermissions) {
            const allowed = checkPermissionAny(
              permissionManager,
              agent,
              permission.category,
              permission.actions,
              permission.resource
            );
            if (!allowed.allowed) {
              return false;
            }
          }
        }

        return true;
      });

      if (parsed.query) {
        const query = parsed.query.toLowerCase();
        tools = tools.filter(
          (tool) =>
            tool.name.toLowerCase().includes(query) ||
            tool.description.toLowerCase().includes(query) ||
            tool.id.toLowerCase().includes(query)
        );
      }

      const result = tools.map((tool: ToolDefinition) => ({
        id: tool.id,
        name: tool.name,
        description: tool.description,
        category: tool.category,
        tags: tool.tags,
      }));

      return { type: "list_tools", tools: result };
    }

    case "invoke_tool": {
      const parsed = InvokeToolTaskSchema.parse(task);
      const toolDefResult = toolRegistry.get(parsed.toolId);
      const toolDef = toolDefResult.ok ? toolDefResult.value : null;

      await ensureApproval(parsed.approval, `tool:${parsed.toolId}`, toolDef?.requiresConfirmation ?? false);
      await ensurePermission("tools", "execute", parsed.toolId);
      await ensureRateLimit("toolCalls", `tool:${parsed.toolId}`);

      const allowedToolIds = getEnabledToolIds(agent);
      if (allowedToolIds && !allowedToolIds.has(parsed.toolId)) {
        throw new Error(`Tool not enabled for agent: ${parsed.toolId}`);
      }

      if (toolDef?.requiredPermissions) {
        for (const required of toolDef.requiredPermissions) {
          const parsedPermissions = parsePermissionString(required);
          if (!parsedPermissions) {
            throw new Error(`Invalid tool permission requirement: ${required}`);
          }

          for (const permission of parsedPermissions) {
            for (const action of permission.actions) {
              await ensurePermission(permission.category, action, permission.resource);
            }
          }
        }
      }

      const args = parsed.arguments ?? {};

      if (parsed.toolId === "builtin:file_read") {
        const pathValue = typeof args.path === "string" ? args.path : "";
        if (!pathValue) {
          throw new Error("file_read requires a path argument");
        }

        await ensurePermission("filesystem", "read", pathValue);
        const allowedOk = isPathAllowed(pathValue, allowedPaths, allowAllPaths);

        if (!allowedOk) {
          if (db) {
            await recordAuditLog(
              db,
              {
                action: "permission.denied",
                resourceType: "filesystem",
                resourceId: pathValue,
                actorId: agent.id,
                details: { blocked: true, path: pathValue },
                outcome: "failure",
              },
              log
            );
          }
          throw new Error("Permission denied: filesystem.read");
        }
      }

      if (parsed.toolId === "builtin:file_write") {
        const pathValue = typeof args.path === "string" ? args.path : "";
        if (!pathValue) {
          throw new Error("file_write requires a path argument");
        }

        await ensurePermission("filesystem", "write", pathValue);
        const allowedOk = isPathAllowed(pathValue, allowedPaths, allowAllPaths);

        if (!allowedOk) {
          if (db) {
            await recordAuditLog(
              db,
              {
                action: "permission.denied",
                resourceType: "filesystem",
                resourceId: pathValue,
                actorId: agent.id,
                details: { blocked: true, path: pathValue },
                outcome: "failure",
              },
              log
            );
          }
          throw new Error("Permission denied: filesystem.write");
        }
      }

      if (parsed.toolId === "builtin:http_fetch") {
        const urlValue = typeof args.url === "string" ? args.url : "";
        if (!urlValue) {
          throw new Error("http_fetch requires a url argument");
        }

        let host: string;
        try {
          host = new URL(urlValue).hostname;
        } catch {
          throw new Error("http_fetch requires a valid url");
        }

        await ensurePermission("network", "execute", host);
        const allowedOk = isDomainAllowed(host, allowedDomains, allowAllDomains);

        if (!allowedOk) {
          if (db) {
            await recordAuditLog(
              db,
              {
                action: "permission.denied",
                resourceType: "network",
                resourceId: host,
                actorId: agent.id,
                details: { blocked: true, host },
                outcome: "failure",
              },
              log
            );
          }
          throw new Error("Permission denied: network.fetch");
        }
      }

      if (parsed.toolId === "builtin:browser_snapshot") {
        const urlValue = typeof args.url === "string" ? args.url : "";
        if (!urlValue) {
          throw new Error("browser_snapshot requires a url argument");
        }

        let host: string;
        try {
          host = new URL(urlValue).hostname;
        } catch {
          throw new Error("browser_snapshot requires a valid url");
        }

        await ensurePermission("network", "execute", host);
        const allowedOk = isDomainAllowed(host, allowedDomains, allowAllDomains);

        if (!allowedOk) {
          if (db) {
            await recordAuditLog(
              db,
              {
                action: "permission.denied",
                resourceType: "network",
                resourceId: host,
                actorId: agent.id,
                details: { blocked: true, host, tool: "browser_snapshot" },
                outcome: "failure",
              },
              log
            );
          }
          throw new Error("Permission denied: network.execute");
        }
      }

      if (parsed.toolId === "builtin:shell_exec") {
        const command = typeof args.command === "string" ? args.command : "";
        if (!command) {
          throw new Error("shell_exec requires a command argument");
        }

        await ensurePermission("shell", "execute", command);
        const allowedOk = isCommandAllowed(command, allowedCommands, allowAllCommands);

        if (!allowedOk) {
          if (db) {
            await recordAuditLog(
              db,
              {
                action: "permission.denied",
                resourceType: "shell",
                resourceId: command,
                actorId: agent.id,
                details: { blocked: true, command },
                outcome: "failure",
              },
              log
            );
          }
          throw new Error("Permission denied: shell.execute");
        }
      }

      if (parsed.toolId.startsWith("mcp:")) {
        const parts = parsed.toolId.split(":");
        const serverName = parts.length >= 2 ? parts[1] : "";
        if (!serverName) {
          throw new Error("mcp tool invocation missing server name");
        }
        if (agent.mcpServers && agent.mcpServers.length > 0 && !agent.mcpServers.includes(serverName)) {
          if (db) {
            await recordAuditLog(
              db,
              {
                action: "permission.denied",
                resourceType: "mcp",
                resourceId: serverName,
                actorId: agent.id,
                details: { blocked: true, server: serverName },
                outcome: "failure",
              },
              log
            );
          }
          throw new Error(`Permission denied: mcp server ${serverName} not allowed`);
        }
      }

      const toolResult = await toolRegistry.invoke({
        toolId: parsed.toolId,
        arguments: args,
        agentId: agent.id,
        requestId: randomUUID(),
      });

      if (!toolResult.ok) {
        if (db) {
          await recordAuditLog(
            db,
            {
              action: "tool.failed",
              resourceType: "tool",
              resourceId: parsed.toolId,
              actorId: agent.id,
              details: { error: toolResult.error.message },
              outcome: "failure",
            },
            log
          );
        }
        throw new Error(toolResult.error.message);
      }

      const value: ToolResult = toolResult.value;
      if (db) {
        await recordAuditLog(
          db,
          {
            action: "tool.invoked",
            resourceType: "tool",
            resourceId: parsed.toolId,
            actorId: agent.id,
            details: { success: value.success, executionTime: value.executionTime },
            outcome: value.success ? "success" : "failure",
          },
          log
        );
      }
      return {
        type: "invoke_tool",
        toolId: parsed.toolId,
        success: value.success,
        content: value.content,
        error: value.error,
        metadata: value.metadata,
        executionTime: value.executionTime,
      };
    }

    case "discover_agents": {
      const parsed = DiscoverAgentsTaskSchema.parse(task);
      await ensurePermission("agents", "read");
      const filter = parsed.filter ?? {};

      let candidates: Array<Record<string, unknown>> = Array.from(agents.values())
        .filter((candidate) => candidate.state !== "terminated")
        .map((candidate) => ({
          id: candidate.id,
          externalId: candidate.externalId,
          name: candidate.name,
          capabilities: candidate.capabilities,
        }));

      if (clusterNodeId && db) {
        const dbAgents = await listAgentsFromDatabase(db);
        candidates = dbAgents;
      }

      if (filter.capability) {
        candidates = candidates.filter((candidate) =>
          Array.isArray(candidate.capabilities) && candidate.capabilities.includes(filter.capability!)
        );
      }

      if (filter.name) {
        const nameQuery = filter.name.toLowerCase();
        candidates = candidates.filter((candidate) =>
          typeof candidate.name === "string" && candidate.name.toLowerCase().includes(nameQuery)
        );
      }

      return {
        type: "discover_agents",
        agents: candidates.map((candidate) => ({
          id: candidate.id as string,
          externalId: candidate.externalId as string | undefined,
          name: candidate.name as string,
          capabilities: Array.isArray(candidate.capabilities) ? candidate.capabilities : [],
        })),
      };
    }

    case "agent_directory": {
      const parsed = AgentDirectoryTaskSchema.parse(task);
      await ensurePermission("agents", "read");
      await ensurePermission("social", "read");
      if (!db) {
        throw new Error("Agent directory requires persistent storage");
      }

      const limit = parsed.limit ?? 100;
      const offset = parsed.offset ?? 0;
      const query = parsed.query?.trim();

      const rows = await db.query((sql) => {
        if (query && parsed.status) {
          return sql`
            SELECT agents.id, agents.name, agents.description, agents.state, agents.created_at,
              agent_reputation.score, agent_reputation.updated_at
            FROM agents
            LEFT JOIN agent_reputation ON agent_reputation.agent_id = agents.id
            WHERE agents.name ILIKE ${`%${escapeILikePattern(query)}%`} AND agents.state = ${parsed.status}
            ORDER BY agents.created_at DESC
            LIMIT ${limit}
            OFFSET ${offset}
          `;
        }
        if (query) {
          return sql`
            SELECT agents.id, agents.name, agents.description, agents.state, agents.created_at,
              agent_reputation.score, agent_reputation.updated_at
            FROM agents
            LEFT JOIN agent_reputation ON agent_reputation.agent_id = agents.id
            WHERE agents.name ILIKE ${`%${escapeILikePattern(query)}%`}
            ORDER BY agents.created_at DESC
            LIMIT ${limit}
            OFFSET ${offset}
          `;
        }
        if (parsed.status) {
          return sql`
            SELECT agents.id, agents.name, agents.description, agents.state, agents.created_at,
              agent_reputation.score, agent_reputation.updated_at
            FROM agents
            LEFT JOIN agent_reputation ON agent_reputation.agent_id = agents.id
            WHERE agents.state = ${parsed.status}
            ORDER BY agents.created_at DESC
            LIMIT ${limit}
            OFFSET ${offset}
          `;
        }
        return sql`
          SELECT agents.id, agents.name, agents.description, agents.state, agents.created_at,
            agent_reputation.score, agent_reputation.updated_at
          FROM agents
          LEFT JOIN agent_reputation ON agent_reputation.agent_id = agents.id
          ORDER BY agents.created_at DESC
          LIMIT ${limit}
          OFFSET ${offset}
        `;
      });

      return {
        type: "agent_directory",
        agents: rows,
      };
    }

    case "forum_create": {
      const parsed = ForumCreateTaskSchema.parse(task);
      await ensurePermission("social", "write");
      if (!db) {
        throw new Error("Forum operations require persistent storage");
      }

      const existing = await db.query((sql) => sql`
        SELECT id FROM forums WHERE name = ${parsed.name} LIMIT 1
      `);

      if (existing.length > 0) {
        throw new Error("Forum already exists");
      }

      const rows = await db.query((sql) => sql`
        INSERT INTO forums (name, description, created_by)
        VALUES (${parsed.name}, ${parsed.description ?? null}, ${agent.id})
        RETURNING id, name, description, created_by, created_at
      `);

      const forum = rows[0];
      if (db && forum) {
        await recordAuditLog(
          db,
          {
            action: "forum.create",
            resourceType: "forum",
            resourceId: forum.id,
            actorId: agent.id,
            details: { name: parsed.name },
            outcome: "success",
          },
          log
        );
      }

      return {
        type: "forum_create",
        forum,
      };
    }

    case "forum_list": {
      const parsed = ForumListTaskSchema.parse(task);
      await ensurePermission("social", "read");
      if (!db) {
        throw new Error("Forum operations require persistent storage");
      }

      const limit = parsed.limit ?? 50;
      const query = parsed.query?.trim();

      const rows = await db.query((sql) => query
        ? sql`
            SELECT id, name, description, created_by, created_at
            FROM forums
            WHERE name ILIKE ${`%${escapeILikePattern(query)}%`}
            ORDER BY created_at DESC
            LIMIT ${limit}
          `
        : sql`
            SELECT id, name, description, created_by, created_at
            FROM forums
            ORDER BY created_at DESC
            LIMIT ${limit}
          `
      );

      return {
        type: "forum_list",
        forums: rows,
      };
    }

    case "forum_post": {
      const parsed = ForumPostTaskSchema.parse(task);
      await ensurePermission("social", "write");
      if (!db) {
        throw new Error("Forum operations require persistent storage");
      }

      const rows = await db.query((sql) => sql`
        INSERT INTO forum_posts (forum_id, author_id, content, metadata)
        VALUES (
          ${parsed.forumId},
          ${agent.id},
          ${parsed.content},
          ${sql.json(toJsonValue(parsed.metadata ?? {}))}
        )
        RETURNING id, forum_id, author_id, content, metadata, created_at
      `);

      const post = rows[0];
      if (db && post) {
        await recordAuditLog(
          db,
          {
            action: "forum.post",
            resourceType: "forum",
            resourceId: parsed.forumId,
            actorId: agent.id,
            details: { postId: post.id },
            outcome: "success",
          },
          log
        );
      }

      return {
        type: "forum_post",
        post,
      };
    }

    case "forum_posts": {
      const parsed = ForumPostsTaskSchema.parse(task);
      await ensurePermission("social", "read");
      if (!db) {
        throw new Error("Forum operations require persistent storage");
      }

      const limit = parsed.limit ?? 50;
      const rows = await db.query((sql) => sql`
        SELECT id, forum_id, author_id, content, metadata, created_at
        FROM forum_posts
        WHERE forum_id = ${parsed.forumId}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `);

      return {
        type: "forum_posts",
        forumId: parsed.forumId,
        posts: rows,
      };
    }

    case "job_post": {
      const parsed = JobPostTaskSchema.parse(task);
      await ensurePermission("social", "write");
      if (!db) {
        throw new Error("Job operations require persistent storage");
      }

      const rows = await db.query((sql) => sql`
        INSERT INTO jobs (title, description, budget_usd, created_by, status)
        VALUES (
          ${parsed.title},
          ${parsed.description ?? null},
          ${parsed.budgetUsd ?? null},
          ${agent.id},
          'open'
        )
        RETURNING id, title, description, budget_usd, created_by, status, created_at, updated_at
      `);

      const job = rows[0];
      if (db && job) {
        await recordAuditLog(
          db,
          {
            action: "job.post",
            resourceType: "job",
            resourceId: job.id,
            actorId: agent.id,
            details: { title: parsed.title },
            outcome: "success",
          },
          log
        );
      }

      return {
        type: "job_post",
        job,
      };
    }

    case "job_list": {
      const parsed = JobListTaskSchema.parse(task);
      await ensurePermission("social", "read");
      if (!db) {
        throw new Error("Job operations require persistent storage");
      }

      const limit = parsed.limit ?? 50;
      const rows = await db.query((sql) => parsed.status
        ? sql`
            SELECT id, title, description, budget_usd, created_by, status, created_at, updated_at
            FROM jobs
            WHERE status = ${parsed.status}
            ORDER BY created_at DESC
            LIMIT ${limit}
          `
        : sql`
            SELECT id, title, description, budget_usd, created_by, status, created_at, updated_at
            FROM jobs
            ORDER BY created_at DESC
            LIMIT ${limit}
          `
      );

      return {
        type: "job_list",
        jobs: rows,
      };
    }

    case "job_apply": {
      const parsed = JobApplyTaskSchema.parse(task);
      await ensurePermission("social", "write");
      if (!db) {
        throw new Error("Job operations require persistent storage");
      }

      const rows = await db.query((sql) => sql`
        INSERT INTO job_applications (job_id, applicant_id, proposal, status)
        VALUES (
          ${parsed.jobId},
          ${agent.id},
          ${parsed.proposal ?? null},
          'submitted'
        )
        RETURNING id, job_id, applicant_id, proposal, status, created_at
      `);

      const application = rows[0];
      if (db && application) {
        await recordAuditLog(
          db,
          {
            action: "job.apply",
            resourceType: "job",
            resourceId: parsed.jobId,
            actorId: agent.id,
            details: { applicationId: application.id },
            outcome: "success",
          },
          log
        );
      }

      return {
        type: "job_apply",
        application,
      };
    }

    case "reputation_get": {
      const parsed = ReputationGetTaskSchema.parse(task);
      await ensurePermission("social", "read");
      if (!db) {
        throw new Error("Reputation operations require persistent storage");
      }

      const targetId = parsed.agentId ?? agent.id;
      const rows = await db.query((sql) => sql`
        SELECT agent_id, score, signals, updated_at
        FROM agent_reputation
        WHERE agent_id = ${targetId}
        LIMIT 1
      `);

      const entry = rows[0] ?? { agent_id: targetId, score: 0, signals: {}, updated_at: null };

      return {
        type: "reputation_get",
        reputation: entry,
      };
    }

    case "reputation_list": {
      const parsed = ReputationListTaskSchema.parse(task);
      await ensurePermission("social", "read");
      if (!db) {
        throw new Error("Reputation operations require persistent storage");
      }

      const limit = parsed.limit ?? 50;
      const rows = await db.query((sql) => sql`
        SELECT agent_id, score, signals, updated_at
        FROM agent_reputation
        ORDER BY score DESC
        LIMIT ${limit}
      `);

      return {
        type: "reputation_list",
        reputations: rows,
      };
    }

    case "reputation_adjust": {
      const parsed = ReputationAdjustTaskSchema.parse(task);
      await ensurePermission("social", "admin");
      if (!db) {
        throw new Error("Reputation operations require persistent storage");
      }

      const signal = {
        delta: parsed.delta,
        reason: parsed.reason ?? "adjustment",
        by: agent.id,
        at: new Date().toISOString(),
      };

      const rows = await db.query((sql) => sql`
        INSERT INTO agent_reputation (agent_id, score, signals)
        VALUES (
          ${parsed.agentId},
          ${parsed.delta},
          ${sql.json(toJsonValue({ lastAdjustment: signal }))}
        )
        ON CONFLICT (agent_id)
        DO UPDATE SET
          score = agent_reputation.score + ${parsed.delta},
          signals = ${sql.json(toJsonValue({ lastAdjustment: signal }))},
          updated_at = NOW()
        RETURNING agent_id, score, signals, updated_at
      `);

      const reputation = rows[0];
      if (db && reputation) {
        await recordAuditLog(
          db,
          {
            action: "reputation.adjust",
            resourceType: "agent",
            resourceId: parsed.agentId,
            actorId: agent.id,
            details: { delta: parsed.delta, reason: parsed.reason },
            outcome: "success",
          },
          log
        );
      }

      return {
        type: "reputation_adjust",
        reputation,
      };
    }

    case "audit_query": {
      const parsed = AuditQueryTaskSchema.parse(task);
      await ensurePermission("admin", "read");
      if (!db) {
        throw new Error("Audit log requires persistent storage");
      }

      const limit = parsed.limit ?? 100;
      const rows = await db.query((sql) => {
        if (parsed.action && parsed.actorId) {
          return sql`
            SELECT id, action, resource_type, resource_id, actor_id, details, outcome, created_at
            FROM audit_log
            WHERE action = ${parsed.action} AND actor_id = ${parsed.actorId}
            ORDER BY created_at DESC
            LIMIT ${limit}
          `;
        }
        if (parsed.action) {
          return sql`
            SELECT id, action, resource_type, resource_id, actor_id, details, outcome, created_at
            FROM audit_log
            WHERE action = ${parsed.action}
            ORDER BY created_at DESC
            LIMIT ${limit}
          `;
        }
        if (parsed.actorId) {
          return sql`
            SELECT id, action, resource_type, resource_id, actor_id, details, outcome, created_at
            FROM audit_log
            WHERE actor_id = ${parsed.actorId}
            ORDER BY created_at DESC
            LIMIT ${limit}
          `;
        }
        return sql`
          SELECT id, action, resource_type, resource_id, actor_id, details, outcome, created_at
          FROM audit_log
          ORDER BY created_at DESC
          LIMIT ${limit}
        `;
      });

      return {
        type: "audit_query",
        entries: rows,
      };
    }

    case "capability_list": {
      const parsed = CapabilityListTaskSchema.parse(task);
      await ensurePermission("admin", "read");
      const targetId = parsed.agentId ?? agent.id;
      const tokens = permissionManager.listTokens(targetId);
      return {
        type: "capability_list",
        agentId: targetId,
        tokens,
      };
    }

    case "capability_grant": {
      const parsed = CapabilityGrantTaskSchema.parse(task);
      await ensurePermission("admin", "admin");

      const parsedPermissions: Permission[] = [];
      const invalid: string[] = [];
      for (const perm of parsed.permissions) {
        const parsedList = parsePermissionString(perm);
        if (!parsedList) {
          invalid.push(perm);
          continue;
        }
        parsedPermissions.push(...parsedList);
      }
      if (invalid.length > 0) {
        throw new Error(`Invalid permissions: ${invalid.join(", ")}`);
      }

      const deduped = dedupePermissions(parsedPermissions);
      const grantResult = permissionManager.grant(
        {
          agentId: parsed.agentId,
          permissions: deduped,
          purpose: parsed.purpose ?? "manual",
          durationMs: parsed.durationMs,
          delegatable: parsed.delegatable ?? false,
        },
        agent.id
      );
      if (!grantResult.ok) {
        throw new Error(`Failed to grant capability: ${grantResult.error.message}`);
      }

      if (db) {
        await recordAuditLog(
          db,
          {
            action: "capability.grant",
            resourceType: "capability",
            resourceId: grantResult.value.id,
            actorId: agent.id,
            details: {
              agentId: parsed.agentId,
              purpose: parsed.purpose ?? "manual",
              permissions: deduped,
            },
            outcome: "success",
          },
          log
        );
      }

      return {
        type: "capability_grant",
        token: grantResult.value,
      };
    }

    case "capability_revoke": {
      const parsed = CapabilityRevokeTaskSchema.parse(task);
      await ensurePermission("admin", "admin");

      const tokenResult = permissionManager.getToken(parsed.tokenId);
      if (!tokenResult.ok) {
        throw new Error(tokenResult.error.message);
      }
      const revokeResult = permissionManager.revoke(parsed.tokenId);
      if (!revokeResult.ok) {
        throw new Error(revokeResult.error.message);
      }

      if (db) {
        await recordAuditLog(
          db,
          {
            action: "capability.revoke",
            resourceType: "capability",
            resourceId: parsed.tokenId,
            actorId: agent.id,
            details: { agentId: tokenResult.value.agentId },
            outcome: "success",
          },
          log
        );
      }

      return {
        type: "capability_revoke",
        tokenId: parsed.tokenId,
        success: true,
      };
    }

    case "capability_revoke_all": {
      const parsed = CapabilityRevokeAllTaskSchema.parse(task);
      await ensurePermission("admin", "admin");
      const count = permissionManager.revokeAll(parsed.agentId);

      if (db) {
        await recordAuditLog(
          db,
          {
            action: "capability.revoke_all",
            resourceType: "capability",
            resourceId: parsed.agentId,
            actorId: agent.id,
            details: { count },
            outcome: "success",
          },
          log
        );
      }

      return {
        type: "capability_revoke_all",
        agentId: parsed.agentId,
        count,
      };
    }

    case "policy_create": {
      const parsed = PolicyCreateTaskSchema.parse(task);
      await ensurePermission("admin", "admin");
      if (!db) {
        throw new Error("Policy operations require persistent storage");
      }

      const rows = await db.query((sql) => sql`
        INSERT INTO policies (name, description, rules, status, created_by)
        VALUES (
          ${parsed.name},
          ${parsed.description ?? null},
          ${sql.json(toJsonValue(parsed.rules ?? {}))},
          'active',
          ${agent.id}
        )
        RETURNING id, name, description, rules, status, created_by, created_at, updated_at
      `);

      const policy = rows[0];
      if (policy) {
        await recordAuditLog(
          db,
          {
            action: "policy.create",
            resourceType: "policy",
            resourceId: policy.id,
            actorId: agent.id,
            details: { name: parsed.name },
            outcome: "success",
          },
          log
        );
      }

      return { type: "policy_create", policy };
    }

    case "policy_list": {
      const parsed = PolicyListTaskSchema.parse(task);
      await ensurePermission("admin", "read");
      if (!db) {
        throw new Error("Policy operations require persistent storage");
      }

      const limit = parsed.limit ?? 100;
      const rows = await db.query((sql) => parsed.status
        ? sql`
            SELECT id, name, description, rules, status, created_by, created_at, updated_at
            FROM policies
            WHERE status = ${parsed.status}
            ORDER BY created_at DESC
            LIMIT ${limit}
          `
        : sql`
            SELECT id, name, description, rules, status, created_by, created_at, updated_at
            FROM policies
            ORDER BY created_at DESC
            LIMIT ${limit}
          `
      );

      return { type: "policy_list", policies: rows };
    }

    case "policy_set_status": {
      const parsed = PolicySetStatusTaskSchema.parse(task);
      await ensurePermission("admin", "admin");
      if (!db) {
        throw new Error("Policy operations require persistent storage");
      }

      const rows = await db.query((sql) => sql`
        UPDATE policies
        SET status = ${parsed.status}, updated_at = NOW()
        WHERE id = ${parsed.policyId}
        RETURNING id, name, description, rules, status, created_by, created_at, updated_at
      `);

      const policy = rows[0];
      if (!policy) {
        throw new Error("Policy not found");
      }

      await recordAuditLog(
        db,
        {
          action: "policy.set_status",
          resourceType: "policy",
          resourceId: parsed.policyId,
          actorId: agent.id,
          details: { status: parsed.status },
          outcome: "success",
        },
        log
      );

      return { type: "policy_set_status", policy };
    }

    case "moderation_case_open": {
      const parsed = ModerationCaseOpenTaskSchema.parse(task);
      await ensurePermission("admin", "admin");
      if (!db) {
        throw new Error("Moderation requires persistent storage");
      }

      const rows = await db.query((sql) => sql`
        INSERT INTO moderation_cases (subject_agent_id, policy_id, status, reason, evidence, opened_by)
        VALUES (
          ${parsed.subjectAgentId},
          ${parsed.policyId ?? null},
          'open',
          ${parsed.reason ?? null},
          ${sql.json(toJsonValue(parsed.evidence ?? {}))},
          ${agent.id}
        )
        RETURNING id, subject_agent_id, policy_id, status, reason, evidence, opened_by, resolution, created_at, updated_at
      `);

      const moderationCase = rows[0];
      if (moderationCase) {
        await recordAuditLog(
          db,
          {
            action: "moderation.case.open",
            resourceType: "moderation_case",
            resourceId: moderationCase.id,
            actorId: agent.id,
            details: { subjectAgentId: parsed.subjectAgentId },
            outcome: "success",
          },
          log
        );
      }

      return { type: "moderation_case_open", case: moderationCase };
    }

    case "moderation_case_list": {
      const parsed = ModerationCaseListTaskSchema.parse(task);
      await ensurePermission("admin", "read");
      if (!db) {
        throw new Error("Moderation requires persistent storage");
      }

      const limit = parsed.limit ?? 100;
      const rows = await db.query((sql) => {
        if (parsed.status && parsed.subjectAgentId) {
          return sql`
            SELECT id, subject_agent_id, policy_id, status, reason, evidence, opened_by, resolution, created_at, updated_at
            FROM moderation_cases
            WHERE status = ${parsed.status} AND subject_agent_id = ${parsed.subjectAgentId}
            ORDER BY created_at DESC
            LIMIT ${limit}
          `;
        }
        if (parsed.status) {
          return sql`
            SELECT id, subject_agent_id, policy_id, status, reason, evidence, opened_by, resolution, created_at, updated_at
            FROM moderation_cases
            WHERE status = ${parsed.status}
            ORDER BY created_at DESC
            LIMIT ${limit}
          `;
        }
        if (parsed.subjectAgentId) {
          return sql`
            SELECT id, subject_agent_id, policy_id, status, reason, evidence, opened_by, resolution, created_at, updated_at
            FROM moderation_cases
            WHERE subject_agent_id = ${parsed.subjectAgentId}
            ORDER BY created_at DESC
            LIMIT ${limit}
          `;
        }
        return sql`
          SELECT id, subject_agent_id, policy_id, status, reason, evidence, opened_by, resolution, created_at, updated_at
          FROM moderation_cases
          ORDER BY created_at DESC
          LIMIT ${limit}
        `;
      });

      return { type: "moderation_case_list", cases: rows };
    }

    case "moderation_case_resolve": {
      const parsed = ModerationCaseResolveTaskSchema.parse(task);
      await ensurePermission("admin", "admin");
      if (!db) {
        throw new Error("Moderation requires persistent storage");
      }

      const newStatus = parsed.status ?? "resolved";
      const rows = await db.query((sql) => sql`
        UPDATE moderation_cases
        SET status = ${newStatus}, resolution = ${parsed.resolution ?? null}, updated_at = NOW()
        WHERE id = ${parsed.caseId}
        RETURNING id, subject_agent_id, policy_id, status, reason, evidence, opened_by, resolution, created_at, updated_at
      `);

      const moderationCase = rows[0];
      if (!moderationCase) {
        throw new Error("Moderation case not found");
      }

      await recordAuditLog(
        db,
        {
          action: "moderation.case.resolve",
          resourceType: "moderation_case",
          resourceId: parsed.caseId,
          actorId: agent.id,
          details: { status: newStatus },
          outcome: "success",
        },
        log
      );

      return { type: "moderation_case_resolve", case: moderationCase };
    }

    case "appeal_open": {
      const parsed = AppealOpenTaskSchema.parse(task);
      let hasPermission = false;
      try {
        await ensurePermission("social", "write");
        hasPermission = true;
      } catch {
        // fallthrough to admin check
      }
      if (!hasPermission) {
        await ensurePermission("admin", "admin");
      }
      if (!db) {
        throw new Error("Appeals require persistent storage");
      }

      const moderationRows = await db.query((sql) => sql`
        SELECT id, subject_agent_id
        FROM moderation_cases
        WHERE id = ${parsed.caseId}
      `);
      const moderationCase = moderationRows[0] as { id: string; subject_agent_id?: string } | undefined;
      if (!moderationCase) {
        throw new Error("Moderation case not found");
      }

      let canAppeal = moderationCase.subject_agent_id === agent.id;
      if (!canAppeal) {
        try {
          await ensurePermission("admin", "admin");
          canAppeal = true;
        } catch {
          // fallthrough
        }
      }
      if (!canAppeal) {
        throw new Error("Only the subject agent or an admin can open an appeal");
      }

      const rows = await db.query((sql) => sql`
        INSERT INTO moderation_appeals (case_id, appellant_agent_id, status, reason, evidence)
        VALUES (
          ${parsed.caseId},
          ${agent.id},
          'open',
          ${parsed.reason ?? null},
          ${sql.json(toJsonValue(parsed.evidence ?? {}))}
        )
        RETURNING id, case_id, appellant_agent_id, status, reason, evidence, resolution, created_at, updated_at
      `);

      const appeal = rows[0];
      if (appeal) {
        await recordAuditLog(
          db,
          {
            action: "appeal.open",
            resourceType: "moderation_appeal",
            resourceId: appeal.id,
            actorId: agent.id,
            details: { caseId: parsed.caseId },
            outcome: "success",
          },
          log
        );
      }

      return { type: "appeal_open", appeal };
    }

    case "appeal_list": {
      const parsed = AppealListTaskSchema.parse(task);
      if (!db) {
        throw new Error("Appeals require persistent storage");
      }

      let isAdmin = false;
      try {
        await ensurePermission("admin", "read");
        isAdmin = true;
      } catch {
        await ensurePermission("social", "read");
      }

      const limit = parsed.limit ?? 100;
      const rows = await db.query((sql) => {
        if (isAdmin) {
          if (parsed.status && parsed.caseId && parsed.appellantAgentId) {
            return sql`
              SELECT id, case_id, appellant_agent_id, status, reason, evidence, resolution, created_at, updated_at
              FROM moderation_appeals
              WHERE status = ${parsed.status}
                AND case_id = ${parsed.caseId}
                AND appellant_agent_id = ${parsed.appellantAgentId}
              ORDER BY created_at DESC
              LIMIT ${limit}
            `;
          }
          if (parsed.status && parsed.caseId) {
            return sql`
              SELECT id, case_id, appellant_agent_id, status, reason, evidence, resolution, created_at, updated_at
              FROM moderation_appeals
              WHERE status = ${parsed.status}
                AND case_id = ${parsed.caseId}
              ORDER BY created_at DESC
              LIMIT ${limit}
            `;
          }
          if (parsed.status && parsed.appellantAgentId) {
            return sql`
              SELECT id, case_id, appellant_agent_id, status, reason, evidence, resolution, created_at, updated_at
              FROM moderation_appeals
              WHERE status = ${parsed.status}
                AND appellant_agent_id = ${parsed.appellantAgentId}
              ORDER BY created_at DESC
              LIMIT ${limit}
            `;
          }
          if (parsed.caseId && parsed.appellantAgentId) {
            return sql`
              SELECT id, case_id, appellant_agent_id, status, reason, evidence, resolution, created_at, updated_at
              FROM moderation_appeals
              WHERE case_id = ${parsed.caseId}
                AND appellant_agent_id = ${parsed.appellantAgentId}
              ORDER BY created_at DESC
              LIMIT ${limit}
            `;
          }
          if (parsed.status) {
            return sql`
              SELECT id, case_id, appellant_agent_id, status, reason, evidence, resolution, created_at, updated_at
              FROM moderation_appeals
              WHERE status = ${parsed.status}
              ORDER BY created_at DESC
              LIMIT ${limit}
            `;
          }
          if (parsed.caseId) {
            return sql`
              SELECT id, case_id, appellant_agent_id, status, reason, evidence, resolution, created_at, updated_at
              FROM moderation_appeals
              WHERE case_id = ${parsed.caseId}
              ORDER BY created_at DESC
              LIMIT ${limit}
            `;
          }
          if (parsed.appellantAgentId) {
            return sql`
              SELECT id, case_id, appellant_agent_id, status, reason, evidence, resolution, created_at, updated_at
              FROM moderation_appeals
              WHERE appellant_agent_id = ${parsed.appellantAgentId}
              ORDER BY created_at DESC
              LIMIT ${limit}
            `;
          }
          return sql`
            SELECT id, case_id, appellant_agent_id, status, reason, evidence, resolution, created_at, updated_at
            FROM moderation_appeals
            ORDER BY created_at DESC
            LIMIT ${limit}
          `;
        }

        if (parsed.caseId) {
          return sql`
            SELECT id, case_id, appellant_agent_id, status, reason, evidence, resolution, created_at, updated_at
            FROM moderation_appeals
            WHERE appellant_agent_id = ${agent.id}
              AND case_id = ${parsed.caseId}
            ORDER BY created_at DESC
            LIMIT ${limit}
          `;
        }
        return sql`
          SELECT id, case_id, appellant_agent_id, status, reason, evidence, resolution, created_at, updated_at
          FROM moderation_appeals
          WHERE appellant_agent_id = ${agent.id}
          ORDER BY created_at DESC
          LIMIT ${limit}
        `;
      });

      return { type: "appeal_list", appeals: rows };
    }

    case "appeal_resolve": {
      const parsed = AppealResolveTaskSchema.parse(task);
      await ensurePermission("admin", "admin");
      if (!db) {
        throw new Error("Appeals require persistent storage");
      }

      const newStatus = parsed.status ?? "resolved";
      const rows = await db.query((sql) => sql`
        UPDATE moderation_appeals
        SET status = ${newStatus}, resolution = ${parsed.resolution ?? null}, updated_at = NOW()
        WHERE id = ${parsed.appealId}
        RETURNING id, case_id, appellant_agent_id, status, reason, evidence, resolution, created_at, updated_at
      `);

      const appeal = rows[0];
      if (!appeal) {
        throw new Error("Appeal not found");
      }

      await recordAuditLog(
        db,
        {
          action: "appeal.resolve",
          resourceType: "moderation_appeal",
          resourceId: parsed.appealId,
          actorId: agent.id,
          details: { status: newStatus },
          outcome: "success",
        },
        log
      );

      return { type: "appeal_resolve", appeal };
    }

    case "sanction_list": {
      const parsed = SanctionListTaskSchema.parse(task);
      await ensurePermission("admin", "read");
      if (!db) {
        throw new Error("Sanctions require persistent storage");
      }

      const limit = parsed.limit ?? 100;
      const rows = await db.query((sql) => {
        if (parsed.subjectAgentId && parsed.status) {
          return sql`
            SELECT id, case_id, subject_agent_id, type, details, status, created_at, resolved_at
            FROM sanctions
            WHERE subject_agent_id = ${parsed.subjectAgentId} AND status = ${parsed.status}
            ORDER BY created_at DESC
            LIMIT ${limit}
          `;
        }
        if (parsed.subjectAgentId) {
          return sql`
            SELECT id, case_id, subject_agent_id, type, details, status, created_at, resolved_at
            FROM sanctions
            WHERE subject_agent_id = ${parsed.subjectAgentId}
            ORDER BY created_at DESC
            LIMIT ${limit}
          `;
        }
        if (parsed.status) {
          return sql`
            SELECT id, case_id, subject_agent_id, type, details, status, created_at, resolved_at
            FROM sanctions
            WHERE status = ${parsed.status}
            ORDER BY created_at DESC
            LIMIT ${limit}
          `;
        }
        return sql`
          SELECT id, case_id, subject_agent_id, type, details, status, created_at, resolved_at
          FROM sanctions
          ORDER BY created_at DESC
          LIMIT ${limit}
        `;
      });

      return { type: "sanction_list", sanctions: rows };
    }

    case "sanction_apply": {
      const parsed = SanctionApplyTaskSchema.parse(task);
      await ensurePermission("admin", "admin");
      if (!db) {
        throw new Error("Sanctions require persistent storage");
      }

      const rows = await db.query((sql) => sql`
        INSERT INTO sanctions (case_id, subject_agent_id, type, details, status)
        VALUES (
          ${parsed.caseId ?? null},
          ${parsed.subjectAgentId},
          ${parsed.sanctionType},
          ${sql.json(toJsonValue(parsed.details ?? {}))},
          'active'
        )
        RETURNING id, case_id, subject_agent_id, type, details, status, created_at, resolved_at
      `);

      const sanction = rows[0];
      if (sanction) {
        await recordAuditLog(
          db,
          {
            action: "sanction.apply",
            resourceType: "sanction",
            resourceId: sanction.id,
            actorId: agent.id,
            details: { subjectAgentId: parsed.subjectAgentId, type: parsed.sanctionType },
            outcome: "success",
          },
          log
        );
      }

      return { type: "sanction_apply", sanction };
    }

    case "sanction_lift": {
      const parsed = SanctionLiftTaskSchema.parse(task);
      await ensurePermission("admin", "admin");
      if (!db) {
        throw new Error("Sanctions require persistent storage");
      }

      const rows = await db.query((sql) => sql`
        UPDATE sanctions
        SET status = 'resolved', resolved_at = NOW()
        WHERE id = ${parsed.sanctionId}
        RETURNING id, case_id, subject_agent_id, type, details, status, created_at, resolved_at
      `);

      const sanction = rows[0];
      if (!sanction) {
        throw new Error("Sanction not found");
      }

      await recordAuditLog(
        db,
        {
          action: "sanction.lift",
          resourceType: "sanction",
          resourceId: parsed.sanctionId,
          actorId: agent.id,
          outcome: "success",
        },
        log
      );

      return { type: "sanction_lift", sanction };
    }

    case "a2a_delegate":
    case "a2a_task":
    case "a2a_task_async": {
      const parsed = baseResult.data.type === "a2a_task_async"
        ? A2ATaskAsyncSchema.parse(task)
        : A2ATaskSchema.parse(task);
      await ensureApproval(parsed.approval, "a2a_task");
      await ensurePermission("agents", "execute", parsed.targetAgentId);
      const target = findAgentById(agents, parsed.targetAgentId);
      if (!target) {
        throw new Error(`Target agent not found: ${parsed.targetAgentId}`);
      }
      validateA2ATask(target, parsed.task);

      const taskId = createA2aTaskId();
      const entry: A2ATaskEntry = {
        id: taskId,
        fromAgentId: agent.id,
        toAgentId: parsed.targetAgentId,
        task: parsed.task,
        status: "submitted",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      a2aTasks.set(taskId, entry);

      if (db) {
        await recordAuditLog(
          db,
          {
            action: "a2a.task.submitted",
            resourceType: "agent",
            resourceId: parsed.targetAgentId,
            actorId: agent.id,
            details: { taskId },
            outcome: "success",
          },
          log
        );
        await recordEvent(
          db,
          "a2a.task.submitted",
          "gateway",
          {
            taskId,
            fromAgentId: agent.id,
            toAgentId: parsed.targetAgentId,
          },
          log,
          { agentId: agent.id, correlationId: taskId }
        );
      }

      setImmediate(async () => {
        entry.status = "working";
        entry.updatedAt = Date.now();

        if (db) {
          await recordEvent(
            db,
            "a2a.task.working",
            "gateway",
            { taskId },
            log,
            { agentId: agent.id, correlationId: taskId }
          );
        }

        try {
          const result = await handleAgentTask(parsed.task, target, taskContext);
          entry.status = "completed";
          entry.result = result;
          entry.updatedAt = Date.now();

          if (db) {
            await recordEvent(
              db,
              "a2a.task.completed",
              "gateway",
              { taskId },
              log,
              { agentId: agent.id, correlationId: taskId }
            );
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          entry.status = "failed";
          entry.error = message;
          entry.updatedAt = Date.now();

          if (db) {
            await recordEvent(
              db,
              "a2a.task.failed",
              "gateway",
              { taskId, error: message },
              log,
              { agentId: agent.id, correlationId: taskId }
            );
          }
        }
      });

      return {
        type: baseResult.data.type,
        taskId,
        status: entry.status,
      };
    }

    case "a2a_task_sync": {
      const parsed = A2ATaskSyncSchema.parse(task);
      await ensureApproval(parsed.approval, "a2a_task_sync");
      await ensurePermission("agents", "execute", parsed.targetAgentId);
      const target = findAgentById(agents, parsed.targetAgentId);
      if (!target) {
        throw new Error(`Target agent not found: ${parsed.targetAgentId}`);
      }
      validateA2ATask(target, parsed.task);

      const taskId = createA2aTaskId();
      const entry: A2ATaskEntry = {
        id: taskId,
        fromAgentId: agent.id,
        toAgentId: parsed.targetAgentId,
        task: parsed.task,
        status: "working",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      a2aTasks.set(taskId, entry);

      if (db) {
        await recordAuditLog(
          db,
          {
            action: "a2a.task.submitted",
            resourceType: "agent",
            resourceId: parsed.targetAgentId,
            actorId: agent.id,
            details: { taskId },
            outcome: "success",
          },
          log
        );
        await recordEvent(
          db,
          "a2a.task.submitted",
          "gateway",
          {
            taskId,
            fromAgentId: agent.id,
            toAgentId: parsed.targetAgentId,
          },
          log,
          { agentId: agent.id, correlationId: taskId }
        );
      }

      try {
        const result = await handleAgentTask(parsed.task, target, taskContext);
        entry.status = "completed";
        entry.result = result;
        entry.updatedAt = Date.now();

        if (db) {
          await recordEvent(
            db,
            "a2a.task.completed",
            "gateway",
            { taskId },
            log,
            { agentId: agent.id, correlationId: taskId }
          );
        }

        return {
          type: "a2a_task_sync",
          taskId,
          status: "completed",
          result,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        entry.status = "failed";
        entry.error = message;
        entry.updatedAt = Date.now();

        if (db) {
          await recordEvent(
            db,
            "a2a.task.failed",
            "gateway",
            { taskId, error: message },
            log,
            { agentId: agent.id, correlationId: taskId }
          );
        }

        return {
          type: "a2a_task_sync",
          taskId,
          status: "failed",
          error: message,
        };
      }
    }

    case "a2a_task_status": {
      const parsed = A2ATaskStatusSchema.parse(task);
      await ensurePermission("agents", "read");
      const entry = a2aTasks.get(parsed.taskId);
      if (!entry) {
        throw new Error(`A2A task not found: ${parsed.taskId}`);
      }

      return {
        type: "a2a_task_status",
        taskId: entry.id,
        status: entry.status,
        result: entry.result,
        error: entry.error,
      };
    }

    // ─── SKILLS SYSTEM ─────────────────────────────────────────

    case "list_skills": {
      const parsed = ListSkillsTaskSchema.parse(task);
      await ensurePermission("agents", "read");

      const skills: Array<{
        id: string;
        name: string;
        description?: string;
        providedBy: string;
        agentName: string;
      }> = [];

      for (const [, agentEntry] of agents) {
        if (agentEntry.state !== "ready" && agentEntry.state !== "running") continue;
        if (parsed.filter?.agentId && agentEntry.id !== parsed.filter.agentId) continue;

        for (const skill of agentEntry.a2aSkills ?? []) {
          if (parsed.filter?.capability && !skill.name.toLowerCase().includes(parsed.filter.capability.toLowerCase())) {
            continue;
          }
          skills.push({
            id: skill.id,
            name: skill.name,
            description: skill.description,
            providedBy: agentEntry.id,
            agentName: agentEntry.name,
          });
        }
      }

      return { type: "list_skills", skills, count: skills.length };
    }

    case "invoke_skill": {
      const parsed = InvokeSkillTaskSchema.parse(task);
      await ensureApproval(parsed.approval, "invoke_skill");

      // Find which agent provides this skill
      let targetAgent: AgentEntry | undefined;
      let matchedSkill: (typeof targetAgent extends AgentEntry ? AgentEntry["a2aSkills"][number] : never) | undefined;

      for (const [, agentEntry] of agents) {
        if (agentEntry.state !== "ready" && agentEntry.state !== "running") continue;
        const found = (agentEntry.a2aSkills ?? []).find((s) => s.id === parsed.skillId);
        if (found) {
          targetAgent = agentEntry;
          matchedSkill = found;
          break;
        }
      }

      if (!targetAgent || !matchedSkill) {
        throw new Error(`Skill not found: ${parsed.skillId}`);
      }

      await ensurePermission("agents", "execute", targetAgent.id);

      // Route to the agent via A2A task dispatch
      const skillTask = {
        type: matchedSkill.id,
        ...parsed.input,
      };

      const result = await handleAgentTask(skillTask, targetAgent, taskContext);

      if (db) {
        await recordAuditLog(db, {
          action: "skill.invoked",
          resourceType: "skill",
          resourceId: parsed.skillId,
          actorId: agent.id,
          details: { targetAgentId: targetAgent.id, skillName: matchedSkill.name },
          outcome: "success",
        }, log);
      }

      return { type: "invoke_skill", skillId: parsed.skillId, result };
    }

    // ─── PROCEDURAL MEMORY ───────────────────────────────────────

    case "store_procedure": {
      const parsed = StoreProcedureTaskSchema.parse(task);
      await ensurePermission("memory", "write");

      const embedding = await tryGenerateEmbedding(
        `${parsed.name}: ${parsed.description}. Trigger: ${parsed.trigger}`,
        log
      );

      const result = await memory.learnProcedure(
        agent.id,
        parsed.name,
        parsed.description,
        parsed.trigger,
        parsed.steps.map((s) => ({
          action: s.action,
          description: s.description,
          parameters: s.parameters as Record<string, unknown> | undefined,
        })),
        {
          inputs: parsed.inputs,
          outputs: parsed.outputs,
          tags: parsed.tags,
          scope: parsed.scope,
          importance: parsed.importance,
        }
      );

      if (!result.ok) {
        throw new Error(result.error.message);
      }

      if (db) {
        await recordAuditLog(db, {
          action: "memory.write",
          resourceType: "procedural_memory",
          resourceId: result.value,
          actorId: agent.id,
          details: { name: parsed.name, trigger: parsed.trigger },
          outcome: "success",
        }, log);
      }

      return { type: "store_procedure", procedureId: result.value, name: parsed.name };
    }

    case "get_procedure": {
      const parsed = GetProcedureTaskSchema.parse(task);
      await ensurePermission("memory", "read");

      const result = await memory.findProcedure(agent.id, parsed.name);
      if (!result.ok) {
        throw new Error(result.error.message);
      }

      return {
        type: "get_procedure",
        found: result.value !== null,
        procedure: result.value ? {
          id: result.value.id,
          name: result.value.name,
          description: result.value.description,
          trigger: result.value.trigger,
          steps: result.value.steps,
          inputs: result.value.inputs,
          outputs: result.value.outputs,
          version: result.value.version,
          successRate: result.value.successRate,
          executionCount: result.value.executionCount,
          active: result.value.active,
        } : null,
      };
    }

    case "find_procedures": {
      const parsed = FindProceduresTaskSchema.parse(task);
      await ensurePermission("memory", "read");

      const result = await memory.matchProcedures(agent.id, parsed.situation, {
        limit: parsed.limit,
        minSuccessRate: parsed.minSuccessRate,
      });

      if (!result.ok) {
        throw new Error(result.error.message);
      }

      return {
        type: "find_procedures",
        procedures: result.value.map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          trigger: p.trigger,
          steps: p.steps,
          successRate: p.successRate,
          executionCount: p.executionCount,
        })),
        count: result.value.length,
      };
    }

    case "record_procedure_execution": {
      const parsed = RecordProcedureExecutionTaskSchema.parse(task);
      await ensurePermission("memory", "write");

      const result = await memory.recordProcedureExecution(parsed.procedureId, parsed.success);
      if (!result.ok) {
        throw new Error(result.error.message);
      }

      return {
        type: "record_procedure_execution",
        procedureId: parsed.procedureId,
        success: parsed.success,
      };
    }

    case "compute": {
      const parsed = ComputeTaskSchema.parse(task);
      const values = parsed.values ?? [];
      const operations = parsed.operations ?? ["add"];

      const results: Record<string, number> = {};

      if (operations.includes("add")) {
        results.add = values.reduce((sum, value) => sum + value, 0);
      }

      if (operations.includes("multiply")) {
        results.multiply = values.reduce((product, value) => product * value, values.length ? 1 : 0);
      }

      return {
        type: "compute",
        values,
        results,
      };
    }

    case "memory_intensive": {
      const parsed = MemoryIntensiveTaskSchema.parse(task);
      const allocateMb = parsed._testFlags?.allocateMb ?? 0;
      const limitMb = agent.limits.maxMemoryMB ?? memoryLimitMb;

      if (limitMb > 0 && allocateMb > limitMb) {
        return {
          type: "memory_intensive",
          error: "Memory limit exceeded",
          oom: true,
          requestedMb: allocateMb,
          limitMb,
        };
      }

      return {
        type: "memory_intensive",
        allocatedMb: allocateMb,
        limitMb,
      };
    }

    default:
      throw new Error(`Unknown task type: ${baseResult.data.type}`);
  }
}

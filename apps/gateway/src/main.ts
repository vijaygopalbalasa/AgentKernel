// Agent OS Gateway — The main daemon process
// Production quality with Zod validation and Layer 4 integration

import { config as loadEnv } from "dotenv";
import { randomUUID, createHash } from "crypto";
import { resolve } from "path";
import { existsSync } from "fs";
import { fork, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { z } from "zod";
import Ajv from "ajv";
import type { ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { WebSocket } from "ws";

// Load .env from the monorepo root (skip in test to avoid leaking local secrets into CI/tests)
if (process.env.NODE_ENV !== "test") {
  loadEnv({ path: resolve(process.cwd(), "../../.env") });
}

import {
  createLogger,
  loadConfig,
  createDatabase,
  waitForDatabase,
  createVectorStore,
  waitForVectorStore,
  getTracer,
  type Config,
  type Database,
  type VectorStore,
} from "@agent-os/kernel";
import { createModelRouter, responseToStream, type ModelRouter, type ProviderAdapter } from "@agent-os/mal";
import { createAnthropicProvider } from "@agent-os/provider-anthropic";
import { createOpenAIProvider } from "@agent-os/provider-openai";
import { createGoogleProvider } from "@agent-os/provider-google";
import { createOllamaProvider } from "@agent-os/provider-ollama";
import { createEventBus, type EventBus } from "@agent-os/events";
import { ok, err, type Result, type ChatResponse, type ChatRequest } from "@agent-os/shared";
import { MemoryManager, InMemoryStore, PersistentMemoryStore } from "@agent-os/memory";
import {
  createCapabilityManager,
  type Permission,
  type PermissionAction,
  type PermissionCategory,
} from "@agent-os/permissions";
import { estimateCost, JobRunner, type JobLockProvider } from "@agent-os/runtime";
import { type A2ASkill } from "@agent-os/communication";
import {
  createToolRegistry,
  registerBuiltinTools,
  createMCPClientManager,
  type MCPServerConfig,
  type ToolDefinition,
  type ToolResult,
} from "@agent-os/tools";

import { createWebSocketServer, type WsServer, type MessageHandler } from "./websocket.js";
import { createHealthServer, type HealthServer } from "./health.js";
import {
  parseAllowedPaths,
  parseAllowedDomains,
  parseAllowedCommands,
  parseBoolean,
  isPathAllowed,
  isDomainAllowed,
  isCommandAllowed,
  verifyManifestSignature,
} from "./security-utils.js";
import {
  type WsMessage,
  type ClientConnection,
  ChatPayloadSchema,
  AgentSpawnPayloadSchema,
  AgentTerminatePayloadSchema,
  SubscribePayloadSchema,
  AgentTaskPayloadSchema,
  GatewayError,
} from "./types.js";

/** Gateway state */
interface GatewayState {
  router: ModelRouter;
  wsServer: WsServer;
  healthServer: HealthServer;
  eventBus: EventBus;
  agents: Map<string, AgentEntry>;
  jobRunner: JobRunner;
  memory: MemoryManager;
  toolRegistry: ReturnType<typeof createToolRegistry>;
  permissionManager: ReturnType<typeof createCapabilityManager>;
  a2aTasks: Map<string, A2ATaskEntry>;
  allowedPaths: string[];
  allowedDomains: string[];
  allowAllPaths: boolean;
  allowAllDomains: boolean;
  memoryLimitMb: number;
  db?: Database;
  vectorStore?: VectorStore;
}

type TrustLevel = "supervised" | "semi-autonomous" | "monitored-autonomous";

type WorkerRuntime = "local" | "docker";

interface WorkerTransport {
  send: (message: unknown) => void;
  onMessage: (handler: (message: unknown) => void) => void;
  onExit: (handler: (code: number | null, signal: NodeJS.Signals | null) => void) => void;
  kill: (signal?: NodeJS.Signals) => void;
}

interface AgentLimits {
  maxTokensPerRequest?: number;
  tokensPerMinute?: number;
  requestsPerMinute?: number;
  toolCallsPerMinute?: number;
  costBudgetUSD?: number;
  maxMemoryMB?: number;
  cpuCores?: number;
  diskQuotaMB?: number;
}

interface AgentUsageWindow {
  windowStart: number;
  requestsThisMinute: number;
  toolCallsThisMinute: number;
  tokensThisMinute: number;
}

/** Agent tracking entry */
interface AgentEntry {
  id: string;
  externalId?: string;
  name: string;
  nodeId?: string;
  state: "initializing" | "ready" | "running" | "paused" | "error" | "terminated";
  startedAt: number;
  model?: string;
  entryPoint?: string;
  capabilities: string[];
  permissions: string[];
  mcpServers?: string[];
  permissionGrants: Permission[];
  trustLevel: TrustLevel;
  permissionTokenId?: string;
  limits: AgentLimits;
  usageWindow: AgentUsageWindow;
  costUsageUSD: number;
  a2aSkills: A2ASkill[];
  a2aValidators: Map<string, ValidateFunction>;
  errorCount: number;
  worker?: ChildProcess;
  workerTransport?: WorkerTransport;
  workerReady: boolean;
  workerTasks: Map<string, { resolve: (value: unknown) => void; reject: (err: Error) => void; timeoutId: NodeJS.Timeout }>;
  lastHeartbeatAt?: number;
  restartAttempts: number;
  restartBackoffMs: number;
  shutdownRequested: boolean;
  tools: Array<{ id: string; enabled?: boolean }>;
  tokenUsage: { input: number; output: number };
}

interface A2ATaskEntry {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  task: Record<string, unknown>;
  status: "submitted" | "working" | "completed" | "failed";
  createdAt: number;
  updatedAt: number;
  result?: unknown;
  error?: string;
}

type AgentManifest = NonNullable<z.infer<typeof AgentSpawnPayloadSchema>["manifest"]>;

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

function parseMcpServers(value?: string): MCPServerConfig[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as MCPServerConfig[] : [];
  } catch {
    return [];
  }
}

function normalizeMcpAllowlist(servers: unknown): string[] {
  if (!Array.isArray(servers)) return [];
  const names: string[] = [];
  for (const entry of servers) {
    if (typeof entry === "string") {
      names.push(entry);
    } else if (entry && typeof entry === "object") {
      const record = entry as { name?: unknown };
      if (typeof record.name === "string" && record.name.trim().length > 0) {
        names.push(record.name.trim());
      }
    }
  }
  return Array.from(new Set(names));
}

const PERMISSION_CATEGORY_ALIASES: Record<string, PermissionCategory> = {
  memory: "memory",
  tools: "tools",
  tool: "tools",
  network: "network",
  net: "network",
  filesystem: "filesystem",
  file: "filesystem",
  fs: "filesystem",
  agents: "agents",
  agent: "agents",
  llm: "llm",
  secrets: "secrets",
  secret: "secrets",
  admin: "admin",
  system: "system",
  shell: "shell",
  skill: "skill",
  social: "social",
};

const PERMISSION_ACTION_ALIASES: Record<string, PermissionAction> = {
  read: "read",
  write: "write",
  execute: "execute",
  delete: "delete",
  admin: "admin",
  list: "read",
  fetch: "execute",
  spawn: "execute",
  terminate: "execute",
  communicate: "execute",
  connect: "execute",
};

function resolvePermissionCategory(value: string): PermissionCategory | null {
  const normalized = value.trim().toLowerCase();
  return PERMISSION_CATEGORY_ALIASES[normalized] ?? null;
}

function resolvePermissionAction(value: string): PermissionAction | null {
  const normalized = value.trim().toLowerCase();
  return PERMISSION_ACTION_ALIASES[normalized] ?? null;
}

function parsePermissionString(permission: string): Permission[] | null {
  const trimmed = permission.trim();
  if (!trimmed) return null;

  const separatorIndex = trimmed.indexOf(":");
  const scope = separatorIndex === -1 ? trimmed : trimmed.slice(0, separatorIndex);
  const resource = separatorIndex === -1 ? undefined : trimmed.slice(separatorIndex + 1).trim() || undefined;

  const [categoryRaw, actionRaw] = scope.split(".", 2);
  if (!categoryRaw || !actionRaw) return null;

  const category = resolvePermissionCategory(categoryRaw);
  const action = resolvePermissionAction(actionRaw);
  if (!category || !action) return null;

  return expandPermission({
    category,
    actions: [action],
    resource,
  });
}

function expandPermission(permission: Permission): Permission[] {
  if (permission.category !== "filesystem" || !permission.resource) {
    return [permission];
  }

  const resource = permission.resource.trim();
  if (!resource) return [permission];
  if (resource.includes("*")) return [{ ...permission, resource }];

  const normalized = resource.endsWith("/") ? resource.slice(0, -1) : resource;
  return [
    { ...permission, resource: normalized },
    { ...permission, resource: `${normalized}/**` },
  ];
}

function dedupePermissions(permissions: Permission[]): Permission[] {
  const seen = new Set<string>();
  const result: Permission[] = [];

  for (const permission of permissions) {
    const actions = Array.from(new Set(permission.actions)).sort();
    const resource = permission.resource ?? "";
    const key = `${permission.category}|${actions.join(",")}|${resource}`;

    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...permission, actions });
  }

  return result;
}

function collectPermissions(manifest: AgentManifest): Result<Permission[], Error> {
  const permissions: Permission[] = [];
  const invalid: string[] = [];

  if (manifest.permissionGrants) {
    for (const grant of manifest.permissionGrants) {
      permissions.push(...expandPermission(grant));
    }
  }

  if (manifest.permissions) {
    for (const perm of manifest.permissions) {
      const parsed = parsePermissionString(perm);
      if (!parsed) {
        invalid.push(perm);
        continue;
      }
      permissions.push(...parsed);
    }
  }

  if (invalid.length > 0) {
    return err(new Error(`Invalid permissions: ${invalid.join(", ")}`));
  }

  return ok(dedupePermissions(permissions));
}

function checkPermissionAny(
  permissionManager: ReturnType<typeof createCapabilityManager>,
  agent: AgentEntry,
  category: PermissionCategory,
  actions: PermissionAction[],
  resource?: string
): { allowed: boolean; action?: PermissionAction; reason?: string } {
  let lastReason: string | undefined;

  for (const action of actions) {
    const result = permissionManager.check(agent.id, category, action, resource);
    if (result.allowed) {
      return { allowed: true, action };
    }
    lastReason = result.reason;
  }

  return { allowed: false, reason: lastReason };
}

function getEnabledToolIds(agent: AgentEntry): Set<string> | null {
  if (!agent.tools || agent.tools.length === 0) return null;
  const enabled = agent.tools
    .filter((tool) => tool.enabled !== false)
    .map((tool) => tool.id);
  return new Set(enabled);
}

function findAgentById(
  agents: Map<string, AgentEntry>,
  agentId: string
): AgentEntry | undefined {
  return agents.get(agentId) ?? Array.from(agents.values()).find((agent) => agent.externalId === agentId);
}

type JsonValue =
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue };

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

const DateLikeSchema = z.preprocess((value) => {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return value;
}, z.date());

const ApprovalSchema = z.object({
  approvedBy: z.string().min(1),
  approvedAt: DateLikeSchema.optional(),
  reason: z.string().optional(),
});

const EchoTaskSchema = z.object({
  type: z.literal("echo"),
  content: z.string().min(1),
});

const ChatTestFlagsSchema = z.object({
  simulateRateLimit: z.boolean().optional(),
  simulateProviderError: z.boolean().optional(),
  simulateAllProvidersDown: z.boolean().optional(),
  simulateRecovery: z.boolean().optional(),
  recoveryDelayMs: z.number().int().min(1).optional(),
}).optional();

type ChatTestFlags = z.infer<typeof ChatTestFlagsSchema>;

const ChatTaskSchema = z.object({
  type: z.literal("chat"),
  _testFlags: ChatTestFlagsSchema,
}).merge(ChatPayloadSchema);

const StoreFactTaskSchema = z.object({
  type: z.literal("store_fact"),
  fact: z.string().min(1),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  importance: z.number().min(0).max(1).optional(),
  embedding: z.array(z.number()).optional(),
});

const RecordEpisodeTaskSchema = z.object({
  type: z.literal("record_episode"),
  event: z.string().min(1),
  context: z.string(),
  outcome: z.string().optional(),
  success: z.boolean().optional(),
  importance: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).optional(),
  sessionId: z.string().optional(),
  relatedEpisodes: z.array(z.string()).optional(),
  embedding: z.array(z.number()).optional(),
});

const SearchMemoryTaskSchema = z.object({
  type: z.literal("search_memory"),
  query: z.string().optional(),
  embedding: z.array(z.number()).optional(),
  types: z.array(z.enum(["episodic", "semantic", "procedural"])).optional(),
  tags: z.array(z.string()).optional(),
  minImportance: z.number().min(0).max(1).optional(),
  minStrength: z.number().min(0).max(1).optional(),
  minSimilarity: z.number().min(0).max(1).optional(),
  after: DateLikeSchema.optional(),
  before: DateLikeSchema.optional(),
  limit: z.number().int().min(1).optional(),
  includeEmbeddings: z.boolean().optional(),
});

const ListToolsTaskSchema = z.object({
  type: z.literal("list_tools"),
  query: z.string().optional(),
});

const InvokeToolTaskSchema = z.object({
  type: z.literal("invoke_tool"),
  toolId: z.string().min(1),
  arguments: z.record(z.unknown()).optional(),
  approval: ApprovalSchema.optional(),
});

const DiscoverAgentsTaskSchema = z.object({
  type: z.literal("discover_agents"),
  filter: z.object({
    capability: z.string().optional(),
    name: z.string().optional(),
  }).optional(),
});

const AgentDirectoryTaskSchema = z.object({
  type: z.literal("agent_directory"),
  query: z.string().optional(),
  status: z.string().optional(),
  limit: z.number().int().min(1).optional(),
  offset: z.number().int().min(0).optional(),
});

const ForumCreateTaskSchema = z.object({
  type: z.literal("forum_create"),
  name: z.string().min(1),
  description: z.string().optional(),
});

const ForumListTaskSchema = z.object({
  type: z.literal("forum_list"),
  query: z.string().optional(),
  limit: z.number().int().min(1).optional(),
});

const ForumPostTaskSchema = z.object({
  type: z.literal("forum_post"),
  forumId: z.string().min(1),
  content: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
});

const ForumPostsTaskSchema = z.object({
  type: z.literal("forum_posts"),
  forumId: z.string().min(1),
  limit: z.number().int().min(1).optional(),
});

const JobPostTaskSchema = z.object({
  type: z.literal("job_post"),
  title: z.string().min(1),
  description: z.string().optional(),
  budgetUsd: z.number().min(0).optional(),
});

const JobListTaskSchema = z.object({
  type: z.literal("job_list"),
  status: z.enum(["open", "in_progress", "closed"]).optional(),
  limit: z.number().int().min(1).optional(),
});

const JobApplyTaskSchema = z.object({
  type: z.literal("job_apply"),
  jobId: z.string().min(1),
  proposal: z.string().optional(),
});

const ReputationGetTaskSchema = z.object({
  type: z.literal("reputation_get"),
  agentId: z.string().min(1).optional(),
});

const ReputationListTaskSchema = z.object({
  type: z.literal("reputation_list"),
  limit: z.number().int().min(1).optional(),
});

const ReputationAdjustTaskSchema = z.object({
  type: z.literal("reputation_adjust"),
  agentId: z.string().min(1),
  delta: z.number(),
  reason: z.string().optional(),
});

const AuditQueryTaskSchema = z.object({
  type: z.literal("audit_query"),
  action: z.string().optional(),
  actorId: z.string().optional(),
  limit: z.number().int().min(1).optional(),
});

const CapabilityListTaskSchema = z.object({
  type: z.literal("capability_list"),
  agentId: z.string().min(1).optional(),
});

const CapabilityGrantTaskSchema = z.object({
  type: z.literal("capability_grant"),
  agentId: z.string().min(1),
  permissions: z.array(z.string().min(1)),
  purpose: z.string().optional(),
  durationMs: z.number().int().min(1).optional(),
  delegatable: z.boolean().optional(),
});

const CapabilityRevokeTaskSchema = z.object({
  type: z.literal("capability_revoke"),
  tokenId: z.string().min(1),
});

const CapabilityRevokeAllTaskSchema = z.object({
  type: z.literal("capability_revoke_all"),
  agentId: z.string().min(1),
});

const PolicyCreateTaskSchema = z.object({
  type: z.literal("policy_create"),
  name: z.string().min(1),
  description: z.string().optional(),
  rules: z.record(z.unknown()).optional(),
});

const PolicyListTaskSchema = z.object({
  type: z.literal("policy_list"),
  status: z.string().optional(),
  limit: z.number().int().min(1).optional(),
});

const PolicySetStatusTaskSchema = z.object({
  type: z.literal("policy_set_status"),
  policyId: z.string().min(1),
  status: z.string().min(1),
});

const ModerationCaseOpenTaskSchema = z.object({
  type: z.literal("moderation_case_open"),
  subjectAgentId: z.string().min(1),
  policyId: z.string().optional(),
  reason: z.string().optional(),
  evidence: z.record(z.unknown()).optional(),
});

const ModerationCaseListTaskSchema = z.object({
  type: z.literal("moderation_case_list"),
  status: z.string().optional(),
  subjectAgentId: z.string().optional(),
  limit: z.number().int().min(1).optional(),
});

const ModerationCaseResolveTaskSchema = z.object({
  type: z.literal("moderation_case_resolve"),
  caseId: z.string().min(1),
  resolution: z.string().optional(),
  status: z.string().optional(),
});

const AppealOpenTaskSchema = z.object({
  type: z.literal("appeal_open"),
  caseId: z.string().min(1),
  reason: z.string().optional(),
  evidence: z.record(z.unknown()).optional(),
});

const AppealListTaskSchema = z.object({
  type: z.literal("appeal_list"),
  status: z.string().optional(),
  caseId: z.string().optional(),
  appellantAgentId: z.string().optional(),
  limit: z.number().int().min(1).optional(),
});

const AppealResolveTaskSchema = z.object({
  type: z.literal("appeal_resolve"),
  appealId: z.string().min(1),
  resolution: z.string().optional(),
  status: z.string().optional(),
});

const SanctionApplyTaskSchema = z.object({
  type: z.literal("sanction_apply"),
  caseId: z.string().optional(),
  subjectAgentId: z.string().min(1),
  sanctionType: z.enum(["warn", "throttle", "quarantine", "ban"]),
  details: z.record(z.unknown()).optional(),
});

const SanctionListTaskSchema = z.object({
  type: z.literal("sanction_list"),
  status: z.string().optional(),
  subjectAgentId: z.string().optional(),
  limit: z.number().int().min(1).optional(),
});

const SanctionLiftTaskSchema = z.object({
  type: z.literal("sanction_lift"),
  sanctionId: z.string().min(1),
});

const A2ATaskSchema = z.object({
  type: z.literal("a2a_task"),
  targetAgentId: z.string().min(1),
  task: z.record(z.unknown()),
  approval: ApprovalSchema.optional(),
});

const A2ATaskSyncSchema = z.object({
  type: z.literal("a2a_task_sync"),
  targetAgentId: z.string().min(1),
  task: z.record(z.unknown()),
  timeout: z.number().int().min(1).optional(),
  approval: ApprovalSchema.optional(),
});

const A2ATaskAsyncSchema = z.object({
  type: z.literal("a2a_task_async"),
  targetAgentId: z.string().min(1),
  task: z.record(z.unknown()),
  approval: ApprovalSchema.optional(),
});

const A2ATaskStatusSchema = z.object({
  type: z.literal("a2a_task_status"),
  taskId: z.string().min(1),
});

const ComputeTaskSchema = z.object({
  type: z.literal("compute"),
  operations: z.array(z.enum(["add", "multiply"])).optional(),
  values: z.array(z.number()).optional(),
});

const MemoryIntensiveTaskSchema = z.object({
  type: z.literal("memory_intensive"),
  _testFlags: z.object({
    allocateMb: z.number().int().min(1).optional(),
  }).optional(),
});

function createEventId(): string {
  return `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createA2aTaskId(): string {
  return randomUUID();
}

function createMockProvider(id: "anthropic" | "openai" | "google" | "ollama"): ProviderAdapter {
  const modelsByProvider: Record<typeof id, string[]> = {
    anthropic: [
      "claude-opus-4-5-20251101",
      "claude-sonnet-4-5-20250929",
      "claude-3-5-haiku-20241022",
      "claude-3-5-sonnet-20241022",
      "claude-3-opus-20240229",
      "claude-3-haiku-20240307",
    ],
    openai: [
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-4",
      "gpt-3.5-turbo",
    ],
    google: [
      "gemini-1.5-pro",
      "gemini-2.0-flash",
      "gemini-1.5-flash",
    ],
    ollama: [
      "llama3",
      "llama3.1",
      "mistral",
    ],
  };

  return {
    id,
    name: `Mock ${id}`,
    models: modelsByProvider[id],
    async isAvailable(): Promise<boolean> {
      return true;
    },
    async chat(request): Promise<Result<ChatResponse>> {
      const flags = (request as { _testFlags?: ChatTestFlags })._testFlags;
      if (flags?.simulateAllProvidersDown) {
        return err(Object.assign(new Error("All providers down"), { status: 503 }));
      }
      if (flags?.simulateProviderError) {
        return err(Object.assign(new Error("Provider error"), { status: 500 }));
      }
      if (flags?.simulateRateLimit && id === "anthropic") {
        return err(Object.assign(new Error("Rate limited"), { status: 429 }));
      }
      if (flags?.simulateRecovery && flags.recoveryDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, flags.recoveryDelayMs));
      }

      const lastMessage = request.messages[request.messages.length - 1];
      const content = `[${id}-mock] ${lastMessage?.content ?? "ok"}`;
      return ok({
        content,
        model: request.model,
        usage: {
          inputTokens: 10,
          outputTokens: 20,
        },
      });
    },
  };
}

const AjvDefault = Ajv.default ?? Ajv;
const addFormatsDefault = addFormats.default ?? addFormats;
const ajv = new AjvDefault({ allErrors: true, strict: false });
addFormatsDefault(ajv);

function resolvePermissionDurationMs(): number {
  const raw = process.env.PERMISSION_TOKEN_DURATION_MS;
  if (!raw) return 30 * 24 * 60 * 60 * 1000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30 * 24 * 60 * 60 * 1000;
}

function resolveMaxAgentErrors(): number {
  const raw = process.env.MAX_AGENT_ERRORS;
  if (!raw) return 5;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}

function resolveMaxAgentRestarts(): number {
  const raw = process.env.MAX_AGENT_RESTARTS;
  if (!raw) return 3;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
}

function resolveInternalTaskToken(): string | undefined {
  const raw = process.env.INTERNAL_AUTH_TOKEN;
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveEgressProxyUrl(): string | undefined {
  return (
    process.env.AGENT_EGRESS_PROXY_URL?.trim() ||
    process.env.HTTPS_PROXY?.trim() ||
    process.env.HTTP_PROXY?.trim() ||
    undefined
  );
}

function resolveMaxAgentTaskTimeoutMs(): number {
  const raw = process.env.MAX_AGENT_TASK_TIMEOUT_MS;
  if (!raw) return 60000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60000;
}

function resolveRetentionDays(value: string | undefined, defaultDays: number): number {
  if (!value) return defaultDays;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return defaultDays;
  return Math.max(0, Math.floor(parsed));
}

function resolveOptionalNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}

function truncateText(value: string | null | undefined, limit: number): string | null | undefined {
  if (value === null || value === undefined) return value;
  if (limit <= 0) return "";
  if (value.length <= limit) return value;
  return value.slice(0, limit);
}

type MemoryType = "episodic" | "semantic" | "procedural";

function compactArchivePayload(
  type: MemoryType,
  row: Record<string, unknown>,
  limit: number
): Record<string, unknown> {
  if (limit <= 0) return row;
  switch (type) {
    case "episodic":
      return {
        ...row,
        event: truncateText(row.event as string | null | undefined, limit),
        context: truncateText(row.context as string | null | undefined, limit),
        outcome: truncateText(row.outcome as string | null | undefined, limit),
      };
    case "semantic":
      return {
        ...row,
        subject: truncateText(row.subject as string | null | undefined, limit),
        predicate: truncateText(row.predicate as string | null | undefined, limit),
        object: truncateText(row.object as string | null | undefined, limit),
        source: truncateText(row.source as string | null | undefined, limit),
      };
    case "procedural":
      return {
        ...row,
        name: truncateText(row.name as string | null | undefined, limit),
        description: truncateText(row.description as string | null | undefined, limit),
        trigger: truncateText(row.trigger as string | null | undefined, limit),
      };
    default:
      return row;
  }
}

function scheduleRetentionCleanup(
  db: Database,
  vectorStore: VectorStore | undefined,
  log: ReturnType<typeof createLogger>,
  config: {
    auditDays: number;
    eventsDays: number;
    taskDays: number;
    episodicDays: number;
    semanticDays: number;
    proceduralDays: number;
    episodicArchiveDays: number;
    semanticArchiveDays: number;
    proceduralArchiveDays: number;
    archiveRetentionDays: number;
    episodicTierDays: number;
    semanticTierDays: number;
    proceduralTierDays: number;
    tierImportanceMax?: number;
    archiveCompact: boolean;
    archiveTextLimit: number;
  }
): NodeJS.Timeout {
  const intervalMs = 24 * 60 * 60 * 1000;

  const runCleanup = async () => {
    try {
      const archiveRows = async <TRow extends { id: string; agent_id: string; created_at: Date }>(
        rows: TRow[],
        type: MemoryType
      ): Promise<string[]> => {
        if (rows.length === 0) return [];
        const payloadRows = rows.map((row) => ({
          agent_id: row.agent_id,
          memory_id: row.id,
          type,
          payload: config.archiveCompact ? compactArchivePayload(type, row as Record<string, unknown>, config.archiveTextLimit) : row,
          created_at: row.created_at,
          archived_at: new Date(),
        }));

        const inserted = await db.query<{ memory_id: string }>((sql) => sql`
          INSERT INTO memory_archives (agent_id, memory_id, type, payload, created_at, archived_at)
          VALUES ${sql(payloadRows.map((entry) => [
            entry.agent_id,
            entry.memory_id,
            entry.type,
            entry.payload,
            entry.created_at,
            entry.archived_at,
          ]))}
          ON CONFLICT (memory_id, type) DO NOTHING
          RETURNING memory_id
        `);

        return inserted.map((row) => row.memory_id);
      };

      if (config.auditDays > 0) {
        const rows = await db.query((sql) => sql`
          DELETE FROM audit_log
          WHERE created_at < NOW() - (${config.auditDays}::int * INTERVAL '1 day')
          RETURNING id
        `);
        if (rows.length > 0) {
          log.info("Audit log retention cleanup", { deleted: rows.length });
        }
      }
      if (config.eventsDays > 0) {
        const rows = await db.query((sql) => sql`
          DELETE FROM events
          WHERE created_at < NOW() - (${config.eventsDays}::int * INTERVAL '1 day')
          RETURNING id
        `);
        if (rows.length > 0) {
          log.info("Event retention cleanup", { deleted: rows.length });
        }
      }
      if (config.taskDays > 0) {
        const rows = await db.query((sql) => sql`
          DELETE FROM task_messages
          WHERE created_at < NOW() - (${config.taskDays}::int * INTERVAL '1 day')
          RETURNING id
        `);
        if (rows.length > 0) {
          log.info("Task message retention cleanup", { deleted: rows.length });
        }
      }
      if (config.episodicTierDays > 0) {
        const rows = await db.query<{ id: string; agent_id: string; created_at: Date }>((sql) => sql`
          DELETE FROM episodic_memories
          WHERE last_accessed_at < NOW() - (${config.episodicTierDays}::int * INTERVAL '1 day')
          ${config.tierImportanceMax !== undefined ? sql`AND importance <= ${config.tierImportanceMax}` : sql``}
          RETURNING *
        `);
        if (rows.length > 0) {
          const archived = await archiveRows(rows, "episodic");
          log.info("Episodic memory tiered to archive", { archived: archived.length });
          if (vectorStore) {
            await vectorStore.deleteBatch(rows.map((row) => row.id));
          }
        }
      }
      if (config.episodicArchiveDays > 0) {
        const rows = await db.query<{ id: string; agent_id: string; created_at: Date }>((sql) => sql`
          DELETE FROM episodic_memories
          WHERE created_at < NOW() - (${config.episodicArchiveDays}::int * INTERVAL '1 day')
          RETURNING *
        `);
        if (rows.length > 0) {
          const archived = await archiveRows(rows, "episodic");
          log.info("Episodic memory archived", { archived: archived.length });
          if (vectorStore) {
            await vectorStore.deleteBatch(rows.map((row) => row.id));
          }
        }
      } else if (config.episodicDays > 0) {
        const rows = await db.query<{ id: string }>((sql) => sql`
          DELETE FROM episodic_memories
          WHERE created_at < NOW() - (${config.episodicDays}::int * INTERVAL '1 day')
          RETURNING id
        `);
        if (rows.length > 0) {
          log.info("Episodic memory retention cleanup", { deleted: rows.length });
          if (vectorStore) {
            await vectorStore.deleteBatch(rows.map((row) => row.id));
          }
        }
      }
      if (config.semanticTierDays > 0) {
        const rows = await db.query<{ id: string; agent_id: string; created_at: Date }>((sql) => sql`
          DELETE FROM semantic_memories
          WHERE last_accessed_at < NOW() - (${config.semanticTierDays}::int * INTERVAL '1 day')
          ${config.tierImportanceMax !== undefined ? sql`AND importance <= ${config.tierImportanceMax}` : sql``}
          RETURNING *
        `);
        if (rows.length > 0) {
          const archived = await archiveRows(rows, "semantic");
          log.info("Semantic memory tiered to archive", { archived: archived.length });
          if (vectorStore) {
            await vectorStore.deleteBatch(rows.map((row) => row.id));
          }
        }
      }
      if (config.semanticArchiveDays > 0) {
        const rows = await db.query<{ id: string; agent_id: string; created_at: Date }>((sql) => sql`
          DELETE FROM semantic_memories
          WHERE created_at < NOW() - (${config.semanticArchiveDays}::int * INTERVAL '1 day')
          RETURNING *
        `);
        if (rows.length > 0) {
          const archived = await archiveRows(rows, "semantic");
          log.info("Semantic memory archived", { archived: archived.length });
          if (vectorStore) {
            await vectorStore.deleteBatch(rows.map((row) => row.id));
          }
        }
      } else if (config.semanticDays > 0) {
        const rows = await db.query<{ id: string }>((sql) => sql`
          DELETE FROM semantic_memories
          WHERE created_at < NOW() - (${config.semanticDays}::int * INTERVAL '1 day')
          RETURNING id
        `);
        if (rows.length > 0) {
          log.info("Semantic memory retention cleanup", { deleted: rows.length });
          if (vectorStore) {
            await vectorStore.deleteBatch(rows.map((row) => row.id));
          }
        }
      }
      if (config.proceduralTierDays > 0) {
        const rows = await db.query<{ id: string; agent_id: string; created_at: Date }>((sql) => sql`
          DELETE FROM procedural_memories
          WHERE last_accessed_at < NOW() - (${config.proceduralTierDays}::int * INTERVAL '1 day')
          ${config.tierImportanceMax !== undefined ? sql`AND importance <= ${config.tierImportanceMax}` : sql``}
          RETURNING *
        `);
        if (rows.length > 0) {
          const archived = await archiveRows(rows, "procedural");
          log.info("Procedural memory tiered to archive", { archived: archived.length });
        }
      }
      if (config.proceduralArchiveDays > 0) {
        const rows = await db.query<{ id: string; agent_id: string; created_at: Date }>((sql) => sql`
          DELETE FROM procedural_memories
          WHERE created_at < NOW() - (${config.proceduralArchiveDays}::int * INTERVAL '1 day')
          RETURNING *
        `);
        if (rows.length > 0) {
          const archived = await archiveRows(rows, "procedural");
          log.info("Procedural memory archived", { archived: archived.length });
        }
      } else if (config.proceduralDays > 0) {
        const rows = await db.query((sql) => sql`
          DELETE FROM procedural_memories
          WHERE created_at < NOW() - (${config.proceduralDays}::int * INTERVAL '1 day')
          RETURNING id
        `);
        if (rows.length > 0) {
          log.info("Procedural memory retention cleanup", { deleted: rows.length });
        }
      }
      if (config.archiveRetentionDays > 0) {
        const rows = await db.query((sql) => sql`
          DELETE FROM memory_archives
          WHERE archived_at < NOW() - (${config.archiveRetentionDays}::int * INTERVAL '1 day')
          RETURNING id
        `);
        if (rows.length > 0) {
          log.info("Memory archive retention cleanup", { deleted: rows.length });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn("Retention cleanup failed", { error: message });
    }
  };

  setTimeout(() => void runCleanup(), 5000);
  return setInterval(() => void runCleanup(), intervalMs);
}

function resolveWorkerScriptPath(): string | null {
  const envPath = process.env.AGENT_WORKER_PATH;
  if (envPath && existsSync(envPath)) return envPath;

  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(currentDir, "agent-worker.js"),
    resolve(process.cwd(), "apps/gateway/dist/agent-worker.js"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

function resolveWorkerRuntime(): WorkerRuntime {
  const raw = process.env.AGENT_WORKER_RUNTIME?.toLowerCase();
  if (raw === "docker") return "docker";
  return "local";
}

function resolveDockerWorkerImage(): string {
  return process.env.AGENT_WORKER_IMAGE?.trim() || "agent-os-worker:latest";
}

function resolveDockerWorkerNetwork(): string | undefined {
  const network = process.env.AGENT_WORKER_DOCKER_NETWORK?.trim();
  return network && network.length > 0 ? network : undefined;
}

function resolveDockerWorkerMount(): string | undefined {
  const mount = process.env.AGENT_WORKER_DOCKER_MOUNT?.trim();
  return mount && mount.length > 0 ? mount : undefined;
}

function resolveDockerTmpfs(): string[] {
  const raw = process.env.AGENT_WORKER_DOCKER_TMPFS?.trim();
  if (!raw) return [];
  return raw.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function resolveDockerSecurityOpts(): string[] {
  const opts: string[] = [];
  if (parseBoolean(process.env.AGENT_WORKER_DOCKER_NO_NEW_PRIVS, false)) {
    opts.push("no-new-privileges");
  }
  const seccomp = process.env.AGENT_WORKER_DOCKER_SECCOMP_PROFILE?.trim();
  if (seccomp) {
    opts.push(`seccomp=${seccomp}`);
  }
  const apparmor = process.env.AGENT_WORKER_DOCKER_APPARMOR?.trim();
  if (apparmor) {
    opts.push(`apparmor=${apparmor}`);
  }
  const extra = process.env.AGENT_WORKER_DOCKER_SECURITY_OPTS?.trim();
  if (extra) {
    opts.push(...extra.split(",").map((entry) => entry.trim()).filter(Boolean));
  }
  return opts;
}

function resolveDockerCapDrop(): string[] {
  const raw = process.env.AGENT_WORKER_DOCKER_CAP_DROP?.trim();
  if (!raw) return [];
  return raw.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function resolveDockerUlimits(): string[] {
  const raw = process.env.AGENT_WORKER_DOCKER_ULIMITS?.trim();
  if (!raw) return [];
  return raw.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function resolveDockerBlkioWeight(): string | undefined {
  const raw = process.env.AGENT_WORKER_DOCKER_BLKIO_WEIGHT?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return undefined;
  const clamped = Math.max(10, Math.min(1000, Math.floor(parsed)));
  return String(clamped);
}

function resolveDockerStorageOpts(): string[] {
  const raw = process.env.AGENT_WORKER_DOCKER_STORAGE_OPTS?.trim();
  if (!raw) return [];
  return raw.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function applyDiskQuota(storageOpts: string[], diskQuotaMb?: number): string[] {
  if (!diskQuotaMb || !Number.isFinite(diskQuotaMb)) {
    return storageOpts;
  }
  const filtered = storageOpts.filter((entry) => !entry.trim().startsWith("size="));
  filtered.push(`size=${Math.floor(diskQuotaMb)}m`);
  return filtered;
}

function resolveStreamChunkSize(): number {
  const raw = process.env.CHAT_STREAM_CHUNK_SIZE;
  if (!raw) return 120;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 120;
}

function validateProductionHardening(
  log: ReturnType<typeof createLogger>,
  isProduction: boolean
): void {
  if (!isProduction) return;

  const enforce = parseBoolean(process.env.ENFORCE_PRODUCTION_HARDENING, isProduction);
  const allowUnsafeLocal = parseBoolean(process.env.ALLOW_UNSAFE_LOCAL_WORKERS, false);
  const enforceEgressProxy = parseBoolean(process.env.ENFORCE_EGRESS_PROXY, false);
  const disableNetwork = parseBoolean(process.env.AGENT_WORKER_DISABLE_NETWORK, false);
  const runtime = resolveWorkerRuntime();
  const errors: string[] = [];
  const warnings: string[] = [];

  const addIssue = (message: string) => {
    if (enforce) {
      errors.push(message);
    } else {
      warnings.push(message);
    }
  };

  if (runtime !== "docker") {
    const message =
      "AGENT_WORKER_RUNTIME should be docker in production for OS-level isolation";
    if (allowUnsafeLocal) {
      warnings.push(`${message} (ALLOW_UNSAFE_LOCAL_WORKERS=true)`);
    } else {
      addIssue(message);
    }
  } else {
    const readOnly = parseBoolean(process.env.AGENT_WORKER_DOCKER_READONLY, false);
    const noNewPrivs = parseBoolean(process.env.AGENT_WORKER_DOCKER_NO_NEW_PRIVS, false);
    const capDrop = resolveDockerCapDrop();
    const securityOpts = resolveDockerSecurityOpts();
    const seccompProfile = process.env.AGENT_WORKER_DOCKER_SECCOMP_PROFILE?.trim();
    const hasSeccomp = Boolean(seccompProfile) ||
      securityOpts.some((opt) => opt.startsWith("seccomp="));
    const requireAppArmor = parseBoolean(process.env.AGENT_WORKER_REQUIRE_APPARMOR, false);
    const appArmorProfile = process.env.AGENT_WORKER_DOCKER_APPARMOR?.trim();
    const hasAppArmor = Boolean(appArmorProfile) ||
      securityOpts.some((opt) => opt.startsWith("apparmor="));
    const pidsLimit = process.env.AGENT_WORKER_DOCKER_PIDS_LIMIT?.trim();
    const ulimits = resolveDockerUlimits();
    const storageOpts = resolveDockerStorageOpts();
    const network = resolveDockerWorkerNetwork();

    if (!readOnly) {
      addIssue("AGENT_WORKER_DOCKER_READONLY should be true in production");
    }
    if (!noNewPrivs) {
      addIssue("AGENT_WORKER_DOCKER_NO_NEW_PRIVS should be true in production");
    }
    if (capDrop.length === 0 || !capDrop.includes("ALL")) {
      addIssue("AGENT_WORKER_DOCKER_CAP_DROP should include ALL in production");
    }
    if (!hasSeccomp) {
      addIssue("AGENT_WORKER_DOCKER_SECCOMP_PROFILE should be set in production");
    }
    if (requireAppArmor && !hasAppArmor) {
      addIssue("AGENT_WORKER_DOCKER_APPARMOR should be set when AGENT_WORKER_REQUIRE_APPARMOR=true");
    }
    if (!pidsLimit) {
      addIssue("AGENT_WORKER_DOCKER_PIDS_LIMIT should be set in production");
    }
    if (ulimits.length === 0) {
      addIssue("AGENT_WORKER_DOCKER_ULIMITS should be set in production");
    }
    if (storageOpts.length === 0) {
      addIssue("AGENT_WORKER_DOCKER_STORAGE_OPTS should be set in production");
    }
    if (!disableNetwork && !network) {
      addIssue(
        "AGENT_WORKER_DISABLE_NETWORK should be true or AGENT_WORKER_DOCKER_NETWORK set in production"
      );
    }
  }

  if (!enforceEgressProxy && !disableNetwork) {
    addIssue("ENFORCE_EGRESS_PROXY should be true or AGENT_WORKER_DISABLE_NETWORK=true in production");
  }

  if (enforceEgressProxy) {
    const proxyUrl = resolveEgressProxyUrl();
    if (!proxyUrl) {
      addIssue("ENFORCE_EGRESS_PROXY requires AGENT_EGRESS_PROXY_URL/HTTPS_PROXY/HTTP_PROXY to be set");
    }
  }

  for (const warning of warnings) {
    log.warn(warning);
  }
  if (errors.length > 0) {
    for (const error of errors) {
      log.error(error);
    }
    process.exit(1);
  }
}

interface ClusterCoordinator {
  nodeId: string;
  isLeader: () => boolean;
  onChange: (handler: (isLeader: boolean) => void) => () => void;
  stop: () => Promise<void>;
}

function hashToInt32(value: string): number {
  const digest = createHash("sha256").update(value).digest();
  return digest.readInt32BE(0);
}

function deriveAdvisoryKeys(key: string): [number, number] {
  return [hashToInt32(key), hashToInt32(`${key}:secondary`)];
}

function resolveClusterNodeWsUrl(config: Config): string | null {
  const override = process.env.CLUSTER_NODE_WS_URL?.trim();
  if (override) return override;

  const host = process.env.CLUSTER_NODE_HOST?.trim() || config.gateway.host;
  const port = process.env.CLUSTER_NODE_PORT?.trim() || String(config.gateway.port);
  if (!host) return null;
  if (host.startsWith("ws://") || host.startsWith("wss://")) {
    return host;
  }
  return `ws://${host}:${port}`;
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object") return value as Record<string, unknown>;
  try {
    return JSON.parse(String(value)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function toNumber(value: unknown, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function registerClusterNode(
  db: Database,
  nodeId: string,
  wsUrl: string,
  log: ReturnType<typeof createLogger>
): Promise<NodeJS.Timeout> {
  const heartbeatMs = Number(process.env.CLUSTER_NODE_HEARTBEAT_MS ?? 10000);

  const upsert = async () => {
    try {
      await db.query((sql) => sql`
        INSERT INTO gateway_nodes (node_id, ws_url, last_seen_at)
        VALUES (${nodeId}, ${wsUrl}, NOW())
        ON CONFLICT (node_id) DO UPDATE SET
          ws_url = EXCLUDED.ws_url,
          last_seen_at = NOW()
      `);
    } catch (error) {
      log.warn("Failed to update cluster node registry", {
        nodeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  await upsert();

  return setInterval(() => {
    void upsert();
  }, Number.isFinite(heartbeatMs) && heartbeatMs > 1000 ? heartbeatMs : 10000);
}

async function resolveClusterNodeUrl(
  db: Database,
  nodeId: string
): Promise<string | null> {
  const rows = await db.query<{ ws_url: string }>((sql) => sql`
    SELECT ws_url
    FROM gateway_nodes
    WHERE node_id = ${nodeId}
    LIMIT 1
  `);
  return rows[0]?.ws_url ?? null;
}

async function resolveAgentNode(
  db: Database,
  agentId: string
): Promise<{ id: string; nodeId?: string }> {
  const rows = await db.query<{ id: string; node_id?: string }>((sql) => sql`
    SELECT id, node_id
    FROM agents
    WHERE id = ${agentId}
       OR metadata->>'manifestId' = ${agentId}
    ORDER BY created_at DESC
    LIMIT 1
  `);
  const row = rows[0];
  return row ? { id: row.id, nodeId: row.node_id } : { id: agentId };
}

async function forwardClusterMessage(
  wsUrl: string,
  message: WsMessage,
  log: ReturnType<typeof createLogger>
): Promise<WsMessage> {
  const authToken = process.env.GATEWAY_AUTH_TOKEN;
  const authId = authToken ? `auth-${message.id ?? randomUUID()}` : undefined;
  const timeoutMs = Number(process.env.CLUSTER_FORWARD_TIMEOUT_MS ?? 15000);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Cluster forward timed out"));
    }, timeoutMs);

    const sendMessage = (payload: WsMessage) => {
      try {
        ws.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timeout);
        ws.close();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };

    ws.on("open", () => {
      if (authToken && authId) {
        sendMessage({ type: "auth", id: authId, payload: { token: authToken } });
      } else {
        sendMessage(message);
      }
    });

    ws.on("message", (data) => {
      try {
        const parsed = JSON.parse(data.toString()) as WsMessage;
        if (authId && parsed.id === authId) {
          if (parsed.type === "auth_success") {
            sendMessage(message);
            return;
          }
          clearTimeout(timeout);
          ws.close();
          reject(new Error("Cluster auth failed"));
          return;
        }

        if (message.id && parsed.id !== message.id) return;
        clearTimeout(timeout);
        ws.close();
        resolve(parsed);
      } catch (error) {
        clearTimeout(timeout);
        ws.close();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    ws.on("error", (error) => {
      clearTimeout(timeout);
      ws.close();
      log.warn("Cluster forward error", { wsUrl, error: error.message });
      reject(error);
    });
  });
}

async function listAgentsFromDatabase(
  db: Database
): Promise<Array<Record<string, unknown>>> {
  const rows = await db.query<{
    id: string;
    name: string;
    state: string;
    created_at: Date;
    node_id?: string;
    metadata?: Record<string, unknown>;
    total_input_tokens?: number | string;
    total_output_tokens?: number | string;
  }>((sql) => sql`
    SELECT id, name, state, created_at, node_id, metadata,
           total_input_tokens, total_output_tokens
    FROM agents
    WHERE deleted_at IS NULL
    ORDER BY created_at DESC
  `);

  return rows.map((row) => {
    const metadata = normalizeRecord(row.metadata);
    const limits = normalizeRecord(metadata.limits);
    return {
      id: row.id,
      externalId: metadata.manifestId ?? row.id,
      name: row.name,
      state: row.state,
      uptime: Math.floor((Date.now() - new Date(row.created_at).getTime()) / 1000),
      model: metadata.model,
      capabilities: Array.isArray(metadata.capabilities) ? metadata.capabilities : [],
      permissions: Array.isArray(metadata.permissions) ? metadata.permissions : [],
      permissionGrants: Array.isArray(metadata.permissionGrants) ? metadata.permissionGrants : [],
      trustLevel: metadata.trustLevel ?? "monitored-autonomous",
      limits,
      tokenUsage: {
        input: toNumber(row.total_input_tokens, 0),
        output: toNumber(row.total_output_tokens, 0),
      },
      nodeId: row.node_id,
    };
  });
}

function createJobLockProvider(
  db: Database,
  log: ReturnType<typeof createLogger>
): JobLockProvider {
  return async (jobId: string) => {
    const [key1, key2] = deriveAdvisoryKeys(`job:${jobId}`);
    const connection = await db.sql.reserve();
    try {
      const rows = await connection<{ acquired: boolean }[]>`
        SELECT pg_try_advisory_lock(${key1}, ${key2}) AS acquired
      `;
      const acquired = rows[0]?.acquired ?? false;
      if (!acquired) {
        connection.release();
        return null;
      }
    } catch (error) {
      connection.release();
      log.warn("Failed to acquire job lock", {
        jobId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }

    return async () => {
      try {
        await connection`
          SELECT pg_advisory_unlock(${key1}, ${key2})
        `;
      } finally {
        connection.release();
      }
    };
  };
}

async function createClusterCoordinator(
  db: Database,
  log: ReturnType<typeof createLogger>
): Promise<ClusterCoordinator | null> {
  const enabled = parseBoolean(process.env.CLUSTER_MODE, false);
  if (!enabled) return null;

  const nodeId = process.env.CLUSTER_NODE_ID?.trim() || `node-${randomUUID().slice(0, 8)}`;
  const lockKey = process.env.CLUSTER_LEADER_LOCK_KEY?.trim() || "agentos:leader";
  const intervalMs = Number(process.env.CLUSTER_LEADER_CHECK_INTERVAL_MS ?? 5000);
  const [key1, key2] = deriveAdvisoryKeys(lockKey);

  const sqlPool = db.sql as unknown as { reserve?: () => Promise<any> };
  if (typeof sqlPool.reserve !== "function") {
    log.error("Cluster mode requires a reservable database connection");
    return null;
  }

  let reserved: any | null = null;
  let leader = false;
  const listeners = new Set<(isLeader: boolean) => void>();

  const notify = () => {
    for (const listener of listeners) {
      listener(leader);
    }
  };

  const ensureReserved = async () => {
    if (!reserved) {
      reserved = await sqlPool.reserve();
    }
  };

  const releaseReserved = async () => {
    if (!reserved) return;
    try {
      await reserved`SELECT pg_advisory_unlock(${key1}, ${key2})`;
    } catch {
      // ignore
    }
    try {
      if (typeof reserved.release === "function") {
        await reserved.release();
      }
    } catch {
      // ignore
    }
    reserved = null;
  };

  const attemptAcquire = async () => {
    await ensureReserved();
    const rows = await reserved`SELECT pg_try_advisory_lock(${key1}, ${key2}) AS locked`;
    const locked = Boolean(rows?.[0]?.locked);
    if (locked !== leader) {
      leader = locked;
      notify();
    }
  };

  const checkLeader = async () => {
    try {
      if (!reserved) {
        await attemptAcquire();
        return;
      }

      if (leader) {
        await reserved`SELECT 1`;
      } else {
        await attemptAcquire();
      }
    } catch (error) {
      if (leader) {
        leader = false;
        notify();
      }
      await releaseReserved();
      try {
        await attemptAcquire();
      } catch {
        // retry on next interval
      }
    }
  };

  await attemptAcquire();
  log.info("Cluster coordinator initialized", { nodeId, isLeader: leader });

  const timer = setInterval(() => {
    void checkLeader();
  }, Math.max(1000, Number.isFinite(intervalMs) ? intervalMs : 5000));

  return {
    nodeId,
    isLeader: () => leader,
    onChange: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    stop: async () => {
      clearInterval(timer);
      await releaseReserved();
    },
  };
}

function sendClientMessage(
  client: ClientConnection,
  message: WsMessage,
  log: ReturnType<typeof createLogger>
): void {
  const ws = client.ws as { send?: (data: string) => void; readyState?: number } | undefined;
  if (!ws || typeof ws.send !== "function") {
    log.warn("Unable to send message to client", { clientId: client.id, type: message.type });
    return;
  }
  if (typeof ws.readyState === "number" && ws.readyState !== 1) {
    log.warn("Client connection not open", { clientId: client.id, state: ws.readyState });
    return;
  }
  try {
    ws.send(JSON.stringify(message));
  } catch (error) {
    log.warn("Failed to send message to client", {
      clientId: client.id,
      type: message.type,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function streamChatToClient(
  client: ClientConnection,
  messageId: string | undefined,
  payload: z.infer<typeof ChatPayloadSchema>,
  router: ModelRouter,
  log: ReturnType<typeof createLogger>
): Promise<Result<void, GatewayError>> {
  const result = await router.route({
    model: payload.model ?? "claude-3-haiku-20240307",
    messages: payload.messages,
    maxTokens: payload.maxTokens ?? 1024,
    temperature: payload.temperature,
    stream: true,
  });

  if (!result.ok) {
    return err(new GatewayError(result.error.message, "PROVIDER_ERROR", client.id));
  }

  const chunkSize = resolveStreamChunkSize();
  let index = 0;
  for await (const chunk of responseToStream(result.value.content, result.value.model, chunkSize)) {
    sendClientMessage(client, {
      type: "chat_stream",
      id: messageId,
      payload: {
        delta: chunk.content,
        index,
      },
    }, log);
    index += 1;
  }

  sendClientMessage(client, {
    type: "chat_stream_end",
    id: messageId,
    payload: {
      content: result.value.content,
      model: result.value.model,
      usage: result.value.usage,
      finishReason: result.value.finishReason,
    },
  }, log);

  return ok(undefined);
}

function resolveWorkerGatewayHost(runtime: WorkerRuntime): string {
  const override = process.env.AGENT_WORKER_GATEWAY_HOST?.trim();
  if (override) return override;
  if (runtime === "docker") {
    return "host.docker.internal";
  }
  return process.env.GATEWAY_HOST ?? "127.0.0.1";
}

function resolveWorkerGatewayUrl(runtime: WorkerRuntime, host: string, port: string): string {
  const override = process.env.AGENT_WORKER_GATEWAY_URL?.trim();
  if (override) return override;
  if (runtime === "docker") {
    return `ws://${host}:${port}`;
  }
  return process.env.GATEWAY_URL ?? `ws://${host}:${port}`;
}

function createIpcTransport(child: ChildProcess): WorkerTransport {
  const messageHandlers = new Set<(message: unknown) => void>();
  const exitHandlers = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>();

  child.on("message", (message: unknown) => {
    for (const handler of messageHandlers) {
      handler(message);
    }
  });

  child.on("exit", (code, signal) => {
    for (const handler of exitHandlers) {
      handler(code, signal);
    }
  });

  return {
    send: (message: unknown) => child.send?.(message),
    onMessage: (handler) => {
      messageHandlers.add(handler);
    },
    onExit: (handler) => {
      exitHandlers.add(handler);
    },
    kill: (signal?: NodeJS.Signals) => {
      child.kill(signal);
    },
  };
}

function createStdioTransport(child: ChildProcess, log: ReturnType<typeof createLogger>): WorkerTransport {
  const messageHandlers = new Set<(message: unknown) => void>();
  const exitHandlers = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>();
  let buffer = "";

  if (child.stdout) {
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let idx = buffer.indexOf("\n");
      while (idx >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line.length > 0) {
          try {
            const parsed = JSON.parse(line);
            for (const handler of messageHandlers) {
              handler(parsed);
            }
          } catch (error) {
            log.debug("Worker stdout parse error", { line, error: String(error) });
          }
        }
        idx = buffer.indexOf("\n");
      }
    });
  }

  if (child.stderr) {
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      const text = chunk.trim();
      if (text.length > 0) {
        log.warn("Worker stderr", { text });
      }
    });
  }

  child.on("exit", (code, signal) => {
    for (const handler of exitHandlers) {
      handler(code, signal);
    }
  });

  return {
    send: (message: unknown) => {
      if (child.stdin && child.stdin.writable) {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      }
    },
    onMessage: (handler) => {
      messageHandlers.add(handler);
    },
    onExit: (handler) => {
      exitHandlers.add(handler);
    },
    kill: (signal?: NodeJS.Signals) => {
      child.kill(signal);
    },
  };
}

function resolveWorkerHeartbeatTimeoutMs(): number {
  const raw = process.env.AGENT_WORKER_HEARTBEAT_TIMEOUT_MS;
  if (!raw) return 30000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30000;
}

function attachWorkerHandlers(
  agent: AgentEntry,
  transport: WorkerTransport,
  log: ReturnType<typeof createLogger>,
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void
): void {
  transport.onMessage((message: unknown) => {
    if (!message || typeof message !== "object") return;
    const payload = message as {
      type?: string;
      taskId?: string;
      status?: "ok" | "error";
      result?: unknown;
      error?: string;
      level?: string;
      text?: string;
      timestamp?: number;
    };

    switch (payload.type) {
      case "ready":
        agent.workerReady = true;
        agent.lastHeartbeatAt = Date.now();
        log.info("Agent worker ready", { agentId: agent.id });
        break;
      case "heartbeat":
        agent.lastHeartbeatAt = Date.now();
        break;
      case "log":
        if (payload.level === "error") {
          log.error(payload.text ?? "Agent worker error", { agentId: agent.id });
        } else if (payload.level === "warn") {
          log.warn(payload.text ?? "Agent worker warning", { agentId: agent.id });
        } else {
          log.info(payload.text ?? "Agent worker log", { agentId: agent.id });
        }
        break;
      case "result": {
        const taskId = payload.taskId;
        if (!taskId) return;
        const pending = agent.workerTasks.get(taskId);
        if (!pending) return;
        clearTimeout(pending.timeoutId);
        agent.workerTasks.delete(taskId);
        if (payload.status === "ok") {
          pending.resolve(payload.result);
        } else {
          pending.reject(new Error(payload.error ?? "Worker task failed"));
        }
        break;
      }
      default:
        break;
    }
  });

  transport.onExit((code, signal) => onExit(code, signal));
}

function startAgentWorker(
  agent: AgentEntry,
  entryPoint: string,
  log: ReturnType<typeof createLogger>,
  defaultMemoryLimitMb: number
): void {
  const runtime = resolveWorkerRuntime();
  const maxMemoryMb = agent.limits.maxMemoryMB ?? defaultMemoryLimitMb;
  const gatewayHost = resolveWorkerGatewayHost(runtime);
  const gatewayPort = process.env.GATEWAY_PORT ?? "18800";
  const gatewayUrl = resolveWorkerGatewayUrl(runtime, gatewayHost, gatewayPort);

  const workerEnv = {
    AGENT_ID: agent.id,
    NODE_ENV: process.env.NODE_ENV ?? "production",
    LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
    GATEWAY_HOST: gatewayHost,
    GATEWAY_PORT: gatewayPort,
    GATEWAY_URL: gatewayUrl,
    GATEWAY_AUTH_TOKEN: process.env.GATEWAY_AUTH_TOKEN,
    INTERNAL_AUTH_TOKEN: process.env.INTERNAL_AUTH_TOKEN,
  } as Record<string, string | undefined>;

  let child: ChildProcess;
  let transport: WorkerTransport;

  if (runtime === "docker") {
    const image = resolveDockerWorkerImage();
    const network = resolveDockerWorkerNetwork();
    const disableNetwork = parseBoolean(process.env.AGENT_WORKER_DISABLE_NETWORK, false);
    const mountPath = resolveDockerWorkerMount();
    const workDir = mountPath ? "/agent-os" : (process.env.AGENT_WORKER_DOCKER_WORKDIR?.trim() || "/app");
    const scriptPath = process.env.AGENT_WORKER_SCRIPT_PATH?.trim() || "apps/gateway/dist/agent-worker.js";
    const tmpfsEntries = resolveDockerTmpfs();
    const securityOpts = resolveDockerSecurityOpts();
    const capDrop = resolveDockerCapDrop();
    const ulimits = resolveDockerUlimits();
    const storageOpts = applyDiskQuota(resolveDockerStorageOpts(), agent.limits.diskQuotaMB);
    const blkioWeight = resolveDockerBlkioWeight();
    const cpuLimit = agent.limits.cpuCores !== undefined
      ? String(agent.limits.cpuCores)
      : process.env.AGENT_WORKER_DOCKER_CPUS?.trim();
    const readOnly = parseBoolean(process.env.AGENT_WORKER_DOCKER_READONLY, false);

    const args: string[] = ["run", "--rm", "-i", "--name", `agentos-worker-${agent.id}`];
    if (disableNetwork) {
      args.push("--network", "none");
    } else if (network) {
      args.push("--network", network);
    }
    if (mountPath) {
      args.push("-v", `${mountPath}:${workDir}:ro`);
    }
    if (maxMemoryMb && Number.isFinite(maxMemoryMb)) {
      args.push("--memory", `${maxMemoryMb}m`);
    }
    if (cpuLimit) {
      args.push("--cpus", cpuLimit);
    }
    const pidsLimit = process.env.AGENT_WORKER_DOCKER_PIDS_LIMIT?.trim();
    if (pidsLimit) {
      args.push("--pids-limit", pidsLimit);
    }
    if (readOnly) {
      args.push("--read-only");
    }
    const effectiveTmpfs = tmpfsEntries.length > 0
      ? tmpfsEntries
      : readOnly
        ? ["/tmp:rw,size=64m", "/var/tmp:rw,size=64m"]
        : [];
    for (const entry of effectiveTmpfs) {
      args.push("--tmpfs", entry);
    }
    for (const cap of capDrop) {
      args.push("--cap-drop", cap);
    }
    for (const limit of ulimits) {
      args.push("--ulimit", limit);
    }
    if (blkioWeight) {
      args.push("--blkio-weight", blkioWeight);
    }
    for (const opt of storageOpts) {
      args.push("--storage-opt", opt);
    }
    for (const opt of securityOpts) {
      args.push("--security-opt", opt);
    }
    args.push("-w", workDir);

    for (const [key, value] of Object.entries(workerEnv)) {
      if (value !== undefined && value !== "") {
        args.push("-e", `${key}=${value}`);
      }
    }

    const nodeArgs: string[] = ["node"];
    if (maxMemoryMb && Number.isFinite(maxMemoryMb)) {
      nodeArgs.push(`--max-old-space-size=${maxMemoryMb}`);
    }
    nodeArgs.push(scriptPath);

    args.push(image, ...nodeArgs);

    child = spawn("docker", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    transport = createStdioTransport(child, log);
  } else {
    const scriptPath = resolveWorkerScriptPath();
    if (!scriptPath) {
      log.warn("Agent worker script not found; running without process isolation", { agentId: agent.id });
      return;
    }

    const filteredExecArgs = process.execArgv.filter(
      (arg) => !arg.startsWith("--max-old-space-size")
    );
    const execArgv = maxMemoryMb && Number.isFinite(maxMemoryMb)
      ? [...filteredExecArgs, `--max-old-space-size=${maxMemoryMb}`]
      : filteredExecArgs;

    child = fork(scriptPath, [], {
      env: {
        ...process.env,
        ...workerEnv,
        AGENT_MAX_MEMORY_MB: maxMemoryMb ? String(maxMemoryMb) : undefined,
      },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      execArgv,
    });
    transport = createIpcTransport(child);
  }

  agent.worker = child;
  agent.workerTransport = transport;
  agent.workerReady = false;
  agent.shutdownRequested = false;

  attachWorkerHandlers(agent, transport, log, (code, signal) => {
    const message = signal ? `signal ${signal}` : `code ${code}`;
    log.warn("Agent worker exited", { agentId: agent.id, message });

    for (const pending of agent.workerTasks.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error("Worker exited"));
    }
    agent.workerTasks.clear();

    agent.worker = undefined;
    agent.workerTransport = undefined;
    agent.workerReady = false;

    if (agent.shutdownRequested || agent.state === "terminated") {
      return;
    }

    agent.restartAttempts += 1;
    const maxRestarts = resolveMaxAgentRestarts();
    if (agent.restartAttempts > maxRestarts) {
      agent.state = "error";
      log.error("Agent worker restart limit exceeded", {
        agentId: agent.id,
        restartAttempts: agent.restartAttempts,
      });
      return;
    }

    agent.restartBackoffMs = Math.min(30000, 1000 * 2 ** (agent.restartAttempts - 1));
    setTimeout(() => {
      if (agent.state === "terminated") return;
      startAgentWorker(agent, entryPoint, log, defaultMemoryLimitMb);
    }, agent.restartBackoffMs);
  });

  transport.send({
    type: "init",
    agentId: agent.id,
    entryPoint,
    name: agent.name,
  });
}

async function sendTaskToWorker(
  agent: AgentEntry,
  task: Record<string, unknown>,
  timeoutMs: number,
  log: ReturnType<typeof createLogger>
): Promise<unknown> {
  if (!agent.worker || !agent.workerTransport || !agent.workerReady) {
    throw new Error("Agent worker not ready");
  }

  const taskId = randomUUID();
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      agent.workerTasks.delete(taskId);
      reject(new Error("Agent task timed out"));
      log.warn("Agent worker task timeout", { agentId: agent.id, taskId });
    }, timeoutMs);

    agent.workerTasks.set(taskId, { resolve, reject, timeoutId });
    if (!agent.workerTransport) {
      agent.workerTasks.delete(taskId);
      clearTimeout(timeoutId);
      reject(new Error("Agent worker not available"));
      return;
    }
    agent.workerTransport.send({ type: "task", taskId, task });
  });
}

function unscheduleMonitorAgent(
  agentId: string,
  jobRunner: JobRunner
): void {
  jobRunner.unregister(`monitor:${agentId}`);
}

function scheduleMonitorAgent(
  agent: AgentEntry,
  intervalMs: number,
  jobRunner: JobRunner,
  ctx: Parameters<typeof handleAgentTask>[2]
): void {
  if (!intervalMs || intervalMs <= 0) return;

  jobRunner.register(
    {
      id: `monitor:${agent.id}`,
      name: `Monitor ${agent.name}`,
      intervalMs,
      runImmediately: false,
      maxConsecutiveFailures: 5,
    },
    async () => {
      if (agent.state !== "ready" || !agent.workerReady) return;
      const previousState = agent.state;
      agent.state = "running";

      if (ctx.db) {
        await updateAgentState(ctx.db, agent.id, "running", ctx.log, { fromState: previousState });
      }

      try {
        await handleAgentTask(
          { type: "monitor_check" },
          agent,
          ctx
        );
        agent.state = "ready";
        if (ctx.db) {
          await updateAgentState(ctx.db, agent.id, "ready", ctx.log, { fromState: "running" });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.log.warn("Scheduled monitor check failed", { agentId: agent.id, error: message });
        agent.state = previousState;
        if (ctx.db) {
          await updateAgentState(ctx.db, agent.id, agent.state, ctx.log, {
            fromState: "running",
            reason: message,
          });
        }
        throw error;
      }
    }
  );
}

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger({ name: "gateway" });
  const proxyUrl = resolveEgressProxyUrl();
  if (proxyUrl) {
    try {
      setGlobalDispatcher(new ProxyAgent(proxyUrl));
      log.info("Global egress proxy enabled", { proxyUrl });
    } catch (error) {
      log.warn("Failed to configure global egress proxy", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const exporterUrl = process.env.TRACING_EXPORTER_URL?.trim() || undefined;
  const tracer = getTracer({
    enabled: parseBoolean(process.env.TRACING_ENABLED, false),
    exporterUrl,
    serviceName: "agent-os-gateway",
    sampleRate: Number(process.env.TRACING_SAMPLE_RATE ?? 1),
  });
  if (exporterUrl) {
    tracer.startExport();
  }

  log.info("Agent OS Gateway starting...", {
    port: config.gateway.port,
    host: config.gateway.host,
  });

  // ─── Layer 1: Initialize Persistence (Postgres + Qdrant) ───
  const { db, vectorStore, memory } = await initializeMemorySubsystem(config, log);

  // ─── Tool Registry (built-ins + MCP) ───
  const toolRegistry = createToolRegistry();
  registerBuiltinTools(toolRegistry);
  log.info("Tool registry initialized", { tools: toolRegistry.list().length });

  const mcpManager = createMCPClientManager();
  const mcpServersRaw = process.env.MCP_SERVERS;
  const mcpServers = parseMcpServers(mcpServersRaw);
  if (mcpServersRaw && mcpServers.length === 0) {
    log.warn("MCP_SERVERS provided but could not be parsed or is empty");
  }
  for (const server of mcpServers) {
    const registerResult = mcpManager.registerServer(server);
    if (!registerResult.ok) {
      log.warn("Failed to register MCP server", { server: server.name, error: registerResult.error.message });
      continue;
    }
    const connectResult = await mcpManager.connect(server.name);
    if (!connectResult.ok) {
      log.warn("Failed to connect MCP server", { server: server.name, error: connectResult.error.message });
      continue;
    }
  }

  const mcpTools = mcpManager.getAllTools();
  for (const tool of mcpTools) {
    const toolId = `mcp:${tool.serverName}:${tool.id}`;
    const definition: ToolDefinition = {
      ...tool,
      id: toolId,
      category: tool.category ?? "mcp",
      tags: Array.from(new Set([...(tool.tags ?? []), "mcp", tool.serverName])),
    };
    toolRegistry.register(
      definition,
      async (args) => {
        const result = await mcpManager.invokeTool(tool.serverName, tool.id, args);
        if (!result.ok) {
          return { success: false, error: result.error.message };
        }
        return result.value;
      },
      { overwrite: true }
    );
  }

  if (mcpTools.length > 0) {
    log.info("MCP tools registered", { count: mcpTools.length });
  }

  // ─── Layer 2: Initialize Model Abstraction Layer ───
  const router = createModelRouter();

  const useMockProviders =
    process.env.NODE_ENV === "test" &&
    parseBoolean(process.env.MAL_USE_MOCK_PROVIDERS, true);

  if (useMockProviders) {
    const mockProviders = [
      { name: "Mock Anthropic Claude", provider: createMockProvider("anthropic") },
      { name: "Mock OpenAI GPT", provider: createMockProvider("openai") },
      { name: "Mock Google Gemini", provider: createMockProvider("google") },
      { name: "Mock Ollama", provider: createMockProvider("ollama") },
    ];
    for (const { name, provider } of mockProviders) {
      router.registerProvider(provider);
      log.info(`${name} provider registered`);
    }
  } else {
    // Register available providers
    const providers = [
      { name: "Anthropic Claude", provider: createAnthropicProvider() },
      { name: "OpenAI GPT", provider: createOpenAIProvider() },
      { name: "Google Gemini", provider: createGoogleProvider() },
      { name: "Ollama (Local)", provider: createOllamaProvider() },
    ];

    for (const { name, provider } of providers) {
      if (await provider.isAvailable()) {
        router.registerProvider(provider);
        log.info(`${name} provider registered`);
      }
    }
  }

  const models = router.listModels();
  if (models.length === 0) {
    log.error("No LLM providers available! Add at least one API key to .env");
    process.exit(1);
  }

  log.info(`Available models: ${models.join(", ")}`);

  // ─── Layer 4: Initialize Event Bus ───
  const eventBus = createEventBus();
  eventBus.setMaxHistorySize(1000);
  log.info("Event bus initialized");

  // ─── Agent Tracking ───
  const agents = new Map<string, AgentEntry>();
  const distributedScheduler = parseBoolean(
    process.env.DISTRIBUTED_SCHEDULER,
    parseBoolean(process.env.CLUSTER_MODE, false)
  );
  const jobLockProvider = db && distributedScheduler ? createJobLockProvider(db, log) : undefined;
  const jobRunner = new JobRunner({ logExecutions: false, lockProvider: jobLockProvider });
  const a2aTasks = new Map<string, A2ATaskEntry>();
  const allowedPaths = parseAllowedPaths(process.env.ALLOWED_PATHS);
  const allowedDomains = parseAllowedDomains(process.env.ALLOWED_DOMAINS);
  const allowedCommands = parseAllowedCommands(process.env.ALLOWED_COMMANDS);
  const isProduction = process.env.NODE_ENV === "production";
  const allowAllPaths = parseBoolean(process.env.ALLOW_ALL_PATHS, !isProduction);
  const allowAllDomains = parseBoolean(process.env.ALLOW_ALL_DOMAINS, !isProduction);
  const allowAllCommands = parseBoolean(process.env.ALLOW_ALL_COMMANDS, false);
  const requireVectorStore = parseBoolean(process.env.REQUIRE_VECTOR_STORE, isProduction);
  const monitorIntervalMs = Number(process.env.MONITOR_AGENT_INTERVAL_MS ?? 60000);
  let clusterCoordinator: ClusterCoordinator | null = null;
  let clusterNodeId: string | null = null;
  let clusterHeartbeat: NodeJS.Timeout | null = null;
  if (parseBoolean(process.env.CLUSTER_MODE, false)) {
    if (!db) {
      log.error("CLUSTER_MODE requires persistent storage");
      process.exit(1);
    }
    clusterCoordinator = await createClusterCoordinator(db, log);
    if (!clusterCoordinator) {
      log.error("Failed to initialize cluster coordinator");
      process.exit(1);
    }
    clusterNodeId = clusterCoordinator.nodeId;
    const wsUrl = resolveClusterNodeWsUrl(config);
    if (wsUrl) {
      clusterHeartbeat = await registerClusterNode(db, clusterCoordinator.nodeId, wsUrl, log);
    } else {
      log.warn("CLUSTER_MODE enabled but CLUSTER_NODE_WS_URL/CLUSTER_NODE_HOST not set; routing disabled");
    }
  }
  if (!clusterCoordinator || distributedScheduler || clusterCoordinator.isLeader()) {
    jobRunner.start();
  } else {
    log.info("Cluster follower: scheduler paused", { nodeId: clusterCoordinator.nodeId });
  }
  if (clusterCoordinator && !distributedScheduler) {
    clusterCoordinator.onChange((isLeader) => {
      if (isLeader) {
        log.info("Cluster leadership acquired; starting scheduler", { nodeId: clusterCoordinator?.nodeId });
        jobRunner.start();
      } else {
        log.warn("Cluster leadership lost; stopping scheduler", { nodeId: clusterCoordinator?.nodeId });
        void jobRunner.stop();
      }
    });
  } else if (clusterCoordinator && distributedScheduler) {
    log.info("Distributed scheduler enabled; job locks handle coordination", {
      nodeId: clusterCoordinator.nodeId,
    });
  }
  const permissionSecret = process.env.PERMISSION_SECRET ?? process.env.CAPABILITY_SECRET;
  const permissionManager = createCapabilityManager({
    secret: permissionSecret && permissionSecret.length >= 16 ? permissionSecret : undefined,
  });
  if (!permissionSecret || permissionSecret.length < 16) {
    const message = "PERMISSION_SECRET not set or too short; using default capability secret";
    if (isProduction) {
      log.error(message);
      process.exit(1);
    }
    log.warn(message);
  }
  if (isProduction && !config.gateway.authToken) {
    log.error("GATEWAY_AUTH_TOKEN is required in production");
    process.exit(1);
  }
  if (isProduction && !process.env.INTERNAL_AUTH_TOKEN) {
    log.error("INTERNAL_AUTH_TOKEN is required in production");
    process.exit(1);
  }
  if (isProduction && !allowAllPaths && allowedPaths.length === 0) {
    log.error("ALLOWED_PATHS must be set in production (or set ALLOW_ALL_PATHS=true)");
    process.exit(1);
  }
  if (isProduction && !allowAllDomains && allowedDomains.length === 0) {
    log.error("ALLOWED_DOMAINS must be set in production (or set ALLOW_ALL_DOMAINS=true)");
    process.exit(1);
  }
  if (isProduction && !allowAllCommands && allowedCommands.length === 0) {
    log.warn("ALLOWED_COMMANDS not set; shell tools will be blocked");
  }
  validateProductionHardening(log, isProduction);
  const memoryLimitEnv = process.env.MAX_MEMORY_PER_AGENT_MB;
  const memoryLimitMb = memoryLimitEnv && memoryLimitEnv.trim() !== ""
    ? Number(memoryLimitEnv)
    : Math.floor(config.runtime.defaultMemoryLimit / (1024 * 1024));
  const heartbeatTimeoutMs = resolveWorkerHeartbeatTimeoutMs();
  const auditRetentionDays = resolveRetentionDays(process.env.AUDIT_LOG_RETENTION_DAYS, 365);
  const eventsRetentionDays = resolveRetentionDays(process.env.EVENTS_RETENTION_DAYS, 90);
  const taskRetentionDays = resolveRetentionDays(process.env.TASK_MESSAGES_RETENTION_DAYS, 90);
  const episodicRetentionDays = resolveRetentionDays(process.env.EPISODIC_RETENTION_DAYS, 365);
  const semanticRetentionDays = resolveRetentionDays(process.env.SEMANTIC_RETENTION_DAYS, 365);
  const proceduralRetentionDays = resolveRetentionDays(process.env.PROCEDURAL_RETENTION_DAYS, 365);
  const episodicArchiveDays = resolveRetentionDays(process.env.EPISODIC_ARCHIVE_DAYS, 0);
  const semanticArchiveDays = resolveRetentionDays(process.env.SEMANTIC_ARCHIVE_DAYS, 0);
  const proceduralArchiveDays = resolveRetentionDays(process.env.PROCEDURAL_ARCHIVE_DAYS, 0);
  const archiveRetentionDays = resolveRetentionDays(process.env.MEMORY_ARCHIVE_RETENTION_DAYS, 0);
  const episodicTierDays = resolveRetentionDays(process.env.EPISODIC_TIER_DAYS, 0);
  const semanticTierDays = resolveRetentionDays(process.env.SEMANTIC_TIER_DAYS, 0);
  const proceduralTierDays = resolveRetentionDays(process.env.PROCEDURAL_TIER_DAYS, 0);
  const tierImportanceMax = resolveOptionalNumber(process.env.MEMORY_TIER_IMPORTANCE_MAX);
  const memoryEncryptionEnabled = parseBoolean(process.env.MEMORY_ENCRYPTION_ENABLED, false);
  const archiveCompact = parseBoolean(process.env.MEMORY_ARCHIVE_COMPACT, false) && !memoryEncryptionEnabled;
  const archiveTextLimit = Math.max(
    256,
    Math.floor(resolveOptionalNumber(process.env.MEMORY_ARCHIVE_TEXT_LIMIT) ?? 4096)
  );
  const retentionInterval = db
    ? scheduleRetentionCleanup(db, vectorStore, log, {
        auditDays: auditRetentionDays,
        eventsDays: eventsRetentionDays,
        taskDays: taskRetentionDays,
        episodicDays: episodicRetentionDays,
        semanticDays: semanticRetentionDays,
        proceduralDays: proceduralRetentionDays,
        episodicArchiveDays,
        semanticArchiveDays,
        proceduralArchiveDays,
        archiveRetentionDays,
        episodicTierDays,
        semanticTierDays,
        proceduralTierDays,
        tierImportanceMax,
        archiveCompact,
        archiveTextLimit,
      })
    : undefined;

  // ─── Message Handler ───
  const handleMessage: MessageHandler = async (client, message) => {
    return tracer.trace(`ws.${message.type}`, async (span) => {
      span.setAttributes({
        "client.id": client.id,
        "message.id": message.id ?? "",
        "message.type": message.type,
      });
      return handleClientMessage(client, message, {
        router,
        eventBus,
        agents,
        jobRunner,
        monitorIntervalMs,
        log,
        memory,
        db,
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
      });
    });
  };

  const heartbeatInterval = setInterval(() => {
    const now = Date.now();
    for (const agent of agents.values()) {
      if (!agent.worker || agent.shutdownRequested || agent.state === "terminated") continue;
      if (!agent.lastHeartbeatAt) {
        agent.lastHeartbeatAt = now;
        continue;
      }
      if (now - agent.lastHeartbeatAt > heartbeatTimeoutMs) {
        log.warn("Agent worker heartbeat missed", {
          agentId: agent.id,
          lastHeartbeatAt: agent.lastHeartbeatAt,
        });
        agent.worker.kill("SIGTERM");
      }
    }
  }, Math.min(heartbeatTimeoutMs / 2, 15000));

  // ─── WebSocket Server ───
  const wsResult = createWebSocketServer(
    {
      port: config.gateway.port,
      host: config.gateway.host,
      authToken: config.gateway.authToken,
      maxConnections: config.gateway.maxConnections,
      messageRateLimit: config.gateway.messageRateLimit,
      maxPayloadSize: config.gateway.maxPayloadSize,
    },
    handleMessage
  );

  if (!wsResult.ok) {
    log.error("Failed to create WebSocket server", { error: wsResult.error.message });
    process.exit(1);
  }

  const wsServer = wsResult.value;

  // ─── Health Server (HTTP on port + 1) ───
  const healthPort = config.gateway.port + 1;
  const healthServer = createHealthServer(
    { port: healthPort, host: config.gateway.host },
    () => ({
      status: (() => {
        const providerStates = router.getState().providers;
        const healthyProviders = providerStates.filter((p) => p.healthy).length;
        if (healthyProviders === 0) return "error";
        if (!db) return "degraded";
        if (healthyProviders < providerStates.length) return "degraded";
        if (requireVectorStore && !vectorStore) return "degraded";
        return "ok";
      })(),
      version: "0.1.0",
      providers: models,
      agents: agents.size,
      connections: wsServer.getConnectionCount(),
    }),
    () => {
      const entries = Array.from(agents.values());
      const totals = entries.reduce(
        (acc, agent) => {
          acc.input += agent.tokenUsage.input;
          acc.output += agent.tokenUsage.output;
          acc.cost += agent.costUsageUSD;
          acc.states[agent.state] = (acc.states[agent.state] ?? 0) + 1;
          return acc;
        },
        {
          input: 0,
          output: 0,
          cost: 0,
          states: {} as Record<string, number>,
        }
      );

      const stateMetrics = Object.entries(totals.states).flatMap(([state, count]) => [
        `agent_os_agents_state_total{state=\"${state}\"} ${count}`,
      ]);

      return [
        ``,
        `# HELP agent_os_tokens_input_total Total input tokens processed`,
        `# TYPE agent_os_tokens_input_total counter`,
        `agent_os_tokens_input_total ${totals.input}`,
        ``,
        `# HELP agent_os_tokens_output_total Total output tokens processed`,
        `# TYPE agent_os_tokens_output_total counter`,
        `agent_os_tokens_output_total ${totals.output}`,
        ``,
        `# HELP agent_os_cost_usd_total Total estimated model spend (USD)`,
        `# TYPE agent_os_cost_usd_total counter`,
        `agent_os_cost_usd_total ${totals.cost.toFixed(6)}`,
        ``,
        `# HELP agent_os_agents_state_total Agents by state`,
        `# TYPE agent_os_agents_state_total gauge`,
        ...stateMetrics,
      ];
    }
  );

  // ─── Event Broadcasting ───
  eventBus.subscribe("*", (event) => {
    wsServer.broadcast({
      type: "event",
      payload: {
        channel: event.channel,
        type: event.type,
        data: event.data,
        timestamp: event.timestamp.getTime(),
      },
    });
  });

  // ─── Optional: Quick LLM test ───
  if (process.env.TEST_LLM === "true") {
    log.info("Testing LLM connectivity...");
    const result = await router.route({
      model: "claude-3-haiku-20240307",
      messages: [
        { role: "system", content: "You are an agent running on Agent OS. Respond in one sentence." },
        { role: "user", content: "Hello! What are you?" },
      ],
      maxTokens: 50,
    });

    if (result.ok) {
      log.info("LLM test passed", {
        content: result.value.content,
        tokens: result.value.usage,
      });
    } else {
      log.warn("LLM test failed (continuing anyway)", { error: result.error.message });
    }
  }

  log.info("Agent OS Gateway ready", {
    ws: `ws://${config.gateway.host}:${config.gateway.port}`,
    health: `http://${config.gateway.host}:${healthPort}/health`,
  });

  // ─── Graceful Shutdown ───
  const shutdown = async (): Promise<void> => {
    log.info("Gateway shutting down...");

    // Publish shutdown event
    eventBus.publish({
      id: createEventId(),
      channel: "system",
      type: "system.shutdown",
      timestamp: new Date(),
      data: { message: "signal" },
    });

    wsServer.close();
    healthServer.close();
    memory.stop();
    clearInterval(heartbeatInterval);
    if (retentionInterval) {
      clearInterval(retentionInterval);
    }
    if (clusterHeartbeat) {
      clearInterval(clusterHeartbeat);
    }
    if (clusterCoordinator) {
      await clusterCoordinator.stop();
    }
    tracer.stopExport();
    await jobRunner.stop();
    await db?.close();
    await vectorStore?.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

/** Handle incoming WebSocket messages */
async function handleClientMessage(
  client: ClientConnection,
  message: WsMessage,
  ctx: {
    router: ModelRouter;
    eventBus: EventBus;
    agents: Map<string, AgentEntry>;
    jobRunner: JobRunner;
    monitorIntervalMs: number;
    log: ReturnType<typeof createLogger>;
    memory: MemoryManager;
    db?: Database;
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
    clusterNodeId: string | null;
  }
): Promise<Result<WsMessage | null, GatewayError>> {
  const {
    router,
    eventBus,
    agents,
    jobRunner,
    monitorIntervalMs,
    log,
    memory,
    db,
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
  };

  switch (message.type) {
    case "chat": {
      const payloadResult = ChatPayloadSchema.safeParse(message.payload);
      if (!payloadResult.success) {
        return err(new GatewayError(
          `Invalid chat payload: ${payloadResult.error.message}`,
          "VALIDATION_ERROR",
          client.id
        ));
      }

      const payload = payloadResult.data;
      log.info("Chat request", { clientId: client.id, model: payload.model });

      if (payload.stream) {
        const streamResult = await streamChatToClient(
          client,
          message.id,
          payload,
          router,
          log
        );
        if (!streamResult.ok) {
          return err(streamResult.error);
        }
        return ok(null);
      }

      const result = await router.route({
        model: payload.model ?? "claude-3-haiku-20240307",
        messages: payload.messages,
        maxTokens: payload.maxTokens ?? 1024,
        temperature: payload.temperature,
      });

      if (result.ok) {
        return ok({
          type: "chat_response",
          id: message.id,
          payload: {
            content: result.value.content,
            model: result.value.model,
            usage: result.value.usage,
          },
        });
      }

      return err(new GatewayError(
        result.error.message,
        "PROVIDER_ERROR",
        client.id
      ));
    }

    case "agent_spawn": {
      const payloadResult = AgentSpawnPayloadSchema.safeParse(message.payload);
      if (!payloadResult.success) {
        return err(new GatewayError(
          `Invalid spawn payload: ${payloadResult.error.message}`,
          "VALIDATION_ERROR",
          client.id
        ));
      }

      const payload = payloadResult.data;
      const manifest = payload.manifest;

      if (!manifest) {
        return err(new GatewayError(
          "Agent manifest required",
          "VALIDATION_ERROR",
          client.id
        ));
      }

      const signingSecret = process.env.MANIFEST_SIGNING_SECRET;
      const requireSignature = parseBoolean(
        process.env.REQUIRE_MANIFEST_SIGNATURE,
        process.env.NODE_ENV === "production"
      );
      if (signingSecret && signingSecret.trim().length > 0) {
        const verification = verifyManifestSignature(manifest, signingSecret);
        if (!verification.ok) {
          return err(new GatewayError(
            verification.message ?? "Manifest signature verification failed",
            "AUTH_ERROR",
            client.id
          ));
        }
      } else if (requireSignature) {
        return err(new GatewayError(
          "Manifest signing secret not configured",
          "AUTH_ERROR",
          client.id
        ));
      }

      const agentId = isUuid(manifest.id) ? manifest.id : randomUUID();
      const existingAgent = findAgentById(agents, manifest.id);
      if (existingAgent) {
        return err(new GatewayError(
          `Agent already exists: ${existingAgent.id}`,
          "AGENT_ERROR",
          client.id,
          existingAgent.id
        ));
      }
      const permissionResult = collectPermissions(manifest);
      if (!permissionResult.ok) {
        return err(new GatewayError(
          `Invalid permissions: ${permissionResult.error.message}`,
          "VALIDATION_ERROR",
          client.id
        ));
      }
      const permissionGrants = permissionResult.value;
      const trustLevel: TrustLevel = manifest.trustLevel ?? "monitored-autonomous";
      let permissionTokenId: string | undefined;
      const mcpAllowlist = normalizeMcpAllowlist(manifest.mcpServers);

      const a2aSkills = manifest.a2aSkills ?? [];
      const a2aValidators = new Map<string, ValidateFunction>();
      for (const skill of a2aSkills) {
        if (!skill.inputSchema) continue;
        try {
          const validator = ajv.compile(skill.inputSchema);
          a2aValidators.set(skill.id, validator);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return err(new GatewayError(
            `Invalid A2A input schema for skill ${skill.id}: ${message}`,
            "VALIDATION_ERROR",
            client.id
          ));
        }
      }

      if (permissionGrants.length > 0) {
        const grantResult = permissionManager.grant(
          {
            agentId,
            permissions: permissionGrants,
            purpose: "manifest",
            durationMs: resolvePermissionDurationMs(),
            delegatable: false,
          },
          "system"
        );

        if (!grantResult.ok) {
          return err(new GatewayError(
            `Failed to grant permissions: ${grantResult.error.message}`,
            "AGENT_ERROR",
            client.id,
            agentId
          ));
        }

        permissionTokenId = grantResult.value.id;
      }

      const entry: AgentEntry = {
        id: agentId,
        externalId: manifest.id,
        name: manifest.name,
        nodeId: clusterNodeId ?? undefined,
        state: "ready",
        startedAt: Date.now(),
        model: manifest.preferredModel ?? manifest.model,
        entryPoint: manifest.entryPoint,
        capabilities: manifest.capabilities ?? [],
        permissions: manifest.permissions ?? [],
        mcpServers: mcpAllowlist.length > 0 ? mcpAllowlist : undefined,
        permissionGrants,
        trustLevel,
        permissionTokenId,
        limits: manifest.limits ?? {},
        usageWindow: {
          windowStart: Date.now(),
          requestsThisMinute: 0,
          toolCallsThisMinute: 0,
          tokensThisMinute: 0,
        },
        costUsageUSD: 0,
        a2aSkills,
        a2aValidators,
        errorCount: 0,
        workerReady: false,
        workerTasks: new Map(),
        restartAttempts: 0,
        restartBackoffMs: 0,
        shutdownRequested: false,
        tools: manifest.tools ?? [],
        tokenUsage: { input: 0, output: 0 },
      };

      agents.set(agentId, entry);
      log.info("Agent spawned", { agentId, name: manifest.name });

      if (manifest.entryPoint) {
        startAgentWorker(entry, manifest.entryPoint, log, memoryLimitMb);
      }
      if (manifest.id === "monitor" && manifest.entryPoint) {
        scheduleMonitorAgent(entry, monitorIntervalMs, jobRunner, taskContext);
      }

      if (db) {
        await upsertAgentRecord(db, agentId, manifest, entry.state, log, clusterNodeId);
        await recordAuditLog(
          db,
          {
            action: "agent.spawn",
            resourceType: "agent",
            resourceId: agentId,
            actorId: client.id,
            details: {
              name: manifest.name,
              model: manifest.preferredModel ?? manifest.model,
              trustLevel,
              permissions: manifest.permissions ?? [],
              hasEntryPoint: !!manifest.entryPoint,
            },
            outcome: "success",
          },
          log
        );
      }

      // Publish event
      await eventBus.publish({
        id: createEventId(),
        channel: "agent.lifecycle",
        type: "agent.created",
        timestamp: new Date(),
        agentId,
        data: {
          state: "ready",
          manifest: { name: manifest.name, model: manifest.preferredModel ?? manifest.model },
        },
      });

      return ok({
        type: "agent_spawn_result",
        id: message.id,
        payload: { agentId, externalId: manifest.id, status: "ready" },
      });
    }

    case "agent_terminate": {
      const payloadResult = AgentTerminatePayloadSchema.safeParse(message.payload);
      if (!payloadResult.success) {
        return err(new GatewayError(
          `Invalid terminate payload: ${payloadResult.error.message}`,
          "VALIDATION_ERROR",
          client.id
        ));
      }

      const { agentId } = payloadResult.data;
      const agent = findAgentById(agents, agentId);

      if (!agent) {
        if (clusterNodeId && db) {
          const { nodeId } = await resolveAgentNode(db, agentId);
          if (nodeId && nodeId !== clusterNodeId) {
            const wsUrl = await resolveClusterNodeUrl(db, nodeId);
            if (wsUrl) {
              try {
                const forwarded = await forwardClusterMessage(wsUrl, message, log);
                return ok(forwarded);
              } catch (error) {
                return err(new GatewayError(
                  `Cluster forward failed: ${error instanceof Error ? error.message : String(error)}`,
                  "CLUSTER_FORWARD_FAILED",
                  client.id,
                  agentId
                ));
              }
            }
          }
        }
        return err(new GatewayError(
          `Agent not found: ${agentId}`,
          "NOT_FOUND",
          client.id,
          agentId
        ));
      }

      if (agent.state === "terminated") {
        return err(new GatewayError(
          `Agent terminated: ${agentId}`,
          "AGENT_ERROR",
          client.id,
          agentId
        ));
      }
      if (agent.state === "error") {
        return err(new GatewayError(
          `Agent in error state: ${agentId}`,
          "AGENT_ERROR",
          client.id,
          agentId
        ));
      }
      if (agent.state === "paused") {
        return err(new GatewayError(
          `Agent is paused: ${agentId}`,
          "AGENT_ERROR",
          client.id,
          agentId
        ));
      }

      const previousState = agent.state;
      agent.state = "terminated";
      agent.shutdownRequested = true;
      if (agent.externalId === "monitor") {
        unscheduleMonitorAgent(agent.id, jobRunner);
      }
      if (agent.worker) {
        try {
          agent.worker.send({ type: "shutdown" });
          setTimeout(() => {
            if (agent.worker) {
              agent.worker.kill("SIGKILL");
            }
          }, 5000);
        } catch (error) {
          log.warn("Failed to shutdown agent worker", { agentId, error: String(error) });
        }
      }
      agents.delete(agent.id);
      permissionManager.revokeAll(agent.id);
      log.info("Agent terminated", { agentId });

      if (db) {
        await updateAgentState(db, agent.id, "terminated", log, { fromState: previousState });
        await recordAuditLog(
          db,
          {
            action: "agent.terminate",
            resourceType: "agent",
            resourceId: agent.id,
            actorId: client.id,
            details: {
              name: agent.name,
              previousState,
              trustLevel: agent.trustLevel,
              uptimeMs: Date.now() - agent.startedAt,
            },
            outcome: "success",
          },
          log
        );
      }

      // Publish event
      await eventBus.publish({
        id: createEventId(),
        channel: "agent.lifecycle",
        type: "agent.terminated",
        timestamp: new Date(),
        agentId,
        data: { state: "terminated", previousState },
      });

      return ok({
        type: "agent_terminate_result",
        id: message.id,
        payload: { agentId, success: true },
      });
    }

    case "agent_status": {
      const agentId = (message.payload as { agentId?: string } | undefined)?.agentId;
      if (agentId) {
        const agent = findAgentById(agents, agentId);
        if (!agent) {
          if (clusterNodeId && db) {
            const { nodeId } = await resolveAgentNode(db, agentId);
            if (nodeId && nodeId !== clusterNodeId) {
              const wsUrl = await resolveClusterNodeUrl(db, nodeId);
              if (wsUrl) {
                try {
                  const forwarded = await forwardClusterMessage(wsUrl, message, log);
                  return ok(forwarded);
                } catch (error) {
                  return err(new GatewayError(
                    `Cluster forward failed: ${error instanceof Error ? error.message : String(error)}`,
                    "CLUSTER_FORWARD_FAILED",
                    client.id,
                    agentId
                  ));
                }
              }
            }

            const rows = await db.query<{
              id: string;
              name: string;
              state: string;
              created_at: Date;
              node_id?: string;
              metadata?: Record<string, unknown>;
              total_input_tokens?: number | string;
              total_output_tokens?: number | string;
            }>((sql) => sql`
              SELECT id, name, state, created_at, node_id, metadata,
                     total_input_tokens, total_output_tokens
              FROM agents
              WHERE id = ${agentId}
                 OR metadata->>'manifestId' = ${agentId}
              ORDER BY created_at DESC
              LIMIT 1
            `);
            const row = rows[0];
            if (row) {
              const metadata = normalizeRecord(row.metadata);
              const limits = normalizeRecord(metadata.limits);
              return ok({
                type: "agent_status",
                id: message.id,
                payload: {
                  agentId: row.id,
                  externalId: metadata.manifestId ?? row.id,
                  name: row.name,
                  state: row.state,
                  uptime: Math.floor((Date.now() - new Date(row.created_at).getTime()) / 1000),
                  model: metadata.model,
                  capabilities: Array.isArray(metadata.capabilities) ? metadata.capabilities : [],
                  permissions: Array.isArray(metadata.permissions) ? metadata.permissions : [],
                  permissionGrants: Array.isArray(metadata.permissionGrants)
                    ? metadata.permissionGrants
                    : [],
                  trustLevel: metadata.trustLevel ?? "monitored-autonomous",
                  limits,
                  tokenUsage: {
                    input: toNumber(row.total_input_tokens, 0),
                    output: toNumber(row.total_output_tokens, 0),
                  },
                  nodeId: row.node_id,
                },
              });
            }
          }

          return err(new GatewayError(
            `Agent not found: ${agentId}`,
            "NOT_FOUND",
            client.id,
            agentId
          ));
        }

        return ok({
          type: "agent_status",
          id: message.id,
          payload: {
            agentId: agent.id,
            externalId: agent.externalId,
            name: agent.name,
            state: agent.state,
            uptime: Math.floor((Date.now() - agent.startedAt) / 1000),
            model: agent.model,
            capabilities: agent.capabilities,
            permissions: agent.permissions,
            trustLevel: agent.trustLevel,
            limits: agent.limits,
            tokenUsage: agent.tokenUsage,
          },
        });
      }

      if (clusterNodeId && db) {
        const agentsList = await listAgentsFromDatabase(db);
        return ok({
          type: "agent_list",
          id: message.id,
          payload: {
            agents: agentsList,
            count: agentsList.length,
          },
        });
      }

      return ok({
        type: "agent_list",
        id: message.id,
        payload: {
          agents: Array.from(agents.values()).map((a) => ({
            id: a.id,
            externalId: a.externalId,
            name: a.name,
            state: a.state,
            uptime: Math.floor((Date.now() - a.startedAt) / 1000),
            model: a.model,
            capabilities: a.capabilities,
            permissions: a.permissions,
            trustLevel: a.trustLevel,
            limits: a.limits,
            tokenUsage: a.tokenUsage,
          })),
          count: agents.size,
        },
      });
    }

    case "agent_task": {
      const payloadResult = AgentTaskPayloadSchema.safeParse(message.payload);
      if (!payloadResult.success) {
        return err(new GatewayError(
          `Invalid task payload: ${payloadResult.error.message}`,
          "VALIDATION_ERROR",
          client.id
        ));
      }

      const {
        agentId,
        task,
        internal,
        internalToken,
      } = payloadResult.data;
      const isInternal = Boolean(internal);
      const agent = findAgentById(agents, agentId);

      if (!agent) {
        if (clusterNodeId && db) {
          const { nodeId } = await resolveAgentNode(db, agentId);
          if (nodeId && nodeId !== clusterNodeId) {
            const wsUrl = await resolveClusterNodeUrl(db, nodeId);
            if (wsUrl) {
              try {
                const forwarded = await forwardClusterMessage(wsUrl, message, log);
                return ok(forwarded);
              } catch (error) {
                return err(new GatewayError(
                  `Cluster forward failed: ${error instanceof Error ? error.message : String(error)}`,
                  "CLUSTER_FORWARD_FAILED",
                  client.id,
                  agentId
                ));
              }
            }
          }
        }

        return err(new GatewayError(
          `Agent not found: ${agentId}`,
          "NOT_FOUND",
          client.id,
          agentId
        ));
      }

      if (isInternal) {
        const expectedToken = resolveInternalTaskToken();
        if (expectedToken && internalToken !== expectedToken) {
          return err(new GatewayError(
            "Invalid internal task token",
            "AUTH_ERROR",
            client.id,
            agentId
          ));
        }
      }

      const previousState = agent.state;
      agent.state = "running";
      if (db) {
        await updateAgentState(db, agent.id, "running", log, { fromState: previousState });
      }

      try {
        const maxTimeoutMs = resolveMaxAgentTaskTimeoutMs();
        const requestedTimeoutMs = typeof (task as { timeoutMs?: unknown }).timeoutMs === "number"
          ? Number((task as { timeoutMs?: unknown }).timeoutMs)
          : maxTimeoutMs;
        const timeoutMs = Math.min(requestedTimeoutMs, maxTimeoutMs);

        if (agent.entryPoint && !agent.worker) {
          log.warn("Agent entryPoint configured but worker not running; falling back to gateway task handler", {
            agentId: agent.id,
            entryPoint: agent.entryPoint,
          });
        }

        const shouldUseWorker = agent.entryPoint && agent.worker && !isInternal;
        const result = shouldUseWorker
          ? await sendTaskToWorker(agent, task, timeoutMs, log)
          : await handleAgentTask(task, agent, {
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
            });
        agent.state = "ready";
        agent.errorCount = 0;
        if (db) {
          await updateAgentState(db, agent.id, "ready", log, { fromState: "running" });
        }

        return ok({
          type: "agent_task_result",
          id: message.id,
          payload: {
            agentId,
            status: "ok",
            result,
          },
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        log.error("Agent task failed", { agentId, error: errorMsg });
        agent.errorCount += 1;
        const maxErrors = resolveMaxAgentErrors();
        if (agent.errorCount >= maxErrors) {
          agent.state = "error";
          log.warn("Agent error threshold exceeded", {
            agentId,
            errorCount: agent.errorCount,
            maxErrors,
          });

          if (db) {
            await recordEvent(
              db,
              "agent.error.threshold",
              "gateway",
              { agentId, errorCount: agent.errorCount, maxErrors },
              log,
              { agentId }
            );
          }
          await eventBus.publish({
            id: createEventId(),
            channel: "alerts",
            type: "agent.error.threshold",
            timestamp: new Date(),
            agentId: agent.id,
            data: { errorCount: agent.errorCount, maxErrors },
          });
        } else {
          agent.state = previousState === "running" ? "ready" : previousState;
        }
        if (db) {
          await updateAgentState(db, agent.id, agent.state, log, { fromState: "running", reason: errorMsg });
        }

        return ok({
          type: "agent_task_result",
          id: message.id,
          payload: {
            agentId,
            status: "error",
            error: errorMsg,
          },
        });
      }
    }

    case "subscribe": {
      const payloadResult = SubscribePayloadSchema.safeParse(message.payload);
      if (!payloadResult.success) {
        return err(new GatewayError(
          `Invalid subscribe payload: ${payloadResult.error.message}`,
          "VALIDATION_ERROR",
          client.id
        ));
      }

      const { channels } = payloadResult.data;
      client.subscriptions = client.subscriptions ?? [];
      client.subscriptions.push(...channels);

      log.debug("Client subscribed", { clientId: client.id, channels });

      return ok({
        type: "subscribe",
        id: message.id,
        payload: { channels, success: true },
      });
    }

    default:
      return err(new GatewayError(
        `Unhandled message type: ${message.type}`,
        "VALIDATION_ERROR",
        client.id
      ));
  }
}

function resolveMigrationsDir(): string | undefined {
  const candidates = [
    resolve(process.cwd(), "../../packages/kernel/migrations"),
    resolve(process.cwd(), "../packages/kernel/migrations"),
    resolve(process.cwd(), "packages/kernel/migrations"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

async function initializeMemorySubsystem(
  config: Config,
  log: ReturnType<typeof createLogger>
): Promise<{ db?: Database; vectorStore?: VectorStore; memory: MemoryManager }> {
  const isProduction = process.env.NODE_ENV === "production";
  const requirePersistent = parseBoolean(process.env.REQUIRE_PERSISTENT_STORE, isProduction);
  const requireVectorStore = parseBoolean(process.env.REQUIRE_VECTOR_STORE, isProduction);
  const encryptionEnabled = parseBoolean(process.env.MEMORY_ENCRYPTION_ENABLED, false);
  const encryptionKey = encryptionEnabled
    ? process.env.MEMORY_ENCRYPTION_KEY?.trim() || undefined
    : undefined;
  if (encryptionEnabled && !encryptionKey) {
    const message = "MEMORY_ENCRYPTION_ENABLED is true but MEMORY_ENCRYPTION_KEY is not set";
    if (isProduction) {
      throw new Error(message);
    }
    log.warn(message);
  }
  let db: Database | undefined;
  let vectorStore: VectorStore | undefined;

  try {
    db = createDatabase(config.database, log);
    const ready = await waitForDatabase(db, { logger: log, maxRetries: 10, retryDelayMs: 1000 });
    if (!ready) {
      if (requirePersistent) {
        throw new Error("Database not ready and persistent storage is required");
      }
      log.warn("Database not ready; falling back to in-memory memory store");
      await db.close();
      db = undefined;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (requirePersistent) {
      throw new Error(`Database initialization failed: ${message}`);
    }
    log.warn("Database initialization failed; using in-memory store", { error: message });
    db = undefined;
  }

  if (db) {
    const migrationsDir = resolveMigrationsDir();
    if (migrationsDir) {
      const result = await db.migrate(migrationsDir);
      if (result.errors.length > 0) {
        if (requirePersistent) {
          throw new Error(`Database migration errors: ${result.errors.map((e) => e.error).join("; ")}`);
        }
        log.warn("Database migration errors", { errors: result.errors });
      } else if (result.applied > 0) {
        log.info("Database migrations applied", { applied: result.applied });
      }
    } else {
      if (requirePersistent) {
        throw new Error("Migrations directory not found");
      }
      log.warn("Migrations directory not found; skipping migrations");
    }

    try {
      vectorStore = createVectorStore(config.qdrant, log);
      const ready = await waitForVectorStore(vectorStore, { logger: log, maxRetries: 5, retryDelayMs: 1000 });
      if (!ready) {
        if (requireVectorStore) {
          throw new Error("Vector store not ready and vector search is required");
        }
        log.warn("Vector store not ready; disabling embeddings search");
        await vectorStore.close();
        vectorStore = undefined;
      } else {
        await vectorStore.ensureCollection();
        log.info("Vector store ready", { collection: config.qdrant.collection });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (requireVectorStore) {
        throw new Error(`Vector store initialization failed: ${message}`);
      }
      log.warn("Vector store initialization failed; continuing without embeddings", { error: message });
      vectorStore = undefined;
    }
  }

  const store = db
      ? new PersistentMemoryStore({
        db,
        vectorStore,
        logger: log,
        enableVectorSearch: Boolean(vectorStore) && !encryptionEnabled,
        encryptionKey,
      })
    : new InMemoryStore();

  if (db) {
    if (encryptionEnabled && vectorStore) {
      log.warn("Memory encryption enabled; disabling vector search/embeddings storage", {
        collection: config.qdrant.collection,
      });
    }
    log.info("Persistent memory store enabled", {
      vectorSearch: Boolean(vectorStore) && !encryptionEnabled,
    });
  } else {
    log.warn("Using in-memory memory store (persistence disabled)");
  }

  const memory = new MemoryManager({ store });

  return { db, vectorStore, memory };
}

async function upsertAgentRecord(
  db: Database,
  agentId: string,
  manifest: AgentManifest,
  state: AgentEntry["state"],
  log: ReturnType<typeof createLogger>,
  nodeId?: string | null
): Promise<void> {
  const tags = Array.from(
    new Set([
      ...(manifest.skills ?? []),
      ...(manifest.capabilities ?? []),
      ...(manifest.permissions ?? []),
    ].filter(Boolean))
  );

  const metadata = {
    manifestId: manifest.id,
    model: manifest.model,
    systemPrompt: manifest.systemPrompt,
    skills: manifest.skills ?? [],
    capabilities: manifest.capabilities ?? [],
    permissions: manifest.permissions ?? [],
    permissionGrants: manifest.permissionGrants ?? [],
    trustLevel: manifest.trustLevel ?? "monitored-autonomous",
    limits: manifest.limits ?? {},
    a2aSkills: manifest.a2aSkills ?? [],
    tools: manifest.tools ?? [],
    mcpServers: manifest.mcpServers ?? [],
  };

  try {
    await db.query((sql) => sql`
      INSERT INTO agents (
        id,
        name,
        version,
        description,
        state,
        tags,
        metadata,
        node_id,
        last_active_at,
        deleted_at
      ) VALUES (
        ${agentId},
        ${manifest.name},
        ${manifest.version ?? "0.1.0"},
        ${manifest.description ?? null},
        ${state},
        ${sql.array(tags)},
        ${sql.json(toJsonValue(metadata))},
        ${nodeId ?? null},
        NOW(),
        NULL
      )
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        version = EXCLUDED.version,
        description = EXCLUDED.description,
        state = EXCLUDED.state,
        tags = EXCLUDED.tags,
        metadata = EXCLUDED.metadata,
        node_id = EXCLUDED.node_id,
        updated_at = NOW(),
        last_active_at = NOW(),
        deleted_at = NULL
    `);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn("Failed to upsert agent record", { agentId, error: message });
  }
}

async function updateAgentState(
  db: Database,
  agentId: string,
  state: AgentEntry["state"],
  log: ReturnType<typeof createLogger>,
  options: { fromState?: AgentEntry["state"]; reason?: string; event?: string } = {}
): Promise<void> {
  try {
    await db.query((sql) => sql`
      UPDATE agents
      SET
        state = ${state},
        updated_at = NOW(),
        last_active_at = NOW(),
        deleted_at = CASE WHEN ${state} = 'terminated' THEN NOW() ELSE deleted_at END
      WHERE id = ${agentId}
    `);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn("Failed to update agent state", { agentId, error: message });
  }
}

async function updateAgentUsage(
  db: Database,
  agentId: string,
  usage: { inputTokens: number; outputTokens: number },
  log: ReturnType<typeof createLogger>
): Promise<void> {
  try {
    await db.query((sql) => sql`
      UPDATE agents
      SET
        total_input_tokens = total_input_tokens + ${usage.inputTokens},
        total_output_tokens = total_output_tokens + ${usage.outputTokens},
        total_requests = total_requests + 1,
        updated_at = NOW(),
        last_active_at = NOW()
      WHERE id = ${agentId}
    `);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn("Failed to update agent usage", { agentId, error: message });
  }
}

async function recordProviderUsage(
  db: Database,
  agentId: string,
  model: string,
  usage: { inputTokens: number; outputTokens: number },
  log: ReturnType<typeof createLogger>,
  provider = "unknown",
  latencyMs?: number
): Promise<void> {
  try {
    await db.query((sql) => sql`
      INSERT INTO provider_usage (agent_id, provider, model, input_tokens, output_tokens, latency_ms)
      VALUES (
        ${agentId},
        ${provider},
        ${model},
        ${usage.inputTokens},
        ${usage.outputTokens},
        ${latencyMs ?? null}
      )
    `);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn("Failed to record provider usage", { agentId, error: message });
  }
}

async function recordEvent(
  db: Database,
  type: string,
  source: string,
  data: Record<string, unknown>,
  log: ReturnType<typeof createLogger>,
  options: { agentId?: string; correlationId?: string } = {}
): Promise<void> {
  try {
    const correlationId = options.correlationId && isUuid(options.correlationId)
      ? options.correlationId
      : null;
    await db.query((sql) => sql`
      INSERT INTO events (type, source, data, agent_id, correlation_id)
      VALUES (
        ${type},
        ${source},
        ${sql.json(toJsonValue(data))},
        ${options.agentId ?? null},
        ${correlationId}
      )
    `);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn("Failed to record event", { type, error: message });
  }
}

async function recordAuditLog(
  db: Database,
  entry: {
    action: string;
    resourceType?: string;
    resourceId?: string;
    actorId?: string;
    details?: Record<string, unknown>;
    outcome: "success" | "failure";
  },
  log: ReturnType<typeof createLogger>,
  options: { skipPolicyCheck?: boolean } = {}
): Promise<void> {
  try {
    await db.query((sql) => sql`
      INSERT INTO audit_log (action, resource_type, resource_id, actor_id, details, outcome)
      VALUES (
        ${entry.action},
        ${entry.resourceType ?? null},
        ${entry.resourceId ?? null},
        ${entry.actorId ?? null},
        ${sql.json(toJsonValue(entry.details ?? {}))},
        ${entry.outcome}
      )
    `);
    if (!options.skipPolicyCheck) {
      await evaluatePolicies(db, entry, log);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn("Failed to record audit log", { action: entry.action, error: message });
  }
}

type PolicyRule = {
  type: "rate_limit" | "deny";
  action?: string;
  resourceType?: string;
  outcome?: "success" | "failure";
  windowSeconds?: number;
  maxCount?: number;
  reason?: string;
  sanction?: {
    type: "warn" | "throttle" | "quarantine" | "ban";
    details?: Record<string, unknown>;
  };
};

type PolicyDefinition = {
  id: string;
  name: string;
  rules: unknown;
};

const POLICY_SKIP_PREFIXES = [
  "policy.",
  "moderation.",
  "sanction.",
  "appeal.",
  "audit.",
  "permission.",
  "approval.",
  "rate_limit.",
  "budget.",
];

function shouldSkipPolicyCheck(entry: { action: string; actorId?: string }): boolean {
  if (!entry.actorId || !isUuid(entry.actorId)) return true;
  return POLICY_SKIP_PREFIXES.some((prefix) => entry.action.startsWith(prefix));
}

function extractPolicyRules(rules: unknown): PolicyRule[] {
  if (!rules || typeof rules !== "object") return [];
  if (Array.isArray(rules)) {
    return rules.filter((rule): rule is PolicyRule => typeof rule === "object" && rule !== null);
  }
  const candidate = rules as { rules?: unknown };
  if (Array.isArray(candidate.rules)) {
    return candidate.rules.filter((rule): rule is PolicyRule => typeof rule === "object" && rule !== null);
  }
  return [];
}

async function evaluatePolicies(
  db: Database,
  entry: {
    action: string;
    resourceType?: string;
    resourceId?: string;
    actorId?: string;
    details?: Record<string, unknown>;
    outcome: "success" | "failure";
  },
  log: ReturnType<typeof createLogger>
): Promise<void> {
  if (shouldSkipPolicyCheck(entry)) return;

  try {
    const policies = await db.query((sql) => sql`
      SELECT id, name, rules
      FROM policies
      WHERE status = 'active'
    `) as PolicyDefinition[];

    if (!policies.length) return;

    for (const policy of policies) {
      const rules = extractPolicyRules(policy.rules);
      for (const rule of rules) {
        if (!rule || (rule.type !== "rate_limit" && rule.type !== "deny")) continue;
        if (rule.action && rule.action !== entry.action) continue;
        if (rule.resourceType && rule.resourceType !== entry.resourceType) continue;
        if (rule.outcome && rule.outcome !== entry.outcome) continue;

        const violation = rule.type === "deny"
          ? true
          : await checkRateLimitViolation(db, entry, rule);

        if (!violation) continue;

        const caseId = await openModerationCaseIfNeeded(db, entry, policy, rule, log);
        if (rule.sanction) {
          await applyPolicySanction(db, entry, caseId, policy, rule, log);
        }

        await recordAuditLog(
          db,
          {
            action: "policy.violation",
            resourceType: "policy",
            resourceId: policy.id,
            actorId: entry.actorId,
            details: { rule, sourceAction: entry.action },
            outcome: "failure",
          },
          log,
          { skipPolicyCheck: true }
        );
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn("Policy evaluation failed", { action: entry.action, error: message });
  }
}

async function checkRateLimitViolation(
  db: Database,
  entry: {
    action: string;
    resourceType?: string;
    actorId?: string;
    outcome: "success" | "failure";
  },
  rule: PolicyRule
): Promise<boolean> {
  if (rule.type !== "rate_limit") return false;
  if (!entry.actorId || !isUuid(entry.actorId)) return false;

  const maxCount = typeof rule.maxCount === "number" && rule.maxCount > 0 ? rule.maxCount : 0;
  const windowSeconds = typeof rule.windowSeconds === "number" && rule.windowSeconds > 0
    ? rule.windowSeconds
    : 60;
  if (!maxCount) return false;

  const action = rule.action ?? entry.action;
  const rows = await db.query((sql) => {
    if (rule.resourceType && rule.outcome) {
      return sql`
        SELECT COUNT(*)::int AS count
        FROM audit_log
        WHERE actor_id = ${entry.actorId}
          AND action = ${action}
          AND resource_type = ${rule.resourceType}
          AND outcome = ${rule.outcome}
          AND created_at >= NOW() - (${windowSeconds}::int * INTERVAL '1 second')
      `;
    }
    if (rule.resourceType) {
      return sql`
        SELECT COUNT(*)::int AS count
        FROM audit_log
        WHERE actor_id = ${entry.actorId}
          AND action = ${action}
          AND resource_type = ${rule.resourceType}
          AND created_at >= NOW() - (${windowSeconds}::int * INTERVAL '1 second')
      `;
    }
    if (rule.outcome) {
      return sql`
        SELECT COUNT(*)::int AS count
        FROM audit_log
        WHERE actor_id = ${entry.actorId}
          AND action = ${action}
          AND outcome = ${rule.outcome}
          AND created_at >= NOW() - (${windowSeconds}::int * INTERVAL '1 second')
      `;
    }
    return sql`
      SELECT COUNT(*)::int AS count
      FROM audit_log
      WHERE actor_id = ${entry.actorId}
        AND action = ${action}
        AND created_at >= NOW() - (${windowSeconds}::int * INTERVAL '1 second')
    `;
  });

  const count = rows[0]?.count ?? 0;
  return count > maxCount;
}

async function openModerationCaseIfNeeded(
  db: Database,
  entry: {
    action: string;
    resourceType?: string;
    resourceId?: string;
    actorId?: string;
    details?: Record<string, unknown>;
  },
  policy: PolicyDefinition,
  rule: PolicyRule,
  log: ReturnType<typeof createLogger>
): Promise<string> {
  const actorId = entry.actorId;
  if (!actorId || !isUuid(actorId)) {
    throw new Error("Cannot open moderation case without actor");
  }

  const existing = await db.query((sql) => sql`
    SELECT id
    FROM moderation_cases
    WHERE subject_agent_id = ${actorId}
      AND policy_id = ${policy.id}
      AND status = 'open'
    ORDER BY created_at DESC
    LIMIT 1
  `);

  if (existing[0]?.id) {
    return existing[0].id;
  }

  const reason = rule.reason ?? `Policy "${policy.name}" violation`;
  const rows = await db.query((sql) => sql`
    INSERT INTO moderation_cases (subject_agent_id, policy_id, status, reason, evidence, opened_by)
    VALUES (
      ${actorId},
      ${policy.id},
      'open',
      ${reason},
      ${sql.json(toJsonValue({
        rule,
        auditEntry: {
          action: entry.action,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId,
          actorId: entry.actorId,
          details: entry.details,
        },
      }))},
      ${actorId}
    )
    RETURNING id
  `);

  const caseId = rows[0]?.id as string | undefined;
  if (caseId) {
    await recordAuditLog(
      db,
      {
        action: "moderation.case.open.auto",
        resourceType: "moderation_case",
        resourceId: caseId,
        actorId,
        details: { policyId: policy.id },
        outcome: "success",
      },
      log,
      { skipPolicyCheck: true }
    );
    return caseId;
  }

  throw new Error("Failed to open moderation case");
}

async function applyPolicySanction(
  db: Database,
  entry: { actorId?: string },
  caseId: string,
  policy: PolicyDefinition,
  rule: PolicyRule,
  log: ReturnType<typeof createLogger>
): Promise<void> {
  if (!rule.sanction || !entry.actorId || !isUuid(entry.actorId)) return;

  const existing = await db.query((sql) => sql`
    SELECT id
    FROM sanctions
    WHERE case_id = ${caseId} AND status = 'active' AND type = ${rule.sanction?.type ?? "warn"}
    LIMIT 1
  `);

  if (existing.length > 0) return;

  const rows = await db.query((sql) => sql`
    INSERT INTO sanctions (case_id, subject_agent_id, type, details, status)
    VALUES (
      ${caseId},
      ${entry.actorId},
      ${rule.sanction.type},
      ${sql.json(toJsonValue({
        ...rule.sanction.details,
        policyId: policy.id,
        policyName: policy.name,
      }))},
      'active'
    )
    RETURNING id
  `);

  const sanctionId = rows[0]?.id as string | undefined;
  if (sanctionId) {
    await recordAuditLog(
      db,
      {
        action: "sanction.apply.auto",
        resourceType: "sanction",
        resourceId: sanctionId,
        actorId: entry.actorId,
        details: { policyId: policy.id, type: rule.sanction.type },
        outcome: "success",
      },
      log,
      { skipPolicyCheck: true }
    );
  }
}

async function handleAgentTask(
  task: Record<string, unknown>,
  agent: AgentEntry,
  ctx: {
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
  }
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
  } = ctx;
  const taskContext = {
    router,
    memory,
    log,
    db,
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
    if (!target.a2aSkills.length) return;

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

      const factResult = await memory.storeFact(
        agent.id,
        parsed.category ?? "fact",
        "fact",
        parsed.fact,
        {
          importance: parsed.importance,
          tags,
          embedding: parsed.embedding,
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
      const episodeResult = await memory.recordEpisode(agent.id, parsed.event, parsed.context, {
        outcome: parsed.outcome,
        success: parsed.success,
        importance: parsed.importance,
        tags: parsed.tags,
        sessionId: parsed.sessionId,
        relatedEpisodes: parsed.relatedEpisodes,
        embedding: parsed.embedding,
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

      const searchResult = await memory.search(agent.id, {
        query: parsed.query,
        embedding: parsed.embedding,
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
            WHERE agents.name ILIKE ${`%${query}%`} AND agents.state = ${parsed.status}
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
            WHERE agents.name ILIKE ${`%${query}%`}
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
            WHERE name ILIKE ${`%${query}%`}
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

main().catch((error) => {
  console.error("Gateway failed to start:", error);
  process.exit(1);
});

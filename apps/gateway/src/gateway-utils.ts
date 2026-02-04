// Gateway Utilities — Permission helpers, config resolvers, Docker config, production validation, memory retention

import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { createLogger, type Database, type VectorStore } from "@agentkernel/kernel";
import { ok, err, type Result, type ChatResponse } from "@agentkernel/shared";
import {
  createCapabilityManager,
  type Permission,
  type PermissionAction,
  type PermissionCategory,
} from "@agentkernel/permissions";
import type { MCPServerConfig } from "@agentkernel/tools";
import type { ProviderAdapter } from "@agentkernel/mal";
import { type AgentEntry, type AgentManifest, type WorkerRuntime, UUID_REGEX, isUuid } from "./gateway-types.js";
import { parseBoolean } from "./security-utils.js";
import { type ChatTestFlags } from "./task-schemas.js";

export function parseMcpServers(value?: string): MCPServerConfig[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as MCPServerConfig[] : [];
  } catch {
    return [];
  }
}

export function normalizeMcpAllowlist(servers: unknown): string[] {
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

export const PERMISSION_CATEGORY_ALIASES: Record<string, PermissionCategory> = {
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

export const PERMISSION_ACTION_ALIASES: Record<string, PermissionAction> = {
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

export function resolvePermissionCategory(value: string): PermissionCategory | null {
  const normalized = value.trim().toLowerCase();
  return PERMISSION_CATEGORY_ALIASES[normalized] ?? null;
}

export function resolvePermissionAction(value: string): PermissionAction | null {
  const normalized = value.trim().toLowerCase();
  return PERMISSION_ACTION_ALIASES[normalized] ?? null;
}

export function parsePermissionString(permission: string): Permission[] | null {
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

export function expandPermission(permission: Permission): Permission[] {
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

export function dedupePermissions(permissions: Permission[]): Permission[] {
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

export function collectPermissions(manifest: AgentManifest): Result<Permission[], Error> {
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

export function checkPermissionAny(
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

export function getEnabledToolIds(agent: AgentEntry): Set<string> | null {
  if (!agent.tools || agent.tools.length === 0) return null;
  const enabled = agent.tools
    .filter((tool) => tool.enabled !== false)
    .map((tool) => tool.id);
  return new Set(enabled);
}

export function findAgentById(
  agents: Map<string, AgentEntry>,
  agentId: string
): AgentEntry | undefined {
  return agents.get(agentId) ?? Array.from(agents.values()).find((agent) => agent.externalId === agentId);
}

// Task schemas extracted to ./task-schemas.ts

export function createEventId(): string {
  return `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createA2aTaskId(): string {
  return randomUUID();
}

export function createMockProvider(id: "anthropic" | "openai" | "google" | "ollama"): ProviderAdapter {
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

export const AjvDefault = Ajv.default ?? Ajv;
export const addFormatsDefault = addFormats.default ?? addFormats;
export const ajv = new AjvDefault({ allErrors: true, strict: false });
addFormatsDefault(ajv);

export function resolvePermissionDurationMs(): number {
  const raw = process.env.PERMISSION_TOKEN_DURATION_MS;
  if (!raw) return 30 * 24 * 60 * 60 * 1000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30 * 24 * 60 * 60 * 1000;
}

export function resolveMaxAgentErrors(): number {
  const raw = process.env.MAX_AGENT_ERRORS;
  if (!raw) return 5;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}

export function resolveMaxAgentRestarts(): number {
  const raw = process.env.MAX_AGENT_RESTARTS;
  if (!raw) return 3;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
}

export function resolveInternalTaskToken(): string | undefined {
  const raw = process.env.INTERNAL_AUTH_TOKEN;
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveEgressProxyUrl(): string | undefined {
  return (
    process.env.AGENT_EGRESS_PROXY_URL?.trim() ||
    process.env.HTTPS_PROXY?.trim() ||
    process.env.HTTP_PROXY?.trim() ||
    undefined
  );
}

export function resolveMaxAgentTaskTimeoutMs(): number {
  const raw = process.env.MAX_AGENT_TASK_TIMEOUT_MS;
  if (!raw) return 60000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60000;
}

export function resolveRetentionDays(value: string | undefined, defaultDays: number): number {
  if (!value) return defaultDays;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return defaultDays;
  return Math.max(0, Math.floor(parsed));
}

export function resolveOptionalNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}

export function truncateText(value: string | null | undefined, limit: number): string | null | undefined {
  if (value === null || value === undefined) return value;
  if (limit <= 0) return "";
  if (value.length <= limit) return value;
  return value.slice(0, limit);
}

export type MemoryType = "episodic" | "semantic" | "procedural";

export function compactArchivePayload(
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

export function scheduleRetentionCleanup(
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
            JSON.stringify(entry.payload),
            entry.created_at instanceof Date ? entry.created_at.toISOString() : String(entry.created_at),
            entry.archived_at.toISOString(),
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


export function resolveWorkerScriptPath(): string | null {
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

export function resolveWorkerRuntime(): WorkerRuntime {
  const raw = process.env.AGENT_WORKER_RUNTIME?.toLowerCase();
  if (raw === "docker") return "docker";
  return "local";
}

export function resolveDockerWorkerImage(): string {
  return process.env.AGENT_WORKER_IMAGE?.trim() || "agentkernel-worker:latest";
}

export function resolveDockerWorkerNetwork(): string | undefined {
  const network = process.env.AGENT_WORKER_DOCKER_NETWORK?.trim();
  return network && network.length > 0 ? network : undefined;
}

export function resolveDockerWorkerMount(): string | undefined {
  const mount = process.env.AGENT_WORKER_DOCKER_MOUNT?.trim();
  return mount && mount.length > 0 ? mount : undefined;
}

export function resolveDockerTmpfs(): string[] {
  const raw = process.env.AGENT_WORKER_DOCKER_TMPFS?.trim();
  if (!raw) return [];
  return raw.split(",").map((entry) => entry.trim()).filter(Boolean);
}

export function resolveDockerSecurityOpts(): string[] {
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

export function resolveDockerCapDrop(): string[] {
  const raw = process.env.AGENT_WORKER_DOCKER_CAP_DROP?.trim();
  if (!raw) return [];
  return raw.split(",").map((entry) => entry.trim()).filter(Boolean);
}

export function resolveDockerUlimits(): string[] {
  const raw = process.env.AGENT_WORKER_DOCKER_ULIMITS?.trim();
  if (!raw) return [];
  return raw.split(",").map((entry) => entry.trim()).filter(Boolean);
}

export function resolveDockerBlkioWeight(): string | undefined {
  const raw = process.env.AGENT_WORKER_DOCKER_BLKIO_WEIGHT?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return undefined;
  const clamped = Math.max(10, Math.min(1000, Math.floor(parsed)));
  return String(clamped);
}

export function resolveDockerStorageOpts(): string[] {
  const raw = process.env.AGENT_WORKER_DOCKER_STORAGE_OPTS?.trim();
  if (!raw) return [];
  return raw.split(",").map((entry) => entry.trim()).filter(Boolean);
}

export function applyDiskQuota(storageOpts: string[], diskQuotaMb?: number): string[] {
  if (!diskQuotaMb || !Number.isFinite(diskQuotaMb)) {
    return storageOpts;
  }
  const filtered = storageOpts.filter((entry) => !entry.trim().startsWith("size="));
  filtered.push(`size=${Math.floor(diskQuotaMb)}m`);
  return filtered;
}

export function resolveStreamChunkSize(): number {
  const raw = process.env.CHAT_STREAM_CHUNK_SIZE;
  if (!raw) return 120;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 120;
}

export function validateProductionHardening(
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


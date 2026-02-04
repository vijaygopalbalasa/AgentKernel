// Database Operations — DB initialization, agent records, audit logging, policy engine

import { resolve } from "path";
import { existsSync } from "fs";
import {
  createLogger,
  createDatabase,
  waitForDatabase,
  createVectorStore,
  waitForVectorStore,
  type Config,
  type Database,
  type VectorStore,
} from "@agentrun/kernel";
import { MemoryManager, InMemoryStore, PersistentMemoryStore } from "@agentrun/memory";
import { type AgentEntry, type AgentManifest, isUuid } from "./gateway-types.js";
import { toJsonValue } from "./task-schemas.js";
import { parseBoolean } from "./security-utils.js";

export function resolveMigrationsDir(): string | undefined {
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

export async function initializeMemorySubsystem(
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

export async function upsertAgentRecord(
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

export async function updateAgentState(
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

export async function updateAgentUsage(
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

export async function recordProviderUsage(
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

export async function recordEvent(
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

export async function recordAuditLog(
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

export type PolicyRule = {
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

export type PolicyDefinition = {
  id: string;
  name: string;
  rules: unknown;
};

export const POLICY_SKIP_PREFIXES = [
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

export function shouldSkipPolicyCheck(entry: { action: string; actorId?: string }): boolean {
  if (!entry.actorId || !isUuid(entry.actorId)) return true;
  return POLICY_SKIP_PREFIXES.some((prefix) => entry.action.startsWith(prefix));
}

export function extractPolicyRules(rules: unknown): PolicyRule[] {
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

export async function evaluatePolicies(
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

export async function checkRateLimitViolation(
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
  const actorId = entry.actorId;
  if (!actorId || !isUuid(actorId)) return false;

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
        WHERE actor_id = ${actorId}
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
        WHERE actor_id = ${actorId}
          AND action = ${action}
          AND resource_type = ${rule.resourceType}
          AND created_at >= NOW() - (${windowSeconds}::int * INTERVAL '1 second')
      `;
    }
    if (rule.outcome) {
      return sql`
        SELECT COUNT(*)::int AS count
        FROM audit_log
        WHERE actor_id = ${actorId}
          AND action = ${action}
          AND outcome = ${rule.outcome}
          AND created_at >= NOW() - (${windowSeconds}::int * INTERVAL '1 second')
      `;
    }
    return sql`
      SELECT COUNT(*)::int AS count
      FROM audit_log
      WHERE actor_id = ${actorId}
        AND action = ${action}
        AND created_at >= NOW() - (${windowSeconds}::int * INTERVAL '1 second')
    `;
  });

  const count = rows[0]?.count ?? 0;
  return count > maxCount;
}

export async function openModerationCaseIfNeeded(
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

export async function applyPolicySanction(
  db: Database,
  entry: { actorId?: string },
  caseId: string,
  policy: PolicyDefinition,
  rule: PolicyRule,
  log: ReturnType<typeof createLogger>
): Promise<void> {
  const sanction = rule.sanction;
  const sanctionActorId = entry.actorId;
  if (!sanction || !sanctionActorId || !isUuid(sanctionActorId)) return;

  const existing = await db.query((sql) => sql`
    SELECT id
    FROM sanctions
    WHERE case_id = ${caseId} AND status = 'active' AND type = ${sanction.type}
    LIMIT 1
  `);

  if (existing.length > 0) return;

  const rows = await db.query((sql) => sql`
    INSERT INTO sanctions (case_id, subject_agent_id, type, details, status)
    VALUES (
      ${caseId},
      ${sanctionActorId},
      ${sanction.type},
      ${sql.json(toJsonValue({
        ...sanction.details,
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
        details: { policyId: policy.id, type: sanction.type },
        outcome: "success",
      },
      log,
      { skipPolicyCheck: true }
    );
  }
}

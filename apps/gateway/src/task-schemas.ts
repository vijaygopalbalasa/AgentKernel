// Task Schemas — Zod validation schemas for all agent task types
// Extracted from main.ts for maintainability

import { z } from "zod";
import { ChatPayloadSchema } from "./types.js";

// ─── UTILITY TYPES ──────────────────────────────────────────

export type JsonValue =
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue };

export function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export const DateLikeSchema = z.preprocess((value) => {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return value;
}, z.date());

export const ApprovalSchema = z.object({
  approvedBy: z.string().min(1),
  approvedAt: DateLikeSchema.optional(),
  reason: z.string().optional(),
});

// ─── CORE TASK SCHEMAS ──────────────────────────────────────

export const EchoTaskSchema = z.object({
  type: z.literal("echo"),
  content: z.string().min(1),
});

export const ChatTestFlagsSchema = z.object({
  simulateRateLimit: z.boolean().optional(),
  simulateProviderError: z.boolean().optional(),
  simulateAllProvidersDown: z.boolean().optional(),
  simulateRecovery: z.boolean().optional(),
  recoveryDelayMs: z.number().int().min(1).optional(),
}).optional();

export type ChatTestFlags = z.infer<typeof ChatTestFlagsSchema>;

export const ChatTaskSchema = z.object({
  type: z.literal("chat"),
  _testFlags: ChatTestFlagsSchema,
}).merge(ChatPayloadSchema);

// ─── MEMORY TASK SCHEMAS ────────────────────────────────────

export const StoreFactTaskSchema = z.object({
  type: z.literal("store_fact"),
  fact: z.string().min(1),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  importance: z.number().min(0).max(1).optional(),
  embedding: z.array(z.number()).optional(),
});

export const RecordEpisodeTaskSchema = z.object({
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

export const SearchMemoryTaskSchema = z.object({
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

// ─── TOOL TASK SCHEMAS ──────────────────────────────────────

export const ListToolsTaskSchema = z.object({
  type: z.literal("list_tools"),
  query: z.string().optional(),
});

export const InvokeToolTaskSchema = z.object({
  type: z.literal("invoke_tool"),
  toolId: z.string().min(1),
  arguments: z.record(z.unknown()).optional(),
  approval: ApprovalSchema.optional(),
});

// ─── DISCOVERY TASK SCHEMAS ─────────────────────────────────

export const DiscoverAgentsTaskSchema = z.object({
  type: z.literal("discover_agents"),
  filter: z.object({
    capability: z.string().optional(),
    name: z.string().optional(),
  }).optional(),
});

export const AgentDirectoryTaskSchema = z.object({
  type: z.literal("agent_directory"),
  query: z.string().optional(),
  status: z.string().optional(),
  limit: z.number().int().min(1).optional(),
  offset: z.number().int().min(0).optional(),
});

// ─── FORUM TASK SCHEMAS ─────────────────────────────────────

export const ForumCreateTaskSchema = z.object({
  type: z.literal("forum_create"),
  name: z.string().min(1),
  description: z.string().optional(),
});

export const ForumListTaskSchema = z.object({
  type: z.literal("forum_list"),
  query: z.string().optional(),
  limit: z.number().int().min(1).optional(),
});

export const ForumPostTaskSchema = z.object({
  type: z.literal("forum_post"),
  forumId: z.string().min(1),
  content: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
});

export const ForumPostsTaskSchema = z.object({
  type: z.literal("forum_posts"),
  forumId: z.string().min(1),
  limit: z.number().int().min(1).optional(),
});

// ─── JOB TASK SCHEMAS ───────────────────────────────────────

export const JobPostTaskSchema = z.object({
  type: z.literal("job_post"),
  title: z.string().min(1),
  description: z.string().optional(),
  budgetUsd: z.number().min(0).optional(),
});

export const JobListTaskSchema = z.object({
  type: z.literal("job_list"),
  status: z.enum(["open", "in_progress", "closed"]).optional(),
  limit: z.number().int().min(1).optional(),
});

export const JobApplyTaskSchema = z.object({
  type: z.literal("job_apply"),
  jobId: z.string().min(1),
  proposal: z.string().optional(),
});

// ─── REPUTATION TASK SCHEMAS ────────────────────────────────

export const ReputationGetTaskSchema = z.object({
  type: z.literal("reputation_get"),
  agentId: z.string().min(1).optional(),
});

export const ReputationListTaskSchema = z.object({
  type: z.literal("reputation_list"),
  limit: z.number().int().min(1).optional(),
});

export const ReputationAdjustTaskSchema = z.object({
  type: z.literal("reputation_adjust"),
  agentId: z.string().min(1),
  delta: z.number(),
  reason: z.string().optional(),
});

// ─── AUDIT TASK SCHEMAS ─────────────────────────────────────

export const AuditQueryTaskSchema = z.object({
  type: z.literal("audit_query"),
  action: z.string().optional(),
  actorId: z.string().optional(),
  limit: z.number().int().min(1).optional(),
});

// ─── CAPABILITY TASK SCHEMAS ────────────────────────────────

export const CapabilityListTaskSchema = z.object({
  type: z.literal("capability_list"),
  agentId: z.string().min(1).optional(),
});

export const CapabilityGrantTaskSchema = z.object({
  type: z.literal("capability_grant"),
  agentId: z.string().min(1),
  permissions: z.array(z.string().min(1)),
  purpose: z.string().optional(),
  durationMs: z.number().int().min(1).optional(),
  delegatable: z.boolean().optional(),
});

export const CapabilityRevokeTaskSchema = z.object({
  type: z.literal("capability_revoke"),
  tokenId: z.string().min(1),
});

export const CapabilityRevokeAllTaskSchema = z.object({
  type: z.literal("capability_revoke_all"),
  agentId: z.string().min(1),
});

// ─── POLICY TASK SCHEMAS ────────────────────────────────────

export const PolicyCreateTaskSchema = z.object({
  type: z.literal("policy_create"),
  name: z.string().min(1),
  description: z.string().optional(),
  rules: z.record(z.unknown()).optional(),
});

export const PolicyListTaskSchema = z.object({
  type: z.literal("policy_list"),
  status: z.string().optional(),
  limit: z.number().int().min(1).optional(),
});

export const PolicySetStatusTaskSchema = z.object({
  type: z.literal("policy_set_status"),
  policyId: z.string().min(1),
  status: z.string().min(1),
});

// ─── MODERATION TASK SCHEMAS ────────────────────────────────

export const ModerationCaseOpenTaskSchema = z.object({
  type: z.literal("moderation_case_open"),
  subjectAgentId: z.string().min(1),
  policyId: z.string().optional(),
  reason: z.string().optional(),
  evidence: z.record(z.unknown()).optional(),
});

export const ModerationCaseListTaskSchema = z.object({
  type: z.literal("moderation_case_list"),
  status: z.string().optional(),
  subjectAgentId: z.string().optional(),
  limit: z.number().int().min(1).optional(),
});

export const ModerationCaseResolveTaskSchema = z.object({
  type: z.literal("moderation_case_resolve"),
  caseId: z.string().min(1),
  resolution: z.string().optional(),
  status: z.string().optional(),
});

// ─── APPEAL TASK SCHEMAS ────────────────────────────────────

export const AppealOpenTaskSchema = z.object({
  type: z.literal("appeal_open"),
  caseId: z.string().min(1),
  reason: z.string().optional(),
  evidence: z.record(z.unknown()).optional(),
});

export const AppealListTaskSchema = z.object({
  type: z.literal("appeal_list"),
  status: z.string().optional(),
  caseId: z.string().optional(),
  appellantAgentId: z.string().optional(),
  limit: z.number().int().min(1).optional(),
});

export const AppealResolveTaskSchema = z.object({
  type: z.literal("appeal_resolve"),
  appealId: z.string().min(1),
  resolution: z.string().optional(),
  status: z.string().optional(),
});

// ─── SANCTION TASK SCHEMAS ──────────────────────────────────

export const SanctionApplyTaskSchema = z.object({
  type: z.literal("sanction_apply"),
  caseId: z.string().optional(),
  subjectAgentId: z.string().min(1),
  sanctionType: z.enum(["warn", "throttle", "quarantine", "ban"]),
  details: z.record(z.unknown()).optional(),
});

export const SanctionListTaskSchema = z.object({
  type: z.literal("sanction_list"),
  status: z.string().optional(),
  subjectAgentId: z.string().optional(),
  limit: z.number().int().min(1).optional(),
});

export const SanctionLiftTaskSchema = z.object({
  type: z.literal("sanction_lift"),
  sanctionId: z.string().min(1),
});

// ─── A2A TASK SCHEMAS ───────────────────────────────────────

export const A2ATaskSchema = z.object({
  type: z.literal("a2a_task"),
  targetAgentId: z.string().min(1),
  task: z.record(z.unknown()),
  approval: ApprovalSchema.optional(),
});

export const A2ATaskSyncSchema = z.object({
  type: z.literal("a2a_task_sync"),
  targetAgentId: z.string().min(1),
  task: z.record(z.unknown()),
  timeout: z.number().int().min(1).optional(),
  approval: ApprovalSchema.optional(),
});

export const A2ATaskAsyncSchema = z.object({
  type: z.literal("a2a_task_async"),
  targetAgentId: z.string().min(1),
  task: z.record(z.unknown()),
  approval: ApprovalSchema.optional(),
});

export const A2ATaskStatusSchema = z.object({
  type: z.literal("a2a_task_status"),
  taskId: z.string().min(1),
});

// ─── COMPUTE TASK SCHEMAS ───────────────────────────────────

export const ComputeTaskSchema = z.object({
  type: z.literal("compute"),
  operations: z.array(z.enum(["add", "multiply"])).optional(),
  values: z.array(z.number()).optional(),
});

export const MemoryIntensiveTaskSchema = z.object({
  type: z.literal("memory_intensive"),
  _testFlags: z.object({
    allocateMb: z.number().int().min(1).optional(),
  }).optional(),
});

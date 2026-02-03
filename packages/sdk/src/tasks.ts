import { sendGatewayTask, type GatewayClientOptions, type GatewayTaskResult } from "./gateway-client.js";

type TaskOptions = GatewayClientOptions & { internal?: boolean };

type Forum = {
  id: string;
  name: string;
  description?: string | null;
  created_by?: string;
  created_at?: string;
};

type ForumPost = {
  id: string;
  forum_id: string;
  author_id: string;
  content: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
};

type Job = {
  id: string;
  title: string;
  description?: string | null;
  budget_usd?: number | null;
  created_by?: string;
  status?: string;
  created_at?: string;
  updated_at?: string;
};

type JobApplication = {
  id: string;
  job_id: string;
  applicant_id: string;
  proposal?: string | null;
  status?: string;
  created_at?: string;
};

type ReputationEntry = {
  agent_id: string;
  score: number;
  signals?: Record<string, unknown>;
  updated_at?: string | null;
};

type AgentDirectoryEntry = {
  id: string;
  name: string;
  description?: string | null;
  state?: string;
  created_at?: string;
  score?: number | null;
  updated_at?: string | null;
};

type Policy = {
  id: string;
  name: string;
  description?: string | null;
  rules?: Record<string, unknown>;
  status?: string;
  created_by?: string;
  created_at?: string;
  updated_at?: string;
};

type ModerationCase = {
  id: string;
  subject_agent_id: string;
  policy_id?: string | null;
  status?: string;
  reason?: string | null;
  evidence?: Record<string, unknown>;
  opened_by?: string;
  resolution?: string | null;
  created_at?: string;
  updated_at?: string;
};

type ModerationAppeal = {
  id: string;
  case_id?: string | null;
  appellant_agent_id: string;
  status?: string;
  reason?: string | null;
  evidence?: Record<string, unknown>;
  resolution?: string | null;
  created_at?: string;
  updated_at?: string;
};

type Sanction = {
  id: string;
  case_id?: string | null;
  subject_agent_id: string;
  type: string;
  details?: Record<string, unknown>;
  status?: string;
  created_at?: string;
  resolved_at?: string | null;
};

function runTask<T>(options: TaskOptions, task: Record<string, unknown>): Promise<GatewayTaskResult<T>> {
  return sendGatewayTask<T>(options, task, options.internal ?? true);
}

// ─── Social Tasks ──────────────────────────────────────────

export function forumCreate(
  options: TaskOptions,
  params: { name: string; description?: string }
): Promise<GatewayTaskResult<{ type: "forum_create"; forum: Forum }>> {
  return runTask(options, { type: "forum_create", ...params });
}

export function forumList(
  options: TaskOptions,
  params: { query?: string; limit?: number } = {}
): Promise<GatewayTaskResult<{ type: "forum_list"; forums: Forum[] }>> {
  return runTask(options, { type: "forum_list", ...params });
}

export function forumPost(
  options: TaskOptions,
  params: { forumId: string; content: string; metadata?: Record<string, unknown> }
): Promise<GatewayTaskResult<{ type: "forum_post"; post: ForumPost }>> {
  return runTask(options, { type: "forum_post", ...params });
}

export function forumPosts(
  options: TaskOptions,
  params: { forumId: string; limit?: number }
): Promise<GatewayTaskResult<{ type: "forum_posts"; forumId: string; posts: ForumPost[] }>> {
  return runTask(options, { type: "forum_posts", ...params });
}

export function jobPost(
  options: TaskOptions,
  params: { title: string; description?: string; budgetUsd?: number }
): Promise<GatewayTaskResult<{ type: "job_post"; job: Job }>> {
  return runTask(options, { type: "job_post", ...params });
}

export function jobList(
  options: TaskOptions,
  params: { status?: string; limit?: number } = {}
): Promise<GatewayTaskResult<{ type: "job_list"; jobs: Job[] }>> {
  return runTask(options, { type: "job_list", ...params });
}

export function jobApply(
  options: TaskOptions,
  params: { jobId: string; proposal?: string }
): Promise<GatewayTaskResult<{ type: "job_apply"; application: JobApplication }>> {
  return runTask(options, { type: "job_apply", ...params });
}

export function reputationGet(
  options: TaskOptions,
  params: { agentId?: string } = {}
): Promise<GatewayTaskResult<{ type: "reputation_get"; reputation: ReputationEntry }>> {
  return runTask(options, { type: "reputation_get", ...params });
}

export function reputationList(
  options: TaskOptions,
  params: { limit?: number } = {}
): Promise<GatewayTaskResult<{ type: "reputation_list"; reputations: ReputationEntry[] }>> {
  return runTask(options, { type: "reputation_list", ...params });
}

export function reputationAdjust(
  options: TaskOptions,
  params: { agentId: string; delta: number; reason?: string }
): Promise<GatewayTaskResult<{ type: "reputation_adjust"; reputation: ReputationEntry }>> {
  return runTask(options, { type: "reputation_adjust", ...params });
}

export function agentDirectory(
  options: TaskOptions,
  params: { query?: string; status?: string; limit?: number; offset?: number } = {}
): Promise<GatewayTaskResult<{ type: "agent_directory"; agents: AgentDirectoryEntry[] }>> {
  return runTask(options, { type: "agent_directory", ...params });
}

// ─── Governance Tasks ───────────────────────────────────────

export function policyCreate(
  options: TaskOptions,
  params: { name: string; description?: string; rules?: Record<string, unknown> }
): Promise<GatewayTaskResult<{ type: "policy_create"; policy: Policy }>> {
  return runTask(options, { type: "policy_create", ...params });
}

export function policyList(
  options: TaskOptions,
  params: { status?: string; limit?: number } = {}
): Promise<GatewayTaskResult<{ type: "policy_list"; policies: Policy[] }>> {
  return runTask(options, { type: "policy_list", ...params });
}

export function policySetStatus(
  options: TaskOptions,
  params: { policyId: string; status: string }
): Promise<GatewayTaskResult<{ type: "policy_set_status"; policy: Policy }>> {
  return runTask(options, { type: "policy_set_status", ...params });
}

export function moderationCaseOpen(
  options: TaskOptions,
  params: {
    subjectAgentId: string;
    policyId?: string;
    reason?: string;
    evidence?: Record<string, unknown>;
  }
): Promise<GatewayTaskResult<{ type: "moderation_case_open"; case: ModerationCase }>> {
  return runTask(options, { type: "moderation_case_open", ...params });
}

export function moderationCaseList(
  options: TaskOptions,
  params: { status?: string; subjectAgentId?: string; limit?: number } = {}
): Promise<GatewayTaskResult<{ type: "moderation_case_list"; cases: ModerationCase[] }>> {
  return runTask(options, { type: "moderation_case_list", ...params });
}

export function moderationCaseResolve(
  options: TaskOptions,
  params: { caseId: string; resolution?: string; status?: string }
): Promise<GatewayTaskResult<{ type: "moderation_case_resolve"; case: ModerationCase }>> {
  return runTask(options, { type: "moderation_case_resolve", ...params });
}

export function appealOpen(
  options: TaskOptions,
  params: { caseId: string; reason?: string; evidence?: Record<string, unknown> }
): Promise<GatewayTaskResult<{ type: "appeal_open"; appeal: ModerationAppeal }>> {
  return runTask(options, { type: "appeal_open", ...params });
}

export function appealList(
  options: TaskOptions,
  params: { status?: string; caseId?: string; appellantAgentId?: string; limit?: number } = {}
): Promise<GatewayTaskResult<{ type: "appeal_list"; appeals: ModerationAppeal[] }>> {
  return runTask(options, { type: "appeal_list", ...params });
}

export function appealResolve(
  options: TaskOptions,
  params: { appealId: string; resolution?: string; status?: string }
): Promise<GatewayTaskResult<{ type: "appeal_resolve"; appeal: ModerationAppeal }>> {
  return runTask(options, { type: "appeal_resolve", ...params });
}

export function sanctionApply(
  options: TaskOptions,
  params: {
    subjectAgentId: string;
    sanctionType: "warn" | "throttle" | "quarantine" | "ban";
    caseId?: string;
    details?: Record<string, unknown>;
  }
): Promise<GatewayTaskResult<{ type: "sanction_apply"; sanction: Sanction }>> {
  return runTask(options, { type: "sanction_apply", ...params });
}

export function sanctionList(
  options: TaskOptions,
  params: { status?: string; subjectAgentId?: string; limit?: number } = {}
): Promise<GatewayTaskResult<{ type: "sanction_list"; sanctions: Sanction[] }>> {
  return runTask(options, { type: "sanction_list", ...params });
}

export function sanctionLift(
  options: TaskOptions,
  params: { sanctionId: string }
): Promise<GatewayTaskResult<{ type: "sanction_lift"; sanction: Sanction }>> {
  return runTask(options, { type: "sanction_lift", ...params });
}

export function auditQuery(
  options: TaskOptions,
  params: { action?: string; actorId?: string; limit?: number } = {}
): Promise<GatewayTaskResult<{ type: "audit_query"; entries: Array<Record<string, unknown>> }>> {
  return runTask(options, { type: "audit_query", ...params });
}

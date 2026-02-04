export interface WsMessage {
  type: string;
  id: string;
  payload?: Record<string, unknown>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ChatResponse {
  content: string;
  model?: string;
  finishReason?: string;
  usage?: TokenUsage;
}

export interface AgentInfo {
  id: string;
  externalId?: string;
  name: string;
  state: "ready" | "running" | "error" | "stopped" | "terminated";
  trustLevel?: string;
  uptime: number;
  model?: string;
  tokenUsage?: { input: number; output: number };
  errorCount?: number;
  permissions?: string[];
  permissionGrants?: unknown[];
  limits?: Record<string, number>;
}

export interface GatewayEvent {
  type: string;
  summary: string;
  timestamp: string;
  channel?: string;
}

export interface HealthData {
  status: string;
  providers?: Array<{ name: string; status: string }>;
  agents?: number;
  uptime?: number;
  version?: string;
}

export interface MetricsData {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface MemoryResult {
  type: "semantic" | "episodic" | "procedural";
  content: string;
  score: number;
  metadata?: Record<string, unknown>;
  tags?: string[];
  importance?: number;
  timestamp?: string;
}

export interface PolicyInfo {
  id: string;
  name: string;
  description?: string;
  status?: string;
  rules?: unknown;
}

export interface ModerationCase {
  id: string;
  subjectAgentId: string;
  policyId?: string;
  reason?: string;
  status: string;
  evidence?: Record<string, unknown>;
  resolution?: string;
}

export interface Sanction {
  id: string;
  type: string;
  subject_agent_id?: string;
  status?: string;
}

export interface Appeal {
  id: string;
  caseId: string;
  reason?: string;
  status: string;
  resolution?: string;
  evidence?: Record<string, unknown>;
}

export interface AuditEntry {
  id: string;
  action: string;
  actor_id?: string;
  resource_type?: string;
  outcome: string;
  created_at: string;
}

export interface CapabilityToken {
  id: string;
  agentId: string;
  permissions: Array<{
    category: string;
    actions?: string[];
    resource?: string;
  }>;
  purpose?: string;
  expiresAt?: string;
}

export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "auth_required"
  | "auth_failed";

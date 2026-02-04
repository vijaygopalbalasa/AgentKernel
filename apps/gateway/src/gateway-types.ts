// Gateway Types — Shared interfaces and types for the gateway modules

import { z } from "zod";
import type { ValidateFunction } from "ajv";
import type { ChildProcess } from "node:child_process";
import type { Permission } from "@agentrun/permissions";
import type { A2ASkill } from "@agentrun/communication";
import { AgentSpawnPayloadSchema } from "./types.js";

/** Gateway state */
export interface GatewayState {
  allowedPaths: string[];
  allowedDomains: string[];
  allowAllPaths: boolean;
  allowAllDomains: boolean;
  memoryLimitMb: number;
}

export type TrustLevel = "supervised" | "semi-autonomous" | "monitored-autonomous";

export type WorkerRuntime = "local" | "docker";

/** Reserved PostgreSQL connection for advisory locks */
export interface ReservedConnection {
  (template: TemplateStringsArray, ...args: readonly unknown[]): Promise<Record<string, unknown>[]>;
  release?: () => Promise<void>;
}

export interface WorkerTransport {
  send: (message: unknown) => void;
  onMessage: (handler: (message: unknown) => void) => void;
  onExit: (handler: (code: number | null, signal: NodeJS.Signals | null) => void) => void;
  kill: (signal?: NodeJS.Signals) => void;
}

export interface AgentLimits {
  maxTokensPerRequest?: number;
  tokensPerMinute?: number;
  requestsPerMinute?: number;
  toolCallsPerMinute?: number;
  costBudgetUSD?: number;
  maxMemoryMB?: number;
  cpuCores?: number;
  diskQuotaMB?: number;
}

export interface AgentUsageWindow {
  windowStart: number;
  requestsThisMinute: number;
  toolCallsThisMinute: number;
  tokensThisMinute: number;
}

/** Agent tracking entry */
export interface AgentEntry {
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

export interface A2ATaskEntry {
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

export type AgentManifest = NonNullable<z.infer<typeof AgentSpawnPayloadSchema>["manifest"]>;

export interface ClusterCoordinator {
  nodeId: string;
  isLeader: () => boolean;
  onChange: (handler: (isLeader: boolean) => void) => () => void;
  stop: () => Promise<void>;
}

export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

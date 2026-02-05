// Agent State Store — distributed agent state for multi-replica deployments
// In-memory store for dev/test, Redis-backed store for production

import type { AgentId, ResourceUsage } from "./agent-context.js";
import type { AgentState } from "./state-machine.js";

/** Serialized agent state for cross-replica storage */
export interface AgentStateEntry {
  id: AgentId;
  name: string;
  state: AgentState;
  nodeId: string;
  usage: ResourceUsage;
  createdAt: number;
  lastActivityAt: number;
  errorCount: number;
}

/** Agent state store interface — abstracts in-memory vs Redis-backed storage */
export interface AgentStateStore {
  /** Get a single agent's state */
  get(id: AgentId): Promise<AgentStateEntry | null>;
  /** Set (upsert) an agent's state */
  set(id: AgentId, entry: AgentStateEntry): Promise<void>;
  /** Delete an agent's state */
  delete(id: AgentId): Promise<boolean>;
  /** List all agents */
  list(): Promise<AgentStateEntry[]>;
  /** List agents on a specific node */
  listByNode(nodeId: string): Promise<AgentStateEntry[]>;
  /** Atomically update token usage counters */
  updateUsage(
    id: AgentId,
    inputTokensDelta: number,
    outputTokensDelta: number,
    costDelta: number,
  ): Promise<void>;
}

/**
 * In-memory agent state store for development/testing.
 */
export class InMemoryAgentStateStore implements AgentStateStore {
  private entries: Map<AgentId, AgentStateEntry> = new Map();

  async get(id: AgentId): Promise<AgentStateEntry | null> {
    return this.entries.get(id) ?? null;
  }

  async set(id: AgentId, entry: AgentStateEntry): Promise<void> {
    this.entries.set(id, { ...entry });
  }

  async delete(id: AgentId): Promise<boolean> {
    return this.entries.delete(id);
  }

  async list(): Promise<AgentStateEntry[]> {
    return Array.from(this.entries.values());
  }

  async listByNode(nodeId: string): Promise<AgentStateEntry[]> {
    return Array.from(this.entries.values()).filter((e) => e.nodeId === nodeId);
  }

  async updateUsage(
    id: AgentId,
    inputTokensDelta: number,
    outputTokensDelta: number,
    costDelta: number,
  ): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;

    entry.usage.inputTokens += inputTokensDelta;
    entry.usage.outputTokens += outputTokensDelta;
    entry.usage.estimatedCostUSD += costDelta;
    entry.usage.requestCount += 1;
    entry.lastActivityAt = Date.now();
  }

  /** Clear all entries (test helper) */
  clear(): void {
    this.entries.clear();
  }

  /** Get current size (test helper) */
  get size(): number {
    return this.entries.size;
  }
}

/**
 * Redis-compatible client interface used by the store.
 */
export interface RedisHashClient {
  hset(key: string, field: string, value: string): Promise<number>;
  hget(key: string, field: string): Promise<string | null>;
  hgetall(key: string): Promise<Record<string, string>>;
  hdel(key: string, ...fields: string[]): Promise<number>;
  del(...keys: string[]): Promise<number>;
  hincrby(key: string, field: string, increment: number): Promise<number>;
  hincrbyfloat(key: string, field: string, increment: number): Promise<number>;
  keys(pattern: string): Promise<string[]>;
}

/**
 * Redis-backed agent state store for distributed deployments.
 * Each agent is stored as a Redis hash under key `agent:{id}`.
 */
export class RedisAgentStateStore implements AgentStateStore {
  private redis: RedisHashClient;
  private keyPrefix: string;

  constructor(redis: RedisHashClient, keyPrefix = "agentkernel:agent:") {
    this.redis = redis;
    this.keyPrefix = keyPrefix;
  }

  private key(id: AgentId): string {
    return `${this.keyPrefix}${id}`;
  }

  async get(id: AgentId): Promise<AgentStateEntry | null> {
    const raw = await this.redis.hgetall(this.key(id));
    if (!raw || Object.keys(raw).length === 0) return null;
    return this.deserialize(raw);
  }

  async set(id: AgentId, entry: AgentStateEntry): Promise<void> {
    const k = this.key(id);
    const fields = this.serialize(entry);
    for (const [field, value] of Object.entries(fields)) {
      await this.redis.hset(k, field, value);
    }
  }

  async delete(id: AgentId): Promise<boolean> {
    const result = await this.redis.del(this.key(id));
    return result > 0;
  }

  async list(): Promise<AgentStateEntry[]> {
    const keys = await this.redis.keys(`${this.keyPrefix}*`);
    const entries: AgentStateEntry[] = [];
    for (const k of keys) {
      const raw = await this.redis.hgetall(k);
      if (raw && Object.keys(raw).length > 0) {
        entries.push(this.deserialize(raw));
      }
    }
    return entries;
  }

  async listByNode(nodeId: string): Promise<AgentStateEntry[]> {
    const all = await this.list();
    return all.filter((e) => e.nodeId === nodeId);
  }

  async updateUsage(
    id: AgentId,
    inputTokensDelta: number,
    outputTokensDelta: number,
    costDelta: number,
  ): Promise<void> {
    const k = this.key(id);
    await this.redis.hincrby(k, "inputTokens", inputTokensDelta);
    await this.redis.hincrby(k, "outputTokens", outputTokensDelta);
    await this.redis.hincrbyfloat(k, "estimatedCostUSD", costDelta);
    await this.redis.hincrby(k, "requestCount", 1);
    await this.redis.hset(k, "lastActivityAt", String(Date.now()));
  }

  private serialize(entry: AgentStateEntry): Record<string, string> {
    return {
      id: entry.id,
      name: entry.name,
      state: entry.state,
      nodeId: entry.nodeId,
      createdAt: String(entry.createdAt),
      lastActivityAt: String(entry.lastActivityAt),
      errorCount: String(entry.errorCount),
      inputTokens: String(entry.usage.inputTokens),
      outputTokens: String(entry.usage.outputTokens),
      requestCount: String(entry.usage.requestCount),
      estimatedCostUSD: String(entry.usage.estimatedCostUSD),
      currentMemoryMB: String(entry.usage.currentMemoryMB),
      activeRequests: String(entry.usage.activeRequests),
      tokensThisMinute: String(entry.usage.tokensThisMinute),
      minuteWindowStart: String(entry.usage.minuteWindowStart.getTime()),
    };
  }

  private deserialize(raw: Record<string, string>): AgentStateEntry {
    return {
      id: raw.id ?? "",
      name: raw.name ?? "",
      state: (raw.state ?? "created") as AgentState,
      nodeId: raw.nodeId ?? "",
      createdAt: Number.parseInt(raw.createdAt ?? "0", 10),
      lastActivityAt: Number.parseInt(raw.lastActivityAt ?? "0", 10),
      errorCount: Number.parseInt(raw.errorCount ?? "0", 10),
      usage: {
        inputTokens: Number.parseInt(raw.inputTokens ?? "0", 10),
        outputTokens: Number.parseInt(raw.outputTokens ?? "0", 10),
        requestCount: Number.parseInt(raw.requestCount ?? "0", 10),
        estimatedCostUSD: Number.parseFloat(raw.estimatedCostUSD ?? "0"),
        currentMemoryMB: Number.parseFloat(raw.currentMemoryMB ?? "0"),
        activeRequests: Number.parseInt(raw.activeRequests ?? "0", 10),
        tokensThisMinute: Number.parseInt(raw.tokensThisMinute ?? "0", 10),
        minuteWindowStart: new Date(Number.parseInt(raw.minuteWindowStart ?? "0", 10)),
      },
    };
  }
}

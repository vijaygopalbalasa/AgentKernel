// Cluster Coordination — Leader election, node registry, cross-node forwarding

import { createHash, randomUUID } from "crypto";
import { WebSocket } from "ws";
import { createLogger, type Config, type Database } from "@agent-os/kernel";
import type { JobLockProvider } from "@agent-os/runtime";
import type { WsMessage } from "./types.js";
import { type ClusterCoordinator, type ReservedConnection } from "./gateway-types.js";
import { parseBoolean } from "./security-utils.js";


export function hashToInt32(value: string): number {
  const digest = createHash("sha256").update(value).digest();
  return digest.readInt32BE(0);
}

export function deriveAdvisoryKeys(key: string): [number, number] {
  return [hashToInt32(key), hashToInt32(`${key}:secondary`)];
}

export function resolveClusterNodeWsUrl(config: Config): string | null {
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

export function normalizeRecord(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object") return value as Record<string, unknown>;
  try {
    return JSON.parse(String(value)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function toNumber(value: unknown, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function registerClusterNode(
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

export async function resolveClusterNodeUrl(
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

export async function resolveAgentNode(
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

export async function forwardClusterMessage(
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

export async function listAgentsFromDatabase(
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

export function createJobLockProvider(
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

export async function createClusterCoordinator(
  db: Database,
  log: ReturnType<typeof createLogger>
): Promise<ClusterCoordinator | null> {
  const enabled = parseBoolean(process.env.CLUSTER_MODE, false);
  if (!enabled) return null;

  const nodeId = process.env.CLUSTER_NODE_ID?.trim() || `node-${randomUUID().slice(0, 8)}`;
  const lockKey = process.env.CLUSTER_LEADER_LOCK_KEY?.trim() || "agentos:leader";
  const intervalMs = Number(process.env.CLUSTER_LEADER_CHECK_INTERVAL_MS ?? 5000);
  const [key1, key2] = deriveAdvisoryKeys(lockKey);

  const sqlPool = db.sql as unknown as { reserve?: () => Promise<ReservedConnection> };
  if (typeof sqlPool.reserve !== "function") {
    log.error("Cluster mode requires a reservable database connection");
    return null;
  }

  let reserved: ReservedConnection | null = null;
  let leader = false;
  const listeners = new Set<(isLeader: boolean) => void>();

  const notify = () => {
    for (const listener of listeners) {
      listener(leader);
    }
  };

  const ensureReserved = async () => {
    if (!reserved && sqlPool.reserve) {
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
    if (!reserved) return;
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

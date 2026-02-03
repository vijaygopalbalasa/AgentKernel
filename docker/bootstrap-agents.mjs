import { readFile } from "node:fs/promises";
import { WebSocket } from "ws";

const manifestPaths = [
  "agents/researcher/manifest.json",
  "agents/monitor/manifest.json",
  "agents/coder/manifest.json",
];

const gatewayHost = process.env.GATEWAY_BOOTSTRAP_HOST ?? process.env.GATEWAY_HOST ?? "gateway";
const gatewayPort = process.env.GATEWAY_PORT ?? "18800";
const gatewayUrl = process.env.GATEWAY_URL ?? `ws://${gatewayHost}:${gatewayPort}`;
const authToken = process.env.GATEWAY_AUTH_TOKEN;

function createMessageId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function connectGateway() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(gatewayUrl);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

async function request(ws, message, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(message.id);
      reject(new Error(`Timeout waiting for ${message.type}`));
    }, timeoutMs);

    pending.set(message.id, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });

    ws.send(JSON.stringify(message));
  });
}

const pending = new Map();

async function main() {
  const ws = await connectGateway();

  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString());
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
      }
    } catch {
      // ignore parse failures
    }
  });

  if (authToken) {
    const authId = createMessageId("auth");
    const authResponse = await request(ws, {
      type: "auth",
      id: authId,
      payload: { token: authToken },
    }, 5000);

    if (authResponse.type === "auth_failed") {
      throw new Error(authResponse.payload?.message ?? "Gateway auth failed");
    }
  }

  const statusId = createMessageId("status");
  const statusResponse = await request(ws, {
    type: "agent_status",
    id: statusId,
    payload: {},
  });

  const existing = new Set();
  if (statusResponse.type === "agent_list") {
    const agents = statusResponse.payload?.agents ?? [];
    for (const agent of agents) {
      if (agent?.externalId) existing.add(agent.externalId);
      if (agent?.id) existing.add(agent.id);
    }
  }

  for (const manifestPath of manifestPaths) {
    const manifestRaw = await readFile(manifestPath, "utf-8");
    const manifest = JSON.parse(manifestRaw);

    if (existing.has(manifest.id)) {
      console.log(`Agent already running: ${manifest.id}`);
      continue;
    }

    const spawnId = createMessageId("spawn");
    const response = await request(ws, {
      type: "agent_spawn",
      id: spawnId,
      payload: { manifest },
    }, 15000);

    if (response.type === "agent_spawn_result") {
      console.log(`Spawned agent ${manifest.id} -> ${response.payload?.status ?? "unknown"}`);
    } else if (response.type === "error") {
      console.warn(`Failed to spawn ${manifest.id}: ${response.payload?.message ?? "unknown error"}`);
    }
  }

  ws.close();
}

main().catch((error) => {
  console.error(`Bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

// Integration test utilities for Agent OS
import { WebSocket } from "ws";
import { ChildProcess, spawn, exec } from "child_process";
import { existsSync } from "fs";
import { resolve } from "path";
import { promisify } from "util";
import { createServer } from "net";
import { type Result, ok, err } from "@agent-os/shared";

const execAsync = promisify(exec);

// ─── CONFIGURATION ──────────────────────────────────────────

export interface TestConfig {
  gatewayHost: string;
  gatewayPort: number;
  healthPort: number;
  postgresUrl: string;
  qdrantUrl: string;
  redisUrl: string;
  timeout: number;
}

const resolvedGatewayPort = Number(process.env.TEST_GATEWAY_PORT ?? 18811);
const resolvedHealthPort = Number(
  process.env.TEST_HEALTH_PORT ?? String(resolvedGatewayPort + 1)
);

export const defaultTestConfig: TestConfig = {
  gatewayHost: "127.0.0.1",
  gatewayPort: Number.isFinite(resolvedGatewayPort) ? resolvedGatewayPort : 18811,
  healthPort: Number.isFinite(resolvedHealthPort) ? resolvedHealthPort : 18812,
  postgresUrl: process.env.TEST_DATABASE_URL ??
    "postgresql://agentos:agentos_test@127.0.0.1:5433/agentos_test",
  qdrantUrl: process.env.TEST_QDRANT_URL ?? "http://127.0.0.1:6335",
  redisUrl: process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6380",
  timeout: 30000,
};

// ─── ERROR TYPES ────────────────────────────────────────────

export class TestError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "TestError";
  }
}

// ─── GATEWAY UTILITIES ──────────────────────────────────────

export interface TestGateway {
  process: ChildProcess;
  wsUrl: string;
  healthUrl: string;
  stop: () => Promise<void>;
}

/**
 * Start the gateway for testing.
 */
export async function createTestGateway(
  config: Partial<TestConfig> = {}
): Promise<Result<TestGateway, TestError>> {
  const cfg = { ...defaultTestConfig, ...config };

  try {
    const [gatewayAvailable, healthAvailable] = await Promise.all([
      isPortAvailable(cfg.gatewayHost, cfg.gatewayPort),
      isPortAvailable(cfg.gatewayHost, cfg.healthPort),
    ]);

    if (!gatewayAvailable) {
      return err(new TestError(`Gateway port ${cfg.gatewayPort} is already in use`, "PORT_IN_USE"));
    }
    if (!healthAvailable) {
      return err(new TestError(`Health port ${cfg.healthPort} is already in use`, "PORT_IN_USE"));
    }

    const distPath = resolve(process.cwd(), "dist/main.js");
    if (!existsSync(distPath)) {
      return err(
        new TestError(
          `Gateway build not found at ${distPath}. Run pnpm -C apps/gateway build first.`,
          "GATEWAY_BUILD_MISSING"
        )
      );
    }

    // Set environment variables
    const env = {
      ...process.env,
      NODE_ENV: "test",
      GATEWAY_PORT: String(cfg.gatewayPort),
      HEALTH_PORT: String(cfg.healthPort),
      DATABASE_URL: cfg.postgresUrl,
      QDRANT_URL: cfg.qdrantUrl,
      REDIS_URL: cfg.redisUrl,
      LOG_LEVEL: "debug",
    };

    // Start the gateway process
    const gatewayProcess = spawn("node", [distPath], {
      cwd: process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const wsUrl = `ws://${cfg.gatewayHost}:${cfg.gatewayPort}`;
    const healthUrl = `http://${cfg.gatewayHost}:${cfg.healthPort}/health`;

    // Wait for gateway to be ready
    const ready = await waitForHealth(healthUrl, cfg.timeout);
    if (!ready.ok) {
      gatewayProcess.kill();
      return err(new TestError("Gateway failed to start", "GATEWAY_START_FAILED", ready.error));
    }

    const stop = async () => {
      return new Promise<void>((resolve) => {
        gatewayProcess.once("exit", () => resolve());
        gatewayProcess.kill("SIGTERM");
        // Force kill after 5 seconds
        setTimeout(() => {
          gatewayProcess.kill("SIGKILL");
          resolve();
        }, 5000);
      });
    };

    return ok({
      process: gatewayProcess,
      wsUrl,
      healthUrl,
      stop,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(new TestError(`Failed to create gateway: ${message}`, "GATEWAY_CREATE_ERROR"));
  }
}

/**
 * Wait for health endpoint to respond with healthy status.
 */
export async function waitForHealth(
  url: string,
  timeout: number = 30000,
  interval: number = 500
): Promise<Result<void, TestError>> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const data = (await response.json()) as { status?: string };
        if (data.status === "ok" || data.status === "healthy") {
          return ok(undefined);
        }
      }
    } catch {
      // Connection refused, keep trying
    }
    await sleep(interval);
  }

  return err(new TestError(`Health check timeout after ${timeout}ms`, "HEALTH_TIMEOUT"));
}

// ─── WEBSOCKET UTILITIES ────────────────────────────────────

export interface TestConnection {
  ws: WebSocket;
  send: (message: unknown) => void;
  receive: (timeout?: number, predicate?: (message: unknown) => boolean) => Promise<unknown>;
  close: () => void;
}

/**
 * Create a WebSocket connection to the gateway.
 */
export async function createTestConnection(
  wsUrl: string,
  token?: string,
  timeout: number = 10000
): Promise<Result<TestConnection, TestError>> {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    const messages: unknown[] = [];
    let messageResolvers: Array<{
      predicate?: (message: unknown) => boolean;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeoutId: NodeJS.Timeout;
    }> = [];
    const rawAuthToken =
      token ?? process.env.TEST_GATEWAY_AUTH_TOKEN ?? process.env.GATEWAY_AUTH_TOKEN;
    const authToken = typeof rawAuthToken === "string" && rawAuthToken.trim().length > 0
      ? rawAuthToken
      : undefined;
    const authRequestId = authToken ? `auth-${Date.now()}` : null;

    const timeoutId = setTimeout(() => {
      ws.close();
      resolve(err(new TestError("Connection timeout", "CONNECTION_TIMEOUT")));
    }, timeout);

    ws.on("open", () => {
      if (authToken) {
        ws.send(
          JSON.stringify({
            type: "auth",
            id: authRequestId,
            payload: { token: authToken },
          })
        );
      } else {
        clearTimeout(timeoutId);
      }
    });

    ws.on("message", (data) => {
      const message = JSON.parse(data.toString());

      // Handle auth success
      if (message.type === "auth_success") {
        if (authRequestId && message.id && message.id !== authRequestId) {
          // Ignore unrelated auth_success
        } else if (authRequestId && !message.id) {
          // Ignore generic auth_success when expecting a response to our auth
        } else {
          clearTimeout(timeoutId);
          resolve(
            ok({
              ws,
              send: (msg) => ws.send(JSON.stringify(msg)),
              receive: async (rxTimeout = 10000, predicate?: (message: unknown) => boolean) => {
                if (messages.length > 0) {
                  if (!predicate) {
                    return messages.shift();
                  }
                  const index = messages.findIndex((msg) => predicate(msg));
                  if (index >= 0) {
                    const [matched] = messages.splice(index, 1);
                    return matched;
                  }
                }
                return new Promise((res, rej) => {
                  const entry = {
                    predicate,
                    resolve: res,
                    reject: rej,
                    timeoutId: setTimeout(() => {
                      const index = messageResolvers.indexOf(entry);
                      if (index >= 0) {
                        messageResolvers.splice(index, 1);
                      }
                      rej(new Error("Receive timeout"));
                    }, rxTimeout),
                  };
                  messageResolvers.push(entry);
                });
              },
              close: () => ws.close(),
            })
          );
          return;
        }
        return;
      }

      if (message.type === "auth_required" && !authToken) {
        clearTimeout(timeoutId);
        resolve(
          err(new TestError("Authentication required", "AUTH_REQUIRED"))
        );
        return;
      }

      if (message.type === "auth_failed") {
        clearTimeout(timeoutId);
        resolve(err(new TestError("Authentication failed", "AUTH_FAILED")));
        return;
      }

      // Deliver to matching receiver if possible
      if (messageResolvers.length > 0) {
        const index = messageResolvers.findIndex((entry) => !entry.predicate || entry.predicate(message));
        if (index >= 0) {
          const entry = messageResolvers.splice(index, 1)[0];
          clearTimeout(entry.timeoutId);
          entry.resolve(message);
          return;
        }
      }

      messages.push(message);
    });

    ws.on("error", (error) => {
      clearTimeout(timeoutId);
      resolve(err(new TestError(`WebSocket error: ${error.message}`, "WEBSOCKET_ERROR")));
    });

    ws.on("close", () => {
      clearTimeout(timeoutId);
      // Resolve any pending receive calls
      messageResolvers.forEach((entry) => {
        clearTimeout(entry.timeoutId);
        entry.resolve({ type: "connection_closed" });
      });
      messageResolvers = [];
    });
  });
}

// ─── AGENT UTILITIES ────────────────────────────────────────

export type AgentState = "idle" | "initializing" | "ready" | "running" | "paused" | "error" | "terminated";

export interface TestAgent {
  id: string;
  connection: TestConnection;
  getState: () => Promise<AgentState>;
  sendTask: (task: unknown) => Promise<unknown>;
  waitForState: (state: AgentState, timeout?: number) => Promise<boolean>;
  terminate: () => Promise<void>;
}

/**
 * Create a test agent via the gateway.
 */
export async function createTestAgent(
  connection: TestConnection,
  manifest: unknown
): Promise<Result<TestAgent, TestError>> {
  try {
    const requestId = `spawn-${generateId()}`;
    const shouldUnique = process.env.TEST_UNIQUE_AGENT_IDS !== "false";
    const manifestValue =
      shouldUnique && manifest && typeof manifest === "object" && "id" in (manifest as Record<string, unknown>)
        ? {
            ...(manifest as Record<string, unknown>),
            id: `${String((manifest as Record<string, unknown>).id)}-${generateId()}`,
          }
        : manifest;

    // Send spawn request
    connection.send({
      type: "agent_spawn",
      id: requestId,
      payload: { manifest: manifestValue },
    });

    // Wait for response
    const response = (await connection.receive(30000, (msg) => {
      const candidate = msg as { id?: string };
      return candidate?.id === requestId;
    })) as {
      type: string;
      id?: string;
      payload?: { agentId?: string; status?: string; message?: string };
    };

    if (response.type === "error") {
      if (response.payload && typeof response.payload === "object") {
        const payload = response.payload as { message?: string; code?: string };
        console.warn(
          `Agent spawn failed: ${payload.code ?? "UNKNOWN"} ${payload.message ?? "Unknown error"}`
        );
      }
      return err(
        new TestError(
          `Agent spawn failed: ${response.payload?.message || "Unknown error"}`,
          "AGENT_SPAWN_FAILED"
        )
      );
    }

    if (response.type !== "agent_spawn_result" || !response.payload?.agentId) {
      return err(new TestError("Invalid spawn response", "INVALID_RESPONSE", response));
    }

    const agentId = response.payload.agentId;

    const agent: TestAgent = {
      id: agentId,
      connection,

      getState: async () => {
        const requestId = `status-${generateId()}`;
        connection.send({
          type: "agent_status",
          id: requestId,
          payload: { agentId },
        });
        const statusResp = (await connection.receive(10000, (msg) => {
          const candidate = msg as { id?: string };
          return candidate?.id === requestId;
        })) as {
          type?: string;
          payload?: { state?: AgentState; agents?: Array<{ id?: string; externalId?: string; state?: AgentState }> };
        };
        if (process.env.TEST_DEBUG === "true") {
          console.log("[test-utils] agent_status response", statusResp);
        }
        if (statusResp.payload?.state) {
          return statusResp.payload.state;
        }
        if (statusResp.type === "agent_list" && Array.isArray(statusResp.payload?.agents)) {
          const match = statusResp.payload.agents.find(
            (entry) => entry.id === agentId || entry.externalId === agentId
          );
          if (match?.state) return match.state;
        }
        return "error";
      },

      sendTask: async (task: unknown) => {
        const taskId = `task-${generateId()}`;
        connection.send({
          type: "agent_task",
          id: taskId,
          payload: { agentId, task },
        });
        const response = await connection.receive(60000, (msg) => {
          const candidate = msg as { id?: string };
          return candidate?.id === taskId;
        });
        if (process.env.TEST_DEBUG === "true") {
          const responseType = (response as { type?: string }).type;
          if (responseType === "error") {
            console.log("[test-utils] agent task error", { task, response });
          }
        }
        const payload = (response as { payload?: unknown })?.payload;
        if (
          response &&
          typeof response === "object" &&
          (response as { type?: string }).type === "agent_task_result" &&
          payload &&
          typeof payload === "object" &&
          "result" in payload
        ) {
          const resultPayload = (payload as { result?: unknown }).result;
          if (resultPayload && typeof resultPayload === "object") {
            return { ...response, payload: resultPayload };
          }
        }
        return response;
      },

      waitForState: async (targetState: AgentState, timeout = 30000) => {
        const startTime = Date.now();
        while (Date.now() - startTime < timeout) {
          const currentState = await agent.getState();
          if (process.env.TEST_DEBUG === "true") {
            console.log("[test-utils] waitForState", { targetState, currentState });
          }
          if (currentState === targetState) return true;
          await sleep(200);
        }
        return false;
      },

      terminate: async () => {
        const requestId = `terminate-${generateId()}`;
        connection.send({
          type: "agent_terminate",
          id: requestId,
          payload: { agentId },
        });
        await connection.receive(10000, (msg) => {
          const candidate = msg as { id?: string };
          return candidate?.id === requestId;
        });
      },
    };

    return ok(agent);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(new TestError(`Failed to create agent: ${message}`, "AGENT_CREATE_ERROR"));
  }
}

/**
 * Wait for an agent to reach a specific state.
 */
export async function waitForState(
  agent: TestAgent,
  targetState: AgentState,
  timeout: number = 30000
): Promise<boolean> {
  return agent.waitForState(targetState, timeout);
}

/**
 * Send a task to an agent and wait for result.
 */
export async function sendTask(agent: TestAgent, task: unknown): Promise<unknown> {
  return agent.sendTask(task);
}

// ─── DATABASE UTILITIES ─────────────────────────────────────

/**
 * Clear all test data from the database.
 */
export async function clearTestDatabase(postgresUrl: string): Promise<Result<void, TestError>> {
  try {
    // Import pg dynamically to avoid requiring it in all contexts
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: postgresUrl });

    await pool.query("BEGIN");

    // Delete in correct order for foreign key constraints
    await pool.query("DELETE FROM agent_permissions");
    await pool.query("DELETE FROM capability_tokens");
    await pool.query("DELETE FROM agent_state_history");
    await pool.query("DELETE FROM task_messages");
    await pool.query("DELETE FROM tasks");
    await pool.query("DELETE FROM episodic_memories");
    await pool.query("DELETE FROM semantic_memories");
    await pool.query("DELETE FROM procedural_memories");
    await pool.query("DELETE FROM events");
    await pool.query("DELETE FROM provider_usage");
    await pool.query("DELETE FROM audit_log");
    await pool.query("DELETE FROM moderation_appeals");
    await pool.query("DELETE FROM sanctions");
    await pool.query("DELETE FROM moderation_cases");
    await pool.query("DELETE FROM policies");
    await pool.query("DELETE FROM forum_posts");
    await pool.query("DELETE FROM forums");
    await pool.query("DELETE FROM job_applications");
    await pool.query("DELETE FROM jobs");
    await pool.query("DELETE FROM agent_reputation");
    await pool.query("DELETE FROM skills");
    await pool.query("DELETE FROM permissions");
    await pool.query("DELETE FROM agents");
    // Don't clear migrations - need to track schema state

    await pool.query("COMMIT");
    await pool.end();

    return ok(undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(new TestError(`Failed to clear database: ${message}`, "DB_CLEAR_ERROR"));
  }
}

/**
 * Query the database directly for test verification.
 */
export async function queryDatabase<T>(
  postgresUrl: string,
  query: string,
  params: unknown[] = []
): Promise<Result<T[], TestError>> {
  try {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: postgresUrl });
    const result = await pool.query(query, params);
    await pool.end();
    return ok(result.rows as T[]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(new TestError(`Database query failed: ${message}`, "DB_QUERY_ERROR"));
  }
}

// ─── INFRASTRUCTURE UTILITIES ───────────────────────────────

/**
 * Check if Docker services are running.
 */
export async function checkTestInfrastructure(config: TestConfig = defaultTestConfig): Promise<{
  postgres: boolean;
  qdrant: boolean;
  redis: boolean;
}> {
  if (process.env.SKIP_INFRA_CHECK === "true") {
    return { postgres: true, qdrant: true, redis: true };
  }
  const checks = {
    postgres: false,
    qdrant: false,
    redis: false,
  };

  // Check PostgreSQL
  try {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: config.postgresUrl, connectionTimeoutMillis: 2000 });
    await pool.query("SELECT 1");
    await pool.end();
    checks.postgres = true;
  } catch {
    // Postgres not available
  }

  // Check Qdrant
  try {
    const response = await fetch(`${config.qdrantUrl}/collections`, {
      signal: AbortSignal.timeout(2000),
    });
    if (response.ok) {
      const data = (await response.json()) as { status?: string };
      checks.qdrant = data.status === "ok";
    } else {
      checks.qdrant = false;
    }
  } catch {
    // Qdrant not available
  }

  // Check Redis
  try {
    const { createClient } = await import("redis");
    const client = createClient({ url: config.redisUrl });
    await client.connect();
    await client.ping();
    await client.disconnect();
    checks.redis = true;
  } catch {
    // Redis not available
  }

  return checks;
}

/**
 * Start test infrastructure with Docker Compose.
 */
export async function startTestInfrastructure(): Promise<Result<void, TestError>> {
  try {
    const composePath = resolveTestComposePath();
    if (!composePath) {
      return err(new TestError("docker-compose.test.yml not found", "INFRA_START_ERROR"));
    }
    await execAsync(`docker compose -f ${composePath} up -d`);

    // Wait for services to be healthy
    const maxWait = 60000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      const status = await checkTestInfrastructure();
      if (status.postgres && status.qdrant && status.redis) {
        return ok(undefined);
      }
      await sleep(1000);
    }

    return err(new TestError("Timeout waiting for infrastructure", "INFRA_TIMEOUT"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(new TestError(`Failed to start infrastructure: ${message}`, "INFRA_START_ERROR"));
  }
}

/**
 * Stop test infrastructure.
 */
export async function stopTestInfrastructure(): Promise<Result<void, TestError>> {
  try {
    const composePath = resolveTestComposePath();
    if (!composePath) {
      return err(new TestError("docker-compose.test.yml not found", "INFRA_STOP_ERROR"));
    }
    await execAsync(`docker compose -f ${composePath} down`);
    return ok(undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(new TestError(`Failed to stop infrastructure: ${message}`, "INFRA_STOP_ERROR"));
  }
}

// ─── MOCK UTILITIES ─────────────────────────────────────────

/**
 * Create a mock LLM provider that returns canned responses.
 */
export function createMockProvider(responses: Map<string, string>) {
  return {
    complete: async (prompt: string) => {
      for (const [pattern, response] of responses.entries()) {
        if (prompt.includes(pattern)) {
          return { content: response, tokens: { input: 10, output: 20 } };
        }
      }
      return { content: "Mock response", tokens: { input: 10, output: 5 } };
    },
  };
}

/**
 * Simulate a provider failure (rate limit, timeout, etc.)
 */
export function createFailingProvider(errorType: "rate_limit" | "timeout" | "server_error") {
  return {
    complete: async () => {
      switch (errorType) {
        case "rate_limit":
          throw Object.assign(new Error("Rate limited"), { status: 429 });
        case "timeout":
          await sleep(120000);
          throw new Error("Timeout");
        case "server_error":
          throw Object.assign(new Error("Internal server error"), { status: 500 });
      }
    },
  };
}

// ─── HELPER FUNCTIONS ───────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isPortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => {
      resolve(false);
    });
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

function resolveTestComposePath(): string | undefined {
  const candidates = [
    resolve(process.cwd(), "docker/docker-compose.test.yml"),
    resolve(process.cwd(), "../docker/docker-compose.test.yml"),
    resolve(process.cwd(), "../../docker/docker-compose.test.yml"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

export function generateId(): string {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function withTimeout<T>(promise: Promise<T>, ms: number, message = "Timeout"): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

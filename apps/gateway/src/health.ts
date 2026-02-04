// Health Check HTTP Server for AgentRun Gateway
// Provides /health endpoint for monitoring with Zod validation

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { z } from "zod";
import { type Logger, createLogger } from "@agentrun/kernel";
import { type HealthStatus, HealthStatusSchema } from "./types.js";

/** Health server configuration schema */
export const HealthServerConfigSchema = z.object({
  port: z.number().int().min(1).max(65535),
  host: z.string().min(1),
});

export type HealthServerConfig = z.infer<typeof HealthServerConfigSchema>;

/** Health status provider function */
export type HealthProvider = () => Omit<HealthStatus, "timestamp" | "uptime">;
export type MetricsProvider = () => string[] | string;

/** Health server interface */
export interface HealthServer {
  close(): void;
}

/**
 * Create the health check HTTP server.
 * Provides /health, /ready, and /metrics endpoints.
 */
export function createHealthServer(
  config: HealthServerConfig,
  getStatus: HealthProvider,
  getMetrics?: MetricsProvider
): HealthServer {
  // Validate config
  const configResult = HealthServerConfigSchema.safeParse(config);
  if (!configResult.success) {
    throw new Error(`Invalid health server config: ${configResult.error.message}`);
  }

  const log = createLogger({ name: "health-server" });
  const startTime = Date.now();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Security headers
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-XSS-Protection", "0");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", "default-src 'none'");

    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    log.debug("Health request", { path: url.pathname, method: req.method });

    switch (url.pathname) {
      case "/health":
      case "/healthz":
        handleHealth(res, startTime, getStatus);
        break;

      case "/ready":
      case "/readiness":
        handleReady(res, getStatus);
        break;

      case "/live":
      case "/liveness":
        handleLive(res);
        break;

      case "/metrics":
        handleMetrics(res, startTime, getStatus, getMetrics);
        break;

      case "/":
        handleRoot(res);
        break;

      default:
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
    }
  });

  server.listen(config.port, config.host, () => {
    log.info("Health server ready", {
      url: `http://${config.host}:${config.port}/health`,
    });
  });

  server.on("error", (error) => {
    log.error("Health server error", { error: error.message });
  });

  return {
    close() {
      server.close();
      log.info("Health server closed");
    },
  };
}

/** Handle /health endpoint */
function handleHealth(
  res: ServerResponse,
  startTime: number,
  getStatus: HealthProvider
): void {
  const status = getStatus();
  const health: HealthStatus = {
    ...status,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    timestamp: Date.now(),
  };

  // Validate output
  const validation = HealthStatusSchema.safeParse(health);
  if (!validation.success) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid health status" }));
    return;
  }

  res.writeHead(health.status === "error" ? 503 : 200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(health, null, 2));
}

/** Handle /ready endpoint */
function handleReady(
  res: ServerResponse,
  getStatus: HealthProvider
): void {
  const status = getStatus();
  const isReady = status.status !== "error" && status.providers.length > 0;

  res.writeHead(isReady ? 200 : 503, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    ready: isReady,
    providers: status.providers,
    agents: status.agents,
  }));
}

/** Handle /live endpoint */
function handleLive(res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ live: true }));
}

/** Handle /metrics endpoint (Prometheus format) */
function handleMetrics(
  res: ServerResponse,
  startTime: number,
  getStatus: HealthProvider,
  getMetrics?: MetricsProvider
): void {
  const status = getStatus();
  const uptime = Math.floor((Date.now() - startTime) / 1000);

  const baseMetrics = [
    `# HELP agent_os_up Whether AgentRun gateway is up`,
    `# TYPE agent_os_up gauge`,
    `agent_os_up ${status.status === "error" ? 0 : 1}`,
    ``,
    `# HELP agent_os_uptime_seconds Gateway uptime in seconds`,
    `# TYPE agent_os_uptime_seconds counter`,
    `agent_os_uptime_seconds ${uptime}`,
    ``,
    `# HELP agent_os_providers_total Number of registered LLM providers`,
    `# TYPE agent_os_providers_total gauge`,
    `agent_os_providers_total ${status.providers.length}`,
    ``,
    `# HELP agent_os_agents_total Number of running agents`,
    `# TYPE agent_os_agents_total gauge`,
    `agent_os_agents_total ${status.agents}`,
    ``,
    `# HELP agent_os_connections_total Number of WebSocket connections`,
    `# TYPE agent_os_connections_total gauge`,
    `agent_os_connections_total ${status.connections}`,
  ];

  const extra = getMetrics ? getMetrics() : [];
  const extraLines = Array.isArray(extra) ? extra : [extra];
  const metrics = [...baseMetrics, ...extraLines].join("\n");

  res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
  res.end(metrics);
}

/** Handle root endpoint */
function handleRoot(res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      name: "AgentRun Gateway",
      version: "0.1.0",
      endpoints: ["/health", "/ready", "/live", "/metrics"],
    })
  );
}

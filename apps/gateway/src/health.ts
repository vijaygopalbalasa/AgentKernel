// Health Check HTTP Server for Agent OS Gateway
// Provides /health endpoint for monitoring and orchestration

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import type { Logger } from "@agent-os/shared";

/** Health status response */
export interface HealthStatus {
  status: "ok" | "degraded" | "error";
  version: string;
  uptime: number;
  providers: string[];
  agents: number;
  connections: number;
  timestamp: number;
}

/** Health server configuration */
export interface HealthServerConfig {
  port: number;
  host: string;
}

/** Create the health check HTTP server */
export function createHealthServer(
  config: HealthServerConfig,
  logger: Logger,
  getStatus: () => Omit<HealthStatus, "timestamp" | "uptime">
) {
  const startTime = Date.now();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
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

    switch (url.pathname) {
      case "/health":
      case "/healthz":
        handleHealth(res, startTime, getStatus);
        break;

      case "/ready":
      case "/readiness":
        handleReady(res, getStatus);
        break;

      case "/metrics":
        handleMetrics(res, startTime, getStatus);
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
    logger.info("Health server ready", {
      url: `http://${config.host}:${config.port}/health`,
    });
  });

  server.on("error", (error) => {
    logger.error("Health server error", { error: error.message });
  });

  return {
    close() {
      server.close();
      logger.info("Health server closed");
    },
  };
}

/** Handle /health endpoint */
function handleHealth(
  res: ServerResponse,
  startTime: number,
  getStatus: () => Omit<HealthStatus, "timestamp" | "uptime">
) {
  const status = getStatus();
  const health: HealthStatus = {
    ...status,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    timestamp: Date.now(),
  };

  res.writeHead(health.status === "ok" ? 200 : 503, { "Content-Type": "application/json" });
  res.end(JSON.stringify(health, null, 2));
}

/** Handle /ready endpoint */
function handleReady(
  res: ServerResponse,
  getStatus: () => Omit<HealthStatus, "timestamp" | "uptime">
) {
  const status = getStatus();
  const isReady = status.status !== "error" && status.providers.length > 0;

  res.writeHead(isReady ? 200 : 503, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ready: isReady, providers: status.providers }));
}

/** Handle /metrics endpoint (Prometheus format) */
function handleMetrics(
  res: ServerResponse,
  startTime: number,
  getStatus: () => Omit<HealthStatus, "timestamp" | "uptime">
) {
  const status = getStatus();
  const uptime = Math.floor((Date.now() - startTime) / 1000);

  const metrics = [
    `# HELP agent_os_up Whether Agent OS gateway is up`,
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
  ].join("\n");

  res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
  res.end(metrics);
}

/** Handle root endpoint */
function handleRoot(res: ServerResponse) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      name: "Agent OS Gateway",
      version: "0.1.0",
      endpoints: ["/health", "/ready", "/metrics"],
    })
  );
}

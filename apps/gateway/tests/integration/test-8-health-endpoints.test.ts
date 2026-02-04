// Integration Test 8: Health Endpoints
// Tests /health, /ready, /live, and /metrics endpoints (Release Checklist)

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { spawn, ChildProcess } from "child_process";
import {
  defaultTestConfig,
  checkTestInfrastructure,
  sleep,
  waitForHealth,
} from "../helpers/test-utils.js";

describe("Integration Test 8: Health Endpoints", () => {
  let gatewayProcess: ChildProcess | null = null;
  const healthPort = defaultTestConfig.healthPort;

  // Ensure infrastructure is running before tests
  beforeAll(async () => {
    const infra = await checkTestInfrastructure();
    expect(infra.postgres).toBe(true);
    expect(infra.qdrant).toBe(true);
    expect(infra.redis).toBe(true);
  }, 30000);

  // Clean up gateway after each test
  afterEach(async () => {
    if (gatewayProcess) {
      gatewayProcess.kill("SIGTERM");
      await sleep(2000);
      if (gatewayProcess.killed === false) {
        gatewayProcess.kill("SIGKILL");
      }
      gatewayProcess = null;
    }
  });

  afterAll(async () => {
    if (gatewayProcess) {
      gatewayProcess.kill("SIGKILL");
    }
  });

  /** Start gateway process for tests */
  async function startGateway(): Promise<void> {
    gatewayProcess = spawn("node", ["dist/main.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "test",
        GATEWAY_PORT: String(defaultTestConfig.gatewayPort),
        HEALTH_PORT: String(healthPort),
        DATABASE_URL: defaultTestConfig.postgresUrl,
        QDRANT_URL: defaultTestConfig.qdrantUrl,
        REDIS_URL: defaultTestConfig.redisUrl,
        LOG_LEVEL: "info",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const healthResult = await waitForHealth(
      `http://127.0.0.1:${healthPort}/health`,
      30000
    );

    expect(healthResult.ok).toBe(true);
  }

  // ─── /health Endpoint Tests ───────────────────────────────────

  describe("/health endpoint", () => {
    it("should return status ok with all required fields", async () => {
      await startGateway();

      const response = await fetch(`http://127.0.0.1:${healthPort}/health`);
      expect(response.ok).toBe(true);
      expect(response.headers.get("content-type")).toContain("application/json");

      const health = (await response.json()) as {
        status: string;
        version: string;
        uptime: number;
        providers: string[];
        agents: number;
        connections: number;
        timestamp: number;
      };

      expect(health.status).toBe("ok");
      expect(health.version).toBeDefined();
      expect(typeof health.uptime).toBe("number");
      expect(health.uptime).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(health.providers)).toBe(true);
      expect(typeof health.agents).toBe("number");
      expect(typeof health.connections).toBe("number");
      expect(typeof health.timestamp).toBe("number");
    }, 60000);

    it("should also respond at /healthz alias", async () => {
      await startGateway();

      const response = await fetch(`http://127.0.0.1:${healthPort}/healthz`);
      expect(response.ok).toBe(true);

      const health = (await response.json()) as { status: string };
      expect(health.status).toBe("ok");
    }, 60000);

    it("should handle CORS preflight requests", async () => {
      await startGateway();

      const response = await fetch(`http://127.0.0.1:${healthPort}/health`, {
        method: "OPTIONS",
      });

      expect(response.status).toBe(204);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(response.headers.get("Access-Control-Allow-Methods")).toContain("GET");
    }, 60000);
  });

  // ─── /ready Endpoint Tests ────────────────────────────────────

  describe("/ready endpoint", () => {
    it("should return readiness status", async () => {
      await startGateway();

      const response = await fetch(`http://127.0.0.1:${healthPort}/ready`);
      expect(response.ok).toBe(true);
      expect(response.headers.get("content-type")).toContain("application/json");

      const ready = (await response.json()) as {
        ready: boolean;
        providers: string[];
        agents: number;
      };

      expect(typeof ready.ready).toBe("boolean");
      expect(Array.isArray(ready.providers)).toBe(true);
      expect(typeof ready.agents).toBe("number");
    }, 60000);

    it("should also respond at /readiness alias", async () => {
      await startGateway();

      const response = await fetch(`http://127.0.0.1:${healthPort}/readiness`);
      expect(response.ok).toBe(true);

      const ready = (await response.json()) as { ready: boolean };
      expect(typeof ready.ready).toBe("boolean");
    }, 60000);
  });

  // ─── /live Endpoint Tests ─────────────────────────────────────

  describe("/live endpoint", () => {
    it("should return liveness status", async () => {
      await startGateway();

      const response = await fetch(`http://127.0.0.1:${healthPort}/live`);
      expect(response.ok).toBe(true);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");

      const live = (await response.json()) as { live: boolean };
      expect(live.live).toBe(true);
    }, 60000);

    it("should also respond at /liveness alias", async () => {
      await startGateway();

      const response = await fetch(`http://127.0.0.1:${healthPort}/liveness`);
      expect(response.ok).toBe(true);

      const live = (await response.json()) as { live: boolean };
      expect(live.live).toBe(true);
    }, 60000);
  });

  // ─── /metrics Endpoint Tests ──────────────────────────────────

  describe("/metrics endpoint", () => {
    it("should return Prometheus format metrics", async () => {
      await startGateway();

      const response = await fetch(`http://127.0.0.1:${healthPort}/metrics`);
      expect(response.ok).toBe(true);
      expect(response.headers.get("content-type")).toContain("text/plain");

      const metrics = await response.text();

      // Check for required Prometheus metrics
      expect(metrics).toContain("# HELP agent_os_up");
      expect(metrics).toContain("# TYPE agent_os_up gauge");
      expect(metrics).toContain("agent_os_up");

      expect(metrics).toContain("# HELP agent_os_uptime_seconds");
      expect(metrics).toContain("# TYPE agent_os_uptime_seconds counter");
      expect(metrics).toContain("agent_os_uptime_seconds");

      expect(metrics).toContain("# HELP agent_os_providers_total");
      expect(metrics).toContain("# TYPE agent_os_providers_total gauge");
      expect(metrics).toContain("agent_os_providers_total");

      expect(metrics).toContain("# HELP agent_os_agents_total");
      expect(metrics).toContain("# TYPE agent_os_agents_total gauge");
      expect(metrics).toContain("agent_os_agents_total");

      expect(metrics).toContain("# HELP agent_os_connections_total");
      expect(metrics).toContain("# TYPE agent_os_connections_total gauge");
      expect(metrics).toContain("agent_os_connections_total");
    }, 60000);

    it("should report gateway as up when healthy", async () => {
      await startGateway();

      const response = await fetch(`http://127.0.0.1:${healthPort}/metrics`);
      const metrics = await response.text();

      // agent_os_up should be 1 when healthy
      expect(metrics).toMatch(/agent_os_up 1/);
    }, 60000);

    it("should report valid uptime value", async () => {
      await startGateway();

      // Wait a bit so uptime is > 0
      await sleep(1000);

      const response = await fetch(`http://127.0.0.1:${healthPort}/metrics`);
      const metrics = await response.text();

      // Extract uptime value
      const uptimeMatch = metrics.match(/agent_os_uptime_seconds (\d+)/);
      expect(uptimeMatch).not.toBeNull();
      if (uptimeMatch && uptimeMatch[1]) {
        const uptime = parseInt(uptimeMatch[1], 10);
        expect(uptime).toBeGreaterThanOrEqual(0);
      }
    }, 60000);
  });

  // ─── Root Endpoint Tests ──────────────────────────────────────

  describe("/ root endpoint", () => {
    it("should return service info and available endpoints", async () => {
      await startGateway();

      const response = await fetch(`http://127.0.0.1:${healthPort}/`);
      expect(response.ok).toBe(true);
      expect(response.headers.get("content-type")).toContain("application/json");

      const info = (await response.json()) as {
        name: string;
        version: string;
        endpoints: string[];
      };

      expect(info.name).toBe("AgentKernel Gateway");
      expect(info.version).toBeDefined();
      expect(Array.isArray(info.endpoints)).toBe(true);
      expect(info.endpoints).toContain("/health");
      expect(info.endpoints).toContain("/ready");
      expect(info.endpoints).toContain("/live");
      expect(info.endpoints).toContain("/metrics");
    }, 60000);
  });

  // ─── 404 Handling Tests ───────────────────────────────────────

  describe("404 handling", () => {
    it("should return 404 for unknown endpoints", async () => {
      await startGateway();

      const response = await fetch(`http://127.0.0.1:${healthPort}/unknown`);
      expect(response.status).toBe(404);

      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Not found");
    }, 60000);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { OpenClawSecurityProxy } from "./proxy.js";

// ─── CONSTRUCTOR / MODE DETECTION ────────────────────────────

describe("OpenClawSecurityProxy mode detection", () => {
  it("defaults to evaluate mode when no gateway URL", () => {
    const proxy = new OpenClawSecurityProxy();
    expect(proxy.mode).toBe("evaluate");
  });

  it("uses proxy mode when gatewayUrl is provided", () => {
    const proxy = new OpenClawSecurityProxy({ gatewayUrl: "ws://127.0.0.1:18789" });
    expect(proxy.mode).toBe("proxy");
  });

  it("respects explicit mode override", () => {
    const proxy = new OpenClawSecurityProxy({ mode: "evaluate", gatewayUrl: "ws://127.0.0.1:18789" });
    expect(proxy.mode).toBe("evaluate");
  });
});

// ─── URL VALIDATION (proxy mode only) ────────────────────────

describe("OpenClawSecurityProxy URL validation", () => {
  it("blocks non-websocket gateway protocols", () => {
    expect(() => new OpenClawSecurityProxy({ gatewayUrl: "http://example.com" })).toThrow(
      /Only ws:\/\/ and wss:\/\//i,
    );
  });

  it("blocks private network gateway URLs by default", () => {
    expect(() => new OpenClawSecurityProxy({ gatewayUrl: "ws://10.0.0.15:18789" })).toThrow(
      /blocked internal ip/i,
    );
  });

  it("allows localhost URLs without requiring skipSsrfValidation", () => {
    expect(() => new OpenClawSecurityProxy({ gatewayUrl: "ws://127.0.0.1:18789" })).not.toThrow();
  });

  it("allows explicit allowlisted hosts", () => {
    expect(
      () =>
        new OpenClawSecurityProxy({
          gatewayUrl: "ws://metadata.google.internal:18789",
          allowedGatewayHosts: ["metadata.google.internal"],
        }),
    ).not.toThrow();
  });
});

// ─── HTTP API + EVALUATE MODE ────────────────────────────────

describe("OpenClawSecurityProxy evaluate mode HTTP API", () => {
  let proxy: OpenClawSecurityProxy;

  afterEach(async () => {
    if (proxy) {
      await proxy.stop();
    }
  });

  it("starts and stops in evaluate mode", async () => {
    proxy = new OpenClawSecurityProxy({ listenPort: 19901 });
    await proxy.start();
    const stats = proxy.getStats();
    expect(stats.mode).toBe("evaluate");
    expect(stats.activeConnections).toBe(0);
    await proxy.stop();
  });

  it("GET /health returns ok", async () => {
    proxy = new OpenClawSecurityProxy({ listenPort: 19902 });
    await proxy.start();

    const resp = await fetch("http://127.0.0.1:19902/health");
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.status).toBe("ok");
    expect(body.mode).toBe("evaluate");
  });

  it("GET /stats returns statistics", async () => {
    proxy = new OpenClawSecurityProxy({ listenPort: 19903 });
    await proxy.start();

    const resp = await fetch("http://127.0.0.1:19903/stats");
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.mode).toBe("evaluate");
    expect(body.totalMessages).toBe(0);
  });

  it("GET /audit returns empty array initially", async () => {
    proxy = new OpenClawSecurityProxy({ listenPort: 19904 });
    await proxy.start();

    const resp = await fetch("http://127.0.0.1:19904/audit");
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("POST /evaluate blocks dangerous commands", async () => {
    proxy = new OpenClawSecurityProxy({
      listenPort: 19905,
      policySet: {
        file: {
          default: "block",
          rules: [{ pattern: "**/.ssh/**", decision: "block", reason: "SSH credentials" }],
        },
      },
    });
    await proxy.start();

    const resp = await fetch("http://127.0.0.1:19905/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "read", args: { path: "/home/user/.ssh/id_rsa" } }),
    });
    const body = await resp.json();
    expect(body.decision).toBe("blocked");
    expect(body.tool).toBe("read");
  });

  it("POST /evaluate allows safe commands", async () => {
    proxy = new OpenClawSecurityProxy({
      listenPort: 19906,
      policySet: {
        name: "test-allow",
        defaultDecision: "allow",
      },
    });
    await proxy.start();

    const resp = await fetch("http://127.0.0.1:19906/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "bash", args: { command: "git status" } }),
    });
    const body = await resp.json();
    expect(body.decision).toBe("allowed");
  });

  it("POST /evaluate returns 400 for empty body", async () => {
    proxy = new OpenClawSecurityProxy({ listenPort: 19907 });
    await proxy.start();

    const resp = await fetch("http://127.0.0.1:19907/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "",
    });
    expect(resp.status).toBe(400);
  });

  it("POST /evaluate accepts MCP format", async () => {
    proxy = new OpenClawSecurityProxy({
      listenPort: 19908,
      policySet: { name: "test-mcp", defaultDecision: "allow" },
    });
    await proxy.start();

    const resp = await fetch("http://127.0.0.1:19908/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "tools/call",
        params: { name: "bash", arguments: { command: "ls" } },
      }),
    });
    const body = await resp.json();
    expect(resp.status).toBe(200);
    expect(body.tool).toBe("bash");
    expect(body.decision).toBe("allowed");
  });

  it("GET /unknown returns 404 with endpoint list", async () => {
    proxy = new OpenClawSecurityProxy({ listenPort: 19909 });
    await proxy.start();

    const resp = await fetch("http://127.0.0.1:19909/unknown");
    expect(resp.status).toBe(404);
    const body = await resp.json();
    expect(body.endpoints).toBeDefined();
  });
});

// ─── WEBSOCKET EVALUATE MODE ─────────────────────────────────

describe("OpenClawSecurityProxy WebSocket evaluate mode", () => {
  let proxy: OpenClawSecurityProxy;

  afterEach(async () => {
    if (proxy) {
      await proxy.stop();
    }
  });

  it("evaluates tool calls via WebSocket", async () => {
    proxy = new OpenClawSecurityProxy({ listenPort: 19910 });
    await proxy.start();

    const { WebSocket } = await import("ws");
    const ws = new WebSocket("ws://127.0.0.1:19910");

    const response = await new Promise<string>((resolve, reject) => {
      ws.on("open", () => {
        ws.send(JSON.stringify({ tool: "bash", args: { command: "ls" } }));
      });
      ws.on("message", (data) => {
        resolve(data.toString());
        ws.close();
      });
      ws.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 5000);
    });

    const parsed = JSON.parse(response);
    expect(parsed.tool).toBe("bash");
    expect(["allowed", "blocked"]).toContain(parsed.decision);
  });
});

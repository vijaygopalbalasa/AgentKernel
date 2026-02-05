// AgentKernel Security Proxy — standalone evaluation + gateway proxy modes

import * as http from "node:http";
import type { PolicySet } from "@agentkernel/runtime";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import {
  type OpenClawAuditLogger,
  type OpenClawAuditSink,
  createOpenClawAuditLogger,
} from "./audit.js";
import {
  type InterceptorConfig,
  type ToolCall,
  type ToolInterceptor,
  createToolInterceptor,
} from "./interceptor.js";
import { type NormalizedMessage, formatResponse, normalizeMessage } from "./message-normalizer.js";

// ─── MESSAGE SCHEMAS (legacy, kept for proxy mode passthrough) ───

/** OpenClaw Gateway message types */
const GatewayMessageSchema = z.object({
  type: z.string(),
  id: z.string().optional(),
  sessionId: z.string().optional(),
  data: z.unknown().optional(),
});

/** Tool result message */
const ToolResultMessageSchema = z.object({
  type: z.literal("tool_result"),
  id: z.string(),
  sessionId: z.string().optional(),
  data: z.object({
    result: z.unknown().optional(),
    error: z.string().optional(),
  }),
});

// ─── SECURITY: URL VALIDATION ───────────────────────────────────

/** Blocked IP patterns for SSRF prevention */
const BLOCKED_IP_PATTERNS = [
  /^127\./, // Loopback
  /^0\./, // Current network
  /^10\./, // Private Class A
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // Private Class B
  /^192\.168\./, // Private Class C
  /^169\.254\./, // Link-local
  /^::1$/, // IPv6 loopback
  /^fe80:/i, // IPv6 link-local
  /^fc00:/i, // IPv6 unique local
  /^fd[0-9a-f]{2}:/i, // IPv6 unique local
];

/** Blocked hostnames for SSRF prevention */
const BLOCKED_HOSTNAMES = [
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "169.254.169.254", // Cloud metadata endpoint
];

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18789";

/**
 * Validate a gateway URL is safe (not internal/metadata).
 * Throws if URL is unsafe for SSRF protection.
 */
function validateGatewayUrl(urlString: string, allowedHosts?: string[]): void {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error(`Invalid gateway URL: ${urlString}`);
  }

  // Only allow ws:// or wss:// protocols
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(
      `Invalid gateway URL protocol: ${url.protocol}. Only ws:// and wss:// are allowed.`,
    );
  }

  const hostname = url.hostname.toLowerCase();

  // Check against allowlist if provided
  if (allowedHosts && allowedHosts.length > 0) {
    if (!allowedHosts.some((h) => h.toLowerCase() === hostname)) {
      throw new Error(`Gateway hostname '${hostname}' not in allowed hosts list`);
    }
    return; // Allowlist takes precedence
  }

  // Block internal hostnames
  for (const blocked of BLOCKED_HOSTNAMES) {
    if (hostname === blocked.toLowerCase()) {
      throw new Error(`Gateway URL points to blocked internal host: ${hostname}`);
    }
  }

  // Block internal IP patterns
  for (const pattern of BLOCKED_IP_PATTERNS) {
    if (pattern.test(hostname)) {
      throw new Error(`Gateway URL points to blocked internal IP: ${hostname}`);
    }
  }
}

function getHostname(urlString: string): string | null {
  try {
    return new URL(urlString).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// ─── RATE LIMITING ───────────────────────────────────────────────

interface RateLimiter {
  /** Check if action is allowed, consuming a token if so */
  tryConsume(): boolean;
  /** Get remaining tokens */
  remaining(): number;
  /** Reset the limiter */
  reset(): void;
}

/**
 * Token bucket rate limiter.
 */
function createRateLimiter(
  maxTokens: number,
  refillRate: number,
  refillIntervalMs: number,
): RateLimiter {
  let tokens = maxTokens;
  let lastRefill = Date.now();

  return {
    tryConsume(): boolean {
      const now = Date.now();
      const elapsed = now - lastRefill;
      const refills = Math.floor(elapsed / refillIntervalMs);

      if (refills > 0) {
        tokens = Math.min(maxTokens, tokens + refills * refillRate);
        lastRefill = now - (elapsed % refillIntervalMs);
      }

      if (tokens > 0) {
        tokens--;
        return true;
      }
      return false;
    },
    remaining(): number {
      return tokens;
    },
    reset(): void {
      tokens = maxTokens;
      lastRefill = Date.now();
    },
  };
}

// ─── PROXY CONFIGURATION ───────────────────────────────────────

export type ProxyMode = "proxy" | "evaluate";

export interface OpenClawProxyConfig {
  /** Operating mode: "proxy" forwards to gateway, "evaluate" is standalone.
   * Auto-detected: "evaluate" when no gatewayUrl, "proxy" when gatewayUrl is set. */
  mode?: ProxyMode;
  /** Port to listen on (default: 18788) */
  listenPort?: number;
  /** Host/IP to bind to (default: "0.0.0.0" — all interfaces) */
  listenHost?: string;
  /** OpenClaw Gateway URL — only needed in proxy mode */
  gatewayUrl?: string;
  /** Allowed gateway hosts (if set, only these hosts are permitted) */
  allowedGatewayHosts?: string[];
  /** Skip SSRF validation (DANGEROUS - only for trusted local development) */
  skipSsrfValidation?: boolean;
  /** Policy set for security enforcement */
  policySet?: Partial<PolicySet>;
  /** Agent ID for audit logging */
  agentId?: string;
  /** Audit sinks for logging */
  auditSinks?: OpenClawAuditSink[];
  /** Callback for approval requests */
  onApprovalRequest?: (call: ToolCall) => Promise<boolean>;
  /** Callback for security events */
  onSecurityEvent?: (event: {
    type: "blocked" | "allowed" | "approval_required" | "rate_limited";
    tool: string;
    reason: string;
  }) => void;
  /** Rate limit: max messages per second per connection (default: 100) */
  maxMessagesPerSecond?: number;
  /** Max message size in bytes (default: 1MB) */
  maxMessageSizeBytes?: number;
  /** Message processing timeout in ms (default: 30000) */
  messageTimeoutMs?: number;
}

export interface OpenClawProxyStats {
  /** Operating mode */
  mode: ProxyMode;
  /** Number of active connections */
  activeConnections: number;
  /** Total messages processed */
  totalMessages: number;
  /** Total tool calls intercepted */
  totalToolCalls: number;
  /** Tool calls blocked */
  blockedCalls: number;
  /** Tool calls allowed */
  allowedCalls: number;
  /** Messages rate-limited */
  rateLimitedMessages: number;
  /** Uptime in seconds */
  uptimeSeconds: number;
}

// ─── ERROR TYPES ────────────────────────────────────────────────

export interface ProxyError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

function createProxyError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): ProxyError {
  return { code, message, details };
}

// ─── HTTP HELPERS ──────────────────────────────────────────────

function readBody(req: http.IncomingMessage, maxSize: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxSize) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function jsonResponse(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data));
}

// ─── SECURITY PROXY ────────────────────────────────────────────

/**
 * AgentKernel Security Proxy — standalone evaluation + gateway proxy.
 *
 * **Evaluate mode** (default, no gateway needed):
 *   Accepts tool calls via HTTP API or WebSocket, evaluates against policies,
 *   returns allowed/blocked decisions. Supports OpenClaw, MCP/JSON-RPC, and Simple formats.
 *
 * **Proxy mode** (when --gateway is specified):
 *   WebSocket proxy between client and gateway. Intercepts tool calls,
 *   blocks dangerous ones, forwards allowed ones to the gateway.
 */
export class OpenClawSecurityProxy {
  readonly mode: ProxyMode;
  private readonly config: Required<
    Omit<
      OpenClawProxyConfig,
      "mode" | "auditSinks" | "onApprovalRequest" | "onSecurityEvent" | "allowedGatewayHosts" | "gatewayUrl"
    >
  > & {
    gatewayUrl: string;
    auditSinks: OpenClawAuditSink[];
    onApprovalRequest?: (call: ToolCall) => Promise<boolean>;
    onSecurityEvent?: OpenClawProxyConfig["onSecurityEvent"];
    allowedGatewayHosts?: string[];
  };
  private httpServer: http.Server | null = null;
  private wsServer: WebSocketServer | null = null;
  private interceptor: ToolInterceptor;
  private auditLogger: OpenClawAuditLogger;
  private connections: Map<WebSocket, { gateway?: WebSocket; rateLimiter: RateLimiter }> =
    new Map();
  private messageCount = 0;
  private rateLimitedCount = 0;
  private startTime: Date | null = null;

  constructor(config: OpenClawProxyConfig = {}) {
    // Determine mode
    this.mode = config.mode ?? (config.gatewayUrl ? "proxy" : "evaluate");

    const gatewayUrl = config.gatewayUrl ?? (this.mode === "proxy" ? DEFAULT_GATEWAY_URL : "");

    // In proxy mode, validate the gateway URL
    if (this.mode === "proxy" && gatewayUrl) {
      const hostname = getHostname(gatewayUrl);
      const derivedAllowedHosts =
        config.allowedGatewayHosts ??
        (hostname && LOOPBACK_HOSTS.has(hostname) ? [hostname] : undefined);

      if (!config.skipSsrfValidation) {
        validateGatewayUrl(gatewayUrl, derivedAllowedHosts);
      }

      this.config = {
        listenPort: config.listenPort ?? 18788,
        listenHost: config.listenHost ?? "0.0.0.0",
        gatewayUrl,
        allowedGatewayHosts: derivedAllowedHosts,
        skipSsrfValidation: config.skipSsrfValidation ?? false,
        policySet: config.policySet ?? {},
        agentId: config.agentId ?? "agentkernel",
        auditSinks: config.auditSinks ?? [],
        onApprovalRequest: config.onApprovalRequest,
        onSecurityEvent: config.onSecurityEvent,
        maxMessagesPerSecond: config.maxMessagesPerSecond ?? 100,
        maxMessageSizeBytes: config.maxMessageSizeBytes ?? 1024 * 1024,
        messageTimeoutMs: config.messageTimeoutMs ?? 30000,
      };
    } else {
      // Evaluate mode — no gateway URL needed
      this.config = {
        listenPort: config.listenPort ?? 18788,
        listenHost: config.listenHost ?? "0.0.0.0",
        gatewayUrl: "",
        skipSsrfValidation: true,
        policySet: config.policySet ?? {},
        agentId: config.agentId ?? "agentkernel",
        auditSinks: config.auditSinks ?? [],
        onApprovalRequest: config.onApprovalRequest,
        onSecurityEvent: config.onSecurityEvent,
        maxMessagesPerSecond: config.maxMessagesPerSecond ?? 100,
        maxMessageSizeBytes: config.maxMessageSizeBytes ?? 1024 * 1024,
        messageTimeoutMs: config.messageTimeoutMs ?? 30000,
      };
    }

    // Create interceptor
    const interceptorConfig: InterceptorConfig = {
      policySet: this.config.policySet,
      agentId: this.config.agentId,
      logAllCalls: true,
      onApprovalRequest: this.config.onApprovalRequest
        ? async (call) => {
            if (this.config.onApprovalRequest) {
              return this.config.onApprovalRequest(call);
            }
            return false;
          }
        : undefined,
      onBlocked: (call, evaluation) => {
        this.config.onSecurityEvent?.({
          type: "blocked",
          tool: call.tool,
          reason: evaluation.reason,
        });
      },
      onAllowed: (call, evaluation) => {
        this.config.onSecurityEvent?.({
          type: "allowed",
          tool: call.tool,
          reason: evaluation.reason,
        });
      },
    };

    this.interceptor = createToolInterceptor(interceptorConfig);
    // Fix duplicate logging: only add console sink if no sinks were provided
    this.auditLogger = createOpenClawAuditLogger({
      sinks: this.config.auditSinks,
      includeConsole: this.config.auditSinks.length === 0,
    });
  }

  /**
   * Start the security proxy (HTTP + WebSocket on same port).
   */
  async start(): Promise<void> {
    if (this.httpServer) {
      throw new Error("Proxy already started");
    }

    this.startTime = new Date();

    return new Promise((resolve, reject) => {
      // Create HTTP server for API endpoints
      this.httpServer = http.createServer((req, res) => {
        this.handleHttpRequest(req, res).catch(() => {
          if (!res.headersSent) {
            jsonResponse(res, 500, { error: "Internal server error" });
          }
        });
      });

      // Attach WebSocket server to the HTTP server
      this.wsServer = new WebSocketServer({
        server: this.httpServer,
        maxPayload: this.config.maxMessageSizeBytes,
      });

      this.wsServer.on("connection", (clientWs) => {
        this.handleClientConnection(clientWs);
      });

      this.httpServer.on("error", (error) => {
        reject(error);
      });

      this.httpServer.listen(this.config.listenPort, this.config.listenHost, () => {
        this.auditLogger.log({
          type: "proxy_started",
          agentId: this.config.agentId,
          details: {
            mode: this.mode,
            listenPort: this.config.listenPort,
            listenHost: this.config.listenHost,
            gatewayUrl: this.mode === "proxy" ? this.config.gatewayUrl : undefined,
            maxMessagesPerSecond: this.config.maxMessagesPerSecond,
            maxMessageSizeBytes: this.config.maxMessageSizeBytes,
          },
        });
        resolve();
      });
    });
  }

  /**
   * Stop the security proxy.
   */
  async stop(): Promise<void> {
    // Close all connections
    for (const [clientWs, conn] of this.connections) {
      try {
        clientWs.close();
      } catch {
        // Ignore
      }
      if (conn.gateway) {
        try {
          conn.gateway.close();
        } catch {
          // Ignore
        }
      }
    }
    this.connections.clear();

    return new Promise((resolve) => {
      const finish = () => {
        this.auditLogger.log({
          type: "proxy_stopped",
          agentId: this.config.agentId,
        });
        resolve();
      };

      if (this.wsServer) {
        this.wsServer.close(() => {
          this.wsServer = null;
          if (this.httpServer) {
            this.httpServer.close(() => {
              this.httpServer = null;
              finish();
            });
          } else {
            finish();
          }
        });
      } else if (this.httpServer) {
        this.httpServer.close(() => {
          this.httpServer = null;
          finish();
        });
      } else {
        finish();
      }
    });
  }

  /**
   * Get proxy statistics.
   */
  getStats(): OpenClawProxyStats {
    const interceptorStats = this.interceptor.getStats();
    return {
      mode: this.mode,
      activeConnections: this.connections.size,
      totalMessages: this.messageCount,
      totalToolCalls: interceptorStats.totalCalls,
      blockedCalls: interceptorStats.blockedCalls,
      allowedCalls: interceptorStats.allowedCalls,
      rateLimitedMessages: this.rateLimitedCount,
      uptimeSeconds: this.startTime
        ? Math.floor((Date.now() - this.startTime.getTime()) / 1000)
        : 0,
    };
  }

  /**
   * Get audit log entries.
   */
  getAuditLog() {
    return this.interceptor.getAuditLog();
  }

  // ─── HTTP API ──────────────────────────────────────────────────

  private async handleHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      jsonResponse(res, 200, {
        status: "ok",
        mode: this.mode,
        uptime: this.getStats().uptimeSeconds,
        version: "0.1.3",
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/stats") {
      jsonResponse(res, 200, this.getStats());
      return;
    }

    if (req.method === "GET" && url.pathname === "/audit") {
      const limit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
      const entries = this.getAuditLog();
      jsonResponse(res, 200, entries.slice(-Math.min(limit, 1000)));
      return;
    }

    if (req.method === "POST" && url.pathname === "/evaluate") {
      await this.handleEvaluateRequest(req, res);
      return;
    }

    jsonResponse(res, 404, {
      error: "Not found",
      endpoints: {
        "GET /health": "Health check",
        "POST /evaluate": "Evaluate a tool call against policies",
        "GET /stats": "Live proxy statistics",
        "GET /audit": "Recent audit entries",
      },
    });
  }

  private async handleEvaluateRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: string;
    try {
      body = await readBody(req, this.config.maxMessageSizeBytes);
    } catch {
      jsonResponse(res, 413, { error: "Request body too large" });
      return;
    }

    if (!body.trim()) {
      jsonResponse(res, 400, {
        error: "Empty request body",
        example: { tool: "bash", args: { command: "cat ~/.ssh/id_rsa" } },
      });
      return;
    }

    const normalized = normalizeMessage(body);
    if (!normalized) {
      jsonResponse(res, 400, {
        error: "Unrecognized message format",
        supported: [
          { format: "simple", example: { tool: "bash", args: { command: "ls" } } },
          {
            format: "mcp",
            example: {
              jsonrpc: "2.0",
              id: "1",
              method: "tools/call",
              params: { name: "bash", arguments: { command: "ls" } },
            },
          },
          {
            format: "openclaw",
            example: {
              type: "tool_invoke",
              id: "1",
              data: { tool: "bash", args: { command: "ls" } },
            },
          },
        ],
      });
      return;
    }

    this.messageCount++;
    const startMs = Date.now();
    const result = await this.interceptor.intercept(normalized.toolCall);
    const elapsedMs = Date.now() - startMs;

    this.auditLogger.log({
      type: "tool_intercepted",
      agentId: this.config.agentId,
      toolName: normalized.toolCall.tool,
      decision: result.evaluation?.decision ?? "unknown",
      reason: result.evaluation?.reason,
      details: { args: normalized.toolCall.args, source: "http" },
    });

    const decision = result.allowed
      ? "allowed"
      : result.evaluation?.decision === "approve"
        ? "approval_required"
        : "blocked";

    jsonResponse(res, result.allowed ? 200 : 403, {
      decision,
      reason: result.evaluation?.reason ?? result.error ?? "Unknown",
      tool: normalized.toolCall.tool,
      matchedRule: result.evaluation?.matchedRule ?? undefined,
      executionTimeMs: elapsedMs,
    });
  }

  // ─── WEBSOCKET HANDLING ────────────────────────────────────────

  /**
   * Handle a new client connection.
   */
  private handleClientConnection(clientWs: WebSocket): void {
    const rateLimiter = createRateLimiter(
      this.config.maxMessagesPerSecond,
      this.config.maxMessagesPerSecond,
      1000,
    );

    if (this.mode === "evaluate") {
      this.handleEvaluateConnection(clientWs, rateLimiter);
    } else {
      this.handleProxyConnection(clientWs, rateLimiter);
    }
  }

  /**
   * Evaluate mode: accept tool calls, return decisions. No gateway.
   */
  private handleEvaluateConnection(clientWs: WebSocket, rateLimiter: RateLimiter): void {
    this.connections.set(clientWs, { rateLimiter });

    this.auditLogger.log({
      type: "client_connected",
      agentId: this.config.agentId,
      details: { mode: "evaluate", activeConnections: this.connections.size },
    });

    clientWs.on("message", async (data) => {
      if (!rateLimiter.tryConsume()) {
        this.rateLimitedCount++;
        this.safeSend(
          clientWs,
          JSON.stringify({ error: "Rate limit exceeded", retryAfterMs: 1000 }),
        );
        return;
      }

      this.messageCount++;

      try {
        const message = data.toString();
        const normalized = normalizeMessage(message);

        if (!normalized) {
          this.safeSend(
            clientWs,
            JSON.stringify({
              error: "Unrecognized message format",
              supported: ["OpenClaw", "MCP/JSON-RPC", "Simple ({tool, args})"],
            }),
          );
          return;
        }

        const result = await this.interceptor.intercept(normalized.toolCall);

        this.auditLogger.log({
          type: "tool_intercepted",
          agentId: this.config.agentId,
          toolName: normalized.toolCall.tool,
          decision: result.evaluation?.decision ?? "unknown",
          reason: result.evaluation?.reason,
          details: { args: normalized.toolCall.args, source: "websocket" },
        });

        const response = formatResponse(normalized, result);
        this.safeSend(clientWs, response);
      } catch (error) {
        this.safeSend(
          clientWs,
          JSON.stringify({
            error: error instanceof Error ? error.message : "Internal error",
          }),
        );
      }
    });

    clientWs.on("close", () => {
      this.connections.delete(clientWs);
      this.auditLogger.log({
        type: "client_disconnected",
        agentId: this.config.agentId,
        details: { activeConnections: this.connections.size },
      });
    });

    clientWs.on("error", (error) => {
      this.auditLogger.log({
        type: "client_error",
        agentId: this.config.agentId,
        details: { error: error.message },
      });
    });
  }

  /**
   * Proxy mode: forward to gateway, intercept tool calls using message normalizer.
   */
  private handleProxyConnection(clientWs: WebSocket, rateLimiter: RateLimiter): void {
    // Connect to actual gateway
    let gatewayWs: WebSocket;
    try {
      gatewayWs = new WebSocket(this.config.gatewayUrl);
    } catch (error) {
      this.auditLogger.log({
        type: "gateway_connection_failed",
        agentId: this.config.agentId,
        details: { error: error instanceof Error ? error.message : String(error) },
      });
      clientWs.close(1011, "Failed to connect to gateway");
      return;
    }

    this.auditLogger.log({
      type: "client_connected",
      agentId: this.config.agentId,
      details: { mode: "proxy", activeConnections: this.connections.size + 1 },
    });

    gatewayWs.on("open", () => {
      this.connections.set(clientWs, { gateway: gatewayWs, rateLimiter });
    });

    gatewayWs.on("error", (error) => {
      this.auditLogger.log({
        type: "gateway_error",
        agentId: this.config.agentId,
        details: { error: error.message },
      });
      try {
        clientWs.close(1011, "Gateway error");
      } catch {
        // Ignore
      }
    });

    gatewayWs.on("close", () => {
      this.connections.delete(clientWs);
      try {
        clientWs.close();
      } catch {
        // Ignore
      }
    });

    // Forward gateway → client (responses)
    gatewayWs.on("message", (data) => {
      this.messageCount++;
      this.safeSend(clientWs, data);
    });

    // Intercept client → gateway (requests)
    clientWs.on("message", async (data) => {
      if (!rateLimiter.tryConsume()) {
        this.rateLimitedCount++;
        this.config.onSecurityEvent?.({
          type: "rate_limited",
          tool: "unknown",
          reason: "Rate limit exceeded",
        });
        return;
      }

      this.messageCount++;

      const timeoutPromise = new Promise<void>((_, reject) => {
        setTimeout(
          () => reject(new Error("Message processing timeout")),
          this.config.messageTimeoutMs,
        );
      });

      try {
        await Promise.race([
          this.handleProxyMessage(clientWs, gatewayWs, data),
          timeoutPromise,
        ]);
      } catch (error) {
        this.auditLogger.log({
          type: "message_processing_error",
          agentId: this.config.agentId,
          details: { error: error instanceof Error ? error.message : String(error) },
        });
      }
    });

    clientWs.on("close", () => {
      this.connections.delete(clientWs);
      try {
        gatewayWs.close();
      } catch {
        // Ignore
      }
      this.auditLogger.log({
        type: "client_disconnected",
        agentId: this.config.agentId,
        details: { activeConnections: this.connections.size },
      });
    });

    clientWs.on("error", (error) => {
      this.auditLogger.log({
        type: "client_error",
        agentId: this.config.agentId,
        details: { error: error.message },
      });
    });
  }

  /**
   * Safely send data on a WebSocket, handling errors.
   */
  private safeSend(ws: WebSocket, data: RawData | string): boolean {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
        return true;
      }
    } catch (error) {
      this.auditLogger.log({
        type: "send_error",
        agentId: this.config.agentId,
        details: { error: error instanceof Error ? error.message : String(error) },
      });
    }
    return false;
  }

  /**
   * Handle a message in proxy mode using the message normalizer (multi-format support).
   */
  private async handleProxyMessage(
    clientWs: WebSocket,
    gatewayWs: WebSocket,
    data: RawData,
  ): Promise<void> {
    const dataStr = data.toString();
    const normalized = normalizeMessage(dataStr);

    if (!normalized) {
      // Not a recognized tool call, pass through
      this.safeSend(gatewayWs, data);
      return;
    }

    // It's a tool call — intercept it
    const result = await this.interceptor.intercept(normalized.toolCall);

    this.auditLogger.log({
      type: "tool_intercepted",
      agentId: this.config.agentId,
      toolName: normalized.toolCall.tool,
      sessionId: normalized.sessionId,
      decision: result.evaluation?.decision ?? "unknown",
      reason: result.evaluation?.reason,
      details: { args: normalized.toolCall.args },
    });

    if (result.allowed) {
      // Forward to gateway
      this.safeSend(gatewayWs, data);
    } else {
      // Send error back to client in the same format
      const response = formatResponse(normalized, result);
      this.safeSend(clientWs, response);
    }
  }
}

/**
 * Create and start an AgentKernel security proxy.
 */
export async function createOpenClawProxy(
  config: OpenClawProxyConfig = {},
): Promise<OpenClawSecurityProxy> {
  const proxy = new OpenClawSecurityProxy(config);
  await proxy.start();
  return proxy;
}

// OpenClaw Security Proxy — WebSocket proxy that intercepts all gateway traffic

import { WebSocket, WebSocketServer, type RawData } from "ws";
import { z } from "zod";
import { ToolInterceptor, createToolInterceptor, type ToolCall, type InterceptorConfig } from "./interceptor.js";
import { OpenClawAuditLogger, createOpenClawAuditLogger, type OpenClawAuditSink } from "./audit.js";
import type { PolicySet } from "@agentkernel/runtime";

// ─── MESSAGE SCHEMAS ───────────────────────────────────────────

/** OpenClaw Gateway message types */
const GatewayMessageSchema = z.object({
  type: z.string(),
  id: z.string().optional(),
  sessionId: z.string().optional(),
  data: z.unknown().optional(),
});

/** Tool invocation message */
const ToolInvocationSchema = z.object({
  type: z.literal("tool_invoke"),
  id: z.string(),
  sessionId: z.string().optional(),
  data: z.object({
    tool: z.string(),
    args: z.record(z.unknown()).optional(),
  }),
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
  /^127\./,                           // Loopback
  /^0\./,                             // Current network
  /^10\./,                            // Private Class A
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,  // Private Class B
  /^192\.168\./,                      // Private Class C
  /^169\.254\./,                      // Link-local
  /^::1$/,                            // IPv6 loopback
  /^fe80:/i,                          // IPv6 link-local
  /^fc00:/i,                          // IPv6 unique local
  /^fd[0-9a-f]{2}:/i,                // IPv6 unique local
];

/** Blocked hostnames for SSRF prevention */
const BLOCKED_HOSTNAMES = [
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "169.254.169.254",                  // Cloud metadata endpoint
];

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
    throw new Error(`Invalid gateway URL protocol: ${url.protocol}. Only ws:// and wss:// are allowed.`);
  }

  const hostname = url.hostname.toLowerCase();

  // Check against allowlist if provided
  if (allowedHosts && allowedHosts.length > 0) {
    if (!allowedHosts.some(h => h.toLowerCase() === hostname)) {
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
  refillIntervalMs: number
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

export interface OpenClawProxyConfig {
  /** Port to listen on (default: 18788) */
  listenPort?: number;
  /** OpenClaw Gateway URL (default: ws://127.0.0.1:18789) */
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
  /** Number of active connections */
  activeConnections: number;
  /** Total messages proxied */
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

function createProxyError(code: string, message: string, details?: Record<string, unknown>): ProxyError {
  return { code, message, details };
}

// ─── SECURITY PROXY ────────────────────────────────────────────

/**
 * OpenClaw Security Proxy — WebSocket proxy that intercepts all OpenClaw traffic.
 *
 * Architecture:
 * ```
 * OpenClaw Client → Security Proxy (this) → OpenClaw Gateway
 *                        ↓
 *                   PolicyEngine
 *                   AuditLogger
 *                   RateLimiter
 * ```
 *
 * Security Features:
 * - SSRF protection (blocks internal IPs/hostnames)
 * - Rate limiting per connection
 * - Message size limits
 * - Timeout enforcement
 * - Policy-based tool blocking
 * - Full audit logging
 */
export class OpenClawSecurityProxy {
  private readonly config: Required<Omit<OpenClawProxyConfig, "auditSinks" | "onApprovalRequest" | "onSecurityEvent" | "allowedGatewayHosts">> & {
    auditSinks: OpenClawAuditSink[];
    onApprovalRequest?: (call: ToolCall) => Promise<boolean>;
    onSecurityEvent?: OpenClawProxyConfig["onSecurityEvent"];
    allowedGatewayHosts?: string[];
  };
  private server: WebSocketServer | null = null;
  private interceptor: ToolInterceptor;
  private auditLogger: OpenClawAuditLogger;
  private connections: Map<WebSocket, { gateway: WebSocket; rateLimiter: RateLimiter }> = new Map();
  private messageCount = 0;
  private rateLimitedCount = 0;
  private startTime: Date | null = null;

  constructor(config: OpenClawProxyConfig = {}) {
    const gatewayUrl = config.gatewayUrl ?? "ws://127.0.0.1:18789";

    // SECURITY: Validate gateway URL unless explicitly skipped
    if (!config.skipSsrfValidation) {
      validateGatewayUrl(gatewayUrl, config.allowedGatewayHosts);
    }

    this.config = {
      listenPort: config.listenPort ?? 18788,
      gatewayUrl,
      allowedGatewayHosts: config.allowedGatewayHosts,
      skipSsrfValidation: config.skipSsrfValidation ?? false,
      policySet: config.policySet ?? {},
      agentId: config.agentId ?? "openclaw-agent",
      auditSinks: config.auditSinks ?? [],
      onApprovalRequest: config.onApprovalRequest,
      onSecurityEvent: config.onSecurityEvent,
      maxMessagesPerSecond: config.maxMessagesPerSecond ?? 100,
      maxMessageSizeBytes: config.maxMessageSizeBytes ?? 1024 * 1024, // 1MB
      messageTimeoutMs: config.messageTimeoutMs ?? 30000,
    };

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
    this.auditLogger = createOpenClawAuditLogger({ sinks: this.config.auditSinks });
  }

  /**
   * Start the security proxy.
   */
  async start(): Promise<void> {
    if (this.server) {
      throw new Error("Proxy already started");
    }

    this.startTime = new Date();

    return new Promise((resolve, reject) => {
      this.server = new WebSocketServer({
        port: this.config.listenPort,
        maxPayload: this.config.maxMessageSizeBytes,
      });

      this.server.on("listening", () => {
        this.auditLogger.log({
          type: "proxy_started",
          agentId: this.config.agentId,
          details: {
            listenPort: this.config.listenPort,
            gatewayUrl: this.config.gatewayUrl,
            maxMessagesPerSecond: this.config.maxMessagesPerSecond,
            maxMessageSizeBytes: this.config.maxMessageSizeBytes,
          },
        });
        resolve();
      });

      this.server.on("error", (error) => {
        reject(error);
      });

      this.server.on("connection", (clientWs) => {
        this.handleClientConnection(clientWs);
      });
    });
  }

  /**
   * Stop the security proxy.
   */
  async stop(): Promise<void> {
    if (!this.server) return;

    // Close all connections
    for (const [clientWs, { gateway }] of this.connections) {
      try {
        clientWs.close();
      } catch {
        // Ignore close errors
      }
      try {
        gateway.close();
      } catch {
        // Ignore close errors
      }
    }
    this.connections.clear();

    return new Promise((resolve) => {
      this.server!.close(() => {
        this.server = null;
        this.auditLogger.log({
          type: "proxy_stopped",
          agentId: this.config.agentId,
        });
        resolve();
      });
    });
  }

  /**
   * Get proxy statistics.
   */
  getStats(): OpenClawProxyStats {
    const interceptorStats = this.interceptor.getStats();
    return {
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

  /**
   * Handle a new client connection.
   */
  private handleClientConnection(clientWs: WebSocket): void {
    // Create rate limiter for this connection
    const rateLimiter = createRateLimiter(
      this.config.maxMessagesPerSecond,
      this.config.maxMessagesPerSecond,
      1000
    );

    // Connect to actual OpenClaw Gateway
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
      details: {
        activeConnections: this.connections.size + 1,
      },
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

    // Proxy messages from gateway to client (responses)
    gatewayWs.on("message", (data) => {
      this.messageCount++;
      // Pass through responses unchanged
      this.safeSend(clientWs, data);
    });

    // Intercept messages from client to gateway (requests)
    clientWs.on("message", async (data) => {
      // SECURITY: Rate limiting
      if (!rateLimiter.tryConsume()) {
        this.rateLimitedCount++;
        this.auditLogger.log({
          type: "rate_limited",
          agentId: this.config.agentId,
          details: { remaining: rateLimiter.remaining() },
        });
        this.config.onSecurityEvent?.({
          type: "rate_limited",
          tool: "unknown",
          reason: "Rate limit exceeded",
        });
        // Don't process rate-limited messages
        return;
      }

      this.messageCount++;

      // SECURITY: Timeout for message processing
      const timeoutPromise = new Promise<void>((_, reject) => {
        setTimeout(() => reject(new Error("Message processing timeout")), this.config.messageTimeoutMs);
      });

      try {
        await Promise.race([
          this.handleClientMessage(clientWs, gatewayWs, data),
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
        details: {
          activeConnections: this.connections.size,
        },
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
   * Handle a message from the client.
   */
  private async handleClientMessage(
    clientWs: WebSocket,
    gatewayWs: WebSocket,
    data: RawData
  ): Promise<void> {
    let message: unknown;

    try {
      message = JSON.parse(data.toString());
    } catch {
      // Not JSON, pass through
      this.safeSend(gatewayWs, data);
      return;
    }

    // Check if it's a tool invocation
    const toolInvocation = ToolInvocationSchema.safeParse(message);

    if (toolInvocation.success) {
      // Intercept tool call
      const toolCall: ToolCall = {
        tool: toolInvocation.data.data.tool,
        args: toolInvocation.data.data.args,
        sessionId: toolInvocation.data.sessionId,
        timestamp: new Date(),
      };

      const result = await this.interceptor.intercept(toolCall);

      this.auditLogger.log({
        type: "tool_intercepted",
        agentId: this.config.agentId,
        toolName: toolCall.tool,
        sessionId: toolCall.sessionId,
        decision: result.evaluation?.decision ?? "unknown",
        reason: result.evaluation?.reason,
        details: {
          args: toolCall.args,
        },
      });

      if (result.allowed) {
        // Forward to gateway
        this.safeSend(gatewayWs, data);
      } else {
        // Send structured error response back to client
        const errorResponse = {
          type: "tool_result",
          id: toolInvocation.data.id,
          sessionId: toolInvocation.data.sessionId,
          data: {
            error: {
              code: "POLICY_BLOCKED",
              message: result.error ?? "Blocked by security policy",
              tool: toolCall.tool,
              decision: result.evaluation?.decision,
            },
          },
        };

        this.safeSend(clientWs, JSON.stringify(errorResponse));
      }
    } else {
      // Not a tool invocation, pass through
      this.safeSend(gatewayWs, data);
    }
  }
}

/**
 * Create and start an OpenClaw security proxy.
 */
export async function createOpenClawProxy(
  config: OpenClawProxyConfig = {}
): Promise<OpenClawSecurityProxy> {
  const proxy = new OpenClawSecurityProxy(config);
  await proxy.start();
  return proxy;
}

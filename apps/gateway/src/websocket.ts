// WebSocket Server for AgentRun Gateway
// Handles real-time communication with Zod validation

import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import { timingSafeEqual, createHash } from "crypto";
import { type Logger, createLogger } from "@agentrun/kernel";
import { type Result, ok, err } from "@agentrun/shared";
import {
  type WsMessage,
  type WsServerConfig,
  type ClientConnection,
  type MessageType,
  WsMessageSchema,
  WsServerConfigSchema,
  AuthPayloadSchema,
  GatewayError,
} from "./types.js";

/** Message handler function */
export type MessageHandler = (
  client: ClientConnection,
  message: WsMessage
) => Promise<Result<WsMessage | null, GatewayError>>;

/** WebSocket server interface */
export interface WsServer {
  broadcast(message: WsMessage, filter?: (client: ClientConnection) => boolean): void;
  sendTo(clientId: string, message: WsMessage): Result<void, GatewayError>;
  getClients(): ClientConnection[];
  getClient(clientId: string): ClientConnection | undefined;
  getConnectionCount(): number;
  /** Gracefully close all connections and stop accepting new ones */
  close(): void;
  /** Drain connections with a grace period, then force close */
  drain(timeoutMs?: number): Promise<void>;
}

/**
 * Create and start the WebSocket server.
 * Production quality with Zod validation and Result types.
 */
export function createWebSocketServer(
  config: WsServerConfig,
  onMessage?: MessageHandler
): Result<WsServer, GatewayError> {
  // Validate config
  const configResult = WsServerConfigSchema.safeParse(config);
  if (!configResult.success) {
    return err(new GatewayError(
      `Invalid server config: ${configResult.error.message}`,
      "VALIDATION_ERROR"
    ));
  }

  const log = createLogger({ name: "ws-server" });
  const connections = new Map<string, ClientConnection>();
  const messageWindows = new Map<string, { windowStart: number; count: number }>();
  const authAttempts = new Map<string, { windowStart: number; failures: number }>();
  let connectionCounter = 0;

  const wss = new WebSocketServer({
    port: config.port,
    host: config.host,
    maxPayload: config.maxPayloadSize,
  });

  log.info("WebSocket server starting", { port: config.port, host: config.host });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    if (config.maxConnections && connections.size >= config.maxConnections) {
      ws.close(1013, "Server overloaded");
      log.warn("Connection rejected: max connections reached", {
        maxConnections: config.maxConnections,
      });
      return;
    }

    const clientId = `client_${++connectionCounter}_${Date.now()}`;
    const client: ClientConnection = {
      id: clientId,
      ws,
      authenticated: false, // Always require auth exchange
      connectedAt: Date.now(),
      subscriptions: [],
    };

    connections.set(clientId, client);
    messageWindows.set(clientId, { windowStart: Date.now(), count: 0 });
    log.info("Client connected", { clientId, ip: req.socket.remoteAddress });

    // Always send auth_required — clients must perform the auth handshake
    sendMessage(ws, {
      type: "auth_required",
      payload: { clientId, message: "Authentication required" },
    });

    ws.on("message", async (data: Buffer) => {
      try {
        if (config.messageRateLimit) {
          const now = Date.now();
          const window = messageWindows.get(clientId) ?? { windowStart: now, count: 0 };
          if (now - window.windowStart >= 60_000) {
            window.windowStart = now;
            window.count = 0;
          }
          window.count += 1;
          messageWindows.set(clientId, window);

          if (window.count > config.messageRateLimit) {
            log.warn("Message rate limit exceeded", {
              clientId,
              limit: config.messageRateLimit,
            });
            sendMessage(ws, {
              type: "error",
              payload: { code: "RATE_LIMIT", message: "Message rate limit exceeded" },
            });
            ws.close(1008, "Rate limit exceeded");
            return;
          }
        }

        const rawMessage = JSON.parse(data.toString());

        // Validate message format
        const messageResult = WsMessageSchema.safeParse(rawMessage);
        if (!messageResult.success) {
          log.warn("Invalid message format", { clientId, error: messageResult.error.message });
          sendMessage(ws, {
            type: "error",
            payload: { code: "VALIDATION_ERROR", message: "Invalid message format" },
          });
          return;
        }

        const message = messageResult.data;
        message.timestamp = Date.now();

        log.debug("Message received", { clientId, type: message.type });

        // Handle built-in message types
        const response = await handleMessage(client, message, config, log, onMessage, authAttempts);
        if (response.ok && response.value) {
          sendMessage(ws, response.value);
        } else if (!response.ok) {
          sendMessage(ws, {
            type: "error",
            id: message.id,
            payload: { code: response.error.code, message: response.error.message },
          });
        }
      } catch (error) {
        log.error("Failed to process message", {
          clientId,
          error: error instanceof Error ? error.message : String(error),
        });
        sendMessage(ws, {
          type: "error",
          payload: { code: "INTERNAL_ERROR", message: "Failed to process message" },
        });
      }
    });

    ws.on("close", () => {
      connections.delete(clientId);
      messageWindows.delete(clientId);
      authAttempts.delete(clientId);
      authAttempts.delete(`auth_${clientId}`);
      log.info("Client disconnected", { clientId });
    });

    ws.on("error", (error) => {
      log.error("WebSocket error", { clientId, error: error.message });
    });
  });

  wss.on("error", (error) => {
    log.error("WebSocket server error", { error: error.message });
  });

  wss.on("listening", () => {
    log.info("WebSocket server ready", {
      url: `ws://${config.host}:${config.port}`,
    });
  });

  const server: WsServer = {
    broadcast(message: WsMessage, filter?: (client: ClientConnection) => boolean) {
      for (const client of connections.values()) {
        if (client.authenticated && (!filter || filter(client))) {
          sendMessage(client.ws as WebSocket, message);
        }
      }
    },

    sendTo(clientId: string, message: WsMessage): Result<void, GatewayError> {
      const client = connections.get(clientId);
      if (!client) {
        return err(new GatewayError(`Client not found: ${clientId}`, "NOT_FOUND", clientId));
      }
      sendMessage(client.ws as WebSocket, message);
      return ok(undefined);
    },

    getClients() {
      return Array.from(connections.values());
    },

    getClient(clientId: string) {
      return connections.get(clientId);
    },

    getConnectionCount() {
      return connections.size;
    },

    close() {
      // Notify clients, then close
      for (const [, client] of connections) {
        try {
          (client.ws as WebSocket).close(1001, "Server shutting down");
        } catch { /* client may already be gone */ }
      }
      wss.close();
      connections.clear();
      messageWindows.clear();
      log.info("WebSocket server closed");
    },

    async drain(timeoutMs = 15000) {
      log.info("Draining WebSocket connections", { count: connections.size, timeoutMs });

      // Stop accepting new connections
      wss.close();

      // Notify all clients about shutdown
      for (const [, client] of connections) {
        try {
          sendMessage(client.ws as WebSocket, {
            type: "system" as MessageType,
            payload: { message: "Server shutting down" },
          });
        } catch { /* ignore */ }
      }

      // Wait for clients to disconnect gracefully, up to timeout
      if (connections.size > 0) {
        await new Promise<void>((resolve) => {
          const check = setInterval(() => {
            if (connections.size === 0) {
              clearInterval(check);
              resolve();
            }
          }, 500);
          setTimeout(() => {
            clearInterval(check);
            resolve();
          }, timeoutMs);
        });
      }

      // Force-close remaining connections
      for (const [, client] of connections) {
        try {
          (client.ws as WebSocket).terminate();
        } catch { /* ignore */ }
      }
      connections.clear();
      messageWindows.clear();
      log.info("WebSocket drain complete");
    },
  };

  return ok(server);
}

/** Handle incoming messages */
async function handleMessage(
  client: ClientConnection,
  message: WsMessage,
  config: WsServerConfig,
  log: Logger,
  onMessage?: MessageHandler,
  authAttempts?: Map<string, { windowStart: number; failures: number }>
): Promise<Result<WsMessage | null, GatewayError>> {
  switch (message.type) {
    case "ping":
      return ok({ type: "pong", id: message.id, timestamp: Date.now() });

    case "auth": {
      const payloadResult = AuthPayloadSchema.safeParse(message.payload);
      if (!payloadResult.success) {
        log.warn("Invalid auth payload", { clientId: client.id });
        return ok({ type: "auth_failed", id: message.id, payload: { message: "Invalid auth payload" } });
      }

      // Rate limit auth attempts: max 5 failures per 60 seconds per client
      if (authAttempts) {
        const now = Date.now();
        const authKey = `auth_${client.id}`;
        const authWindow = authAttempts.get(authKey) ?? { windowStart: now, failures: 0 };
        if (now - authWindow.windowStart >= 60_000) {
          authWindow.windowStart = now;
          authWindow.failures = 0;
        }
        if (authWindow.failures >= 5) {
          log.warn("Auth rate limit exceeded", { clientId: client.id });
          return ok({ type: "auth_failed", id: message.id, payload: { message: "Too many auth attempts. Try again later." } });
        }

        if (!config.authToken) {
          if (payloadResult.data.token && payloadResult.data.token.length > 0) {
            client.authenticated = true;
            log.info("Client authenticated (dev mode)", { clientId: client.id });
            return ok({ type: "auth_success", id: message.id, payload: { clientId: client.id } });
          }
          authWindow.failures += 1;
          authAttempts.set(authKey, authWindow);
          log.warn("Empty token rejected", { clientId: client.id });
          return ok({ type: "auth_failed", id: message.id, payload: { message: "Token required" } });
        }

        if (safeTokenCompare(payloadResult.data.token, config.authToken)) {
          client.authenticated = true;
          authAttempts.delete(authKey);
          log.info("Client authenticated", { clientId: client.id });
          return ok({ type: "auth_success", id: message.id, payload: { clientId: client.id } });
        } else {
          authWindow.failures += 1;
          authAttempts.set(authKey, authWindow);
          log.warn("Authentication failed", { clientId: client.id });
          return ok({ type: "auth_failed", id: message.id, payload: { message: "Invalid token" } });
        }
      }

      // Fallback when no authAttempts map (shouldn't happen in normal flow)
      if (!config.authToken) {
        if (payloadResult.data.token && payloadResult.data.token.length > 0) {
          client.authenticated = true;
          return ok({ type: "auth_success", id: message.id, payload: { clientId: client.id } });
        }
        return ok({ type: "auth_failed", id: message.id, payload: { message: "Token required" } });
      }

      if (safeTokenCompare(payloadResult.data.token, config.authToken)) {
        client.authenticated = true;
        return ok({ type: "auth_success", id: message.id, payload: { clientId: client.id } });
      } else {
        return ok({ type: "auth_failed", id: message.id, payload: { message: "Invalid token" } });
      }
    }

    default:
      // Require authentication for other message types
      if (!client.authenticated) {
        return err(new GatewayError("Not authenticated", "AUTH_ERROR", client.id));
      }

      // Pass to custom handler if provided
      if (onMessage) {
        return onMessage(client, message);
      }

      return err(new GatewayError(`Unknown message type: ${message.type}`, "VALIDATION_ERROR", client.id));
  }
}

/** Constant-time token comparison to prevent timing attacks.
 *  Uses SHA-256 hashing so both buffers are always 32 bytes,
 *  eliminating any length-leakage side channel. */
function safeTokenCompare(provided: string, expected: string): boolean {
  const providedHash = createHash("sha256").update(provided).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedHash, expectedHash);
}

/** Send message to WebSocket client */
function sendMessage(ws: WebSocket, message: WsMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ ...message, timestamp: message.timestamp ?? Date.now() }));
  }
}

export { ClientConnection, WsMessage };

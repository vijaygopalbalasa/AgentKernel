// WebSocket Server for Agent OS Gateway
// Handles real-time communication with Zod validation

import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import { type Logger, createLogger } from "@agent-os/kernel";
import { type Result, ok, err } from "@agent-os/shared";
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
  close(): void;
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
      authenticated: !config.authToken, // Auto-auth if no token required
      connectedAt: Date.now(),
      subscriptions: [],
    };

    connections.set(clientId, client);
    messageWindows.set(clientId, { windowStart: Date.now(), count: 0 });
    log.info("Client connected", { clientId, ip: req.socket.remoteAddress });

    // Send connection status
    if (config.authToken) {
      sendMessage(ws, {
        type: "auth_required",
        payload: { clientId, message: "Authentication required" },
      });
    } else {
      sendMessage(ws, {
        type: "auth_success",
        payload: { clientId, message: "Connected to Agent OS Gateway" },
      });
    }

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
        const response = await handleMessage(client, message, config, log, onMessage);
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
      wss.close();
      log.info("WebSocket server closed");
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
  onMessage?: MessageHandler
): Promise<Result<WsMessage | null, GatewayError>> {
  switch (message.type) {
    case "ping":
      return ok({ type: "pong", id: message.id, timestamp: Date.now() });

    case "auth": {
      if (!config.authToken) {
        client.authenticated = true;
        return ok({ type: "auth_success", id: message.id, payload: { clientId: client.id } });
      }

      const payloadResult = AuthPayloadSchema.safeParse(message.payload);
      if (!payloadResult.success) {
        log.warn("Invalid auth payload", { clientId: client.id });
        return ok({ type: "auth_failed", id: message.id, payload: { message: "Invalid auth payload" } });
      }

      if (payloadResult.data.token === config.authToken) {
        client.authenticated = true;
        log.info("Client authenticated", { clientId: client.id });
        return ok({ type: "auth_success", id: message.id, payload: { clientId: client.id } });
      } else {
        log.warn("Authentication failed", { clientId: client.id });
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

/** Send message to WebSocket client */
function sendMessage(ws: WebSocket, message: WsMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ ...message, timestamp: message.timestamp ?? Date.now() }));
  }
}

export { ClientConnection, WsMessage };

// WebSocket Server for Agent OS Gateway
// Handles real-time communication between agents and clients

import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import type { Logger } from "@agent-os/shared";

/** Message types for WebSocket communication */
export type MessageType =
  | "ping"
  | "pong"
  | "auth"
  | "auth_success"
  | "auth_failed"
  | "chat"
  | "chat_response"
  | "agent_spawn"
  | "agent_terminate"
  | "agent_status"
  | "error";

/** Base message structure */
export interface WsMessage {
  type: MessageType;
  id?: string;
  payload?: unknown;
  timestamp?: number;
}

/** Client connection state */
interface ClientConnection {
  id: string;
  ws: WebSocket;
  authenticated: boolean;
  agentId?: string;
  connectedAt: number;
}

/** WebSocket server configuration */
export interface WsServerConfig {
  port: number;
  host: string;
  authToken?: string;
}

/** Create and start the WebSocket server */
export function createWebSocketServer(
  config: WsServerConfig,
  logger: Logger,
  onMessage?: (client: ClientConnection, message: WsMessage) => Promise<WsMessage | null>
) {
  const connections = new Map<string, ClientConnection>();
  let connectionCounter = 0;

  const wss = new WebSocketServer({
    port: config.port,
    host: config.host,
  });

  logger.info("WebSocket server starting", { port: config.port, host: config.host });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const clientId = `client_${++connectionCounter}_${Date.now()}`;
    const client: ClientConnection = {
      id: clientId,
      ws,
      authenticated: !config.authToken, // Auto-auth if no token required
      connectedAt: Date.now(),
    };

    connections.set(clientId, client);
    logger.info("Client connected", { clientId, ip: req.socket.remoteAddress });

    // Send welcome message
    sendMessage(ws, {
      type: "auth_success",
      payload: { clientId, message: "Connected to Agent OS Gateway" },
    });

    ws.on("message", async (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString()) as WsMessage;
        message.timestamp = Date.now();

        logger.debug("Message received", { clientId, type: message.type });

        // Handle built-in message types
        const response = await handleMessage(client, message, config, logger, onMessage);
        if (response) {
          sendMessage(ws, response);
        }
      } catch (error) {
        logger.error("Failed to process message", {
          clientId,
          error: error instanceof Error ? error.message : String(error),
        });
        sendMessage(ws, {
          type: "error",
          payload: { message: "Invalid message format" },
        });
      }
    });

    ws.on("close", () => {
      connections.delete(clientId);
      logger.info("Client disconnected", { clientId });
    });

    ws.on("error", (error) => {
      logger.error("WebSocket error", { clientId, error: error.message });
    });
  });

  wss.on("error", (error) => {
    logger.error("WebSocket server error", { error: error.message });
  });

  wss.on("listening", () => {
    logger.info("WebSocket server ready", {
      url: `ws://${config.host}:${config.port}`,
    });
  });

  return {
    /** Broadcast message to all authenticated clients */
    broadcast(message: WsMessage, filter?: (client: ClientConnection) => boolean) {
      for (const client of connections.values()) {
        if (client.authenticated && (!filter || filter(client))) {
          sendMessage(client.ws, message);
        }
      }
    },

    /** Send message to specific client */
    sendTo(clientId: string, message: WsMessage) {
      const client = connections.get(clientId);
      if (client) {
        sendMessage(client.ws, message);
      }
    },

    /** Get all connected clients */
    getClients() {
      return Array.from(connections.values());
    },

    /** Get connection count */
    getConnectionCount() {
      return connections.size;
    },

    /** Close the server */
    close() {
      wss.close();
      logger.info("WebSocket server closed");
    },
  };
}

/** Handle incoming messages */
async function handleMessage(
  client: ClientConnection,
  message: WsMessage,
  config: WsServerConfig,
  logger: Logger,
  onMessage?: (client: ClientConnection, message: WsMessage) => Promise<WsMessage | null>
): Promise<WsMessage | null> {
  switch (message.type) {
    case "ping":
      return { type: "pong", id: message.id, timestamp: Date.now() };

    case "auth":
      if (config.authToken) {
        const token = (message.payload as { token?: string })?.token;
        if (token === config.authToken) {
          client.authenticated = true;
          logger.info("Client authenticated", { clientId: client.id });
          return { type: "auth_success", id: message.id, payload: { clientId: client.id } };
        } else {
          logger.warn("Authentication failed", { clientId: client.id });
          return { type: "auth_failed", id: message.id, payload: { message: "Invalid token" } };
        }
      }
      return { type: "auth_success", id: message.id, payload: { clientId: client.id } };

    default:
      // Require authentication for other message types
      if (!client.authenticated) {
        return { type: "error", id: message.id, payload: { message: "Not authenticated" } };
      }

      // Pass to custom handler if provided
      if (onMessage) {
        return onMessage(client, message);
      }

      return { type: "error", id: message.id, payload: { message: `Unknown message type: ${message.type}` } };
  }
}

/** Send message to WebSocket client */
function sendMessage(ws: WebSocket, message: WsMessage) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ ...message, timestamp: message.timestamp ?? Date.now() }));
  }
}

export type { ClientConnection };

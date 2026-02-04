"use client";

import {
  createContext,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  WsMessage,
  ChatMessage,
  TokenUsage,
  GatewayEvent,
  ConnectionStatus,
} from "@/lib/types";
import {
  authMessage,
  agentStatusMessage,
  subscribeMessage,
  chatMessage,
  agentTaskMessage,
  generateId,
} from "@/lib/ws-client";
import {
  getWsUrl,
  MAX_EVENTS,
  REQUEST_TIMEOUT_MS,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
} from "@/lib/constants";

interface PendingRequest {
  resolve: (msg: WsMessage) => void;
  reject: (err: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

interface StreamHandler {
  onDelta: (delta: string) => void;
  accumulated: string;
  resolve: (result: {
    content: string;
    model?: string;
    usage?: TokenUsage;
  }) => void;
  reject: (err: Error) => void;
}

export interface WebSocketContextValue {
  status: ConnectionStatus;
  authenticate: (token: string) => void;
  sendRequest: (message: WsMessage) => Promise<WsMessage>;
  sendAgentTask: (
    agentId: string,
    task: Record<string, unknown>
  ) => Promise<unknown>;
  sendStreamingChat: (
    messages: ChatMessage[],
    onDelta: (delta: string) => void,
    options?: { model?: string; maxTokens?: number; temperature?: number }
  ) => Promise<{ content: string; model?: string; usage?: TokenUsage }>;
  events: GatewayEvent[];
  operatorAgentId: string | null;
  setOperatorAgentId: (id: string | null) => void;
}

export const WebSocketContext = createContext<WebSocketContextValue | null>(
  null
);

export function WebSocketProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [events, setEvents] = useState<GatewayEvent[]>([]);
  const [operatorAgentId, setOperatorAgentIdState] = useState<string | null>(
    null
  );

  const wsRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef<Map<string, PendingRequest>>(new Map());
  const streamRef = useRef<Map<string, StreamHandler>>(new Map());
  const reconnectRef = useRef<number>(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const authTokenRef = useRef<string>("");
  const statusRef = useRef<ConnectionStatus>("disconnected");
  /** When true the close handler should NOT auto-reconnect */
  const intentionalCloseRef = useRef(false);
  /** Stable ref so the close-handler always calls the latest `connect` */
  const connectRef = useRef<() => void>(() => {});

  useEffect(() => {
    const savedToken =
      typeof window !== "undefined"
        ? localStorage.getItem("gatewayAuthToken") || ""
        : "";
    const savedAgent =
      typeof window !== "undefined"
        ? localStorage.getItem("operatorAgentId") || null
        : null;
    authTokenRef.current = savedToken;
    setOperatorAgentIdState(savedAgent);
  }, []);

  /* ------------------------------------------------------------------ */
  /* Helper: push a gateway event into state                            */
  /* ------------------------------------------------------------------ */
  const pushEvent = useCallback((event: GatewayEvent) => {
    setEvents((prev) => [event, ...prev].slice(0, MAX_EVENTS));
  }, []);

  /* ------------------------------------------------------------------ */
  /* onConnected — runs after auth_success (or immediate open if no token) */
  /* ------------------------------------------------------------------ */
  const onConnectedRef = useRef<(socket: WebSocket) => void>(() => {});
  onConnectedRef.current = (socket: WebSocket) => {
    statusRef.current = "connected";
    setStatus("connected");
    reconnectRef.current = 0;
    socket.send(JSON.stringify(agentStatusMessage()));
    socket.send(
      JSON.stringify(
        subscribeMessage(["agent.lifecycle", "system", "audit", "*"])
      )
    );
    pushEvent({
      type: "connection",
      summary: "Connected to gateway",
      timestamp: new Date().toLocaleTimeString(),
    });
  };

  /* ------------------------------------------------------------------ */
  /* handleMessage — dispatches incoming WebSocket messages              */
  /* ------------------------------------------------------------------ */
  const handleMessageRef = useRef<(event: MessageEvent) => void>(() => {});
  handleMessageRef.current = (event: MessageEvent) => {
    let message: WsMessage;
    try {
      message = JSON.parse(event.data as string);
    } catch {
      return;
    }

    // Handle pending request/response correlation
    if (message.id && pendingRef.current.has(message.id)) {
      const pending = pendingRef.current.get(message.id)!;
      pendingRef.current.delete(message.id);
      clearTimeout(pending.timeoutId);
      pending.resolve(message);
      return;
    }

    // Handle streaming chat deltas
    if (message.type === "chat_stream" && message.id) {
      const handler = streamRef.current.get(message.id);
      if (handler) {
        const delta =
          (message.payload?.delta as string) || "";
        handler.accumulated += delta;
        handler.onDelta(delta);
      }
      return;
    }

    if (message.type === "chat_stream_end" && message.id) {
      const handler = streamRef.current.get(message.id);
      if (handler) {
        streamRef.current.delete(message.id);
        handler.resolve({
          content: handler.accumulated,
          model: message.payload?.model as string | undefined,
          usage: message.payload?.usage as TokenUsage | undefined,
        });
      }
      return;
    }

    // Auth flow
    if (message.type === "auth_success") {
      onConnectedRef.current(wsRef.current!);
      return;
    }

    if (message.type === "auth_required") {
      statusRef.current = "auth_required";
      setStatus("auth_required");
      if (authTokenRef.current) {
        wsRef.current?.send(
          JSON.stringify(authMessage(authTokenRef.current))
        );
      }
      return;
    }

    if (message.type === "auth_failed") {
      statusRef.current = "auth_failed";
      setStatus("auth_failed");
      pushEvent({
        type: "auth",
        summary:
          (message.payload?.message as string) || "Authentication failed",
        timestamp: new Date().toLocaleTimeString(),
      });
      return;
    }

    // Events
    if (message.type === "event" && message.payload) {
      const payload = message.payload;
      pushEvent({
        type: (payload.type as string) || "event",
        summary: payload.channel
          ? `${payload.channel} ${payload.data ? JSON.stringify(payload.data) : ""}`
          : "",
        timestamp: new Date(
          (payload.timestamp as string) || Date.now()
        ).toLocaleTimeString(),
        channel: payload.channel as string | undefined,
      });
      return;
    }

    // Errors
    if (message.type === "error") {
      pushEvent({
        type: "error",
        summary: (message.payload?.message as string) || "Gateway error",
        timestamp: new Date().toLocaleTimeString(),
      });
    }
  };

  /* ------------------------------------------------------------------ */
  /* connect — opens a new WebSocket to the gateway                     */
  /* Uses refs so the function identity never changes and the useEffect */
  /* that calls it only runs once (on mount).                           */
  /* ------------------------------------------------------------------ */
  const connect = useCallback(() => {
    // Cancel any pending reconnect timer
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    // Close existing socket without triggering auto-reconnect
    if (wsRef.current) {
      intentionalCloseRef.current = true;
      wsRef.current.close();
    }

    statusRef.current = "connecting";
    setStatus("connecting");

    const socket = new WebSocket(getWsUrl());
    wsRef.current = socket;

    socket.addEventListener("open", () => {
      if (authTokenRef.current) {
        socket.send(JSON.stringify(authMessage(authTokenRef.current)));
      } else {
        onConnectedRef.current(socket);
      }
    });

    socket.addEventListener("close", () => {
      // If this socket is no longer the active one, ignore
      if (wsRef.current !== socket) return;

      statusRef.current = "disconnected";
      setStatus("disconnected");

      // Don't auto-reconnect if the close was intentional (we're
      // already opening a new connection from connect() or authenticate())
      if (intentionalCloseRef.current) {
        intentionalCloseRef.current = false;
        return;
      }

      // Exponential backoff reconnect
      const delay = Math.min(
        RECONNECT_BASE_MS * Math.pow(2, reconnectRef.current),
        RECONNECT_MAX_MS
      );
      reconnectRef.current += 1;
      reconnectTimerRef.current = setTimeout(
        () => connectRef.current(),
        delay
      );
    });

    socket.addEventListener("message", (ev) => handleMessageRef.current(ev));

    socket.addEventListener("error", () => {
      // close handler manages reconnection
    });
  }, []);

  // Keep connectRef in sync so the close-handler's setTimeout always
  // calls the latest version (though with [] deps it never changes).
  connectRef.current = connect;

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      if (wsRef.current) {
        intentionalCloseRef.current = true;
        wsRef.current.close();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendRequest = useCallback(
    (message: WsMessage): Promise<WsMessage> => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error("Not connected"));
      }
      return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          pendingRef.current.delete(message.id);
          reject(new Error("Request timeout"));
        }, REQUEST_TIMEOUT_MS);

        pendingRef.current.set(message.id, { resolve, reject, timeoutId });
        wsRef.current!.send(JSON.stringify(message));
      });
    },
    []
  );

  const sendAgentTask = useCallback(
    async (
      agentId: string,
      task: Record<string, unknown>
    ): Promise<unknown> => {
      const response = await sendRequest(agentTaskMessage(agentId, task));
      if (response.type === "agent_task_result") {
        if (response.payload?.status === "ok") {
          return response.payload.result;
        }
        throw new Error(
          (response.payload?.error as string) || "Task failed"
        );
      }
      if (response.type === "error") {
        throw new Error(
          (response.payload?.message as string) || "Gateway error"
        );
      }
      throw new Error("Unexpected response");
    },
    [sendRequest]
  );

  const sendStreamingChat = useCallback(
    (
      messages: ChatMessage[],
      onDelta: (delta: string) => void,
      options?: { model?: string; maxTokens?: number; temperature?: number }
    ): Promise<{ content: string; model?: string; usage?: TokenUsage }> => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error("Not connected"));
      }

      const msg = chatMessage(messages, { ...options, stream: true });

      return new Promise((resolve, reject) => {
        streamRef.current.set(msg.id, {
          onDelta,
          accumulated: "",
          resolve,
          reject,
        });

        const timeoutId = setTimeout(() => {
          if (streamRef.current.has(msg.id)) {
            const handler = streamRef.current.get(msg.id)!;
            streamRef.current.delete(msg.id);
            if (handler.accumulated) {
              handler.resolve({ content: handler.accumulated });
            } else {
              handler.reject(new Error("Stream timeout"));
            }
          }
        }, 60_000);

        wsRef.current!.send(JSON.stringify(msg));

        // Clean up timeout on completion
        const originalResolve = resolve;
        const originalReject = reject;
        const handler = streamRef.current.get(msg.id);
        if (handler) {
          handler.resolve = (result) => {
            clearTimeout(timeoutId);
            originalResolve(result);
          };
          handler.reject = (err) => {
            clearTimeout(timeoutId);
            originalReject(err);
          };
        }
      });
    },
    []
  );

  const authenticate = useCallback(
    (token: string) => {
      authTokenRef.current = token;
      if (typeof window !== "undefined") {
        localStorage.setItem("gatewayAuthToken", token);
      }
      // Reconnect with new token — connect() handles intentional close internally
      reconnectRef.current = 0;
      connect();
    },
    [connect]
  );

  const setOperatorAgentId = useCallback((id: string | null) => {
    setOperatorAgentIdState(id);
    if (typeof window !== "undefined") {
      if (id) {
        localStorage.setItem("operatorAgentId", id);
      } else {
        localStorage.removeItem("operatorAgentId");
      }
    }
  }, []);

  return (
    <WebSocketContext.Provider
      value={{
        status,
        authenticate,
        sendRequest,
        sendAgentTask: (agentId: string, task: Record<string, unknown>) =>
          sendAgentTask(agentId, task),
        sendStreamingChat,
        events,
        operatorAgentId,
        setOperatorAgentId,
      }}
    >
      {children}
    </WebSocketContext.Provider>
  );
}

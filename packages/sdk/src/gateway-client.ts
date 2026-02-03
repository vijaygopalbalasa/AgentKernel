import { WebSocket } from "ws";

type RawData = WebSocket.RawData;

export interface GatewayClientOptions {
  url: string;
  agentId: string;
  authToken?: string;
  internalToken?: string;
  timeoutMs?: number;
}

export interface GatewayTaskResult<T = unknown> {
  ok: boolean;
  result?: T;
  error?: string;
}

export async function sendGatewayTask<T = unknown>(
  options: GatewayClientOptions,
  task: Record<string, unknown>,
  internal: boolean = true
): Promise<GatewayTaskResult<T>> {
  const timeoutMs = options.timeoutMs ?? 30000;
  const messageId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const authId = options.authToken ? `auth-${messageId}` : undefined;

  return new Promise((resolve) => {
    const ws = new WebSocket(options.url);
    let taskSent = false;

    const timeoutId = setTimeout(() => {
      ws.close();
      resolve({ ok: false, error: "Gateway request timed out" });
    }, timeoutMs);

    ws.on("open", () => {
      if (options.authToken) {
        ws.send(JSON.stringify({
          type: "auth",
          id: authId,
          payload: { token: options.authToken },
        }));
      } else {
        sendTask();
      }
    });

    ws.on("message", (data: RawData) => {
      try {
        const message = JSON.parse(data.toString());
        if (authId && message.id === authId) {
          if (message.type === "auth_success") {
            sendTask();
            return;
          }
          if (message.type === "auth_failed") {
            clearTimeout(timeoutId);
            ws.close();
            resolve({ ok: false, error: message.payload?.message ?? "Gateway auth failed" });
            return;
          }
        }

        if (message.id !== messageId) return;

        clearTimeout(timeoutId);
        ws.close();

        if (message.type === "agent_task_result" && message.payload?.status === "ok") {
          resolve({ ok: true, result: message.payload.result as T });
        } else if (message.type === "agent_task_result") {
          resolve({ ok: false, error: message.payload?.error ?? "Agent task failed" });
        } else if (message.type === "error") {
          resolve({ ok: false, error: message.payload?.message ?? "Gateway error" });
        }
      } catch (error) {
        clearTimeout(timeoutId);
        ws.close();
        resolve({ ok: false, error: String(error) });
      }
    });

    ws.on("error", (error: Error) => {
      clearTimeout(timeoutId);
      resolve({ ok: false, error: error.message });
    });

    function sendTask() {
      if (taskSent) return;
      taskSent = true;
      ws.send(JSON.stringify({
        type: "agent_task",
        id: messageId,
        payload: {
          agentId: options.agentId,
          task,
          internal,
          internalToken: options.internalToken,
        },
      }));
    }
  });
}

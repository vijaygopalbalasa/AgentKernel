import type { WsMessage, ChatMessage } from "./types";

let counter = 0;

export function generateId(prefix: string = "req"): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

export function authMessage(token: string): WsMessage {
  return {
    type: "auth",
    id: generateId("auth"),
    payload: { token },
  };
}

export function agentStatusMessage(): WsMessage {
  return {
    type: "agent_status",
    id: generateId("agents"),
  };
}

export function subscribeMessage(channels: string[]): WsMessage {
  return {
    type: "subscribe",
    id: generateId("sub"),
    payload: { channels },
  };
}

export function chatMessage(
  messages: ChatMessage[],
  options?: { model?: string; maxTokens?: number; temperature?: number; stream?: boolean; systemPrompt?: string }
): WsMessage {
  return {
    type: "chat",
    id: generateId("chat"),
    payload: {
      messages,
      ...(options?.model && { model: options.model }),
      ...(options?.maxTokens && { maxTokens: options.maxTokens }),
      ...(options?.temperature !== undefined && { temperature: options.temperature }),
      ...(options?.stream && { stream: true }),
      ...(options?.systemPrompt && { systemPrompt: options.systemPrompt }),
    },
  };
}

export function agentTaskMessage(
  agentId: string,
  task: Record<string, unknown>
): WsMessage {
  return {
    type: "agent_task",
    id: generateId("task"),
    payload: { agentId, task },
  };
}

export function agentSpawnMessage(manifest: Record<string, unknown>): WsMessage {
  return {
    type: "agent_spawn",
    id: generateId("spawn"),
    payload: { manifest },
  };
}

export function agentTerminateMessage(
  agentId: string,
  force = false
): WsMessage {
  return {
    type: "agent_terminate",
    id: generateId("term"),
    payload: { agentId, force },
  };
}

"use client";

import { useState, useCallback } from "react";
import type { ChatMessage, TokenUsage } from "@/lib/types";
import { useWebSocket } from "./useWebSocket";

export interface DisplayMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  model?: string;
  usage?: TokenUsage;
  streaming?: boolean;
  timestamp: string;
  agentName?: string;
}

export function useChat() {
  const { sendStreamingChat, sendAgentTask, operatorAgentId } = useWebSocket();
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [streaming, setStreaming] = useState(false);

  const sendMessage = useCallback(
    async (
      content: string,
      options?: { agentId?: string; agentName?: string; model?: string }
    ) => {
      const userMsg: DisplayMessage = {
        id: `user-${Date.now()}`,
        role: "user",
        content,
        timestamp: new Date().toLocaleTimeString(),
      };
      setMessages((prev) => [...prev, userMsg]);

      const assistantId = `assistant-${Date.now()}`;
      const assistantMsg: DisplayMessage = {
        id: assistantId,
        role: "assistant",
        content: "",
        streaming: true,
        timestamp: new Date().toLocaleTimeString(),
        agentName: options?.agentName,
      };
      setMessages((prev) => [...prev, assistantMsg]);
      setStreaming(true);

      try {
        const targetAgent = options?.agentId || operatorAgentId;

        if (targetAgent) {
          // Send through an agent
          const result = (await sendAgentTask(targetAgent, {
            type: "chat",
            messages: [{ role: "user", content }],
          })) as { content?: string; model?: string };

          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    content: result?.content || "No response",
                    model: result?.model,
                    streaming: false,
                  }
                : m
            )
          );
        } else {
          // Direct LLM chat with streaming
          const chatMessages: ChatMessage[] = [
            ...messages
              .filter((m) => !m.streaming)
              .map((m) => ({
                role: m.role as "user" | "assistant",
                content: m.content,
              })),
            { role: "user" as const, content },
          ];

          const result = await sendStreamingChat(
            chatMessages,
            (delta) => {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? { ...m, content: m.content + delta }
                    : m
                )
              );
            },
            { model: options?.model }
          );

          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    content: result.content,
                    model: result.model,
                    usage: result.usage,
                    streaming: false,
                  }
                : m
            )
          );
        }
      } catch (err) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  content: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
                  streaming: false,
                }
              : m
          )
        );
      } finally {
        setStreaming(false);
      }
    },
    [messages, sendStreamingChat, sendAgentTask, operatorAgentId]
  );

  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  return { messages, streaming, sendMessage, clearMessages };
}

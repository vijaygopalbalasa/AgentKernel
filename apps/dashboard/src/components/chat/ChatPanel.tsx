"use client";

import { useEffect, useRef } from "react";
import type { DisplayMessage } from "@/hooks/useChat";
import { ChatMessage } from "./ChatMessage";
import { EmptyState } from "@/components/shared/EmptyState";

interface ChatPanelProps {
  messages: DisplayMessage[];
}

export function ChatPanel({ messages }: ChatPanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  if (!messages.length) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <EmptyState message="$ Type a command to begin..." />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-3 font-mono">
      {messages.map((msg) => (
        <ChatMessage key={msg.id} message={msg} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

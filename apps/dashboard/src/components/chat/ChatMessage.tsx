"use client";

import type { DisplayMessage } from "@/hooks/useChat";

interface ChatMessageProps {
  message: DisplayMessage;
}

export function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === "user";

  return (
    <div className="mb-3 font-mono">
      {/* Prompt line */}
      <div className="flex items-center gap-2 text-xs mb-0.5">
        <span className={isUser ? "text-ctp-green" : "text-ctp-mauve"}>
          {isUser ? "user $" : `${message.agentName || "system"} >`}
        </span>
        <span className="text-ctp-overlay0 text-2xs">{message.timestamp}</span>
        {message.model && (
          <span className="text-ctp-overlay0 text-2xs">[{message.model}]</span>
        )}
      </div>

      {/* Content */}
      <div className="pl-4 text-sm text-ctp-text whitespace-pre-wrap break-words">
        {message.content}
        {message.streaming && (
          <span className="inline-block w-2 h-4 ml-0.5 bg-ctp-green animate-pulse" />
        )}
      </div>

      {/* Usage info */}
      {message.usage && (
        <div className="pl-4 mt-1 text-2xs text-ctp-overlay0">
          {message.usage.totalTokens} tokens
        </div>
      )}
    </div>
  );
}

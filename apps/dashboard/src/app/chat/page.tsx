"use client";

import { useState } from "react";
import { Window } from "@/components/shell/Window";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { ChatInput } from "@/components/chat/ChatInput";
import { AgentSelector } from "@/components/chat/AgentSelector";
import { Button } from "@/components/shared/Button";
import { useChat } from "@/hooks/useChat";
import { useAgents } from "@/hooks/useAgents";
import { useWebSocket } from "@/hooks/useWebSocket";

export default function ChatPage() {
  const { status } = useWebSocket();
  const { messages, streaming, sendMessage, clearMessages } = useChat();
  const { agents } = useAgents();
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  const selectedAgent = agents.find((a) => a.id === selectedAgentId);

  const handleSend = (content: string) => {
    sendMessage(content, {
      agentId: selectedAgentId || undefined,
      agentName: selectedAgent?.name,
    });
  };

  return (
    <Window
      title="Terminal"
      icon={
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
      }
      noPadding
      className="h-full"
    >
      <div className="flex flex-col h-full terminal-bg">
        {/* Toolbar */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-ctp-surface0 bg-ctp-crust/50">
          <AgentSelector
            agents={agents}
            selectedId={selectedAgentId}
            onSelect={setSelectedAgentId}
          />
          {messages.length > 0 && (
            <Button variant="ghost" onClick={clearMessages} className="text-xs">
              clear
            </Button>
          )}
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-hidden">
          <ChatPanel messages={messages} />
        </div>

        {/* Input */}
        <div className="border-t border-ctp-surface0">
          <ChatInput
            onSend={handleSend}
            disabled={status !== "connected" || streaming}
          />
        </div>
      </div>
    </Window>
  );
}

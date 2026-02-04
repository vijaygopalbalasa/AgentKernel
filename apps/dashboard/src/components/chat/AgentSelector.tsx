"use client";

import type { AgentInfo } from "@/lib/types";

interface AgentSelectorProps {
  agents: AgentInfo[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

export function AgentSelector({
  agents,
  selectedId,
  onSelect,
}: AgentSelectorProps) {
  return (
    <div className="flex items-center gap-2 font-mono">
      <label className="text-xs text-ctp-overlay0">target:</label>
      <select
        value={selectedId || ""}
        onChange={(e) => onSelect(e.target.value || null)}
        className="bg-ctp-surface0 border border-ctp-surface1 rounded-input px-2 py-1 text-xs text-ctp-text focus:outline-none focus:border-ctp-blue/50 transition-colors"
      >
        <option value="" className="bg-ctp-mantle">
          Direct LLM
        </option>
        {agents.map((agent) => (
          <option
            key={agent.id}
            value={agent.id}
            className="bg-ctp-mantle"
          >
            {agent.name || agent.id} ({agent.externalId || agent.id})
          </option>
        ))}
      </select>
    </div>
  );
}

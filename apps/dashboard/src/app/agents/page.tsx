"use client";

import { useState } from "react";
import { Window } from "@/components/shell/Window";
import { Panel } from "@/components/shared/Panel";
import { AgentCatalog } from "@/components/agents/AgentCatalog";
import { RunningAgents } from "@/components/agents/RunningAgents";
import { useAgents } from "@/hooks/useAgents";
import type { AgentManifest } from "@/lib/manifests";

export default function AgentsPage() {
  const { agents, spawn, terminate } = useAgents();
  const [deployingId, setDeployingId] = useState<string | null>(null);

  const handleDeploy = async (manifest: AgentManifest) => {
    setDeployingId(manifest.id);
    try {
      await spawn(manifest as unknown as Record<string, unknown>);
    } catch {
      // error shown in events
    } finally {
      setDeployingId(null);
    }
  };

  const handleTerminate = async (agentId: string) => {
    try {
      await terminate(agentId);
    } catch {
      // error shown in events
    }
  };

  return (
    <Window
      title="Task Manager"
      icon={
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="2" y="3" width="20" height="18" rx="2" />
          <path d="M6 8h12M6 12h12M6 16h8" />
        </svg>
      }
      className="h-full"
    >
      <div className="space-y-4">
        {/* Running processes */}
        <Panel>
          <h2 className="text-xs font-mono font-semibold text-ctp-subtext0 uppercase tracking-wider mb-3">
            Running Processes ({agents.length})
          </h2>
          <RunningAgents agents={agents} onTerminate={handleTerminate} />
        </Panel>

        {/* Catalog */}
        <div>
          <h2 className="text-xs font-mono font-semibold text-ctp-subtext0 uppercase tracking-wider mb-3">
            Available Programs
          </h2>
          <AgentCatalog onDeploy={handleDeploy} deployingId={deployingId} />
        </div>
      </div>
    </Window>
  );
}

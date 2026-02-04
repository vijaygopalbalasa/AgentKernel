"use client";

import { useState } from "react";
import type { AgentInfo } from "@/lib/types";
import { Tag } from "@/components/shared/Tag";
import { Button } from "@/components/shared/Button";
import { EmptyState } from "@/components/shared/EmptyState";

interface RunningAgentsProps {
  agents: AgentInfo[];
  onTerminate: (agentId: string) => void;
}

function stateVariant(state: string) {
  if (state === "running") return "success" as const;
  if (state === "error") return "danger" as const;
  if (state === "ready") return "info" as const;
  return "default" as const;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

export function RunningAgents({ agents, onTerminate }: RunningAgentsProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (!agents.length) {
    return <EmptyState message="No processes running" />;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs font-mono">
        <thead>
          <tr className="text-ctp-overlay0 border-b border-ctp-surface0">
            <th className="text-left py-2 px-2 font-medium">PID</th>
            <th className="text-left py-2 px-2 font-medium">NAME</th>
            <th className="text-left py-2 px-2 font-medium">STATE</th>
            <th className="text-left py-2 px-2 font-medium">MODEL</th>
            <th className="text-left py-2 px-2 font-medium">TRUST</th>
            <th className="text-left py-2 px-2 font-medium">UPTIME</th>
            <th className="text-left py-2 px-2 font-medium">TOKENS</th>
            <th className="text-right py-2 px-2 font-medium" />
          </tr>
        </thead>
        <tbody>
          {agents.map((agent) => {
            const isExpanded = expandedId === agent.id;
            return (
              <tr key={agent.id} className="group">
                <td colSpan={8} className="p-0">
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : agent.id)}
                    className="w-full text-left grid grid-cols-[auto_1fr_auto_auto_auto_auto_auto_auto] items-center border-b border-ctp-surface0/50 hover:bg-ctp-surface0/30 transition-colors"
                  >
                    <span className="py-2 px-2 text-ctp-overlay1" title={agent.id}>
                      {agent.id.slice(0, 8)}
                    </span>
                    <span className="py-2 px-2 text-ctp-text">
                      {agent.name || agent.id}
                    </span>
                    <span className="py-2 px-2">
                      <Tag variant={stateVariant(agent.state)}>{agent.state}</Tag>
                    </span>
                    <span className="py-2 px-2 text-ctp-mauve">
                      {agent.model || "—"}
                    </span>
                    <span className="py-2 px-2 text-ctp-overlay1">
                      {agent.trustLevel || "—"}
                    </span>
                    <span className="py-2 px-2 text-ctp-overlay1 tabular-nums">
                      {formatUptime(agent.uptime)}
                    </span>
                    <span className="py-2 px-2 text-ctp-overlay1 tabular-nums">
                      {agent.tokenUsage && (agent.tokenUsage.input > 0 || agent.tokenUsage.output > 0)
                        ? `${agent.tokenUsage.input}/${agent.tokenUsage.output}`
                        : "—"}
                    </span>
                    <span className="py-2 px-2 text-right">
                      <Button
                        variant="danger"
                        onClick={(e) => { e.stopPropagation(); onTerminate(agent.id); }}
                        className="text-2xs px-2 py-1"
                      >
                        kill
                      </Button>
                    </span>
                  </button>

                  {isExpanded && (
                    <div className="px-4 py-3 bg-ctp-crust/50 border-b border-ctp-surface0/50 space-y-1.5">
                      <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
                        <div>
                          <span className="text-ctp-overlay0">Full ID: </span>
                          <span className="text-ctp-text select-all">{agent.id}</span>
                        </div>
                        {agent.externalId && (
                          <div>
                            <span className="text-ctp-overlay0">External: </span>
                            <span className="text-ctp-text">{agent.externalId}</span>
                          </div>
                        )}
                        <div>
                          <span className="text-ctp-overlay0">Model: </span>
                          <span className="text-ctp-mauve">{agent.model || "none"}</span>
                        </div>
                        <div>
                          <span className="text-ctp-overlay0">State: </span>
                          <span className="text-ctp-text">{agent.state}</span>
                        </div>
                        <div>
                          <span className="text-ctp-overlay0">Trust: </span>
                          <span className="text-ctp-text">{agent.trustLevel || "unset"}</span>
                        </div>
                        <div>
                          <span className="text-ctp-overlay0">Uptime: </span>
                          <span className="text-ctp-text">{formatUptime(agent.uptime)}</span>
                        </div>
                        {agent.tokenUsage && (
                          <div>
                            <span className="text-ctp-overlay0">Tokens: </span>
                            <span className="text-ctp-text">
                              {agent.tokenUsage.input} in / {agent.tokenUsage.output} out
                            </span>
                          </div>
                        )}
                      </div>
                      <div className="pt-1">
                        <Button
                          variant="danger"
                          onClick={() => onTerminate(agent.id)}
                          className="text-xs"
                        >
                          Terminate Process
                        </Button>
                      </div>
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

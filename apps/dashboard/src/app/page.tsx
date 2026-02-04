"use client";

import Link from "next/link";
import { Window } from "@/components/shell/Window";
import { StatusCard } from "@/components/home/StatusCard";
import { MetricBar } from "@/components/home/MetricBar";
import { EventFeed } from "@/components/home/EventFeed";
import { Panel } from "@/components/shared/Panel";
import { Tag } from "@/components/shared/Tag";
import { useHealth } from "@/hooks/useHealth";
import { useEvents } from "@/hooks/useEvents";
import { useAgents } from "@/hooks/useAgents";

export default function HomePage() {
  const { health, metrics, loading, refresh } = useHealth();
  const { events } = useEvents();
  const { agents } = useAgents();

  const agentsByState = agents.reduce(
    (acc, agent) => {
      acc[agent.state] = (acc[agent.state] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  return (
    <Window
      title="System Monitor"
      icon={
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="2" y="3" width="20" height="14" rx="2" />
          <path d="M8 21h8M12 17v4" />
        </svg>
      }
      className="h-full"
    >
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <StatusCard
          health={health}
          agentCount={agents.length}
          loading={loading}
        />

        <Panel>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs font-mono font-semibold text-ctp-subtext0 uppercase tracking-wider">
              Runtime Metrics
            </h2>
            <button
              onClick={refresh}
              className="text-xs text-ctp-overlay0 hover:text-ctp-blue transition-colors font-mono underline decoration-ctp-surface1 hover:decoration-ctp-blue"
            >
              refresh
            </button>
          </div>
          <div className="space-y-3">
            <MetricBar
              label="Input Tokens"
              value={metrics?.inputTokens.toLocaleString() ?? "—"}
              rawValue={metrics?.inputTokens ?? 0}
              color="#89b4fa"
            />
            <MetricBar
              label="Output Tokens"
              value={metrics?.outputTokens.toLocaleString() ?? "—"}
              rawValue={metrics?.outputTokens ?? 0}
              color="#cba6f7"
            />
            <MetricBar
              label="Cost"
              value={metrics ? `$${metrics.costUsd.toFixed(4)}` : "—"}
              rawValue={metrics?.costUsd ?? 0}
              color="#a6e3a1"
            />
          </div>
        </Panel>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Link href="/agents" className="block group">
          <Panel className="h-full transition-colors group-hover:border-ctp-blue/30">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs font-mono font-semibold text-ctp-subtext0 uppercase tracking-wider">
                Processes
              </h2>
              <span className="text-2xs font-mono text-ctp-overlay0 group-hover:text-ctp-blue transition-colors">
                Open Task Manager →
              </span>
            </div>
            {agents.length === 0 ? (
              <div className="text-sm text-ctp-overlay0 font-mono">
                No agents running.{" "}
                <span className="text-ctp-blue/70 group-hover:text-ctp-blue">Click to start one.</span>
              </div>
            ) : (
              <div className="space-y-2">
                {Object.entries(agentsByState).map(([state, count]) => (
                  <div key={state} className="flex items-center justify-between">
                    <Tag
                      variant={
                        state === "running"
                          ? "success"
                          : state === "error"
                            ? "danger"
                            : state === "ready"
                              ? "info"
                              : "default"
                      }
                    >
                      {state}
                    </Tag>
                    <span className="text-sm font-mono font-bold text-ctp-text tabular-nums">
                      {count}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </Link>

        <Panel className="lg:col-span-2">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs font-mono font-semibold text-ctp-subtext0 uppercase tracking-wider">
              Event Log
            </h2>
            {events.length > 0 && (
              <span className="text-2xs font-mono text-ctp-overlay0 tabular-nums">
                {events.length} events
              </span>
            )}
          </div>
          <EventFeed events={events} />
        </Panel>
      </div>
    </Window>
  );
}

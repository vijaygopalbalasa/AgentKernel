"use client";

import Link from "next/link";
import type { HealthData } from "@/lib/types";
import { Panel } from "@/components/shared/Panel";
import { Tag } from "@/components/shared/Tag";

interface StatusCardProps {
  health: HealthData | null;
  agentCount: number;
  loading: boolean;
}

export function StatusCard({ health, agentCount, loading }: StatusCardProps) {
  const statusVariant =
    health?.status === "healthy"
      ? "success"
      : health?.status === "offline"
        ? "danger"
        : "warning";

  return (
    <Link href="/settings" className="block group">
      <Panel className="transition-colors group-hover:border-ctp-blue/30">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs font-mono font-semibold text-ctp-subtext0 uppercase tracking-wider">
            Gateway Status
          </h2>
          <div className="flex items-center gap-2">
            {loading && (
              <div className="w-3 h-3 rounded-full border-2 border-ctp-blue/30 border-t-ctp-blue animate-spin" />
            )}
            <span className="text-2xs font-mono text-ctp-overlay0 group-hover:text-ctp-blue transition-colors">
              Settings →
            </span>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div>
            <div className="text-xs text-ctp-overlay0 font-mono mb-1">status</div>
            <Tag variant={statusVariant}>
              {health?.status || "unknown"}
            </Tag>
          </div>
          <div>
            <div className="text-xs text-ctp-overlay0 font-mono mb-1">providers</div>
            <div className="text-lg font-mono font-bold text-ctp-text tabular-nums">
              {health?.providers?.length ?? "—"}
            </div>
          </div>
          <div>
            <div className="text-xs text-ctp-overlay0 font-mono mb-1">agents</div>
            <div className="text-lg font-mono font-bold text-ctp-text tabular-nums">
              {agentCount}
            </div>
          </div>
        </div>
      </Panel>
    </Link>
  );
}

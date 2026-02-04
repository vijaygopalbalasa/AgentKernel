"use client";

import { useState, useEffect } from "react";
import { useWebSocket } from "@/hooks/useWebSocket";
import { useAgents } from "@/hooks/useAgents";

export function SystemTray() {
  const { status } = useWebSocket();
  const { agents } = useAgents();
  const [time, setTime] = useState("");

  useEffect(() => {
    const tick = () => {
      const now = new Date();
      setTime(
        now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      );
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);

  const runningCount = agents.filter(
    (a) => a.state === "running" || a.state === "ready"
  ).length;

  const statusColor =
    status === "connected"
      ? "bg-ctp-green"
      : status === "auth_failed"
        ? "bg-ctp-red"
        : "bg-ctp-yellow";

  return (
    <div className="flex items-center gap-4 text-xs font-mono text-ctp-subtext0">
      <div className="flex items-center gap-1.5" title={`Gateway: ${status}`}>
        <span className={`w-2 h-2 rounded-full ${statusColor}`} />
        <span className="hidden sm:inline">{status}</span>
      </div>
      <div className="flex items-center gap-1.5" title={`${runningCount} agent(s) running`}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
          <path d="M5 3a3 3 0 1 1 6 0 3 3 0 0 1-6 0zm-1 8a4 4 0 0 1 8 0v1H4v-1z" />
        </svg>
        <span>{runningCount}</span>
      </div>
      <div className="text-ctp-subtext1 font-medium tabular-nums">
        {time}
      </div>
    </div>
  );
}

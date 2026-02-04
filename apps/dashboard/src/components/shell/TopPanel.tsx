"use client";

import { SystemTray } from "./SystemTray";

export function TopPanel() {
  return (
    <header className="h-8 bg-ctp-crust border-b border-ctp-surface0 flex items-center justify-between px-4 select-none shrink-0">
      {/* Left — wordmark */}
      <div className="flex items-center gap-2">
        <span className="font-mono font-bold text-xs text-ctp-blue tracking-wider">
          AgentRun
        </span>
      </div>

      {/* Right — system tray */}
      <SystemTray />
    </header>
  );
}

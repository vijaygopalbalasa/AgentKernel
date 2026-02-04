"use client";

import { useState, useEffect, type ReactNode } from "react";
import { useWebSocket } from "@/hooks/useWebSocket";
import { TopPanel } from "./TopPanel";
import { Taskbar } from "./Taskbar";
import { SetupAssistant } from "./SetupAssistant";

interface DesktopShellProps {
  children: ReactNode;
}

export function DesktopShell({ children }: DesktopShellProps) {
  const { operatorAgentId } = useWebSocket();
  const [setupDismissed, setSetupDismissed] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
    const dismissed = localStorage.getItem("setupDismissed");
    if (dismissed === "true") setSetupDismissed(true);
  }, []);

  const handleSetupComplete = () => {
    setSetupDismissed(true);
    localStorage.setItem("setupDismissed", "true");
  };

  // Don't render until hydrated to avoid SSR mismatch
  if (!hydrated) {
    return (
      <div className="h-screen bg-ctp-base flex items-center justify-center">
        <div className="text-sm font-mono text-ctp-overlay0">Loading...</div>
      </div>
    );
  }

  // Show setup assistant on first boot
  if (!operatorAgentId && !setupDismissed) {
    return <SetupAssistant onComplete={handleSetupComplete} />;
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <TopPanel />
      <main className="flex-1 overflow-auto p-4 lg:p-6">{children}</main>
      <Taskbar />
    </div>
  );
}

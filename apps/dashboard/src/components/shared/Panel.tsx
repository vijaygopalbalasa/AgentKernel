"use client";

import type { ReactNode } from "react";

interface PanelProps {
  children: ReactNode;
  className?: string;
}

export function Panel({ children, className = "" }: PanelProps) {
  return (
    <div
      className={`os-panel p-4 ${className}`}
    >
      {children}
    </div>
  );
}

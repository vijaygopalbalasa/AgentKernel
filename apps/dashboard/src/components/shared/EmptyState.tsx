"use client";

import { type ReactNode } from "react";

interface EmptyStateProps {
  message: string;
  hint?: ReactNode;
  className?: string;
}

export function EmptyState({ message, hint, className = "" }: EmptyStateProps) {
  return (
    <div className={`py-8 text-center font-mono ${className}`}>
      <div className="text-sm text-ctp-overlay0">{message}</div>
      {hint && (
        <div className="text-xs text-ctp-overlay0/70 mt-1">{hint}</div>
      )}
    </div>
  );
}

"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

interface WindowProps {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Remove inner padding — useful for full-bleed content like terminals */
  noPadding?: boolean;
}

export function Window({ title, icon, children, className, noPadding }: WindowProps) {
  const router = useRouter();
  const [minimized, setMinimized] = useState(false);

  return (
    <div
      className={`flex flex-col bg-ctp-mantle border border-ctp-surface0 rounded-window shadow-lg shadow-black/20 overflow-hidden ${className ?? ""}`}
    >
      {/* Title bar */}
      <div className="window-titlebar shrink-0">
        {/* Traffic lights */}
        <div className="flex items-center gap-1.5 mr-2">
          <button
            onClick={() => router.push("/")}
            className="w-3 h-3 rounded-full bg-ctp-red hover:brightness-110 transition-all"
            title="Close — go to desktop"
          />
          <button
            onClick={() => setMinimized(!minimized)}
            className="w-3 h-3 rounded-full bg-ctp-yellow hover:brightness-110 transition-all"
            title={minimized ? "Restore" : "Minimize"}
          />
          <button
            onClick={() => setMinimized(false)}
            className="w-3 h-3 rounded-full bg-ctp-green hover:brightness-110 transition-all"
            title="Maximize"
          />
        </div>

        {/* App icon + title */}
        {icon && <span className="text-ctp-subtext0">{icon}</span>}
        <span className="text-xs font-mono font-medium text-ctp-subtext1 truncate">
          {title}
        </span>
      </div>

      {/* Content */}
      {!minimized && (
        <div className={`flex-1 overflow-auto ${noPadding ? "" : "p-4"}`}>
          {children}
        </div>
      )}
      {minimized && (
        <div className="px-4 py-6 text-center">
          <button
            onClick={() => setMinimized(false)}
            className="text-xs font-mono text-ctp-overlay0 hover:text-ctp-text transition-colors"
          >
            Click to restore window
          </button>
        </div>
      )}
    </div>
  );
}

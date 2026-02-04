"use client";

import type { InputHTMLAttributes } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
}

export function Input({ label, className = "", id, ...props }: InputProps) {
  const inputId = id || label?.toLowerCase().replace(/\s+/g, "-");
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={inputId} className="text-xs text-ctp-subtext0 font-medium">
          {label}
        </label>
      )}
      <input
        id={inputId}
        className={`bg-ctp-surface0 border border-ctp-surface1 rounded-input px-3 py-2 text-sm text-ctp-text placeholder:text-ctp-overlay0 focus:outline-none focus:border-ctp-blue/50 focus:ring-1 focus:ring-ctp-blue/20 transition-colors ${className}`}
        {...props}
      />
    </div>
  );
}

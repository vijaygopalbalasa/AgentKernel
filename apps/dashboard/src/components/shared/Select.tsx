"use client";

import type { SelectHTMLAttributes } from "react";

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  options: Array<{ value: string; label: string }>;
}

export function Select({
  label,
  options,
  className = "",
  id,
  ...props
}: SelectProps) {
  const selectId = id || label?.toLowerCase().replace(/\s+/g, "-");
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label
          htmlFor={selectId}
          className="text-xs text-ctp-subtext0 font-medium"
        >
          {label}
        </label>
      )}
      <select
        id={selectId}
        className={`bg-ctp-surface0 border border-ctp-surface1 rounded-input px-3 py-2 text-sm text-ctp-text focus:outline-none focus:border-ctp-blue/50 focus:ring-1 focus:ring-ctp-blue/20 transition-colors ${className}`}
        {...props}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value} className="bg-ctp-mantle">
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

"use client";

interface MetricBarProps {
  label: string;
  value: string;
  rawValue: number;
  color: string;
}

function scaleBar(value: number): number {
  if (value <= 0) return 0;
  const scaled = Math.log10(value + 1) / 6;
  return Math.min(100, Math.max(2, scaled * 100));
}

export function MetricBar({ label, value, rawValue, color }: MetricBarProps) {
  const width = scaleBar(rawValue);

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-ctp-overlay0 font-mono">{label}</span>
        <span className="text-xs font-mono font-medium text-ctp-subtext1 tabular-nums">
          {value}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-ctp-surface0 overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500 ease-out"
          style={{ width: `${width}%`, background: color }}
        />
      </div>
    </div>
  );
}

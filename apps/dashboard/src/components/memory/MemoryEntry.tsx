"use client";

import type { MemoryResult } from "@/lib/types";
import { Tag } from "@/components/shared/Tag";

interface MemoryEntryProps {
  memory: MemoryResult;
}

const typeBorder: Record<string, string> = {
  semantic: "border-ctp-blue",
  episodic: "border-ctp-mauve",
  procedural: "border-ctp-green",
};

export function MemoryEntry({ memory }: MemoryEntryProps) {
  return (
    <div
      className={`border-l-2 ${typeBorder[memory.type] || "border-ctp-surface1"} pl-3 py-2`}
    >
      <div className="flex items-center gap-2 mb-1">
        <Tag
          variant={
            memory.type === "semantic"
              ? "info"
              : memory.type === "episodic"
                ? "default"
                : "success"
          }
        >
          {memory.type}
        </Tag>
        <span className="text-2xs text-ctp-overlay0 font-mono tabular-nums">
          score: {typeof memory.score === "number" ? memory.score.toFixed(2) : "—"}
        </span>
        {memory.importance !== undefined && (
          <span className="text-2xs text-ctp-overlay0 font-mono tabular-nums">
            imp: {memory.importance}
          </span>
        )}
      </div>
      <div className="text-sm text-ctp-subtext1 mb-1">{memory.content}</div>
      {memory.tags && memory.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {memory.tags.map((tag) => (
            <span
              key={tag}
              className="text-2xs px-1.5 py-0.5 rounded bg-ctp-surface0 text-ctp-overlay1 font-mono"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

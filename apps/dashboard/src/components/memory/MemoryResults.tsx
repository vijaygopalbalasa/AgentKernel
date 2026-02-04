"use client";

import type { MemoryResult } from "@/lib/types";
import { MemoryEntry } from "./MemoryEntry";
import { EmptyState } from "@/components/shared/EmptyState";

interface MemoryResultsProps {
  results: MemoryResult[];
  loading?: boolean;
}

export function MemoryResults({ results, loading }: MemoryResultsProps) {
  if (loading) {
    return (
      <div className="py-8 text-center">
        <div className="inline-block w-4 h-4 rounded-full border-2 border-ctp-blue/30 border-t-ctp-blue animate-spin" />
      </div>
    );
  }

  if (!results.length) {
    return <EmptyState message="No memories found. Try a different query." />;
  }

  return (
    <div className="space-y-1">
      {results.map((memory, i) => (
        <MemoryEntry key={`${memory.type}-${i}`} memory={memory} />
      ))}
    </div>
  );
}

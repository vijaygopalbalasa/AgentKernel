"use client";

import { useState, useCallback, type FormEvent } from "react";
import { Input } from "@/components/shared/Input";
import { Button } from "@/components/shared/Button";

interface MemorySearchProps {
  onSearch: (query: string, types?: string[]) => void;
  loading?: boolean;
  activeType?: string | null;
}

const MEMORY_TYPES = ["semantic", "episodic", "procedural"] as const;

const typeColors: Record<string, string> = {
  semantic: "border-ctp-blue bg-ctp-blue/15 text-ctp-blue",
  episodic: "border-ctp-mauve bg-ctp-mauve/15 text-ctp-mauve",
  procedural: "border-ctp-green bg-ctp-green/15 text-ctp-green",
};

export function MemorySearch({ onSearch, loading, activeType }: MemorySearchProps) {
  const [query, setQuery] = useState("");
  const [activeTypes, setActiveTypes] = useState<Set<string>>(new Set());

  const toggleType = useCallback((type: string) => {
    setActiveTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  }, []);

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      if (!query.trim()) return;
      const types = activeTypes.size > 0 ? [...activeTypes] : undefined;
      onSearch(query.trim(), types);
    },
    [query, activeTypes, onSearch]
  );

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="flex gap-3">
        <div className="flex-1">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search memory..."
          />
        </div>
        <Button type="submit" disabled={loading || !query.trim()}>
          {loading ? "Searching..." : "Search"}
        </Button>
      </div>
      <div className="flex gap-2 items-center">
        {MEMORY_TYPES.map((type) => (
          <button
            key={type}
            type="button"
            onClick={() => toggleType(type)}
            className={`px-3 py-1 text-xs font-mono rounded-pill border transition-colors ${
              activeTypes.has(type) || activeType === type
                ? typeColors[type]
                : "border-ctp-surface1 text-ctp-overlay0 hover:text-ctp-subtext1"
            }`}
          >
            {type}
          </button>
        ))}
        {activeType && (
          <span className="text-2xs text-ctp-overlay0 font-mono ml-1">
            (filtered via sidebar)
          </span>
        )}
      </div>
    </form>
  );
}

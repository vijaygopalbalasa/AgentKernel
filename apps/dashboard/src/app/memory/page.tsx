"use client";

import { useState, useCallback } from "react";
import { Window } from "@/components/shell/Window";
import { Panel } from "@/components/shared/Panel";
import { MemorySearch } from "@/components/memory/MemorySearch";
import { MemoryResults } from "@/components/memory/MemoryResults";
import { StoreFactForm } from "@/components/memory/StoreFactForm";
import { useMemory } from "@/hooks/useMemory";

const MEMORY_TYPES = [
  {
    id: "semantic",
    label: "Semantic",
    active: "text-ctp-blue bg-ctp-blue/10 font-medium",
    inactive: "text-ctp-overlay1 hover:text-ctp-blue hover:bg-ctp-blue/5",
    iconActive: "text-ctp-blue",
    icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></svg>,
  },
  {
    id: "episodic",
    label: "Episodic",
    active: "text-ctp-mauve bg-ctp-mauve/10 font-medium",
    inactive: "text-ctp-overlay1 hover:text-ctp-mauve hover:bg-ctp-mauve/5",
    iconActive: "text-ctp-mauve",
    icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>,
  },
  {
    id: "procedural",
    label: "Procedural",
    active: "text-ctp-green bg-ctp-green/10 font-medium",
    inactive: "text-ctp-overlay1 hover:text-ctp-green hover:bg-ctp-green/5",
    iconActive: "text-ctp-green",
    icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" /></svg>,
  },
] as const;

export default function MemoryPage() {
  const { results, loading, error, search, storeFact } = useMemory();
  const [activeType, setActiveType] = useState<string | null>(null);

  const handleTypeClick = useCallback((typeId: string) => {
    setActiveType((prev) => prev === typeId ? null : typeId);
  }, []);

  const handleSearch = useCallback((query: string, types?: string[]) => {
    const filterTypes = activeType ? [activeType] : types;
    search(query, filterTypes);
  }, [activeType, search]);

  return (
    <Window
      title="File Manager — Memory"
      icon={
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
      }
      className="h-full"
    >
      <div className="flex flex-col lg:flex-row gap-4 h-full">
        {/* Sidebar — memory types */}
        <div className="lg:w-48 shrink-0">
          <Panel className="space-y-1">
            <h2 className="text-xs font-mono font-semibold text-ctp-subtext0 uppercase tracking-wider mb-2">
              Memory Types
            </h2>
            {MEMORY_TYPES.map((type) => {
              const isActive = activeType === type.id;
              return (
                <button
                  key={type.id}
                  onClick={() => handleTypeClick(type.id)}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-input text-xs font-mono transition-colors text-left ${
                    isActive ? type.active : type.inactive
                  }`}
                >
                  <span className={isActive ? type.iconActive : "text-ctp-overlay0"}>
                    {type.icon}
                  </span>
                  {type.label}
                  {isActive && (
                    <span className="ml-auto text-2xs text-ctp-overlay0">✕</span>
                  )}
                </button>
              );
            })}
          </Panel>
          <div className="mt-3">
            <StoreFactForm onStore={storeFact} />
          </div>
        </div>

        {/* Main — search + results */}
        <div className="flex-1 min-w-0">
          <Panel>
            <MemorySearch
              onSearch={handleSearch}
              loading={loading}
              activeType={activeType}
            />
            {error && (
              <div className="mt-2 text-xs text-ctp-red font-mono">{error}</div>
            )}
            <div className="mt-4">
              <MemoryResults results={results} loading={loading} />
            </div>
          </Panel>
        </div>
      </div>
    </Window>
  );
}

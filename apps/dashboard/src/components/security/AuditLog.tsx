"use client";

import { useState, type FormEvent } from "react";
import type { AuditEntry } from "@/lib/types";
import { Input } from "@/components/shared/Input";
import { Button } from "@/components/shared/Button";
import { EmptyState } from "@/components/shared/EmptyState";

interface AuditLogProps {
  entries: AuditEntry[];
  loading?: boolean;
  onQuery: (filters?: { action?: string; actorId?: string; limit?: number }) => void;
}

export function AuditLog({ entries, loading, onQuery }: AuditLogProps) {
  const [action, setAction] = useState("");
  const [actorId, setActorId] = useState("");
  const [limit, setLimit] = useState("50");

  const handleSearch = (e: FormEvent) => {
    e.preventDefault();
    onQuery({
      action: action.trim() || undefined,
      actorId: actorId.trim() || undefined,
      limit: Number(limit) || 50,
    });
  };

  return (
    <div>
      <form onSubmit={handleSearch} className="flex gap-2 items-end mb-4">
        <Input label="Action" value={action} onChange={(e) => setAction(e.target.value)} placeholder="filter by action" />
        <Input label="Actor ID" value={actorId} onChange={(e) => setActorId(e.target.value)} placeholder="filter by actor" />
        <div className="w-20">
          <Input label="Limit" type="number" value={limit} onChange={(e) => setLimit(e.target.value)} />
        </div>
        <Button type="submit" disabled={loading}>
          {loading ? "Loading..." : "Query"}
        </Button>
      </form>

      {entries.length === 0 ? (
        <EmptyState message="No audit entries" />
      ) : (
        <div className="space-y-2 max-h-96 overflow-y-auto">
          {entries.map((entry, i) => (
            <div key={entry.id || i} className="os-panel px-3 py-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-ctp-text">{entry.action}</span>
                <span className="text-2xs text-ctp-overlay0">
                  {new Date(entry.created_at).toLocaleString()}
                </span>
              </div>
              <div className="text-2xs text-ctp-overlay0 mt-0.5">
                Actor: {entry.actor_id || "—"} | Resource: {entry.resource_type || "—"} | Outcome: {entry.outcome}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

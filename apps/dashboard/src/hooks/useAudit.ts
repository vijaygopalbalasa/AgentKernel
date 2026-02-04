"use client";

import { useState, useCallback } from "react";
import type { AuditEntry } from "@/lib/types";
import { useWebSocket } from "./useWebSocket";

export function useAudit() {
  const { sendAgentTask, operatorAgentId } = useWebSocket();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const query = useCallback(
    async (filters?: { action?: string; actorId?: string; limit?: number }) => {
      if (!operatorAgentId) {
        setError("Set operator agent first");
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const result = (await sendAgentTask(operatorAgentId, {
          type: "audit_query",
          ...(filters?.action && { action: filters.action }),
          ...(filters?.actorId && { actorId: filters.actorId }),
          limit: filters?.limit || 50,
        })) as { entries?: AuditEntry[] };
        setEntries(result?.entries ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Audit query failed");
      } finally {
        setLoading(false);
      }
    },
    [sendAgentTask, operatorAgentId]
  );

  return { entries, loading, error, query };
}

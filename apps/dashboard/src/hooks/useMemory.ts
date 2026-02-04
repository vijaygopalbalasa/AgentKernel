"use client";

import { useState, useCallback } from "react";
import type { MemoryResult } from "@/lib/types";
import { useWebSocket } from "./useWebSocket";

export function useMemory() {
  const { sendAgentTask, operatorAgentId } = useWebSocket();
  const [results, setResults] = useState<MemoryResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = useCallback(
    async (
      query: string,
      types?: string[],
      limit?: number
    ) => {
      if (!operatorAgentId) {
        setError("Set an operator agent in Settings first");
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const result = (await sendAgentTask(operatorAgentId, {
          type: "search_memory",
          query,
          ...(types?.length && { types }),
          ...(limit && { limit }),
        })) as { memories?: MemoryResult[] };
        setResults(result?.memories ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Search failed");
        setResults([]);
      } finally {
        setLoading(false);
      }
    },
    [sendAgentTask, operatorAgentId]
  );

  const storeFact = useCallback(
    async (fact: {
      category: string;
      fact: string;
      tags?: string[];
      importance?: number;
    }) => {
      if (!operatorAgentId) {
        throw new Error("Set an operator agent in Settings first");
      }
      await sendAgentTask(operatorAgentId, {
        type: "store_fact",
        ...fact,
      });
    },
    [sendAgentTask, operatorAgentId]
  );

  return { results, loading, error, search, storeFact };
}

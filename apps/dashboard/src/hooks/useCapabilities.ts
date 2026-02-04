"use client";

import { useState, useCallback } from "react";
import type { CapabilityToken } from "@/lib/types";
import { useWebSocket } from "./useWebSocket";

export function useCapabilities() {
  const { sendAgentTask, operatorAgentId } = useWebSocket();
  const [tokens, setTokens] = useState<CapabilityToken[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const task = useCallback(
    async (taskData: Record<string, unknown>) => {
      if (!operatorAgentId) throw new Error("Set operator agent first");
      return sendAgentTask(operatorAgentId, taskData);
    },
    [sendAgentTask, operatorAgentId]
  );

  const listTokens = useCallback(
    async (agentId?: string) => {
      setLoading(true);
      setError(null);
      try {
        const result = (await task({
          type: "capability_list",
          agentId: agentId || operatorAgentId,
        })) as { tokens?: CapabilityToken[] };
        setTokens(result?.tokens ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to list tokens");
      } finally {
        setLoading(false);
      }
    },
    [task, operatorAgentId]
  );

  const grant = useCallback(
    async (
      agentId: string,
      permissions: string[],
      purpose?: string,
      durationMs?: number
    ) => {
      await task({
        type: "capability_grant",
        agentId,
        permissions,
        ...(purpose && { purpose }),
        ...(durationMs && { durationMs }),
      });
      await listTokens(agentId);
    },
    [task, listTokens]
  );

  const revoke = useCallback(
    async (tokenId: string) => {
      await task({ type: "capability_revoke", tokenId });
      await listTokens();
    },
    [task, listTokens]
  );

  const revokeAll = useCallback(
    async (agentId: string) => {
      await task({ type: "capability_revoke_all", agentId });
      await listTokens(agentId);
    },
    [task, listTokens]
  );

  return { tokens, loading, error, listTokens, grant, revoke, revokeAll };
}

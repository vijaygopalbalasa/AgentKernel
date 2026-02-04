"use client";

import { useState, useEffect, useCallback } from "react";
import type { AgentInfo } from "@/lib/types";
import { useWebSocket } from "./useWebSocket";
import {
  agentStatusMessage,
  agentSpawnMessage,
  agentTerminateMessage,
} from "@/lib/ws-client";

const POLL_INTERVAL = 10_000;

export function useAgents() {
  const { status, sendRequest } = useWebSocket();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (status !== "connected") return;
    try {
      setLoading(true);
      const response = await sendRequest(agentStatusMessage());
      if (response.type === "agent_list" && response.payload) {
        setAgents(
          (response.payload.agents as AgentInfo[]) || []
        );
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch agents");
    } finally {
      setLoading(false);
    }
  }, [status, sendRequest]);

  useEffect(() => {
    if (status === "connected") {
      refresh();
      const interval = setInterval(refresh, POLL_INTERVAL);
      return () => clearInterval(interval);
    }
  }, [status, refresh]);

  const spawn = useCallback(
    async (manifest: Record<string, unknown>) => {
      const response = await sendRequest(agentSpawnMessage(manifest));
      if (response.type === "error") {
        throw new Error(
          (response.payload?.message as string) || "Failed to spawn agent"
        );
      }
      await refresh();
      return response;
    },
    [sendRequest, refresh]
  );

  const terminate = useCallback(
    async (agentId: string, force = false) => {
      const response = await sendRequest(
        agentTerminateMessage(agentId, force)
      );
      if (response.type === "error") {
        throw new Error(
          (response.payload?.message as string) ||
            "Failed to terminate agent"
        );
      }
      await refresh();
      return response;
    },
    [sendRequest, refresh]
  );

  return { agents, loading, error, refresh, spawn, terminate };
}

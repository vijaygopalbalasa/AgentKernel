"use client";

import { useState, useCallback } from "react";
import type {
  PolicyInfo,
  ModerationCase,
  Sanction,
  Appeal,
} from "@/lib/types";
import { useWebSocket } from "./useWebSocket";

interface GovernanceData {
  policies: PolicyInfo[];
  cases: ModerationCase[];
  sanctions: Sanction[];
  appeals: Appeal[];
}

export function useGovernance() {
  const { sendAgentTask, operatorAgentId } = useWebSocket();
  const [data, setData] = useState<GovernanceData>({
    policies: [],
    cases: [],
    sanctions: [],
    appeals: [],
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const task = useCallback(
    async (taskData: Record<string, unknown>) => {
      if (!operatorAgentId) throw new Error("Set operator agent first");
      return sendAgentTask(operatorAgentId, taskData);
    },
    [sendAgentTask, operatorAgentId]
  );

  const refresh = useCallback(async () => {
    if (!operatorAgentId) return;
    setLoading(true);
    setError(null);
    try {
      const [policies, cases, sanctions, appeals] = await Promise.all([
        task({ type: "policy_list", limit: 50 }),
        task({ type: "moderation_case_list", limit: 50 }),
        task({ type: "sanction_list", limit: 50 }),
        task({ type: "appeal_list", limit: 50 }),
      ]);
      setData({
        policies: (policies as { policies?: PolicyInfo[] })?.policies ?? [],
        cases: (cases as { cases?: ModerationCase[] })?.cases ?? [],
        sanctions:
          (sanctions as { sanctions?: Sanction[] })?.sanctions ?? [],
        appeals: (appeals as { appeals?: Appeal[] })?.appeals ?? [],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch");
    } finally {
      setLoading(false);
    }
  }, [task, operatorAgentId]);

  const openCase = useCallback(
    async (subjectAgentId: string, policyId?: string, reason?: string) => {
      await task({
        type: "moderation_case_open",
        subjectAgentId,
        ...(policyId && { policyId }),
        ...(reason && { reason }),
      });
      await refresh();
    },
    [task, refresh]
  );

  const resolveCase = useCallback(
    async (caseId: string, status?: string, resolution?: string) => {
      await task({
        type: "moderation_case_resolve",
        caseId,
        ...(status && { status }),
        ...(resolution && { resolution }),
      });
      await refresh();
    },
    [task, refresh]
  );

  const applySanction = useCallback(
    async (subjectAgentId: string, sanctionType: string) => {
      await task({ type: "sanction_apply", subjectAgentId, sanctionType });
      await refresh();
    },
    [task, refresh]
  );

  const liftSanction = useCallback(
    async (sanctionId: string) => {
      await task({ type: "sanction_lift", sanctionId });
      await refresh();
    },
    [task, refresh]
  );

  const openAppeal = useCallback(
    async (caseId: string, reason?: string) => {
      await task({
        type: "appeal_open",
        caseId,
        ...(reason && { reason }),
      });
      await refresh();
    },
    [task, refresh]
  );

  const resolveAppeal = useCallback(
    async (appealId: string, status?: string, resolution?: string) => {
      await task({
        type: "appeal_resolve",
        appealId,
        ...(status && { status }),
        ...(resolution && { resolution }),
      });
      await refresh();
    },
    [task, refresh]
  );

  return {
    ...data,
    loading,
    error,
    refresh,
    openCase,
    resolveCase,
    applySanction,
    liftSanction,
    openAppeal,
    resolveAppeal,
  };
}

"use client";

import { useState } from "react";
import { Input } from "@/components/shared/Input";
import { Button } from "@/components/shared/Button";
import { useWebSocket } from "@/hooks/useWebSocket";

export function IncidentPanel() {
  const { sendAgentTask, operatorAgentId } = useWebSocket();
  const [policyName, setPolicyName] = useState("Global Lockdown");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const task = async (taskData: Record<string, unknown>) => {
    if (!operatorAgentId) throw new Error("Set operator agent first");
    return sendAgentTask(operatorAgentId, taskData);
  };

  const getLockdownPolicy = async (name: string) => {
    const result = (await task({ type: "policy_list", limit: 100 })) as {
      policies?: Array<{ id: string; name: string }>;
    };
    return result?.policies?.find((p) => p.name === name);
  };

  const ensureLockdownPolicy = async (name: string) => {
    const existing = await getLockdownPolicy(name);
    if (existing) return existing;
    const result = (await task({
      type: "policy_create",
      name,
      description: "Global incident lockdown policy",
      rules: {
        rules: [
          {
            type: "deny",
            action: "tool.invoked",
            resourceType: "tool",
            reason: "Incident lockdown active",
            sanction: { type: "quarantine" },
          },
        ],
      },
    })) as { policy?: { id: string; name: string } };
    return result?.policy;
  };

  const enableLockdown = async () => {
    setWorking(true);
    setStatusMessage(null);
    try {
      const policy = await ensureLockdownPolicy(policyName.trim() || "Global Lockdown");
      if (policy?.id) {
        await task({ type: "policy_set_status", policyId: policy.id, status: "active" });
        setStatusMessage(`Lockdown enabled (${policy.id})`);
      }
    } catch (err) {
      setStatusMessage(`Error: ${err instanceof Error ? err.message : "Failed"}`);
    } finally {
      setWorking(false);
    }
  };

  const disableLockdown = async () => {
    setWorking(true);
    setStatusMessage(null);
    try {
      const policy = await getLockdownPolicy(policyName.trim() || "Global Lockdown");
      if (!policy?.id) {
        setStatusMessage("No policy found");
        return;
      }
      await task({ type: "policy_set_status", policyId: policy.id, status: "inactive" });
      setStatusMessage(`Lockdown disabled (${policy.id})`);
    } catch (err) {
      setStatusMessage(`Error: ${err instanceof Error ? err.message : "Failed"}`);
    } finally {
      setWorking(false);
    }
  };

  return (
    <div>
      <div className="flex gap-2 items-end mb-4">
        <Input
          label="Policy Name"
          value={policyName}
          onChange={(e) => setPolicyName(e.target.value)}
          placeholder="Global Lockdown"
        />
        <Button onClick={enableLockdown} disabled={working}>
          {working ? "Working..." : "Enable Lockdown"}
        </Button>
        <Button variant="ghost" onClick={disableLockdown} disabled={working}>
          Disable Lockdown
        </Button>
      </div>
      {statusMessage && (
        <div
          className={`text-xs font-mono ${statusMessage.startsWith("Error") ? "text-ctp-red" : "text-ctp-green"}`}
        >
          {statusMessage}
        </div>
      )}
    </div>
  );
}

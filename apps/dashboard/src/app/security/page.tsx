"use client";

import { useState, useEffect } from "react";
import { Window } from "@/components/shell/Window";
import { Panel } from "@/components/shared/Panel";
import { GovernancePanel } from "@/components/security/GovernancePanel";
import { AuditLog } from "@/components/security/AuditLog";
import { CapabilityManager } from "@/components/security/CapabilityManager";
import { IncidentPanel } from "@/components/security/IncidentPanel";
import { useGovernance } from "@/hooks/useGovernance";
import { useAudit } from "@/hooks/useAudit";
import { useCapabilities } from "@/hooks/useCapabilities";
import { useWebSocket } from "@/hooks/useWebSocket";

type SecurityTab = "governance" | "audit" | "capabilities" | "incident";

export default function SecurityPage() {
  const [activeTab, setActiveTab] = useState<SecurityTab>("audit");
  const { status, operatorAgentId } = useWebSocket();

  const governance = useGovernance();
  const audit = useAudit();
  const capabilities = useCapabilities();

  useEffect(() => {
    if (status === "connected" && operatorAgentId) {
      governance.refresh();
    }
  }, [status, operatorAgentId]);

  const tabs: { id: SecurityTab; label: string; preview?: boolean }[] = [
    { id: "audit", label: "Audit Log" },
    { id: "governance", label: "Governance", preview: true },
    { id: "capabilities", label: "Capabilities", preview: true },
    { id: "incident", label: "Incident", preview: true },
  ];

  return (
    <Window
      title="Security Center"
      icon={
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
      }
      className="h-full"
    >
      {!operatorAgentId && (
        <div className="mb-4 px-3 py-2 bg-ctp-yellow/10 border border-ctp-yellow/20 rounded-panel text-xs text-ctp-yellow font-mono">
          Set an operator agent in Preferences to use security features.
        </div>
      )}

      {/* Tab Bar */}
      <div className="flex gap-1 mb-4 p-1 bg-ctp-crust rounded-panel w-fit">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-3 py-1.5 text-xs font-mono rounded-input transition-colors ${
              activeTab === tab.id
                ? "bg-ctp-blue/15 text-ctp-blue font-medium"
                : "text-ctp-overlay0 hover:text-ctp-subtext1"
            }`}
          >
            {tab.label}
            {tab.preview && (
              <span className="ml-1.5 text-2xs px-1 py-0.5 rounded bg-ctp-surface1 text-ctp-overlay0">
                Preview
              </span>
            )}
          </button>
        ))}
      </div>

      <Panel>
        {activeTab === "governance" && (
          <GovernancePanel
            policies={governance.policies}
            cases={governance.cases}
            sanctions={governance.sanctions}
            appeals={governance.appeals}
            onOpenCase={governance.openCase}
            onResolveCase={governance.resolveCase}
            onApplySanction={governance.applySanction}
            onLiftSanction={governance.liftSanction}
            onOpenAppeal={governance.openAppeal}
            onResolveAppeal={governance.resolveAppeal}
          />
        )}

        {activeTab === "audit" && (
          <AuditLog
            entries={audit.entries}
            loading={audit.loading}
            onQuery={audit.query}
          />
        )}

        {activeTab === "capabilities" && (
          <CapabilityManager
            tokens={capabilities.tokens}
            loading={capabilities.loading}
            onList={capabilities.listTokens}
            onGrant={capabilities.grant}
            onRevoke={capabilities.revoke}
            onRevokeAll={capabilities.revokeAll}
          />
        )}

        {activeTab === "incident" && <IncidentPanel />}

        {governance.error && (
          <div className="mt-3 text-xs text-ctp-red font-mono">
            {governance.error}
          </div>
        )}
      </Panel>
    </Window>
  );
}

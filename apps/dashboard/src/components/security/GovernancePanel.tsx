"use client";

import { useState, type FormEvent } from "react";
import type { PolicyInfo, ModerationCase, Sanction, Appeal } from "@/lib/types";
import { Tag } from "@/components/shared/Tag";
import { Input } from "@/components/shared/Input";
import { Button } from "@/components/shared/Button";
import { EmptyState } from "@/components/shared/EmptyState";

interface GovernancePanelProps {
  policies: PolicyInfo[];
  cases: ModerationCase[];
  sanctions: Sanction[];
  appeals: Appeal[];
  onOpenCase: (subjectAgentId: string, policyId?: string, reason?: string) => Promise<void>;
  onResolveCase: (caseId: string, status?: string, resolution?: string) => Promise<void>;
  onApplySanction: (subjectAgentId: string, sanctionType: string) => Promise<void>;
  onLiftSanction: (sanctionId: string) => Promise<void>;
  onOpenAppeal: (caseId: string, reason?: string) => Promise<void>;
  onResolveAppeal: (appealId: string, status?: string, resolution?: string) => Promise<void>;
}

function formatEvidence(value: unknown): string {
  if (!value || typeof value !== "object") return "No evidence";
  const keys = Object.keys(value);
  if (!keys.length) return "No evidence";
  return `Evidence: ${keys.slice(0, 3).join(", ")}${keys.length > 3 ? "..." : ""}`;
}

export function GovernancePanel({
  policies,
  cases,
  sanctions,
  appeals,
  onOpenCase,
  onResolveCase,
  onApplySanction,
  onLiftSanction,
  onOpenAppeal,
  onResolveAppeal,
}: GovernancePanelProps) {
  const [caseSubject, setCaseSubject] = useState("");
  const [casePolicy, setCasePolicy] = useState("");
  const [caseReason, setCaseReason] = useState("");
  const [sanctionSubject, setSanctionSubject] = useState("");
  const [sanctionType, setSanctionType] = useState("warning");
  const [resolveCaseId, setResolveCaseId] = useState("");
  const [resolveCaseStatus, setResolveCaseStatus] = useState("");
  const [resolveCaseNotes, setResolveCaseNotes] = useState("");
  const [liftSanctionId, setLiftSanctionId] = useState("");
  const [appealCaseId, setAppealCaseId] = useState("");
  const [appealReason, setAppealReason] = useState("");
  const [resolveAppealId, setResolveAppealId] = useState("");
  const [resolveAppealStatus, setResolveAppealStatus] = useState("");
  const [resolveAppealNotes, setResolveAppealNotes] = useState("");

  const handleOpenCase = async (e: FormEvent) => {
    e.preventDefault();
    if (!caseSubject.trim()) return;
    await onOpenCase(caseSubject.trim(), casePolicy.trim() || undefined, caseReason.trim() || undefined);
    setCaseSubject("");
    setCasePolicy("");
    setCaseReason("");
  };

  const handleApplySanction = async (e: FormEvent) => {
    e.preventDefault();
    if (!sanctionSubject.trim()) return;
    await onApplySanction(sanctionSubject.trim(), sanctionType);
    setSanctionSubject("");
  };

  const handleResolveCase = async (e: FormEvent) => {
    e.preventDefault();
    if (!resolveCaseId.trim()) return;
    await onResolveCase(resolveCaseId.trim(), resolveCaseStatus.trim() || undefined, resolveCaseNotes.trim() || undefined);
    setResolveCaseId("");
    setResolveCaseStatus("");
    setResolveCaseNotes("");
  };

  const handleLiftSanction = async (e: FormEvent) => {
    e.preventDefault();
    if (!liftSanctionId.trim()) return;
    await onLiftSanction(liftSanctionId.trim());
    setLiftSanctionId("");
  };

  const handleOpenAppeal = async (e: FormEvent) => {
    e.preventDefault();
    if (!appealCaseId.trim()) return;
    await onOpenAppeal(appealCaseId.trim(), appealReason.trim() || undefined);
    setAppealCaseId("");
    setAppealReason("");
  };

  const handleResolveAppeal = async (e: FormEvent) => {
    e.preventDefault();
    if (!resolveAppealId.trim()) return;
    await onResolveAppeal(resolveAppealId.trim(), resolveAppealStatus.trim() || undefined, resolveAppealNotes.trim() || undefined);
    setResolveAppealId("");
    setResolveAppealStatus("");
    setResolveAppealNotes("");
  };

  return (
    <div className="space-y-6">
      {/* Policies */}
      <div>
        <h3 className="text-xs font-mono font-semibold text-ctp-subtext0 uppercase tracking-wider mb-3">Policies</h3>
        {policies.length === 0 ? (
          <EmptyState message="No policies" />
        ) : (
          <div className="space-y-2">
            {policies.map((p) => (
              <div key={p.id} className="os-panel px-3 py-2 flex items-center justify-between">
                <div>
                  <span className="text-sm font-medium text-ctp-text">{p.name}</span>
                  <Tag variant={p.status === "active" ? "success" : "default"} className="ml-2">{p.status || "active"}</Tag>
                </div>
                <span className="text-2xs text-ctp-overlay0">{p.id}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Cases */}
      <div>
        <h3 className="text-xs font-mono font-semibold text-ctp-subtext0 uppercase tracking-wider mb-3">Moderation Cases</h3>
        {cases.length === 0 ? (
          <EmptyState message="No cases" />
        ) : (
          <div className="space-y-2">
            {cases.map((c) => (
              <div key={c.id} className="os-panel px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-ctp-text">{c.id}</span>
                  <Tag variant={c.status === "open" ? "warning" : "default"}>{c.status}</Tag>
                </div>
                <div className="text-2xs text-ctp-overlay0 mt-1">
                  {c.reason || "No reason"} | {formatEvidence(c.evidence)}
                </div>
              </div>
            ))}
          </div>
        )}
        <form onSubmit={handleOpenCase} className="mt-3 flex gap-2 items-end">
          <Input label="Subject Agent" value={caseSubject} onChange={(e) => setCaseSubject(e.target.value)} placeholder="agent-id" />
          <Input label="Policy ID" value={casePolicy} onChange={(e) => setCasePolicy(e.target.value)} placeholder="optional" />
          <Input label="Reason" value={caseReason} onChange={(e) => setCaseReason(e.target.value)} placeholder="optional" />
          <Button type="submit" disabled={!caseSubject.trim()}>Open Case</Button>
        </form>
        <form onSubmit={handleResolveCase} className="mt-2 flex gap-2 items-end">
          <Input label="Case ID" value={resolveCaseId} onChange={(e) => setResolveCaseId(e.target.value)} placeholder="case-id" />
          <Input label="Status" value={resolveCaseStatus} onChange={(e) => setResolveCaseStatus(e.target.value)} placeholder="resolved" />
          <Input label="Notes" value={resolveCaseNotes} onChange={(e) => setResolveCaseNotes(e.target.value)} placeholder="optional" />
          <Button type="submit" variant="ghost" disabled={!resolveCaseId.trim()}>Resolve</Button>
        </form>
      </div>

      {/* Sanctions */}
      <div>
        <h3 className="text-xs font-mono font-semibold text-ctp-subtext0 uppercase tracking-wider mb-3">Sanctions</h3>
        {sanctions.length === 0 ? (
          <EmptyState message="No sanctions" />
        ) : (
          <div className="space-y-2">
            {sanctions.map((s) => (
              <div key={s.id} className="os-panel px-3 py-2 flex items-center justify-between">
                <div>
                  <span className="text-sm text-ctp-text">{s.type}</span>
                  <span className="text-2xs text-ctp-overlay0 ml-2">{s.subject_agent_id || "—"}</span>
                </div>
                <span className="text-2xs text-ctp-overlay0">{s.id}</span>
              </div>
            ))}
          </div>
        )}
        <form onSubmit={handleApplySanction} className="mt-3 flex gap-2 items-end">
          <Input label="Subject Agent" value={sanctionSubject} onChange={(e) => setSanctionSubject(e.target.value)} placeholder="agent-id" />
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-ctp-subtext0 font-medium">Type</label>
            <select value={sanctionType} onChange={(e) => setSanctionType(e.target.value)} className="bg-ctp-surface0 border border-ctp-surface1 rounded-input px-3 py-2 text-sm text-ctp-text">
              <option value="warning" className="bg-ctp-mantle">Warning</option>
              <option value="quarantine" className="bg-ctp-mantle">Quarantine</option>
              <option value="suspension" className="bg-ctp-mantle">Suspension</option>
              <option value="ban" className="bg-ctp-mantle">Ban</option>
            </select>
          </div>
          <Button type="submit" disabled={!sanctionSubject.trim()}>Apply</Button>
        </form>
        <form onSubmit={handleLiftSanction} className="mt-2 flex gap-2 items-end">
          <Input label="Sanction ID" value={liftSanctionId} onChange={(e) => setLiftSanctionId(e.target.value)} placeholder="sanction-id" />
          <Button type="submit" variant="ghost" disabled={!liftSanctionId.trim()}>Lift</Button>
        </form>
      </div>

      {/* Appeals */}
      <div>
        <h3 className="text-xs font-mono font-semibold text-ctp-subtext0 uppercase tracking-wider mb-3">Appeals</h3>
        {appeals.length === 0 ? (
          <EmptyState message="No appeals" />
        ) : (
          <div className="space-y-2">
            {appeals.map((a) => (
              <div key={a.id} className="os-panel px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-ctp-text">{a.id}</span>
                  <Tag variant={a.status === "open" ? "warning" : "default"}>{a.status}</Tag>
                </div>
                <div className="text-2xs text-ctp-overlay0 mt-1">
                  {a.resolution || "No resolution"} | {formatEvidence(a.evidence)}
                </div>
              </div>
            ))}
          </div>
        )}
        <form onSubmit={handleOpenAppeal} className="mt-3 flex gap-2 items-end">
          <Input label="Case ID" value={appealCaseId} onChange={(e) => setAppealCaseId(e.target.value)} placeholder="case-id" />
          <Input label="Reason" value={appealReason} onChange={(e) => setAppealReason(e.target.value)} placeholder="optional" />
          <Button type="submit" disabled={!appealCaseId.trim()}>Open Appeal</Button>
        </form>
        <form onSubmit={handleResolveAppeal} className="mt-2 flex gap-2 items-end">
          <Input label="Appeal ID" value={resolveAppealId} onChange={(e) => setResolveAppealId(e.target.value)} placeholder="appeal-id" />
          <Input label="Status" value={resolveAppealStatus} onChange={(e) => setResolveAppealStatus(e.target.value)} placeholder="resolved" />
          <Input label="Notes" value={resolveAppealNotes} onChange={(e) => setResolveAppealNotes(e.target.value)} placeholder="optional" />
          <Button type="submit" variant="ghost" disabled={!resolveAppealId.trim()}>Resolve</Button>
        </form>
      </div>
    </div>
  );
}

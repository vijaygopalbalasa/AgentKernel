"use client";

import { useState, type FormEvent } from "react";
import type { CapabilityToken } from "@/lib/types";
import { Input } from "@/components/shared/Input";
import { Button } from "@/components/shared/Button";
import { EmptyState } from "@/components/shared/EmptyState";

interface CapabilityManagerProps {
  tokens: CapabilityToken[];
  loading?: boolean;
  onList: (agentId?: string) => void;
  onGrant: (agentId: string, permissions: string[], purpose?: string, durationMs?: number) => Promise<void>;
  onRevoke: (tokenId: string) => Promise<void>;
  onRevokeAll: (agentId: string) => Promise<void>;
}

export function CapabilityManager({
  tokens,
  loading,
  onList,
  onGrant,
  onRevoke,
  onRevokeAll,
}: CapabilityManagerProps) {
  const [agentId, setAgentId] = useState("");
  const [permissions, setPermissions] = useState("");
  const [purpose, setPurpose] = useState("");
  const [duration, setDuration] = useState("");
  const [revokeTokenId, setRevokeTokenId] = useState("");

  const handleList = () => onList(agentId.trim() || undefined);

  const handleGrant = async (e: FormEvent) => {
    e.preventDefault();
    if (!agentId.trim() || !permissions.trim()) return;
    const perms = permissions.split(/[\n,]/).map((p) => p.trim()).filter(Boolean);
    const dur = Number(duration);
    await onGrant(agentId.trim(), perms, purpose.trim() || undefined, dur > 0 ? dur : undefined);
    setPermissions("");
    setPurpose("");
    setDuration("");
  };

  const handleRevoke = async (e: FormEvent) => {
    e.preventDefault();
    if (!revokeTokenId.trim()) return;
    await onRevoke(revokeTokenId.trim());
    setRevokeTokenId("");
  };

  const handleRevokeAll = async () => {
    if (!agentId.trim()) return;
    await onRevokeAll(agentId.trim());
  };

  const formatPerms = (token: CapabilityToken) => {
    if (!Array.isArray(token.permissions)) return "—";
    return token.permissions
      .map((p) => `${p.category}.${p.actions?.join("|") || "*"}${p.resource ? `:${p.resource}` : ""}`)
      .join(", ");
  };

  return (
    <div>
      <div className="flex gap-2 items-end mb-4">
        <Input label="Agent ID" value={agentId} onChange={(e) => setAgentId(e.target.value)} placeholder="agent-id" />
        <Button onClick={handleList} disabled={loading}>
          {loading ? "Loading..." : "List Tokens"}
        </Button>
        <Button variant="danger" onClick={handleRevokeAll} disabled={!agentId.trim()}>
          Revoke All
        </Button>
      </div>

      {tokens.length === 0 ? (
        <EmptyState message="No capability tokens" />
      ) : (
        <div className="space-y-2 mb-6 max-h-64 overflow-y-auto">
          {tokens.map((token) => (
            <div key={token.id} className="os-panel px-3 py-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-ctp-text">{token.id}</span>
                <Button variant="ghost" onClick={() => onRevoke(token.id)} className="text-xs">
                  Revoke
                </Button>
              </div>
              <div className="text-2xs text-ctp-overlay0 mt-0.5">
                Agent: {token.agentId} | Expires: {token.expiresAt ? new Date(token.expiresAt).toLocaleString() : "—"}
              </div>
              <div className="text-2xs text-ctp-overlay0 mt-0.5">{formatPerms(token)}</div>
            </div>
          ))}
        </div>
      )}

      <div className="border-t border-ctp-surface0 pt-4 mt-4">
        <h4 className="text-xs font-mono text-ctp-subtext0 uppercase mb-3">Grant Token</h4>
        <form onSubmit={handleGrant} className="space-y-2">
          <Input label="Permissions (comma-separated)" value={permissions} onChange={(e) => setPermissions(e.target.value)} placeholder="memory.read, llm.execute" />
          <div className="flex gap-2 items-end">
            <Input label="Purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="optional" />
            <div className="w-40">
              <Input label="Duration (ms)" type="number" value={duration} onChange={(e) => setDuration(e.target.value)} placeholder="optional" />
            </div>
            <Button type="submit" disabled={!agentId.trim() || !permissions.trim()}>Grant</Button>
          </div>
        </form>
      </div>

      <div className="border-t border-ctp-surface0 pt-4 mt-4">
        <h4 className="text-xs font-mono text-ctp-subtext0 uppercase mb-3">Revoke by ID</h4>
        <form onSubmit={handleRevoke} className="flex gap-2 items-end">
          <Input label="Token ID" value={revokeTokenId} onChange={(e) => setRevokeTokenId(e.target.value)} placeholder="token-id" />
          <Button type="submit" variant="danger" disabled={!revokeTokenId.trim()}>Revoke</Button>
        </form>
      </div>
    </div>
  );
}

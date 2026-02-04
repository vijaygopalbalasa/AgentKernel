"use client";

import { useState, useEffect } from "react";
import { Window } from "@/components/shell/Window";
import { Panel } from "@/components/shared/Panel";
import { Input } from "@/components/shared/Input";
import { Button } from "@/components/shared/Button";
import { Tag } from "@/components/shared/Tag";
import { useWebSocket } from "@/hooks/useWebSocket";
import { useAgents } from "@/hooks/useAgents";
import { getWsUrl, getHealthUrl } from "@/lib/constants";

export default function SettingsPage() {
  const { status, authenticate, operatorAgentId, setOperatorAgentId } =
    useWebSocket();
  const { agents } = useAgents();

  const [tokenInput, setTokenInput] = useState("");
  const [operatorInput, setOperatorInput] = useState("");

  useEffect(() => {
    const saved =
      typeof window !== "undefined"
        ? localStorage.getItem("gatewayAuthToken") || ""
        : "";
    setTokenInput(saved);
  }, []);

  useEffect(() => {
    setOperatorInput(operatorAgentId || "");
  }, [operatorAgentId]);

  const handleSaveToken = () => {
    authenticate(tokenInput.trim());
  };

  const handleSetOperator = () => {
    setOperatorAgentId(operatorInput.trim() || null);
  };

  return (
    <Window
      title="System Preferences"
      icon={
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      }
      className="h-full"
    >
      <div className="space-y-4 max-w-2xl">
        {/* Connection */}
        <Panel>
          <h2 className="text-xs font-mono font-semibold text-ctp-subtext0 uppercase tracking-wider mb-3">
            Connection
          </h2>
          <div className="flex items-center gap-3 mb-3">
            <span className="text-xs text-ctp-overlay0 font-mono">Status:</span>
            <Tag
              variant={
                status === "connected"
                  ? "success"
                  : status === "auth_failed"
                    ? "danger"
                    : "warning"
              }
            >
              {status}
            </Tag>
          </div>
          <div className="flex gap-3 items-end">
            <div className="flex-1">
              <Input
                label="Auth Token"
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="Enter gateway auth token"
              />
            </div>
            <Button onClick={handleSaveToken}>Save & Reconnect</Button>
          </div>
        </Panel>

        {/* Operator Agent */}
        <Panel>
          <h2 className="text-xs font-mono font-semibold text-ctp-subtext0 uppercase tracking-wider mb-3">
            Operator Agent
          </h2>
          <p className="text-xs text-ctp-overlay0 mb-3 font-mono">
            The operator agent is used for memory search, governance tasks, and
            other operations that require an agent context.
          </p>
          <div className="flex gap-3 items-end">
            <div className="flex-1">
              <label className="text-xs text-ctp-subtext0 font-mono block mb-1.5">
                Select Agent
              </label>
              <select
                value={operatorInput}
                onChange={(e) => setOperatorInput(e.target.value)}
                className="w-full bg-ctp-surface0 border border-ctp-surface1 rounded-input px-3 py-2 text-sm text-ctp-text focus:outline-none focus:border-ctp-blue/50 transition-colors"
              >
                <option value="" className="bg-ctp-mantle">
                  Select an agent...
                </option>
                {agents.map((agent) => (
                  <option
                    key={agent.id}
                    value={agent.id}
                    className="bg-ctp-mantle"
                  >
                    {agent.name || agent.id} ({agent.externalId || agent.id})
                  </option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <Input
                label="Or enter manually"
                value={operatorInput}
                onChange={(e) => setOperatorInput(e.target.value)}
                placeholder="agent-id"
              />
            </div>
            <Button onClick={handleSetOperator}>Set Operator</Button>
          </div>
          {operatorAgentId && (
            <div className="mt-2 text-xs text-ctp-green font-mono">
              Active: {operatorAgentId}
            </div>
          )}
        </Panel>

        {/* About */}
        <Panel>
          <h2 className="text-xs font-mono font-semibold text-ctp-subtext0 uppercase tracking-wider mb-3">
            About
          </h2>
          <div className="space-y-2 text-xs font-mono text-ctp-overlay1">
            <div className="flex justify-between">
              <span>AgentKernel Dashboard</span>
              <span className="text-ctp-overlay0">v0.2.0</span>
            </div>
            <div className="flex justify-between">
              <span>Gateway WebSocket</span>
              <span className="text-ctp-overlay0">{getWsUrl()}</span>
            </div>
            <div className="flex justify-between">
              <span>Gateway HTTP</span>
              <a
                href={getHealthUrl()}
                target="_blank"
                rel="noopener noreferrer"
                className="text-ctp-lavender hover:text-ctp-blue transition-colors underline decoration-ctp-surface1 hover:decoration-ctp-blue"
              >
                {getHealthUrl().replace("/health", "")}
              </a>
            </div>
          </div>
        </Panel>
      </div>
    </Window>
  );
}

"use client";

import { useState, useEffect, useCallback } from "react";
import { useWebSocket } from "@/hooks/useWebSocket";
import { useAgents } from "@/hooks/useAgents";
import { getHealthUrl } from "@/lib/constants";

type Step = "connection" | "auth" | "operator" | "done";

interface SetupAssistantProps {
  onComplete: () => void;
}

export function SetupAssistant({ onComplete }: SetupAssistantProps) {
  const { status, authenticate, setOperatorAgentId } = useWebSocket();
  const { agents } = useAgents();
  const [step, setStep] = useState<Step>("connection");
  const [healthOk, setHealthOk] = useState<boolean | null>(null);
  const [token, setToken] = useState("");
  const [selectedAgent, setSelectedAgent] = useState("");
  const [checking, setChecking] = useState(false);

  const checkHealth = useCallback(async () => {
    setChecking(true);
    try {
      const res = await fetch(getHealthUrl(), { signal: AbortSignal.timeout(5000) });
      setHealthOk(res.ok);
      if (res.ok) setStep("auth");
    } catch {
      setHealthOk(false);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    checkHealth();
  }, [checkHealth]);

  useEffect(() => {
    if (step === "auth" && status === "connected") {
      setStep("operator");
    }
  }, [step, status]);

  const handleAuth = () => {
    if (token.trim()) {
      authenticate(token.trim());
    } else {
      setStep("operator");
    }
  };

  const handleSelectAgent = () => {
    if (selectedAgent) {
      setOperatorAgentId(selectedAgent);
    }
    setStep("done");
  };

  useEffect(() => {
    if (step === "done") {
      const timer = setTimeout(onComplete, 600);
      return () => clearTimeout(timer);
    }
  }, [step, onComplete]);

  const steps: Step[] = ["connection", "auth", "operator", "done"];
  const stepIndex = steps.indexOf(step);

  return (
    <div className="h-screen flex items-center justify-center bg-ctp-crust">
      <div className="w-full max-w-lg">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-3 mb-2">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" className="text-ctp-blue">
              <rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" strokeWidth="1.5" />
              <circle cx="8.5" cy="9" r="1.5" fill="currentColor" />
              <circle cx="15.5" cy="9" r="1.5" fill="currentColor" />
              <path d="M8 15c1.5 1.5 6.5 1.5 8 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <span className="text-xl font-mono font-bold text-ctp-text">AgentRun</span>
          </div>
          <p className="text-sm text-ctp-overlay0 font-mono">Setup Assistant</p>
        </div>

        {/* Progress */}
        <div className="flex items-center gap-1 mb-8 px-4">
          {steps.map((s, i) => (
            <div key={s} className="flex-1 flex items-center">
              <div
                className={`h-1 w-full rounded-full transition-colors duration-300 ${
                  i <= stepIndex ? "bg-ctp-blue" : "bg-ctp-surface0"
                }`}
              />
            </div>
          ))}
        </div>

        {/* Card */}
        <div className="bg-ctp-mantle border border-ctp-surface0 rounded-window mx-4">
          {/* Title bar */}
          <div className="flex items-center gap-2 px-4 py-3 border-b border-ctp-surface0">
            <div className="flex gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-ctp-red/60" />
              <span className="w-2.5 h-2.5 rounded-full bg-ctp-yellow/60" />
              <span className="w-2.5 h-2.5 rounded-full bg-ctp-green/60" />
            </div>
            <span className="text-xs font-mono text-ctp-overlay0 ml-2">
              setup-assistant
            </span>
          </div>

          <div className="p-6">
            {/* Step 1: Connection */}
            {step === "connection" && (
              <div>
                <h2 className="text-base font-mono font-semibold text-ctp-text mb-1">
                  Checking Connection
                </h2>
                <p className="text-sm text-ctp-subtext0 mb-6">
                  Looking for the AgentRun gateway on this machine.
                </p>

                <div className="os-panel px-4 py-3 mb-4">
                  <div className="flex items-center gap-3">
                    {checking ? (
                      <div className="w-3 h-3 rounded-full bg-ctp-yellow animate-pulse" />
                    ) : healthOk ? (
                      <div className="w-3 h-3 rounded-full bg-ctp-green" />
                    ) : (
                      <div className="w-3 h-3 rounded-full bg-ctp-red" />
                    )}
                    <div>
                      <div className="text-sm font-mono text-ctp-text">
                        {checking
                          ? "Checking..."
                          : healthOk
                            ? "Gateway detected"
                            : "Gateway not found"}
                      </div>
                      <div className="text-2xs text-ctp-overlay0 font-mono">
                        {getHealthUrl()}
                      </div>
                    </div>
                  </div>
                </div>

                {healthOk === false && (
                  <div className="text-xs text-ctp-subtext0 mb-4 font-mono">
                    Make sure the gateway is running:<br />
                    <code className="text-ctp-peach">pnpm --filter gateway dev</code>
                  </div>
                )}

                <div className="flex gap-2 justify-end">
                  {healthOk === false && (
                    <button
                      onClick={checkHealth}
                      disabled={checking}
                      className="px-4 py-2 text-sm font-mono bg-ctp-surface0 text-ctp-text rounded-input hover:bg-ctp-surface1 transition-colors disabled:opacity-50"
                    >
                      Retry
                    </button>
                  )}
                  {healthOk && (
                    <button
                      onClick={() => setStep("auth")}
                      className="px-4 py-2 text-sm font-mono bg-ctp-blue text-ctp-crust rounded-input hover:opacity-90 transition-opacity"
                    >
                      Continue
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Step 2: Auth Token */}
            {step === "auth" && (
              <div>
                <h2 className="text-base font-mono font-semibold text-ctp-text mb-1">
                  Authentication
                </h2>
                <p className="text-sm text-ctp-subtext0 mb-6">
                  Enter your gateway auth token, or skip if auth is disabled.
                </p>

                <div className="mb-4">
                  <label className="block text-xs font-mono text-ctp-subtext0 mb-1.5">
                    Auth Token
                  </label>
                  <input
                    type="password"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="paste token here..."
                    className="w-full bg-ctp-surface0 border border-ctp-surface1 rounded-input px-3 py-2 text-sm font-mono text-ctp-text placeholder:text-ctp-overlay0 focus:outline-none focus:border-ctp-blue transition-colors"
                    onKeyDown={(e) => e.key === "Enter" && handleAuth()}
                  />
                </div>

                {status === "auth_failed" && (
                  <div className="text-xs font-mono text-ctp-red mb-4">
                    Authentication failed. Check your token.
                  </div>
                )}

                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => setStep("operator")}
                    className="px-4 py-2 text-sm font-mono text-ctp-subtext0 hover:text-ctp-text transition-colors"
                  >
                    Skip
                  </button>
                  <button
                    onClick={handleAuth}
                    className="px-4 py-2 text-sm font-mono bg-ctp-blue text-ctp-crust rounded-input hover:opacity-90 transition-opacity"
                  >
                    {token.trim() ? "Authenticate" : "Continue"}
                  </button>
                </div>
              </div>
            )}

            {/* Step 3: Operator Agent */}
            {step === "operator" && (
              <div>
                <h2 className="text-base font-mono font-semibold text-ctp-text mb-1">
                  Operator Agent
                </h2>
                <p className="text-sm text-ctp-subtext0 mb-6">
                  Select a running agent to act as the system operator, or skip to choose later.
                </p>

                {agents.length > 0 ? (
                  <div className="space-y-1.5 mb-4 max-h-48 overflow-y-auto">
                    {agents.map((agent) => (
                      <button
                        key={agent.id}
                        onClick={() => setSelectedAgent(agent.id)}
                        className={`w-full text-left os-panel px-3 py-2.5 transition-colors ${
                          selectedAgent === agent.id
                            ? "border-ctp-blue bg-ctp-blue/10"
                            : "hover:border-ctp-surface1"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-mono text-ctp-text">{agent.id}</span>
                          <span className={`text-2xs font-mono ${
                            agent.state === "running" ? "text-ctp-green" : "text-ctp-overlay0"
                          }`}>
                            {agent.state}
                          </span>
                        </div>
                        {agent.model && (
                          <div className="text-2xs text-ctp-overlay0 font-mono mt-0.5">
                            {agent.model}
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="os-panel px-4 py-6 text-center mb-4">
                    <div className="text-sm text-ctp-overlay0 font-mono mb-2">
                      No agents running
                    </div>
                    <div className="text-xs text-ctp-overlay0 font-mono">
                      Start agents from the Task Manager after setup.
                    </div>
                  </div>
                )}

                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => { setStep("done"); }}
                    className="px-4 py-2 text-sm font-mono text-ctp-subtext0 hover:text-ctp-text transition-colors"
                  >
                    Skip
                  </button>
                  <button
                    onClick={handleSelectAgent}
                    disabled={!selectedAgent && agents.length > 0}
                    className="px-4 py-2 text-sm font-mono bg-ctp-blue text-ctp-crust rounded-input hover:opacity-90 transition-opacity disabled:opacity-50"
                  >
                    {selectedAgent ? "Set Operator" : "Continue"}
                  </button>
                </div>
              </div>
            )}

            {/* Step 4: Done */}
            {step === "done" && (
              <div className="text-center py-4">
                <div className="w-10 h-10 rounded-full bg-ctp-green/20 flex items-center justify-center mx-auto mb-3">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" className="text-ctp-green">
                    <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
                <h2 className="text-base font-mono font-semibold text-ctp-text mb-1">
                  Ready
                </h2>
                <p className="text-sm text-ctp-subtext0">
                  Loading desktop...
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Step labels */}
        <div className="flex justify-between px-4 mt-3">
          {(["Connection", "Auth", "Operator", "Done"] as const).map((label, i) => (
            <span
              key={label}
              className={`text-2xs font-mono ${
                i <= stepIndex ? "text-ctp-blue" : "text-ctp-overlay0"
              }`}
            >
              {label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

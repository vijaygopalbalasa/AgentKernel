"use client";

import { useState, useEffect, useCallback } from "react";
import type { HealthData, MetricsData } from "@/lib/types";
import { getHealthUrl, getMetricsUrl } from "@/lib/constants";

const POLL_INTERVAL = 15_000;

function parseMetric(text: string, name: string): number {
  const match = text.match(new RegExp(`${name} ([0-9.]+)`));
  return match ? Number(match[1]) : 0;
}

export function useHealth() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [metrics, setMetrics] = useState<MetricsData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchHealth = useCallback(async () => {
    try {
      const response = await fetch(getHealthUrl());
      if (!response.ok) {
        setHealth({ status: "offline" });
        return;
      }
      const data = await response.json();
      setHealth(data);
    } catch {
      setHealth({ status: "offline" });
    }
  }, []);

  const fetchMetrics = useCallback(async () => {
    try {
      const response = await fetch(getMetricsUrl());
      if (!response.ok) {
        setMetrics(null);
        return;
      }
      const text = await response.text();
      setMetrics({
        inputTokens: parseMetric(text, "agent_os_tokens_input_total"),
        outputTokens: parseMetric(text, "agent_os_tokens_output_total"),
        costUsd: parseMetric(text, "agent_os_cost_usd_total"),
      });
    } catch {
      setMetrics(null);
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    await Promise.all([fetchHealth(), fetchMetrics()]);
    setLoading(false);
  }, [fetchHealth, fetchMetrics]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [refresh]);

  return { health, metrics, loading, refresh };
}

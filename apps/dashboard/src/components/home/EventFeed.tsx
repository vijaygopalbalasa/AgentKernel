"use client";

import { useState } from "react";
import type { GatewayEvent } from "@/lib/types";
import { EmptyState } from "@/components/shared/EmptyState";

interface EventFeedProps {
  events: GatewayEvent[];
}

function eventColor(type: string): string {
  if (type === "error") return "border-ctp-red";
  if (type === "auth") return "border-ctp-yellow";
  if (type === "connection") return "border-ctp-green";
  return "border-ctp-blue/30";
}

export function EventFeed({ events }: EventFeedProps) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  if (!events.length) {
    return <EmptyState message="Waiting for events..." />;
  }

  return (
    <div className="space-y-1 max-h-80 overflow-y-auto pr-1 font-mono">
      {events.map((event, i) => {
        const isExpanded = expandedIndex === i;
        const hasLongSummary = (event.summary?.length ?? 0) > 80;

        return (
          <button
            key={`${event.timestamp}-${i}`}
            onClick={() => setExpandedIndex(isExpanded ? null : i)}
            className={`w-full text-left border-l-2 ${eventColor(event.type)} pl-3 py-1 hover:bg-ctp-surface0/30 rounded-r-input transition-colors`}
          >
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-ctp-subtext1">
                {event.type}
              </span>
              <span className="text-2xs text-ctp-overlay0">{event.timestamp}</span>
              {event.channel && (
                <span className="text-2xs text-ctp-overlay0 ml-auto">{event.channel}</span>
              )}
            </div>
            {event.summary && (
              <div className={`text-xs text-ctp-overlay1 mt-0.5 break-all ${
                isExpanded ? "" : "line-clamp-2"
              }`}>
                {event.summary}
              </div>
            )}
            {hasLongSummary && (
              <span className="text-2xs text-ctp-overlay0 hover:text-ctp-blue">
                {isExpanded ? "collapse" : "expand"}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

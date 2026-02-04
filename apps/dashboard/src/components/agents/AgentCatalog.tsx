"use client";

import { AGENT_MANIFESTS, type AgentManifest } from "@/lib/manifests";
import { AgentCard } from "./AgentCard";
import { EmptyState } from "@/components/shared/EmptyState";

interface AgentCatalogProps {
  onDeploy: (manifest: AgentManifest) => void;
  deployingId?: string | null;
}

export function AgentCatalog({ onDeploy, deployingId }: AgentCatalogProps) {
  if (!AGENT_MANIFESTS.length) {
    return <EmptyState message="No agent manifests found in agents/ directory" />;
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {AGENT_MANIFESTS.map((manifest) => (
        <AgentCard
          key={manifest.id}
          manifest={manifest}
          onDeploy={onDeploy}
          deploying={deployingId === manifest.id}
        />
      ))}
    </div>
  );
}

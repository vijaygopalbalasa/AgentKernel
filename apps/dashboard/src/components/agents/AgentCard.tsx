"use client";

import type { AgentManifest } from "@/lib/manifests";
import { Panel } from "@/components/shared/Panel";
import { Tag } from "@/components/shared/Tag";
import { Button } from "@/components/shared/Button";

interface AgentCardProps {
  manifest: AgentManifest;
  onDeploy: (manifest: AgentManifest) => void;
  deploying?: boolean;
}

export function AgentCard({ manifest, onDeploy, deploying }: AgentCardProps) {
  return (
    <Panel className="flex flex-col justify-between hover:border-ctp-blue/30 transition-colors">
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-mono font-semibold text-ctp-text text-sm">
            {manifest.name}
          </h3>
          <span className="text-2xs text-ctp-overlay0 font-mono">v{manifest.version}</span>
        </div>
        {manifest.description && (
          <p className="text-xs text-ctp-overlay1 mb-3">{manifest.description}</p>
        )}
        <div className="flex flex-wrap gap-1 mb-3">
          {manifest.permissions?.slice(0, 4).map((perm) => (
            <Tag key={perm} variant="info">
              {perm}
            </Tag>
          ))}
          {(manifest.permissions?.length || 0) > 4 && (
            <Tag>+{(manifest.permissions?.length || 0) - 4}</Tag>
          )}
        </div>
        {manifest.trustLevel && (
          <div className="text-2xs text-ctp-overlay0 font-mono">
            trust: {manifest.trustLevel}
          </div>
        )}
      </div>
      <div className="mt-3">
        <Button
          onClick={() => onDeploy(manifest)}
          disabled={deploying}
          className="w-full"
        >
          {deploying ? "Deploying..." : "Deploy"}
        </Button>
      </div>
    </Panel>
  );
}

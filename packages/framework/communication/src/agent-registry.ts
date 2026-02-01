// Agent Registry — discovers and tracks agents
// Central registry for both local and remote agents

import type {
  A2AAgentCard,
  AgentRegistryEntry,
  CommunicationEvent,
} from "./types.js";

/**
 * Agent Registry — manages discovery and tracking of agents.
 *
 * Features:
 * - Register local agents (running on this OS)
 * - Discover remote agents via Agent Cards
 * - Track agent availability
 * - Query agents by capabilities
 */
export class AgentRegistry {
  private agents: Map<string, AgentRegistryEntry> = new Map();
  private eventListeners: Array<(event: CommunicationEvent) => void> = [];
  private fetchTimeout: number = 5000;

  /**
   * Register a local agent with its Agent Card.
   */
  registerLocal(agentId: string, card: A2AAgentCard): void {
    const entry: AgentRegistryEntry = {
      card,
      registeredAt: new Date(),
      lastFetchedAt: new Date(),
      isOnline: true,
      localAgentId: agentId,
    };

    this.agents.set(card.url, entry);
    this.emit({
      type: "agent_registered",
      agentId,
      agentUrl: card.url,
      timestamp: new Date(),
    });
  }

  /**
   * Discover a remote agent by fetching its Agent Card.
   */
  async discover(agentUrl: string): Promise<AgentRegistryEntry | null> {
    const wellKnownUrl = this.getWellKnownUrl(agentUrl);

    try {
      const response = await this.fetchWithTimeout(wellKnownUrl, this.fetchTimeout);

      if (!response.ok) {
        return null;
      }

      const card = (await response.json()) as A2AAgentCard;

      // Validate the card has required fields
      if (!card.name || !card.url) {
        return null;
      }

      const entry: AgentRegistryEntry = {
        card,
        registeredAt: new Date(),
        lastFetchedAt: new Date(),
        isOnline: true,
      };

      this.agents.set(agentUrl, entry);
      this.emit({
        type: "agent_discovered",
        agentUrl,
        timestamp: new Date(),
        data: { card },
      });

      return entry;
    } catch {
      return null;
    }
  }

  /**
   * Get an agent by URL.
   */
  get(agentUrl: string): AgentRegistryEntry | null {
    return this.agents.get(agentUrl) ?? null;
  }

  /**
   * Check if an agent is registered.
   */
  has(agentUrl: string): boolean {
    return this.agents.has(agentUrl);
  }

  /**
   * List all registered agents.
   */
  list(): AgentRegistryEntry[] {
    return Array.from(this.agents.values());
  }

  /**
   * List all online agents.
   */
  listOnline(): AgentRegistryEntry[] {
    return this.list().filter((entry) => entry.isOnline);
  }

  /**
   * List local agents (running on this OS).
   */
  listLocal(): AgentRegistryEntry[] {
    return this.list().filter((entry) => entry.localAgentId !== undefined);
  }

  /**
   * List remote agents.
   */
  listRemote(): AgentRegistryEntry[] {
    return this.list().filter((entry) => entry.localAgentId === undefined);
  }

  /**
   * Find agents by skill.
   */
  findBySkill(skillId: string): AgentRegistryEntry[] {
    return this.list().filter((entry) =>
      entry.card.skills?.some((skill) => skill.id === skillId)
    );
  }

  /**
   * Find agents by capability.
   */
  findByCapability(
    capability: keyof NonNullable<A2AAgentCard["capabilities"]>
  ): AgentRegistryEntry[] {
    return this.list().filter(
      (entry) => entry.card.capabilities?.[capability] === true
    );
  }

  /**
   * Find agents that support a specific input mode.
   */
  findByInputMode(mode: string): AgentRegistryEntry[] {
    return this.list().filter((entry) =>
      entry.card.defaultInputModes?.includes(mode as any)
    );
  }

  /**
   * Search agents by name or description.
   */
  search(query: string): AgentRegistryEntry[] {
    const q = query.toLowerCase();
    return this.list().filter(
      (entry) =>
        entry.card.name.toLowerCase().includes(q) ||
        entry.card.description?.toLowerCase().includes(q)
    );
  }

  /**
   * Mark an agent as offline.
   */
  markOffline(agentUrl: string): void {
    const entry = this.agents.get(agentUrl);
    if (entry) {
      entry.isOnline = false;
      this.emit({
        type: "agent_offline",
        agentUrl,
        timestamp: new Date(),
      });
    }
  }

  /**
   * Mark an agent as online.
   */
  markOnline(agentUrl: string): void {
    const entry = this.agents.get(agentUrl);
    if (entry) {
      entry.isOnline = true;
    }
  }

  /**
   * Refresh an agent's card.
   */
  async refresh(agentUrl: string): Promise<boolean> {
    const entry = this.agents.get(agentUrl);
    if (!entry) return false;

    // Local agents don't need refreshing
    if (entry.localAgentId) {
      return true;
    }

    const updated = await this.discover(agentUrl);
    return updated !== null;
  }

  /**
   * Remove an agent from the registry.
   */
  unregister(agentUrl: string): boolean {
    return this.agents.delete(agentUrl);
  }

  /**
   * Subscribe to registry events.
   */
  onEvent(listener: (event: CommunicationEvent) => void): () => void {
    this.eventListeners.push(listener);
    return () => {
      const index = this.eventListeners.indexOf(listener);
      if (index > -1) {
        this.eventListeners.splice(index, 1);
      }
    };
  }

  /**
   * Set the fetch timeout for discovery.
   */
  setFetchTimeout(timeout: number): void {
    this.fetchTimeout = timeout;
  }

  /** Get the well-known URL for an agent */
  private getWellKnownUrl(baseUrl: string): string {
    const url = new URL(baseUrl);
    url.pathname = "/.well-known/agent.json";
    return url.toString();
  }

  /** Fetch with timeout */
  private async fetchWithTimeout(
    url: string,
    timeout: number
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, { signal: controller.signal });
      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** Emit an event */
  private emit(event: CommunicationEvent): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }
}

/** Create a new agent registry */
export function createAgentRegistry(): AgentRegistry {
  return new AgentRegistry();
}

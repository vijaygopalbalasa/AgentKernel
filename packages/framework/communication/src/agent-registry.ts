// Agent Registry — discovers and tracks agents
// Central registry for both local and remote agents

import { type Result, ok, err } from "@agentkernel/shared";
import { type Logger, createLogger } from "@agentkernel/kernel";
import type {
  A2AAgentCard,
  AgentRegistryEntry,
  CommunicationEvent,
} from "./types.js";
import {
  CommunicationError,
  A2AAgentCardSchema,
  RegisterLocalInputSchema,
  DiscoverAgentInputSchema,
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
  private log: Logger;

  constructor() {
    this.log = createLogger({ name: "agent-registry" });
  }

  /**
   * Register a local agent with its Agent Card.
   */
  registerLocal(
    agentId: string,
    card: A2AAgentCard
  ): Result<AgentRegistryEntry, CommunicationError> {
    // Validate input
    const inputResult = RegisterLocalInputSchema.safeParse({ agentId, card });
    if (!inputResult.success) {
      return err(
        new CommunicationError(
          `Invalid registration input: ${inputResult.error.message}`,
          "VALIDATION_ERROR"
        )
      );
    }

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

    this.log.debug("Local agent registered", { agentId, url: card.url });
    return ok(entry);
  }

  /**
   * Discover a remote agent by fetching its Agent Card.
   */
  async discover(
    agentUrl: string
  ): Promise<Result<AgentRegistryEntry, CommunicationError>> {
    // Validate input
    const inputResult = DiscoverAgentInputSchema.safeParse({ agentUrl });
    if (!inputResult.success) {
      return err(
        new CommunicationError(
          `Invalid agent URL: ${inputResult.error.message}`,
          "VALIDATION_ERROR",
          agentUrl
        )
      );
    }

    const wellKnownUrl = this.getWellKnownUrl(agentUrl);

    try {
      this.log.debug("Discovering agent", { url: wellKnownUrl });
      const response = await this.fetchWithTimeout(wellKnownUrl, this.fetchTimeout);

      if (!response.ok) {
        return err(
          new CommunicationError(
            `Failed to fetch agent card: HTTP ${response.status}`,
            "NETWORK_ERROR",
            agentUrl
          )
        );
      }

      const cardData = await response.json();

      // Validate the card
      const cardResult = A2AAgentCardSchema.safeParse(cardData);
      if (!cardResult.success) {
        return err(
          new CommunicationError(
            `Invalid agent card: ${cardResult.error.message}`,
            "VALIDATION_ERROR",
            agentUrl
          )
        );
      }

      const card = cardData as A2AAgentCard;

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

      this.log.info("Agent discovered", { url: agentUrl, name: card.name });
      return ok(entry);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("aborted")) {
        this.log.warn("Agent discovery timed out", { url: agentUrl });
        return err(
          new CommunicationError(
            `Discovery timed out for ${agentUrl}`,
            "TIMEOUT_ERROR",
            agentUrl
          )
        );
      }
      this.log.warn("Agent discovery failed", { url: agentUrl, error: message });
      return err(
        new CommunicationError(
          `Failed to discover agent: ${message}`,
          "NETWORK_ERROR",
          agentUrl
        )
      );
    }
  }

  /**
   * Get an agent by URL.
   */
  get(agentUrl: string): Result<AgentRegistryEntry, CommunicationError> {
    const entry = this.agents.get(agentUrl);
    if (!entry) {
      return err(
        new CommunicationError(
          `Agent not found: ${agentUrl}`,
          "NOT_FOUND",
          agentUrl
        )
      );
    }
    return ok(entry);
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
      entry.card.defaultInputModes?.includes(mode as "text" | "audio" | "video" | "file")
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
  markOffline(agentUrl: string): Result<void, CommunicationError> {
    const entry = this.agents.get(agentUrl);
    if (!entry) {
      return err(
        new CommunicationError(
          `Agent not found: ${agentUrl}`,
          "NOT_FOUND",
          agentUrl
        )
      );
    }
    entry.isOnline = false;
    this.emit({
      type: "agent_offline",
      agentUrl,
      timestamp: new Date(),
    });
    this.log.debug("Agent marked offline", { url: agentUrl });
    return ok(undefined);
  }

  /**
   * Mark an agent as online.
   */
  markOnline(agentUrl: string): Result<void, CommunicationError> {
    const entry = this.agents.get(agentUrl);
    if (!entry) {
      return err(
        new CommunicationError(
          `Agent not found: ${agentUrl}`,
          "NOT_FOUND",
          agentUrl
        )
      );
    }
    entry.isOnline = true;
    this.log.debug("Agent marked online", { url: agentUrl });
    return ok(undefined);
  }

  /**
   * Refresh an agent's card.
   */
  async refresh(agentUrl: string): Promise<Result<boolean, CommunicationError>> {
    const entry = this.agents.get(agentUrl);
    if (!entry) {
      return err(
        new CommunicationError(
          `Agent not found: ${agentUrl}`,
          "NOT_FOUND",
          agentUrl
        )
      );
    }

    // Local agents don't need refreshing
    if (entry.localAgentId) {
      this.log.debug("Skipping refresh for local agent", { url: agentUrl });
      return ok(true);
    }

    const result = await this.discover(agentUrl);
    return ok(result.ok);
  }

  /**
   * Remove an agent from the registry.
   */
  unregister(agentUrl: string): Result<boolean, CommunicationError> {
    const existed = this.agents.delete(agentUrl);
    if (existed) {
      this.log.debug("Agent unregistered", { url: agentUrl });
    }
    return ok(existed);
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
    this.log.debug("Fetch timeout updated", { timeout });
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

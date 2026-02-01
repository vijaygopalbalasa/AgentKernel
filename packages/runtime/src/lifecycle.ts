// Agent Lifecycle Manager — spawns, manages, and terminates agents
// Like Android's ActivityManager + ProcessManager

import { randomUUID } from "crypto";
import { AgentStateMachine, type AgentState, type StateTransition } from "./state-machine.js";
import {
  type AgentContext,
  type AgentId,
  type AgentMetadata,
  type ResourceLimits,
  type ResourceUsage,
  DEFAULT_LIMITS,
  createInitialUsage,
  checkLimits,
  estimateCost,
} from "./agent-context.js";

/** Agent manifest — the "AndroidManifest.xml" equivalent */
export interface AgentManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  tags?: string[];
  /** Required permissions */
  permissions?: string[];
  /** Resource limit overrides */
  limits?: Partial<ResourceLimits>;
  /** Environment variables to inject */
  env?: Record<string, string>;
  /** Entry point module */
  entryPoint?: string;
}

/** Internal agent instance data */
interface AgentInstance {
  context: AgentContext;
  stateMachine: AgentStateMachine;
  usage: ResourceUsage;
  manifest: AgentManifest;
}

/** Event emitted by lifecycle manager */
export interface LifecycleEvent {
  type: "spawn" | "state_change" | "terminate" | "error" | "resource_warning";
  agentId: AgentId;
  timestamp: Date;
  data?: unknown;
}

/** Lifecycle manager options */
export interface LifecycleManagerOptions {
  /** Maximum number of agents allowed */
  maxAgents?: number;
  /** Global resource limits */
  globalLimits?: Partial<ResourceLimits>;
  /** Enable audit logging */
  auditLogging?: boolean;
}

/**
 * Agent Lifecycle Manager — the core runtime component.
 * Handles agent spawning, state management, resource tracking, and termination.
 */
export class AgentLifecycleManager {
  private agents: Map<AgentId, AgentInstance> = new Map();
  private listeners: Array<(event: LifecycleEvent) => void> = [];
  private options: Required<LifecycleManagerOptions>;

  constructor(options: LifecycleManagerOptions = {}) {
    this.options = {
      maxAgents: options.maxAgents ?? 100,
      globalLimits: options.globalLimits ?? {},
      auditLogging: options.auditLogging ?? true,
    };
  }

  /** Get current agent count */
  get agentCount(): number {
    return this.agents.size;
  }

  /** Get all agent IDs */
  get agentIds(): AgentId[] {
    return Array.from(this.agents.keys());
  }

  /**
   * Spawn a new agent from a manifest.
   * Returns the agent ID or throws if spawning fails.
   */
  spawn(manifest: AgentManifest, parentId?: AgentId): AgentId {
    // Check capacity
    if (this.agents.size >= this.options.maxAgents) {
      throw new Error(`Agent limit reached (${this.options.maxAgents})`);
    }

    // Generate unique ID
    const id = `agent-${randomUUID().slice(0, 8)}`;

    // Create state machine
    const stateMachine = new AgentStateMachine();

    // Merge limits
    const limits: ResourceLimits = {
      ...DEFAULT_LIMITS,
      ...this.options.globalLimits,
      ...manifest.limits,
    };

    // Create initial usage
    const usage = createInitialUsage();

    // Build metadata
    const metadata: AgentMetadata = {
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author,
      tags: manifest.tags,
    };

    // Create context
    const context: AgentContext = {
      id,
      metadata,
      state: stateMachine.state,
      limits,
      usage,
      createdAt: new Date(),
      lastStateChange: new Date(),
      parentId,
      env: manifest.env ?? {},
    };

    // Create instance
    const instance: AgentInstance = {
      context,
      stateMachine,
      usage,
      manifest,
    };

    // Register state change listener
    stateMachine.onTransition((transition) => {
      this.handleStateTransition(id, transition);
    });

    // Store instance
    this.agents.set(id, instance);

    // Emit spawn event
    this.emit({
      type: "spawn",
      agentId: id,
      timestamp: new Date(),
      data: { manifest },
    });

    return id;
  }

  /**
   * Initialize an agent (transition from created → initializing → ready).
   */
  async initialize(agentId: AgentId): Promise<boolean> {
    const instance = this.agents.get(agentId);
    if (!instance) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    // Start initialization
    if (!instance.stateMachine.transition("INITIALIZE", "Starting initialization")) {
      return false;
    }

    try {
      // TODO: Load agent module, connect to services, etc.
      // For now, just simulate initialization
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Mark as ready
      return instance.stateMachine.transition("READY", "Initialization complete");
    } catch (error) {
      instance.stateMachine.transition("FAIL", String(error));
      return false;
    }
  }

  /**
   * Start an agent (transition from ready → running).
   */
  start(agentId: AgentId): boolean {
    const instance = this.agents.get(agentId);
    if (!instance) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    return instance.stateMachine.transition("START", "Task started");
  }

  /**
   * Pause an agent (transition to paused).
   */
  pause(agentId: AgentId): boolean {
    const instance = this.agents.get(agentId);
    if (!instance) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    return instance.stateMachine.transition("PAUSE", "Agent paused");
  }

  /**
   * Resume a paused agent.
   */
  resume(agentId: AgentId): boolean {
    const instance = this.agents.get(agentId);
    if (!instance) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    return instance.stateMachine.transition("RESUME", "Agent resumed");
  }

  /**
   * Mark task as complete (running → ready).
   */
  complete(agentId: AgentId): boolean {
    const instance = this.agents.get(agentId);
    if (!instance) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    return instance.stateMachine.transition("COMPLETE", "Task completed");
  }

  /**
   * Report an error (transition to error state).
   */
  fail(agentId: AgentId, reason: string): boolean {
    const instance = this.agents.get(agentId);
    if (!instance) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    this.emit({
      type: "error",
      agentId,
      timestamp: new Date(),
      data: { reason },
    });

    return instance.stateMachine.transition("FAIL", reason);
  }

  /**
   * Attempt recovery from error state.
   */
  recover(agentId: AgentId): boolean {
    const instance = this.agents.get(agentId);
    if (!instance) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    return instance.stateMachine.transition("RECOVER", "Recovery attempted");
  }

  /**
   * Terminate an agent.
   */
  terminate(agentId: AgentId, reason?: string): boolean {
    const instance = this.agents.get(agentId);
    if (!instance) {
      return false;
    }

    const result = instance.stateMachine.transition("TERMINATE", reason ?? "Agent terminated");

    if (result) {
      this.emit({
        type: "terminate",
        agentId,
        timestamp: new Date(),
        data: { reason, finalUsage: instance.usage },
      });

      // Remove from active agents after a short delay (for cleanup)
      setTimeout(() => {
        this.agents.delete(agentId);
      }, 1000);
    }

    return result;
  }

  /**
   * Get agent context by ID.
   */
  getContext(agentId: AgentId): AgentContext | null {
    const instance = this.agents.get(agentId);
    if (!instance) return null;

    // Return updated context with current state
    return {
      ...instance.context,
      state: instance.stateMachine.state,
      usage: instance.usage,
      lastStateChange: new Date(),
    };
  }

  /**
   * Get agent state by ID.
   */
  getState(agentId: AgentId): AgentState | null {
    const instance = this.agents.get(agentId);
    return instance?.stateMachine.state ?? null;
  }

  /**
   * Record token usage for an agent.
   */
  recordUsage(
    agentId: AgentId,
    model: string,
    inputTokens: number,
    outputTokens: number
  ): void {
    const instance = this.agents.get(agentId);
    if (!instance) return;

    const usage = instance.usage;
    const now = new Date();

    // Reset minute window if needed
    const windowAge = now.getTime() - usage.minuteWindowStart.getTime();
    if (windowAge > 60_000) {
      usage.tokensThisMinute = 0;
      usage.minuteWindowStart = now;
    }

    // Update usage
    usage.inputTokens += inputTokens;
    usage.outputTokens += outputTokens;
    usage.requestCount += 1;
    usage.tokensThisMinute += inputTokens + outputTokens;
    usage.estimatedCostUSD += estimateCost(model, inputTokens, outputTokens);

    // Check limits
    const limitCheck = checkLimits(usage, instance.context.limits);
    if (!limitCheck.allowed) {
      this.emit({
        type: "resource_warning",
        agentId,
        timestamp: now,
        data: { violations: limitCheck.violations },
      });
    }
  }

  /**
   * List all agents with their states.
   */
  listAgents(): Array<{ id: AgentId; state: AgentState; name: string }> {
    return Array.from(this.agents.entries()).map(([id, instance]) => ({
      id,
      state: instance.stateMachine.state,
      name: instance.manifest.name,
    }));
  }

  /**
   * Get agents by state.
   */
  getAgentsByState(state: AgentState): AgentId[] {
    return Array.from(this.agents.entries())
      .filter(([, instance]) => instance.stateMachine.state === state)
      .map(([id]) => id);
  }

  /**
   * Register event listener.
   */
  onEvent(listener: (event: LifecycleEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index > -1) {
        this.listeners.splice(index, 1);
      }
    };
  }

  /**
   * Graceful shutdown — terminate all agents.
   */
  async shutdown(): Promise<void> {
    const agents = Array.from(this.agents.keys());
    for (const agentId of agents) {
      this.terminate(agentId, "System shutdown");
    }
  }

  /** Emit an event to all listeners */
  private emit(event: LifecycleEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  /** Handle state transition (update context, emit events) */
  private handleStateTransition(agentId: AgentId, transition: StateTransition): void {
    this.emit({
      type: "state_change",
      agentId,
      timestamp: transition.timestamp,
      data: {
        from: transition.fromState,
        to: transition.toState,
        event: transition.event,
        reason: transition.reason,
      },
    });
  }
}

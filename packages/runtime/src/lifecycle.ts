// Agent Lifecycle Manager — spawns, manages, and terminates agents
// Like Android's ActivityManager + ProcessManager

import { randomUUID } from "crypto";
import { resolve, isAbsolute } from "path";
import { pathToFileURL } from "url";
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
import {
  AgentSandbox,
  SandboxRegistry,
  type Capability,
  type SandboxConfig,
  DEFAULT_CAPABILITIES,
} from "./sandbox.js";
import {
  type PersistenceManager,
  type AgentCheckpoint,
} from "./persistence.js";
import {
  type AuditLogger,
} from "./audit.js";
import {
  HealthMonitor,
  type HealthMetrics,
  type HealthCheckResult,
} from "./health.js";

/** Agent manifest — the "AndroidManifest.xml" equivalent */
export interface AgentManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  tags?: string[];
  /** Required permissions/capabilities */
  permissions?: Capability[];
  /** Resource limit overrides */
  limits?: Partial<ResourceLimits>;
  /** Environment variables to inject */
  env?: Record<string, string>;
  /** Entry point module */
  entryPoint?: string;
  /** Custom data to persist with agent */
  customData?: Record<string, unknown>;
}

export interface AgentInitializerContext {
  agentId: AgentId;
  context: AgentContext;
  manifest: AgentManifest;
  sandbox: AgentSandbox;
}

export type AgentInitializer = (context: AgentInitializerContext) => Promise<void> | void;

/** Internal agent instance data */
interface AgentInstance {
  context: AgentContext;
  stateMachine: AgentStateMachine;
  usage: ResourceUsage;
  manifest: AgentManifest;
  sandbox: AgentSandbox;
  createdAt: Date;
  lastActivityAt: Date;
  errorCount: number;
  successCount: number;
  customData?: Record<string, unknown>;
}

/** Event emitted by lifecycle manager */
export interface LifecycleEvent {
  type: "spawn" | "state_change" | "terminate" | "error" | "resource_warning" | "checkpoint" | "recover";
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
  /** Sandbox configuration */
  sandboxConfig?: Partial<SandboxConfig>;
  /** Persistence manager (optional) */
  persistence?: PersistenceManager;
  /** Audit logger (optional) */
  auditLogger?: AuditLogger;
  /** Health monitor (optional) */
  healthMonitor?: HealthMonitor;
  /** Auto-checkpoint interval in ms (0 = disabled) */
  autoCheckpointIntervalMs?: number;
  /** Shutdown timeout in ms */
  shutdownTimeoutMs?: number;
  /** Optional agent initializer hook */
  agentInitializer?: AgentInitializer;
}

/** Required options with defaults applied */
interface ResolvedOptions {
  maxAgents: number;
  globalLimits: Partial<ResourceLimits>;
  auditLogging: boolean;
  sandboxConfig: Partial<SandboxConfig>;
  persistence: PersistenceManager | null;
  auditLogger: AuditLogger | null;
  healthMonitor: HealthMonitor | null;
  autoCheckpointIntervalMs: number;
  shutdownTimeoutMs: number;
  agentInitializer: AgentInitializer | null;
}

function resolveEntryPoint(entryPoint: string): string {
  if (entryPoint.startsWith("file://")) {
    return entryPoint;
  }

  if (
    entryPoint.startsWith(".") ||
    entryPoint.includes("/") ||
    entryPoint.includes("\\") ||
    isAbsolute(entryPoint)
  ) {
    return pathToFileURL(resolve(entryPoint)).href;
  }

  return entryPoint;
}

function resolveInitializer(module: Record<string, unknown>): AgentInitializer | null {
  const candidate =
    (typeof module.default === "function" ? module.default : null) ??
    (typeof module.initialize === "function" ? module.initialize : null) ??
    (typeof module.init === "function" ? module.init : null) ??
    (typeof module.start === "function" ? module.start : null);

  if (candidate) {
    return candidate as AgentInitializer;
  }

  if (module.default && typeof (module.default as { initialize?: unknown }).initialize === "function") {
    return (context) => (module.default as { initialize: AgentInitializer }).initialize(context);
  }

  return null;
}

async function loadEntryPoint(entryPoint: string, context: AgentInitializerContext): Promise<void> {
  const specifier = resolveEntryPoint(entryPoint);
  const module = (await import(specifier)) as Record<string, unknown>;
  const initializer = resolveInitializer(module);

  if (!initializer) {
    throw new Error(
      `Entry point ${entryPoint} does not export an initializer (expected default/initialize/init/start)`
    );
  }

  await initializer(context);
}

/**
 * Agent Lifecycle Manager — the core runtime component.
 * Handles agent spawning, state management, resource tracking, and termination.
 */
export class AgentLifecycleManager {
  private agents: Map<AgentId, AgentInstance> = new Map();
  private listeners: Array<(event: LifecycleEvent) => void> = [];
  private options: ResolvedOptions;
  private sandboxRegistry: SandboxRegistry;
  private isShuttingDown = false;
  private autoCheckpointTimers: Map<AgentId, NodeJS.Timeout> = new Map();

  constructor(options: LifecycleManagerOptions = {}) {
    this.options = {
      maxAgents: options.maxAgents ?? 100,
      globalLimits: options.globalLimits ?? {},
      auditLogging: options.auditLogging ?? true,
      sandboxConfig: options.sandboxConfig ?? {},
      persistence: options.persistence ?? null,
      auditLogger: options.auditLogger ?? null,
      healthMonitor: options.healthMonitor ?? null,
      autoCheckpointIntervalMs: options.autoCheckpointIntervalMs ?? 0,
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? 30000,
      agentInitializer: options.agentInitializer ?? null,
    };

    this.sandboxRegistry = new SandboxRegistry(this.options.sandboxConfig);

    // Configure health monitor if provided
    if (this.options.healthMonitor) {
      this.options.healthMonitor.setMetricsProvider((agentId) => this.getHealthMetrics(agentId));
    }
  }

  /** Get current agent count */
  get agentCount(): number {
    return this.agents.size;
  }

  /** Get all agent IDs */
  get agentIds(): AgentId[] {
    return Array.from(this.agents.keys());
  }

  /** Check if system is shutting down */
  get shuttingDown(): boolean {
    return this.isShuttingDown;
  }

  /**
   * Spawn a new agent from a manifest.
   * Returns the agent ID or throws if spawning fails.
   */
  spawn(manifest: AgentManifest, parentId?: AgentId): AgentId {
    // Check if shutting down
    if (this.isShuttingDown) {
      throw new Error("Cannot spawn agent during shutdown");
    }

    // Check capacity
    if (this.agents.size >= this.options.maxAgents) {
      throw new Error(`Agent limit reached (${this.options.maxAgents})`);
    }

    // Generate unique ID
    const id = randomUUID();
    const now = new Date();

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

    // Create sandbox with requested capabilities
    const sandbox = this.sandboxRegistry.create(id, this.options.sandboxConfig);

    // Grant requested capabilities
    const requestedCapabilities = manifest.permissions ?? [];
    for (const capability of requestedCapabilities) {
      // Only grant if not already granted by default
      if (!DEFAULT_CAPABILITIES.includes(capability)) {
        sandbox.grant(capability, parentId ?? "system");
      }
    }

    // Create context
    const context: AgentContext = {
      id,
      metadata,
      state: stateMachine.state,
      limits,
      usage,
      createdAt: now,
      lastStateChange: now,
      parentId,
      env: manifest.env ?? {},
    };

    // Create instance
    const instance: AgentInstance = {
      context,
      stateMachine,
      usage,
      manifest,
      sandbox,
      createdAt: now,
      lastActivityAt: now,
      errorCount: 0,
      successCount: 0,
      customData: manifest.customData,
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
      timestamp: now,
      data: { manifest, parentId },
    });

    // Audit log
    this.options.auditLogger?.lifecycle(id, {
      action: "spawn",
      parentId,
      manifest: { name: manifest.name, version: manifest.version },
    });

    // Start auto-checkpoint if enabled
    this.startAutoCheckpoint(id);

    return id;
  }

  /**
   * Recover an agent from a checkpoint.
   */
  async recover(checkpoint: AgentCheckpoint): Promise<AgentId> {
    if (this.isShuttingDown) {
      throw new Error("Cannot recover agent during shutdown");
    }

    // Check capacity
    if (this.agents.size >= this.options.maxAgents) {
      throw new Error(`Agent limit reached (${this.options.maxAgents})`);
    }

    const { agentId: id, manifest, state, stateHistory, usage, env, parentId, createdAt, capabilities, customData } = checkpoint;
    const now = new Date();

    // Check if agent already exists
    if (this.agents.has(id)) {
      throw new Error(`Agent already exists: ${id}`);
    }

    // Recreate state machine from checkpoint
    const stateMachine = AgentStateMachine.fromJSON({
      state,
      history: stateHistory,
    });

    // Merge limits
    const limits: ResourceLimits = {
      ...DEFAULT_LIMITS,
      ...this.options.globalLimits,
      ...manifest.limits,
    };

    // Build metadata
    const metadata: AgentMetadata = {
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author,
      tags: manifest.tags,
    };

    // Create sandbox with restored capabilities
    const sandbox = this.sandboxRegistry.create(id, this.options.sandboxConfig);
    for (const { capability, grant } of capabilities) {
      sandbox.grant(capability, grant.grantedBy, {
        expiresAt: grant.expiresAt,
        constraints: grant.constraints,
      });
    }

    // Create context
    const context: AgentContext = {
      id,
      metadata,
      state: stateMachine.state,
      limits,
      usage: { ...usage },
      createdAt,
      lastStateChange: now,
      parentId,
      env,
    };

    // Create instance
    const instance: AgentInstance = {
      context,
      stateMachine,
      usage: { ...usage },
      manifest,
      sandbox,
      createdAt,
      lastActivityAt: now,
      errorCount: 0,
      successCount: 0,
      customData,
    };

    // Register state change listener
    stateMachine.onTransition((transition) => {
      this.handleStateTransition(id, transition);
    });

    // Store instance
    this.agents.set(id, instance);

    // Emit recover event
    this.emit({
      type: "recover",
      agentId: id,
      timestamp: now,
      data: { checkpoint },
    });

    // Audit log
    this.options.auditLogger?.lifecycle(id, {
      action: "initialize",
      reason: "Recovered from checkpoint",
    });

    // Start auto-checkpoint
    this.startAutoCheckpoint(id);

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
      await this.runInitializer(agentId, instance);

      // Mark as ready
      const result = instance.stateMachine.transition("READY", "Initialization complete");

      if (result) {
        instance.lastActivityAt = new Date();

        // Audit log
        this.options.auditLogger?.lifecycle(agentId, {
          action: "initialize",
        });
      }

      return result;
    } catch (error) {
      instance.stateMachine.transition("FAIL", String(error));
      instance.errorCount++;

      // Audit log
      this.options.auditLogger?.error(
        `Agent initialization failed: ${agentId}`,
        error instanceof Error ? error : new Error(String(error)),
        { agentId }
      );

      return false;
    }
  }

  private async runInitializer(agentId: AgentId, instance: AgentInstance): Promise<void> {
    const initContext: AgentInitializerContext = {
      agentId,
      context: instance.context,
      manifest: instance.manifest,
      sandbox: instance.sandbox,
    };

    if (this.options.agentInitializer) {
      await this.options.agentInitializer(initContext);
      return;
    }

    if (instance.manifest.entryPoint) {
      await loadEntryPoint(instance.manifest.entryPoint, initContext);
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

    const result = instance.stateMachine.transition("START", "Task started");
    if (result) {
      instance.lastActivityAt = new Date();
      instance.usage.activeRequests++;

      // Audit log
      this.options.auditLogger?.lifecycle(agentId, { action: "start" });
    }

    return result;
  }

  /**
   * Pause an agent (transition to paused).
   */
  pause(agentId: AgentId): boolean {
    const instance = this.agents.get(agentId);
    if (!instance) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const result = instance.stateMachine.transition("PAUSE", "Agent paused");
    if (result) {
      instance.lastActivityAt = new Date();

      // Audit log
      this.options.auditLogger?.lifecycle(agentId, { action: "pause" });
    }

    return result;
  }

  /**
   * Resume a paused agent.
   */
  resume(agentId: AgentId): boolean {
    const instance = this.agents.get(agentId);
    if (!instance) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const result = instance.stateMachine.transition("RESUME", "Agent resumed");
    if (result) {
      instance.lastActivityAt = new Date();

      // Audit log
      this.options.auditLogger?.lifecycle(agentId, { action: "resume" });
    }

    return result;
  }

  /**
   * Mark task as complete (running → ready).
   */
  complete(agentId: AgentId): boolean {
    const instance = this.agents.get(agentId);
    if (!instance) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const result = instance.stateMachine.transition("COMPLETE", "Task completed");
    if (result) {
      instance.lastActivityAt = new Date();
      instance.successCount++;
      if (instance.usage.activeRequests > 0) {
        instance.usage.activeRequests--;
      }
    }

    return result;
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

    const result = instance.stateMachine.transition("FAIL", reason);
    if (result) {
      instance.lastActivityAt = new Date();
      instance.errorCount++;
      if (instance.usage.activeRequests > 0) {
        instance.usage.activeRequests--;
      }

      // Audit log
      this.options.auditLogger?.error(
        `Agent failed: ${reason}`,
        new Error(reason),
        { agentId }
      );
    }

    return result;
  }

  /**
   * Attempt recovery from error state.
   */
  recover2(agentId: AgentId): boolean {
    const instance = this.agents.get(agentId);
    if (!instance) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const result = instance.stateMachine.transition("RECOVER", "Recovery attempted");
    if (result) {
      instance.lastActivityAt = new Date();

      // Audit log
      this.options.auditLogger?.lifecycle(agentId, {
        action: "resume",
        reason: "Recovery from error state",
      });
    }

    return result;
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
      // Stop auto-checkpoint
      this.stopAutoCheckpoint(agentId);

      this.emit({
        type: "terminate",
        agentId,
        timestamp: new Date(),
        data: { reason, finalUsage: instance.usage },
      });

      // Remove sandbox
      this.sandboxRegistry.remove(agentId);

      // Audit log
      this.options.auditLogger?.lifecycle(agentId, {
        action: "terminate",
        reason,
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
   * Get agent sandbox by ID.
   */
  getSandbox(agentId: AgentId): AgentSandbox | undefined {
    return this.sandboxRegistry.get(agentId);
  }

  /**
   * Check if agent has a capability.
   */
  hasCapability(agentId: AgentId, capability: Capability): boolean {
    const sandbox = this.sandboxRegistry.get(agentId);
    return sandbox?.has(capability) ?? false;
  }

  /**
   * Check capability and record usage.
   */
  checkCapability(agentId: AgentId, capability: Capability, context?: Record<string, unknown>): boolean {
    const sandbox = this.sandboxRegistry.get(agentId);
    if (!sandbox) return false;

    const result = sandbox.check(capability, context);

    // Audit log permission check
    this.options.auditLogger?.permission(agentId, {
      action: "check",
      capability,
      allowed: result.allowed,
      reason: result.reason,
    });

    return result.allowed;
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

    // Update activity timestamp
    instance.lastActivityAt = now;

    // Check limits
    const limitCheck = checkLimits(usage, instance.context.limits);
    if (!limitCheck.allowed) {
      this.emit({
        type: "resource_warning",
        agentId,
        timestamp: now,
        data: { violations: limitCheck.violations },
      });

      // Audit log
      this.options.auditLogger?.resource(agentId, {
        type: "limit_warning",
        resourceType: "tokens",
        current: usage.tokensThisMinute,
        limit: instance.context.limits.tokensPerMinute,
        usage,
      });
    }
  }

  /**
   * Create checkpoint for an agent.
   */
  async checkpoint(agentId: AgentId): Promise<void> {
    if (!this.options.persistence) return;

    const instance = this.agents.get(agentId);
    if (!instance) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const checkpointData = this.options.persistence.createCheckpointData(
      {
        ...instance.context,
        state: instance.stateMachine.state,
        usage: instance.usage,
      },
      instance.stateMachine.history as StateTransition[],
      instance.manifest,
      instance.sandbox.getGrants().map((grant) => ({
        capability: grant.capability,
        grant,
      })),
      instance.customData
    );

    await this.options.persistence.checkpoint(agentId, checkpointData);

    this.emit({
      type: "checkpoint",
      agentId,
      timestamp: new Date(),
    });
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
   * Get health metrics for an agent.
   */
  getHealthMetrics(agentId: AgentId): HealthMetrics | null {
    const instance = this.agents.get(agentId);
    if (!instance) return null;

    const now = new Date();
    const uptimeSeconds = (now.getTime() - instance.createdAt.getTime()) / 1000;
    const idleSeconds = (now.getTime() - instance.lastActivityAt.getTime()) / 1000;
    const totalRequests = instance.successCount + instance.errorCount;
    const successRate = totalRequests > 0 ? instance.successCount / totalRequests : 1;

    return {
      agentId,
      state: instance.stateMachine.state,
      usage: instance.usage,
      limits: instance.context.limits,
      uptimeSeconds,
      idleSeconds,
      errorCountLastHour: instance.errorCount, // Simplified; should track per-hour
      transitionCountLastHour: instance.stateMachine.history.length,
      avgResponseTimeMs: 0, // Would need request timing to compute
      successRateLastHour: successRate,
    };
  }

  /**
   * Run health check for an agent.
   */
  checkHealth(agentId: AgentId): HealthCheckResult | null {
    if (!this.options.healthMonitor) return null;

    const metrics = this.getHealthMetrics(agentId);
    if (!metrics) return null;

    return this.options.healthMonitor.check(metrics);
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
   * Graceful shutdown — terminate all agents with timeout.
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    // Audit log
    this.options.auditLogger?.system("System shutdown initiated", {
      agentCount: this.agents.size,
    });

    // Stop health monitoring
    this.options.healthMonitor?.stop();

    // Stop all auto-checkpoints
    for (const agentId of this.agents.keys()) {
      this.stopAutoCheckpoint(agentId);
    }

    // Checkpoint all agents before shutdown
    if (this.options.persistence) {
      const checkpointPromises: Promise<void>[] = [];
      for (const agentId of this.agents.keys()) {
        checkpointPromises.push(
          this.checkpoint(agentId).catch(() => {
            // Ignore checkpoint errors during shutdown
          })
        );
      }
      await Promise.all(checkpointPromises);
    }

    // Terminate all agents
    const agents = Array.from(this.agents.keys());
    for (const agentId of agents) {
      this.terminate(agentId, "System shutdown");
    }

    // Wait for termination with timeout
    const startTime = Date.now();
    while (this.agents.size > 0) {
      if (Date.now() - startTime > this.options.shutdownTimeoutMs) {
        // Force cleanup
        this.agents.clear();
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Close audit logger
    await this.options.auditLogger?.close();

    // Audit log
    this.options.auditLogger?.system("System shutdown complete");
  }

  /** Start auto-checkpoint for an agent */
  private startAutoCheckpoint(agentId: AgentId): void {
    if (this.options.autoCheckpointIntervalMs <= 0) return;
    if (!this.options.persistence) return;

    const timer = setInterval(async () => {
      try {
        await this.checkpoint(agentId);
      } catch {
        // Ignore checkpoint errors
      }
    }, this.options.autoCheckpointIntervalMs);

    this.autoCheckpointTimers.set(agentId, timer);
  }

  /** Stop auto-checkpoint for an agent */
  private stopAutoCheckpoint(agentId: AgentId): void {
    const timer = this.autoCheckpointTimers.get(agentId);
    if (timer) {
      clearInterval(timer);
      this.autoCheckpointTimers.delete(agentId);
    }
  }

  /** Emit an event to all listeners */
  private emit(event: LifecycleEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Don't crash on listener errors
      }
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

    // Audit log
    this.options.auditLogger?.stateTransition(agentId, transition);
  }
}

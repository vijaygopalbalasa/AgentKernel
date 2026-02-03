// System Agent — Health monitoring and resource management for Agent OS
// Provides system-level oversight and diagnostics

import { z } from "zod";
import { type Result, ok, err } from "@agent-os/shared";
import { type Logger, createLogger } from "@agent-os/kernel";
import { createEventBus, type EventBus } from "@agent-os/events";

// ─── MANIFEST ───────────────────────────────────────────────

/** System agent manifest schema */
export const SystemManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().default("0.1.0"),
  description: z.string().optional(),
  checkInterval: z.number().min(1000).default(30000), // Health check interval in ms
  maxMemoryMB: z.number().min(128).default(512), // Max memory per agent
  maxAgents: z.number().min(1).default(100), // Max concurrent agents
});

export type SystemManifest = z.infer<typeof SystemManifestSchema>;

/** Default manifest */
export const DEFAULT_MANIFEST: SystemManifest = {
  id: "system",
  name: "System Agent",
  version: "0.1.0",
  description: "Agent OS system monitor and resource manager",
  checkInterval: 30000,
  maxMemoryMB: 512,
  maxAgents: 100,
};

// ─── ERROR CLASS ────────────────────────────────────────────

export type SystemErrorCode =
  | "NOT_INITIALIZED"
  | "ALREADY_RUNNING"
  | "VALIDATION_ERROR"
  | "RESOURCE_EXCEEDED"
  | "HEALTH_CHECK_FAILED";

export class SystemError extends Error {
  constructor(
    message: string,
    public readonly code: SystemErrorCode
  ) {
    super(message);
    this.name = "SystemError";
  }
}

// ─── AGENT STATE ────────────────────────────────────────────

export type SystemState = "idle" | "initializing" | "monitoring" | "error" | "terminated";

/** Health status levels */
export type HealthLevel = "healthy" | "degraded" | "critical";

/** System health report */
export interface HealthReport {
  level: HealthLevel;
  timestamp: Date;
  uptime: number;
  memory: {
    used: number;
    total: number;
    percentage: number;
  };
  agents: {
    active: number;
    total: number;
    errored: number;
  };
  providers: string[];
  issues: string[];
}

/** Resource usage per agent */
export interface AgentResourceUsage {
  agentId: string;
  memoryMB: number;
  cpuPercent: number;
  requestsPerMinute: number;
  lastActivity: Date;
}

// ─── SYSTEM AGENT CLASS ─────────────────────────────────────

/**
 * System Agent — Monitors and manages Agent OS resources.
 *
 * Responsibilities:
 * - Health monitoring of the overall system
 * - Resource tracking per agent
 * - Alerting on degraded conditions
 * - Providing system diagnostics
 */
export class SystemAgent {
  private log: Logger;
  private manifest: SystemManifest;
  private state: SystemState = "idle";
  private eventBus: EventBus;
  private startedAt?: number;
  private healthCheckTimer?: ReturnType<typeof setInterval>;
  private lastHealthReport?: HealthReport;
  private agentResources: Map<string, AgentResourceUsage> = new Map();
  private registeredProviders: Set<string> = new Set();

  constructor(manifest?: Partial<SystemManifest>) {
    // Validate and merge manifest
    const result = SystemManifestSchema.safeParse({ ...DEFAULT_MANIFEST, ...manifest });
    if (!result.success) {
      throw new SystemError(`Invalid manifest: ${result.error.message}`, "VALIDATION_ERROR");
    }
    this.manifest = result.data;

    // Initialize logger
    this.log = createLogger({ name: `agent:${this.manifest.id}` });

    // Initialize event bus
    this.eventBus = createEventBus();

    this.log.debug("System agent created", { id: this.manifest.id });
  }

  /**
   * Initialize the system agent.
   */
  async initialize(): Promise<Result<void, SystemError>> {
    if (this.state !== "idle") {
      return err(new SystemError("Agent already initialized", "ALREADY_RUNNING"));
    }

    this.state = "initializing";
    this.log.info("Initializing system agent", { id: this.manifest.id });

    try {
      this.startedAt = Date.now();
      this.state = "monitoring";

      // Start health check timer
      this.healthCheckTimer = setInterval(() => {
        this.performHealthCheck().catch((e) => {
          this.log.error("Health check failed", { error: e instanceof Error ? e.message : String(e) });
        });
      }, this.manifest.checkInterval);

      // Perform initial health check
      await this.performHealthCheck();

      this.log.info("System agent ready", { id: this.manifest.id });
      return ok(undefined);
    } catch (error) {
      this.state = "error";
      const message = error instanceof Error ? error.message : String(error);
      this.log.error("Initialization failed", { error: message });
      return err(new SystemError(`Initialization failed: ${message}`, "VALIDATION_ERROR"));
    }
  }

  /**
   * Perform a health check of the system.
   */
  async performHealthCheck(): Promise<Result<HealthReport, SystemError>> {
    if (this.state !== "monitoring") {
      return err(new SystemError("Agent not monitoring", "NOT_INITIALIZED"));
    }

    this.log.debug("Performing health check");

    try {
      const issues: string[] = [];
      let level: HealthLevel = "healthy";

      // Collect memory info
      const memoryUsage = process.memoryUsage();
      const usedMB = Math.round(memoryUsage.heapUsed / 1024 / 1024);
      const totalMB = Math.round(memoryUsage.heapTotal / 1024 / 1024);
      const memoryPercent = Math.round((usedMB / totalMB) * 100);

      if (memoryPercent > 90) {
        issues.push("Memory usage critical: >90%");
        level = "critical";
      } else if (memoryPercent > 75) {
        issues.push("Memory usage high: >75%");
        if (level === "healthy") level = "degraded";
      }

      // Count agents
      const activeAgents = this.agentResources.size;
      let erroredAgents = 0;

      for (const usage of this.agentResources.values()) {
        // Check for stale agents (no activity in 5 minutes)
        const staleThreshold = 5 * 60 * 1000;
        if (Date.now() - usage.lastActivity.getTime() > staleThreshold) {
          issues.push(`Agent ${usage.agentId} appears stale`);
          if (level === "healthy") level = "degraded";
        }

        // Check for high memory usage
        if (usage.memoryMB > this.manifest.maxMemoryMB) {
          issues.push(`Agent ${usage.agentId} exceeds memory limit`);
          erroredAgents++;
          if (level === "healthy") level = "degraded";
        }
      }

      // Check agent count
      if (activeAgents >= this.manifest.maxAgents) {
        issues.push("Maximum agent count reached");
        if (level !== "critical") level = "degraded";
      }

      // Build report
      const report: HealthReport = {
        level,
        timestamp: new Date(),
        uptime: this.getUptime(),
        memory: {
          used: usedMB,
          total: totalMB,
          percentage: memoryPercent,
        },
        agents: {
          active: activeAgents,
          total: activeAgents,
          errored: erroredAgents,
        },
        providers: Array.from(this.registeredProviders),
        issues,
      };

      this.lastHealthReport = report;
      this.log.debug("Health check complete", { level, issues: issues.length });

      return ok(report);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error("Health check failed", { error: message });
      return err(new SystemError(`Health check failed: ${message}`, "HEALTH_CHECK_FAILED"));
    }
  }

  /**
   * Register a new agent for resource tracking.
   */
  registerAgent(agentId: string): Result<void, SystemError> {
    if (this.agentResources.size >= this.manifest.maxAgents) {
      return err(new SystemError("Maximum agent count reached", "RESOURCE_EXCEEDED"));
    }

    this.agentResources.set(agentId, {
      agentId,
      memoryMB: 0,
      cpuPercent: 0,
      requestsPerMinute: 0,
      lastActivity: new Date(),
    });

    this.log.debug("Agent registered", { agentId });
    return ok(undefined);
  }

  /**
   * Unregister an agent from resource tracking.
   */
  unregisterAgent(agentId: string): void {
    this.agentResources.delete(agentId);
    this.log.debug("Agent unregistered", { agentId });
  }

  /**
   * Update resource usage for an agent.
   */
  updateAgentResources(agentId: string, usage: Partial<Omit<AgentResourceUsage, "agentId">>): Result<void, SystemError> {
    const current = this.agentResources.get(agentId);
    if (!current) {
      return err(new SystemError(`Agent not registered: ${agentId}`, "VALIDATION_ERROR"));
    }

    this.agentResources.set(agentId, {
      ...current,
      ...usage,
      lastActivity: new Date(),
    });

    return ok(undefined);
  }

  /**
   * Register an LLM provider.
   */
  registerProvider(providerId: string): void {
    this.registeredProviders.add(providerId);
    this.log.debug("Provider registered", { providerId });
  }

  /**
   * Unregister an LLM provider.
   */
  unregisterProvider(providerId: string): void {
    this.registeredProviders.delete(providerId);
    this.log.debug("Provider unregistered", { providerId });
  }

  /**
   * Get the last health report.
   */
  getLastHealthReport(): HealthReport | undefined {
    return this.lastHealthReport;
  }

  /**
   * Get resource usage for a specific agent.
   */
  getAgentResources(agentId: string): AgentResourceUsage | undefined {
    return this.agentResources.get(agentId);
  }

  /**
   * Get all agent resource usage.
   */
  getAllAgentResources(): AgentResourceUsage[] {
    return Array.from(this.agentResources.values());
  }

  /**
   * Get uptime in seconds.
   */
  private getUptime(): number {
    return this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0;
  }

  /**
   * Get agent status.
   */
  getStatus(): {
    id: string;
    name: string;
    state: SystemState;
    uptime: number;
    healthLevel: HealthLevel | "unknown";
    agentCount: number;
    providerCount: number;
  } {
    return {
      id: this.manifest.id,
      name: this.manifest.name,
      state: this.state,
      uptime: this.getUptime(),
      healthLevel: this.lastHealthReport?.level ?? "unknown",
      agentCount: this.agentResources.size,
      providerCount: this.registeredProviders.size,
    };
  }

  /**
   * Get system diagnostics.
   */
  getDiagnostics(): {
    manifest: SystemManifest;
    state: SystemState;
    uptime: number;
    lastHealthCheck?: Date;
    agents: AgentResourceUsage[];
    providers: string[];
    memory: {
      heapUsed: number;
      heapTotal: number;
      rss: number;
    };
  } {
    const memoryUsage = process.memoryUsage();

    return {
      manifest: this.manifest,
      state: this.state,
      uptime: this.getUptime(),
      lastHealthCheck: this.lastHealthReport?.timestamp,
      agents: this.getAllAgentResources(),
      providers: Array.from(this.registeredProviders),
      memory: {
        heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
        heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024),
        rss: Math.round(memoryUsage.rss / 1024 / 1024),
      },
    };
  }

  /**
   * Terminate the system agent.
   */
  async terminate(): Promise<Result<void, SystemError>> {
    this.log.info("Terminating system agent", { id: this.manifest.id });

    // Stop health check timer
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }

    // Clear resources
    this.agentResources.clear();
    this.registeredProviders.clear();

    this.state = "terminated";

    return ok(undefined);
  }
}

// ─── FACTORY FUNCTION ───────────────────────────────────────

/**
 * Create a new System Agent.
 */
export function createSystemAgent(manifest?: Partial<SystemManifest>): SystemAgent {
  return new SystemAgent(manifest);
}

// ─── EXPORTS ────────────────────────────────────────────────

export { DEFAULT_MANIFEST as SYSTEM_MANIFEST };

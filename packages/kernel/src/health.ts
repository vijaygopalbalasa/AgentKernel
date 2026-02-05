// Health check aggregator for all kernel components
// Provides unified health status for monitoring and readiness probes

import type { Database } from "./database.js";
import type { EventBus } from "./event-bus.js";
import type { Logger } from "./logger.js";
import type { VectorStore } from "./vector-store.js";

/** Health status for a component */
export interface ComponentHealth {
  /** Component name */
  name: string;
  /** Whether the component is healthy */
  healthy: boolean;
  /** Latency in milliseconds */
  latencyMs: number;
  /** Optional details */
  details?: Record<string, unknown>;
  /** Error message if unhealthy */
  error?: string;
  /** Last check timestamp */
  lastCheck: Date;
}

/** Overall system health */
export interface SystemHealth {
  /** Overall status */
  status: "healthy" | "degraded" | "unhealthy";
  /** Timestamp of this health check */
  timestamp: Date;
  /** Individual component health */
  components: ComponentHealth[];
  /** System uptime in seconds */
  uptimeSeconds: number;
  /** Memory usage */
  memory: {
    heapUsedMB: number;
    heapTotalMB: number;
    rssMB: number;
    percentUsed: number;
  };
  /** Version info */
  version: string;
}

/** Health check options */
export interface HealthCheckOptions {
  /** Check timeout in milliseconds */
  timeoutMs?: number;
  /** Include detailed component info */
  detailed?: boolean;
}

/** Health checker function */
export type HealthChecker = () => Promise<ComponentHealth>;

/** Health check manager */
export interface HealthManager {
  /** Register a health checker */
  register(name: string, checker: HealthChecker): void;

  /** Unregister a health checker */
  unregister(name: string): void;

  /** Check health of a specific component */
  checkComponent(name: string, options?: HealthCheckOptions): Promise<ComponentHealth | null>;

  /** Check health of all components */
  checkAll(options?: HealthCheckOptions): Promise<SystemHealth>;

  /** Get last health check results (cached) */
  getLastCheck(): SystemHealth | null;

  /** Start periodic health checks */
  startPeriodicChecks(intervalMs: number): void;

  /** Stop periodic health checks */
  stopPeriodicChecks(): void;

  /** Register health change listener */
  onHealthChange(listener: (health: SystemHealth) => void): () => void;
}

/** System start time for uptime calculation */
const startTime = Date.now();

/** Create a health manager */
export function createHealthManager(logger?: Logger): HealthManager {
  const log = logger ?? {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  const checkers = new Map<string, HealthChecker>();
  const listeners = new Set<(health: SystemHealth) => void>();
  let lastHealth: SystemHealth | null = null;
  let periodicInterval: NodeJS.Timeout | null = null;

  /** Get memory stats */
  function getMemoryStats() {
    const mem = process.memoryUsage();
    return {
      heapUsedMB: Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100,
      heapTotalMB: Math.round((mem.heapTotal / 1024 / 1024) * 100) / 100,
      rssMB: Math.round((mem.rss / 1024 / 1024) * 100) / 100,
      percentUsed: Math.round((mem.heapUsed / mem.heapTotal) * 100),
    };
  }

  /** Run a health check with timeout */
  async function runWithTimeout(
    name: string,
    checker: HealthChecker,
    timeoutMs: number,
  ): Promise<ComponentHealth> {
    const start = Date.now();

    try {
      const result = await Promise.race([
        checker(),
        new Promise<ComponentHealth>((_, reject) =>
          setTimeout(() => reject(new Error("Health check timed out")), timeoutMs),
        ),
      ]);
      return result;
    } catch (error) {
      return {
        name,
        healthy: false,
        latencyMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
        lastCheck: new Date(),
      };
    }
  }

  /** Notify listeners of health change */
  function notifyListeners(health: SystemHealth) {
    for (const listener of listeners) {
      try {
        listener(health);
      } catch (error) {
        log.error("Health listener error", { error: String(error) });
      }
    }
  }

  /** Determine overall status from components */
  function determineStatus(components: ComponentHealth[]): "healthy" | "degraded" | "unhealthy" {
    const unhealthyCount = components.filter((c) => !c.healthy).length;
    const totalCount = components.length;

    if (unhealthyCount === 0) return "healthy";
    if (unhealthyCount === totalCount) return "unhealthy";
    return "degraded";
  }

  const manager: HealthManager = {
    register(name: string, checker: HealthChecker): void {
      checkers.set(name, checker);
      log.debug("Health checker registered", { name });
    },

    unregister(name: string): void {
      checkers.delete(name);
      log.debug("Health checker unregistered", { name });
    },

    async checkComponent(
      name: string,
      options: HealthCheckOptions = {},
    ): Promise<ComponentHealth | null> {
      const { timeoutMs = 5000 } = options;
      const checker = checkers.get(name);

      if (!checker) {
        return null;
      }

      return runWithTimeout(name, checker, timeoutMs);
    },

    async checkAll(options: HealthCheckOptions = {}): Promise<SystemHealth> {
      const { timeoutMs = 5000 } = options;

      // Run all health checks in parallel
      const checkPromises: Promise<ComponentHealth>[] = [];

      for (const [name, checker] of checkers) {
        checkPromises.push(runWithTimeout(name, checker, timeoutMs));
      }

      const components = await Promise.all(checkPromises);

      const health: SystemHealth = {
        status: determineStatus(components),
        timestamp: new Date(),
        components,
        uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
        memory: getMemoryStats(),
        version: process.env.npm_package_version ?? "0.1.0",
      };

      // Check if status changed
      const statusChanged = lastHealth?.status !== health.status;
      lastHealth = health;

      if (statusChanged) {
        log.info("System health status changed", { status: health.status });
        notifyListeners(health);
      }

      return health;
    },

    getLastCheck(): SystemHealth | null {
      return lastHealth;
    },

    startPeriodicChecks(intervalMs: number): void {
      if (periodicInterval) {
        clearInterval(periodicInterval);
      }

      log.info("Starting periodic health checks", { intervalMs });

      // Run initial check
      manager.checkAll().catch((err) => {
        log.error("Periodic health check failed", { error: String(err) });
      });

      periodicInterval = setInterval(() => {
        manager.checkAll().catch((err) => {
          log.error("Periodic health check failed", { error: String(err) });
        });
      }, intervalMs);
    },

    stopPeriodicChecks(): void {
      if (periodicInterval) {
        clearInterval(periodicInterval);
        periodicInterval = null;
        log.info("Periodic health checks stopped");
      }
    },

    onHealthChange(listener: (health: SystemHealth) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return manager;
}

/** Create database health checker */
export function createDatabaseHealthChecker(db: Database): HealthChecker {
  return async () => {
    const start = Date.now();
    try {
      const connected = await db.isConnected();
      const stats = db.getStats();

      return {
        name: "database",
        healthy: connected,
        latencyMs: Date.now() - start,
        details: {
          ...stats,
        },
        lastCheck: new Date(),
      };
    } catch (error) {
      return {
        name: "database",
        healthy: false,
        latencyMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
        lastCheck: new Date(),
      };
    }
  };
}

/** Create vector store health checker */
export function createVectorStoreHealthChecker(store: VectorStore): HealthChecker {
  return async () => {
    const start = Date.now();
    try {
      const healthy = await store.isHealthy();
      if (!healthy) {
        return {
          name: "vector-store",
          healthy: false,
          latencyMs: Date.now() - start,
          error: "Vector store not responding",
          lastCheck: new Date(),
        };
      }

      const info = await store.getInfo();
      return {
        name: "vector-store",
        healthy: true,
        latencyMs: Date.now() - start,
        details: {
          collection: info.name,
          pointsCount: info.pointsCount,
          status: info.status,
        },
        lastCheck: new Date(),
      };
    } catch (error) {
      return {
        name: "vector-store",
        healthy: false,
        latencyMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
        lastCheck: new Date(),
      };
    }
  };
}

/** Create event bus health checker */
export function createEventBusHealthChecker(bus: EventBus): HealthChecker {
  return async () => {
    const start = Date.now();
    try {
      const connected = bus.isConnected();
      const stats = bus.getStats();

      return {
        name: "event-bus",
        healthy: connected,
        latencyMs: Date.now() - start,
        details: {
          subscriptions: stats.subscriptions,
          published: stats.published,
          received: stats.received,
        },
        lastCheck: new Date(),
      };
    } catch (error) {
      return {
        name: "event-bus",
        healthy: false,
        latencyMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
        lastCheck: new Date(),
      };
    }
  };
}

/** Create a simple health checker from a check function */
export function createSimpleHealthChecker(
  name: string,
  check: () => Promise<boolean> | boolean,
  getDetails?: () => Record<string, unknown>,
): HealthChecker {
  return async () => {
    const start = Date.now();
    try {
      const healthy = await check();
      return {
        name,
        healthy,
        latencyMs: Date.now() - start,
        details: getDetails?.(),
        lastCheck: new Date(),
      };
    } catch (error) {
      return {
        name,
        healthy: false,
        latencyMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
        lastCheck: new Date(),
      };
    }
  };
}

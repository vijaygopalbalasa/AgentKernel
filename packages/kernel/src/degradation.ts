// Graceful Degradation Utilities
// Provides fallback mechanisms when services are unavailable

import { z } from "zod";
import { createLogger } from "./logger.js";

const log = createLogger({ name: "degradation" });

// ─── TYPES ──────────────────────────────────────────────────

export type DegradationLevel = "normal" | "degraded" | "emergency";

export interface DegradationState {
  level: DegradationLevel;
  services: Map<string, ServiceStatus>;
  startedAt?: Date;
  reason?: string;
}

export interface ServiceStatus {
  name: string;
  available: boolean;
  degraded: boolean;
  lastCheck: Date;
  error?: string;
  fallbackActive: boolean;
}

export const DegradationConfigSchema = z.object({
  checkInterval: z.number().min(1000).optional().default(30000),
  maxDegradedServices: z.number().min(1).optional().default(2),
  emergencyThreshold: z.number().min(1).optional().default(3),
});

export type DegradationConfig = z.infer<typeof DegradationConfigSchema>;

// ─── DEGRADATION MANAGER ────────────────────────────────────

/**
 * Manages graceful degradation across services.
 */
export class DegradationManager {
  private state: DegradationState;
  private config: DegradationConfig;
  private checkTimer?: ReturnType<typeof setInterval>;
  private healthChecks: Map<string, () => Promise<boolean>> = new Map();
  private fallbacks: Map<string, () => void> = new Map();

  constructor(config: Partial<DegradationConfig> = {}) {
    this.config = DegradationConfigSchema.parse(config);
    this.state = {
      level: "normal",
      services: new Map(),
    };
  }

  /**
   * Register a service with health check and fallback.
   */
  registerService(
    name: string,
    healthCheck: () => Promise<boolean>,
    fallback?: () => void
  ): void {
    this.healthChecks.set(name, healthCheck);
    if (fallback) {
      this.fallbacks.set(name, fallback);
    }

    this.state.services.set(name, {
      name,
      available: true,
      degraded: false,
      lastCheck: new Date(),
      fallbackActive: false,
    });

    log.debug("Service registered for degradation monitoring", { name });
  }

  /**
   * Start periodic health checks.
   */
  startMonitoring(): void {
    if (this.checkTimer) return;

    this.checkTimer = setInterval(() => {
      this.checkAllServices().catch((e) => {
        log.error("Service check failed", { error: e });
      });
    }, this.config.checkInterval);

    // Initial check
    this.checkAllServices().catch((e) => {
      log.error("Initial service check failed", { error: e });
    });

    log.info("Degradation monitoring started", { interval: this.config.checkInterval });
  }

  /**
   * Stop monitoring.
   */
  stopMonitoring(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = undefined;
    }
    log.info("Degradation monitoring stopped");
  }

  /**
   * Check all registered services.
   */
  async checkAllServices(): Promise<void> {
    const checks = Array.from(this.healthChecks.entries()).map(
      async ([name, check]) => {
        try {
          const healthy = await check();
          this.updateServiceStatus(name, healthy, healthy ? undefined : "Health check failed");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.updateServiceStatus(name, false, message);
        }
      }
    );

    await Promise.all(checks);
    this.updateDegradationLevel();
  }

  /**
   * Update status for a single service.
   */
  private updateServiceStatus(name: string, available: boolean, error?: string): void {
    const current = this.state.services.get(name);
    const wasAvailable = current?.available ?? true;

    const status: ServiceStatus = {
      name,
      available,
      degraded: !available,
      lastCheck: new Date(),
      error,
      fallbackActive: !available && this.fallbacks.has(name),
    };

    this.state.services.set(name, status);

    // Log status changes
    if (wasAvailable && !available) {
      log.warn("Service became unavailable", { name, error, fallbackActive: status.fallbackActive });

      // Activate fallback if available
      const fallback = this.fallbacks.get(name);
      if (fallback) {
        try {
          fallback();
          log.info("Fallback activated for service", { name });
        } catch (e) {
          log.error("Fallback activation failed", { name, error: e });
        }
      }
    } else if (!wasAvailable && available) {
      log.info("Service recovered", { name });
    }
  }

  /**
   * Update overall degradation level.
   */
  private updateDegradationLevel(): void {
    const unavailableCount = Array.from(this.state.services.values()).filter(
      (s) => !s.available
    ).length;

    const previousLevel = this.state.level;
    let newLevel: DegradationLevel = "normal";

    if (unavailableCount >= this.config.emergencyThreshold) {
      newLevel = "emergency";
    } else if (unavailableCount > 0) {
      newLevel = "degraded";
    }

    if (newLevel !== previousLevel) {
      this.state.level = newLevel;
      this.state.startedAt = newLevel === "normal" ? undefined : new Date();
      this.state.reason = unavailableCount > 0
        ? `${unavailableCount} service(s) unavailable`
        : undefined;

      log.warn("Degradation level changed", {
        from: previousLevel,
        to: newLevel,
        unavailableCount,
      });
    }
  }

  /**
   * Get current degradation state.
   */
  getState(): DegradationState {
    return {
      ...this.state,
      services: new Map(this.state.services),
    };
  }

  /**
   * Get current degradation level.
   */
  getLevel(): DegradationLevel {
    return this.state.level;
  }

  /**
   * Check if a specific service is available.
   */
  isServiceAvailable(name: string): boolean {
    return this.state.services.get(name)?.available ?? true;
  }

  /**
   * Check if system is in emergency mode.
   */
  isEmergency(): boolean {
    return this.state.level === "emergency";
  }

  /**
   * Check if system is degraded.
   */
  isDegraded(): boolean {
    return this.state.level !== "normal";
  }

  /**
   * Manually mark a service as unavailable.
   */
  markServiceUnavailable(name: string, reason: string): void {
    this.updateServiceStatus(name, false, reason);
    this.updateDegradationLevel();
  }

  /**
   * Manually mark a service as available.
   */
  markServiceAvailable(name: string): void {
    this.updateServiceStatus(name, true);
    this.updateDegradationLevel();
  }
}

// ─── GLOBAL DEGRADATION MANAGER ─────────────────────────────

let globalManager: DegradationManager | undefined;

/**
 * Get or create the global degradation manager.
 */
export function getDegradationManager(config?: Partial<DegradationConfig>): DegradationManager {
  if (!globalManager) {
    globalManager = new DegradationManager(config);
  }
  return globalManager;
}

/**
 * Reset the global degradation manager.
 */
export function resetDegradationManager(): void {
  if (globalManager) {
    globalManager.stopMonitoring();
    globalManager = undefined;
  }
}

// ─── FALLBACK UTILITIES ─────────────────────────────────────

/**
 * Execute with fallback on error.
 */
export async function withFallback<T>(
  primary: () => Promise<T>,
  fallback: () => Promise<T>,
  serviceName: string
): Promise<T> {
  try {
    return await primary();
  } catch (error) {
    log.warn("Primary operation failed, using fallback", {
      service: serviceName,
      error: error instanceof Error ? error.message : String(error),
    });
    return fallback();
  }
}

/**
 * Execute with cached fallback.
 */
export async function withCachedFallback<T>(
  primary: () => Promise<T>,
  getCache: () => T | undefined,
  serviceName: string
): Promise<T> {
  try {
    return await primary();
  } catch (error) {
    const cached = getCache();
    if (cached !== undefined) {
      log.warn("Using cached value due to primary failure", {
        service: serviceName,
        error: error instanceof Error ? error.message : String(error),
      });
      return cached;
    }
    throw error;
  }
}

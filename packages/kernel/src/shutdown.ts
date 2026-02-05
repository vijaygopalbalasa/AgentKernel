// Graceful shutdown handler for clean process termination
// Ensures all connections are closed and resources released

import type { Logger } from "./logger.js";

/** Shutdown handler function */
export type ShutdownHandler = () => void | Promise<void>;

/** Shutdown options */
export interface ShutdownOptions {
  /** Timeout before forced exit (ms) */
  timeoutMs?: number;
  /** Logger instance */
  logger?: Logger;
  /** Exit code on timeout */
  timeoutExitCode?: number;
  /** Exit code on error */
  errorExitCode?: number;
  /** Signals to handle */
  signals?: NodeJS.Signals[];
}

/** Shutdown manager state */
export interface ShutdownManager {
  /** Register a shutdown handler */
  register(name: string, handler: ShutdownHandler, priority?: number): void;

  /** Unregister a shutdown handler */
  unregister(name: string): void;

  /** Manually trigger shutdown */
  shutdown(reason?: string): Promise<void>;

  /** Check if shutdown is in progress */
  isShuttingDown(): boolean;

  /** Get registered handler names */
  getHandlers(): string[];
}

/** Default shutdown options */
const DEFAULT_OPTIONS: Required<ShutdownOptions> = {
  timeoutMs: 30000,
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    trace: () => {},
    fatal: () => {},
    child: function () {
      return this;
    },
    level: "info",
    flush: () => {},
  },
  timeoutExitCode: 1,
  errorExitCode: 1,
  signals: ["SIGTERM", "SIGINT", "SIGHUP"],
};

/** Create a shutdown manager */
export function createShutdownManager(options: ShutdownOptions = {}): ShutdownManager {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const log = opts.logger;

  // Handlers sorted by priority (higher runs first)
  const handlers = new Map<string, { handler: ShutdownHandler; priority: number }>();
  let shuttingDown = false;
  let signalHandlersRegistered = false;

  /** Run all shutdown handlers in priority order */
  async function runHandlers(reason: string): Promise<void> {
    if (shuttingDown) {
      log.warn("Shutdown already in progress");
      return;
    }

    shuttingDown = true;
    log.info("Starting graceful shutdown", { reason });

    // Sort handlers by priority (descending)
    const sortedHandlers = Array.from(handlers.entries()).sort(
      (a, b) => b[1].priority - a[1].priority,
    );

    const startTime = Date.now();

    for (const [name, { handler }] of sortedHandlers) {
      const elapsed = Date.now() - startTime;
      const remaining = opts.timeoutMs - elapsed;

      if (remaining <= 0) {
        log.warn("Shutdown timeout reached, skipping remaining handlers", {
          skipped: sortedHandlers
            .slice(sortedHandlers.indexOf([name, { handler, priority: 0 }]))
            .map(([n]) => n),
        });
        break;
      }

      try {
        log.debug("Running shutdown handler", { name });
        const handlerStart = Date.now();

        await Promise.race([
          Promise.resolve(handler()),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error(`Handler ${name} timed out`)), remaining),
          ),
        ]);

        log.debug("Shutdown handler completed", { name, durationMs: Date.now() - handlerStart });
      } catch (error) {
        log.error("Shutdown handler failed", { name, error: String(error) });
      }
    }

    const totalDuration = Date.now() - startTime;
    log.info("Graceful shutdown completed", { durationMs: totalDuration });
  }

  /** Handle shutdown signal */
  function handleSignal(signal: NodeJS.Signals) {
    log.info("Received shutdown signal", { signal });
    runHandlers(signal)
      .then(() => {
        process.exit(0);
      })
      .catch((error) => {
        log.error("Shutdown error", { error: String(error) });
        process.exit(opts.errorExitCode);
      });
  }

  /** Register signal handlers */
  function registerSignalHandlers() {
    if (signalHandlersRegistered) return;

    for (const signal of opts.signals) {
      process.on(signal, () => handleSignal(signal));
    }

    // Handle uncaught exceptions
    process.on("uncaughtException", (error) => {
      log.fatal("Uncaught exception", { error: String(error), stack: error.stack });
      runHandlers("uncaughtException").finally(() => process.exit(opts.errorExitCode));
    });

    // Handle unhandled promise rejections
    process.on("unhandledRejection", (reason) => {
      log.fatal("Unhandled rejection", { reason: String(reason) });
      runHandlers("unhandledRejection").finally(() => process.exit(opts.errorExitCode));
    });

    signalHandlersRegistered = true;
    log.debug("Signal handlers registered", { signals: opts.signals });
  }

  const manager: ShutdownManager = {
    register(name: string, handler: ShutdownHandler, priority = 0): void {
      handlers.set(name, { handler, priority });
      log.debug("Shutdown handler registered", { name, priority });

      // Register signal handlers on first handler registration
      if (!signalHandlersRegistered) {
        registerSignalHandlers();
      }
    },

    unregister(name: string): void {
      handlers.delete(name);
      log.debug("Shutdown handler unregistered", { name });
    },

    async shutdown(reason = "manual"): Promise<void> {
      await runHandlers(reason);
    },

    isShuttingDown(): boolean {
      return shuttingDown;
    },

    getHandlers(): string[] {
      return Array.from(handlers.keys());
    },
  };

  return manager;
}

/** Predefined shutdown priorities */
export const SHUTDOWN_PRIORITIES = {
  /** Highest priority - run first (e.g., stop accepting new requests) */
  IMMEDIATE: 100,
  /** High priority - run early (e.g., finish current requests) */
  HIGH: 75,
  /** Normal priority - run in middle (e.g., save state) */
  NORMAL: 50,
  /** Low priority - run late (e.g., close connections) */
  LOW: 25,
  /** Lowest priority - run last (e.g., cleanup, logging) */
  FINAL: 0,
} as const;

/** Create a shutdown handler that waits for pending operations */
export function createDrainHandler(
  name: string,
  getPendingCount: () => number,
  options: {
    checkIntervalMs?: number;
    maxWaitMs?: number;
    logger?: Logger;
  } = {},
): ShutdownHandler {
  const { checkIntervalMs = 100, maxWaitMs = 10000, logger } = options;

  return async () => {
    const startTime = Date.now();

    while (getPendingCount() > 0) {
      const elapsed = Date.now() - startTime;
      if (elapsed >= maxWaitMs) {
        const msg = `Max wait time reached with ${getPendingCount()} pending operations`;
        if (logger) {
          logger.warn(msg, { name, pending: getPendingCount(), maxWaitMs });
        }
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, checkIntervalMs));
    }
  };
}

/** Global shutdown manager instance */
let globalShutdownManager: ShutdownManager | null = null;

/** Get or create the global shutdown manager */
export function getShutdownManager(options?: ShutdownOptions): ShutdownManager {
  if (!globalShutdownManager) {
    globalShutdownManager = createShutdownManager(options);
  }
  return globalShutdownManager;
}

/** Register a shutdown handler with the global manager */
export function onShutdown(
  name: string,
  handler: ShutdownHandler,
  priority: number = SHUTDOWN_PRIORITIES.NORMAL,
): void {
  getShutdownManager().register(name, handler, priority);
}

/** Trigger shutdown programmatically */
export async function shutdown(reason = "manual"): Promise<void> {
  await getShutdownManager().shutdown(reason);
}

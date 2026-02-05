// Structured logging with pino — production-quality implementation
// Supports: child loggers, log levels, pretty printing, file output

import pino, { type Logger as PinoLogger, type LoggerOptions } from "pino";
import type { LoggingConfig } from "./config.js";

/** Log context data */
export interface LogContext {
  [key: string]: unknown;
}

/** Logger interface that our code uses */
export interface Logger {
  trace(msg: string, context?: LogContext): void;
  debug(msg: string, context?: LogContext): void;
  info(msg: string, context?: LogContext): void;
  warn(msg: string, context?: LogContext): void;
  error(msg: string, context?: LogContext): void;
  fatal(msg: string, context?: LogContext): void;
  child(bindings: LogContext): Logger;
  level: string;
  flush(): void;
}

/** Wrap pino logger to match our interface */
function wrapPinoLogger(pinoLogger: PinoLogger): Logger {
  return {
    trace: (msg, ctx) => (ctx ? pinoLogger.trace(ctx, msg) : pinoLogger.trace(msg)),
    debug: (msg, ctx) => (ctx ? pinoLogger.debug(ctx, msg) : pinoLogger.debug(msg)),
    info: (msg, ctx) => (ctx ? pinoLogger.info(ctx, msg) : pinoLogger.info(msg)),
    warn: (msg, ctx) => (ctx ? pinoLogger.warn(ctx, msg) : pinoLogger.warn(msg)),
    error: (msg, ctx) => (ctx ? pinoLogger.error(ctx, msg) : pinoLogger.error(msg)),
    fatal: (msg, ctx) => (ctx ? pinoLogger.fatal(ctx, msg) : pinoLogger.fatal(msg)),
    child: (bindings) => wrapPinoLogger(pinoLogger.child(bindings)),
    get level() {
      return pinoLogger.level;
    },
    flush: () => pinoLogger.flush(),
  };
}

/** Logger options for creating new loggers */
export interface CreateLoggerOptions {
  /** Logger name (appears in logs) */
  name: string;
  /** Log level */
  level?: LoggingConfig["level"];
  /** Enable pretty printing for development */
  pretty?: boolean;
  /** File path for log output */
  file?: string;
  /** Additional bindings for all log entries */
  bindings?: LogContext;
}

/** Global root logger instance */
let rootLogger: PinoLogger | null = null;

/** Initialize the root logger with configuration */
export function initLogger(config: LoggingConfig): Logger {
  // Set up transport for pretty printing or file output
  const transports: pino.TransportTargetOptions[] = [];

  if (config.pretty) {
    transports.push({
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:HH:MM:ss.l",
        ignore: "pid,hostname",
        messageFormat: "{name} | {msg}",
      },
    });
  } else {
    transports.push({
      target: "pino/file",
      options: { destination: 1 }, // stdout
    });
  }

  if (config.file) {
    transports.push({
      target: "pino/file",
      options: { destination: config.file },
    });
  }

  // When using transports, pino doesn't allow custom formatters
  // So we use a simpler configuration with transports
  if (transports.length > 0) {
    rootLogger = pino({
      name: "agentkernel",
      level: config.level,
      timestamp: pino.stdTimeFunctions.isoTime,
      base: {
        env: process.env.NODE_ENV ?? "development",
      },
      transport: {
        targets: transports,
      },
    });
  } else {
    // Without transports, we can use full configuration
    rootLogger = pino({
      name: "agentkernel",
      level: config.level,
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label) => ({ level: label }),
        bindings: (bindings) => ({
          pid: bindings.pid,
          hostname: bindings.hostname,
          name: bindings.name,
        }),
      },
      base: {
        env: process.env.NODE_ENV ?? "development",
      },
    });
  }

  return wrapPinoLogger(rootLogger);
}

/** Create a child logger from the root logger */
export function createLogger(options: CreateLoggerOptions): Logger {
  if (!rootLogger) {
    // Initialize with defaults if not already initialized
    rootLogger = pino({
      name: "agentkernel",
      level: process.env.LOG_LEVEL ?? options.level ?? "info",
      timestamp: pino.stdTimeFunctions.isoTime,
    });
  }

  const childLogger = rootLogger.child({
    component: options.name,
    ...options.bindings,
  });

  if (options.level) {
    childLogger.level = options.level;
  }

  return wrapPinoLogger(childLogger);
}

/** Get the root logger (initializes with defaults if not set) */
export function getLogger(): Logger {
  if (!rootLogger) {
    rootLogger = pino({
      name: "agentkernel",
      level: process.env.LOG_LEVEL ?? "info",
      timestamp: pino.stdTimeFunctions.isoTime,
    });
  }
  return wrapPinoLogger(rootLogger);
}

/** Flush all pending log writes */
export function flushLogs(): void {
  rootLogger?.flush();
}

/** Shutdown logging (flush and close) */
export async function shutdownLogger(): Promise<void> {
  if (rootLogger) {
    rootLogger.flush();
    // Give time for async transports to flush
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Log levels in order of verbosity */
export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Check if a level is enabled */
export function isLevelEnabled(logger: Logger, level: LogLevel): boolean {
  const currentIndex = LOG_LEVELS.indexOf(logger.level as LogLevel);
  const checkIndex = LOG_LEVELS.indexOf(level);
  return checkIndex >= currentIndex;
}

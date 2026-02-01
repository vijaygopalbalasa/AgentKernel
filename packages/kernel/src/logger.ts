import type { Logger, LogLevel } from "@agent-os/shared";

/** Creates a structured logger instance */
export function createLogger(name: string, level: LogLevel = "info"): Logger {
  const levels: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  const currentLevel = levels[level];

  const log = (msgLevel: LogLevel, message: string, context?: Record<string, unknown>) => {
    if (levels[msgLevel] >= currentLevel) {
      const entry = {
        timestamp: new Date().toISOString(),
        level: msgLevel,
        name,
        message,
        ...context,
      };
      const output = msgLevel === "error" ? console.error : console.log;
      output(JSON.stringify(entry));
    }
  };

  return {
    debug: (msg, ctx) => log("debug", msg, ctx),
    info: (msg, ctx) => log("info", msg, ctx),
    warn: (msg, ctx) => log("warn", msg, ctx),
    error: (msg, ctx) => log("error", msg, ctx),
  };
}

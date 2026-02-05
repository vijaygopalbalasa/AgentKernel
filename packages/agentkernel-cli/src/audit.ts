// OpenClaw Audit Logger — logs all security events for OpenClaw operations

import { z } from "zod";

// ─── AUDIT EVENT SCHEMAS ───────────────────────────────────────

/** OpenClaw audit event types */
export const OpenClawEventTypeSchema = z.enum([
  "proxy_started",
  "proxy_stopped",
  "client_connected",
  "client_disconnected",
  "client_error",
  "gateway_error",
  "gateway_connection_failed",
  "tool_intercepted",
  "tool_blocked",
  "tool_allowed",
  "approval_requested",
  "approval_granted",
  "approval_denied",
  "rate_limited",
  "message_processing_error",
  "send_error",
]);
export type OpenClawEventType = z.infer<typeof OpenClawEventTypeSchema>;

/** OpenClaw audit event */
export interface OpenClawAuditEvent {
  /** Event type */
  type: OpenClawEventType;
  /** Timestamp */
  timestamp: Date;
  /** Agent ID */
  agentId: string;
  /** Session ID (if applicable) */
  sessionId?: string;
  /** Tool name (if applicable) */
  toolName?: string;
  /** Policy decision (if applicable) */
  decision?: "allow" | "block" | "approve" | "unknown";
  /** Reason for decision */
  reason?: string;
  /** Additional details */
  details?: Record<string, unknown>;
}

/** Audit sink interface */
export interface OpenClawAuditSink {
  write(event: OpenClawAuditEvent): void | Promise<void>;
  flush?(): void | Promise<void>;
  close?(): void | Promise<void>;
}

// ─── AUDIT SINKS ───────────────────────────────────────────────

/** Console audit sink */
export class ConsoleOpenClawAuditSink implements OpenClawAuditSink {
  write(event: OpenClawAuditEvent): void {
    const timestamp = event.timestamp.toISOString();
    const tool = event.toolName ? ` [${event.toolName}]` : "";
    const decision = event.decision ? ` → ${event.decision.toUpperCase()}` : "";
    const reason = event.reason ? `: ${event.reason}` : "";

    const color = this.getColor(event);
    const reset = "\x1b[0m";

    console.log(
      `${color}[${timestamp}] [OpenClaw] ${event.type}${tool}${decision}${reason}${reset}`
    );

    if (event.details && Object.keys(event.details).length > 0) {
      console.log(`  Details: ${JSON.stringify(event.details)}`);
    }
  }

  private getColor(event: OpenClawAuditEvent): string {
    switch (event.decision) {
      case "block":
        return "\x1b[31m"; // Red
      case "allow":
        return "\x1b[32m"; // Green
      case "approve":
        return "\x1b[33m"; // Yellow
      default:
        return "\x1b[36m"; // Cyan
    }
  }
}

/** Memory audit sink for testing */
export class MemoryOpenClawAuditSink implements OpenClawAuditSink {
  private events: OpenClawAuditEvent[] = [];
  private readonly maxEvents: number;

  constructor(maxEvents: number = 10000) {
    this.maxEvents = maxEvents;
  }

  write(event: OpenClawAuditEvent): void {
    this.events.push(event);
    while (this.events.length > this.maxEvents) {
      this.events.shift();
    }
  }

  getEvents(): OpenClawAuditEvent[] {
    return [...this.events];
  }

  getByType(type: OpenClawEventType): OpenClawAuditEvent[] {
    return this.events.filter((e) => e.type === type);
  }

  getByDecision(decision: "allow" | "block" | "approve"): OpenClawAuditEvent[] {
    return this.events.filter((e) => e.decision === decision);
  }

  clear(): void {
    this.events = [];
  }

  get count(): number {
    return this.events.length;
  }
}

/** File audit sink */
export class FileOpenClawAuditSink implements OpenClawAuditSink {
  private buffer: OpenClawAuditEvent[] = [];
  private readonly filePath: string;
  private readonly flushIntervalMs: number;
  private readonly maxBufferSize: number;
  private flushTimer: NodeJS.Timeout | null = null;
  private writePromise: Promise<void> = Promise.resolve();
  private dirEnsured = false;

  constructor(
    filePath: string,
    options: {
      flushIntervalMs?: number;
      maxBufferSize?: number;
    } = {}
  ) {
    this.filePath = filePath;
    this.flushIntervalMs = options.flushIntervalMs ?? 5000;
    this.maxBufferSize = options.maxBufferSize ?? 100;

    if (this.flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => {
        this.flush().catch(() => {});
      }, this.flushIntervalMs);
    }
  }

  write(event: OpenClawAuditEvent): void {
    this.buffer.push(event);
    if (this.buffer.length >= this.maxBufferSize) {
      this.flush().catch(() => {});
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const toWrite = this.buffer;
    this.buffer = [];

    this.writePromise = this.writePromise.then(async () => {
      const { appendFile, mkdir } = await import("fs/promises");
      const { dirname } = await import("path");

      if (!this.dirEnsured) {
        await mkdir(dirname(this.filePath), { recursive: true });
        this.dirEnsured = true;
      }

      const lines = toWrite.map((e) => JSON.stringify(e)).join("\n") + "\n";
      await appendFile(this.filePath, lines, "utf-8");
    });

    await this.writePromise;
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }
}

// ─── AUDIT LOGGER ──────────────────────────────────────────────

/** Audit logger configuration */
export interface OpenClawAuditLoggerConfig {
  sinks: OpenClawAuditSink[];
}

/**
 * OpenClaw Audit Logger — logs all security events.
 */
export class OpenClawAuditLogger {
  private readonly sinks: OpenClawAuditSink[];

  constructor(config: OpenClawAuditLoggerConfig) {
    this.sinks = config.sinks;
  }

  /**
   * Log an audit event.
   */
  log(
    event: Omit<OpenClawAuditEvent, "timestamp">
  ): void {
    const fullEvent: OpenClawAuditEvent = {
      ...event,
      timestamp: new Date(),
    };

    for (const sink of this.sinks) {
      try {
        sink.write(fullEvent);
      } catch {
        // Don't crash on sink errors
      }
    }
  }

  /**
   * Flush all sinks.
   */
  async flush(): Promise<void> {
    await Promise.all(
      this.sinks.map(async (sink) => {
        if (sink.flush) {
          await sink.flush();
        }
      })
    );
  }

  /**
   * Close all sinks.
   */
  async close(): Promise<void> {
    await Promise.all(
      this.sinks.map(async (sink) => {
        if (sink.close) {
          await sink.close();
        }
      })
    );
  }
}

/**
 * Create an OpenClaw audit logger with default sinks.
 */
export function createOpenClawAuditLogger(
  options: {
    sinks?: OpenClawAuditSink[];
    logFile?: string;
    includeConsole?: boolean;
  } = {}
): OpenClawAuditLogger {
  const sinks: OpenClawAuditSink[] = options.sinks ?? [];

  // Add console sink by default
  if (options.includeConsole !== false) {
    sinks.push(new ConsoleOpenClawAuditSink());
  }

  // Add memory sink for programmatic access
  sinks.push(new MemoryOpenClawAuditSink());

  // Add file sink if specified
  if (options.logFile) {
    sinks.push(new FileOpenClawAuditSink(options.logFile));
  }

  return new OpenClawAuditLogger({ sinks });
}

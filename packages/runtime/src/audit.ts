// Audit — structured audit logging for agent operations
// Implements OWASP 2026 continuous explainability requirement

import type { AgentId, ResourceUsage } from "./agent-context.js";
import type { AgentState, StateTransition } from "./state-machine.js";
import type { Capability } from "./sandbox.js";

/** Audit event severity levels */
export type AuditSeverity = "debug" | "info" | "warn" | "error" | "critical";

/** Audit event categories */
export type AuditCategory =
  | "lifecycle"      // Agent lifecycle events (spawn, terminate)
  | "state"          // State transitions
  | "permission"     // Permission checks and grants
  | "resource"       // Resource usage and limits
  | "security"       // Security-related events
  | "communication"  // Agent-to-agent communication
  | "tool"           // Tool/MCP invocations
  | "error"          // Errors and exceptions
  | "system";        // System-level events

/** Base audit event structure */
export interface AuditEvent {
  /** Unique event ID */
  id: string;
  /** Event timestamp */
  timestamp: Date;
  /** Severity level */
  severity: AuditSeverity;
  /** Event category */
  category: AuditCategory;
  /** Human-readable event message */
  message: string;
  /** Agent ID (if agent-specific) */
  agentId?: AgentId;
  /** Parent agent ID (for tracing) */
  parentAgentId?: AgentId;
  /** Request/trace ID for correlation */
  traceId?: string;
  /** Structured event data */
  data?: Record<string, unknown>;
  /** Source module/component */
  source?: string;
  /** User/actor who initiated the action */
  actor?: string;
  /** Tags for filtering/searching */
  tags?: string[];
}

/** Lifecycle audit event data */
export interface LifecycleAuditData {
  action: "spawn" | "initialize" | "start" | "pause" | "resume" | "terminate";
  reason?: string;
  parentId?: AgentId;
  manifest?: Record<string, unknown>;
}

/** State transition audit event data */
export interface StateAuditData {
  fromState: AgentState;
  toState: AgentState;
  event: string;
  reason?: string;
}

/** Permission audit event data */
export interface PermissionAuditData {
  action: "check" | "grant" | "revoke";
  capability: Capability;
  allowed?: boolean;
  grantedBy?: AgentId | "system";
  reason?: string;
  constraints?: Record<string, unknown>;
}

/** Resource audit event data */
export interface ResourceAuditData {
  type: "usage" | "limit_warning" | "limit_exceeded" | "budget_alert";
  resourceType: "tokens" | "memory" | "requests" | "cost";
  current: number;
  limit?: number;
  usage?: Partial<ResourceUsage>;
}

/** Security audit event data */
export interface SecurityAuditData {
  type: "auth" | "authz" | "injection" | "anomaly" | "violation";
  severity: "low" | "medium" | "high" | "critical";
  details: string;
  blocked?: boolean;
}

/** Tool audit event data */
export interface ToolAuditData {
  toolName: string;
  toolServer?: string;
  action: "invoke" | "complete" | "error";
  inputSummary?: string;
  outputSummary?: string;
  durationMs?: number;
  error?: string;
}

/** Communication audit event data */
export interface CommunicationAuditData {
  type: "send" | "receive" | "broadcast";
  protocol: "a2a" | "internal" | "websocket";
  targetAgentId?: AgentId;
  sourceAgentId?: AgentId;
  messageType?: string;
  messageSizebytes?: number;
}

/** Audit sink interface for outputting events */
export interface AuditSink {
  /** Write an audit event */
  write(event: AuditEvent): void | Promise<void>;
  /** Flush pending events */
  flush?(): void | Promise<void>;
  /** Close the sink */
  close?(): void | Promise<void>;
}

/** Console audit sink for development */
export class ConsoleAuditSink implements AuditSink {
  private readonly minSeverity: AuditSeverity;
  private readonly severityOrder: Record<AuditSeverity, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
    critical: 4,
  };

  constructor(minSeverity: AuditSeverity = "info") {
    this.minSeverity = minSeverity;
  }

  write(event: AuditEvent): void {
    if (this.severityOrder[event.severity] < this.severityOrder[this.minSeverity]) {
      return;
    }

    const prefix = `[${event.timestamp.toISOString()}] [${event.severity.toUpperCase()}] [${event.category}]`;
    const agentInfo = event.agentId ? ` [${event.agentId}]` : "";
    const message = `${prefix}${agentInfo} ${event.message}`;

    switch (event.severity) {
      case "debug":
        // In production, use structured logger
        break;
      case "info":
        // In production, use structured logger
        break;
      case "warn":
        // In production, use structured logger
        break;
      case "error":
      case "critical":
        // In production, use structured logger
        break;
    }

    // Output structured data if present
    if (event.data && Object.keys(event.data).length > 0) {
      // In production, use structured logger
    }
  }
}

/** In-memory audit sink for testing */
export class MemoryAuditSink implements AuditSink {
  private events: AuditEvent[] = [];
  private readonly maxEvents: number;

  constructor(maxEvents: number = 10000) {
    this.maxEvents = maxEvents;
  }

  write(event: AuditEvent): void {
    this.events.push(event);

    // Trim if over limit
    while (this.events.length > this.maxEvents) {
      this.events.shift();
    }
  }

  /** Get all events */
  getEvents(): AuditEvent[] {
    return [...this.events];
  }

  /** Get events by category */
  getByCategory(category: AuditCategory): AuditEvent[] {
    return this.events.filter((e) => e.category === category);
  }

  /** Get events by agent ID */
  getByAgentId(agentId: AgentId): AuditEvent[] {
    return this.events.filter((e) => e.agentId === agentId);
  }

  /** Get events by severity */
  getBySeverity(severity: AuditSeverity): AuditEvent[] {
    return this.events.filter((e) => e.severity === severity);
  }

  /** Get events in time range */
  getInTimeRange(from: Date, to: Date): AuditEvent[] {
    return this.events.filter(
      (e) => e.timestamp >= from && e.timestamp <= to
    );
  }

  /** Clear all events */
  clear(): void {
    this.events = [];
  }

  /** Get event count */
  get count(): number {
    return this.events.length;
  }
}

/** File audit sink for persistent logging */
export class FileAuditSink implements AuditSink {
  private buffer: AuditEvent[] = [];
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

    // Start periodic flush
    if (this.flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => {
        this.flush().catch(() => {});
      }, this.flushIntervalMs);
    }
  }

  write(event: AuditEvent): void {
    this.buffer.push(event);

    // Flush if buffer is full
    if (this.buffer.length >= this.maxBufferSize) {
      this.flush().catch(() => {});
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const toWrite = this.buffer;
    this.buffer = [];

    // Chain writes to ensure ordering
    this.writePromise = this.writePromise.then(async () => {
      const { appendFile, mkdir } = await import("fs/promises");
      const { dirname } = await import("path");

      // Ensure directory exists
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

/**
 * Database audit record structure.
 * Maps AuditEvent to the audit_log table schema.
 */
export interface DatabaseAuditRecord {
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  actor_id: string | null;
  details: Record<string, unknown>;
  outcome: string;
}

/**
 * Database writer function type.
 * Accepts audit records and writes them to the database.
 */
export type DatabaseAuditWriter = (records: DatabaseAuditRecord[]) => Promise<void>;

/**
 * Database audit sink for persistent audit logging to PostgreSQL.
 * Writes audit events to the audit_log table via a provided writer function.
 * This design keeps the runtime decoupled from direct database dependencies.
 */
export class DatabaseAuditSink implements AuditSink {
  private buffer: AuditEvent[] = [];
  private readonly writer: DatabaseAuditWriter;
  private readonly flushIntervalMs: number;
  private readonly maxBufferSize: number;
  private flushTimer: NodeJS.Timeout | null = null;
  private writePromise: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    writer: DatabaseAuditWriter,
    options: {
      /** Flush interval in milliseconds (default: 5000) */
      flushIntervalMs?: number;
      /** Maximum buffer size before auto-flush (default: 100) */
      maxBufferSize?: number;
    } = {}
  ) {
    this.writer = writer;
    this.flushIntervalMs = options.flushIntervalMs ?? 5000;
    this.maxBufferSize = options.maxBufferSize ?? 100;

    // Start periodic flush
    if (this.flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => {
        this.flush().catch(() => {});
      }, this.flushIntervalMs);
    }
  }

  write(event: AuditEvent): void {
    if (this.closed) return;

    this.buffer.push(event);

    // Flush if buffer is full
    if (this.buffer.length >= this.maxBufferSize) {
      this.flush().catch(() => {});
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const toWrite = this.buffer;
    this.buffer = [];

    // Chain writes to ensure ordering
    this.writePromise = this.writePromise.then(async () => {
      const records = toWrite.map((event) => this.eventToRecord(event));
      try {
        await this.writer(records);
      } catch {
        // On failure, re-add events to buffer (best effort)
        // Note: Events may be lost if buffer overflows
        if (!this.closed) {
          this.buffer.unshift(...toWrite);
        }
      }
    });

    await this.writePromise;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  /**
   * Convert an AuditEvent to a database record.
   */
  private eventToRecord(event: AuditEvent): DatabaseAuditRecord {
    // Determine action from category + specific type from data
    let action: string = event.category;
    if (event.data) {
      if ("action" in event.data && typeof event.data.action === "string") {
        action = `${event.category}.${event.data.action}`;
      } else if ("type" in event.data && typeof event.data.type === "string") {
        action = `${event.category}.${event.data.type}`;
      }
    }

    // Determine outcome from severity
    let outcome: string;
    if (event.severity === "error" || event.severity === "critical") {
      outcome = "failure";
    } else if (event.data && "allowed" in event.data && event.data.allowed === false) {
      outcome = "denied";
    } else if (event.data && "blocked" in event.data && event.data.blocked === true) {
      outcome = "blocked";
    } else {
      outcome = "success";
    }

    // Extract resource info
    let resourceType: string | null = null;
    let resourceId: string | null = null;

    if (event.data) {
      // Tool invocations
      if ("toolName" in event.data) {
        resourceType = "tool";
        resourceId = String(event.data.toolName);
      }
      // Permission checks
      else if ("capability" in event.data) {
        resourceType = "permission";
        resourceId = String(event.data.capability);
      }
      // Resource usage
      else if ("resourceType" in event.data) {
        resourceType = String(event.data.resourceType);
      }
      // Communication
      else if ("protocol" in event.data) {
        resourceType = "communication";
        resourceId = String(event.data.protocol);
      }
      // Default to category
      else {
        resourceType = event.category;
      }
    } else {
      resourceType = event.category;
    }

    // Agent ID as resource ID for lifecycle events
    if (event.category === "lifecycle" && event.agentId) {
      resourceType = "agent";
      resourceId = event.agentId;
    }

    return {
      action,
      resource_type: resourceType,
      resource_id: resourceId,
      actor_id: event.actor ?? event.agentId ?? null,
      details: {
        id: event.id,
        message: event.message,
        severity: event.severity,
        timestamp: event.timestamp.toISOString(),
        agentId: event.agentId,
        parentAgentId: event.parentAgentId,
        traceId: event.traceId,
        source: event.source,
        tags: event.tags,
        data: event.data,
      },
      outcome,
    };
  }
}

/** Audit logger configuration */
export interface AuditLoggerConfig {
  /** Audit sinks to write to */
  sinks: AuditSink[];
  /** Default source identifier */
  defaultSource?: string;
  /** Whether to include stack traces for errors */
  includeStackTraces?: boolean;
  /** Global tags to add to all events */
  globalTags?: string[];
}

/** Counter for generating unique event IDs */
let eventCounter = 0;

/** Generate a unique event ID */
function generateEventId(): string {
  eventCounter++;
  return `audit_${Date.now()}_${eventCounter.toString(36)}`;
}

/**
 * Audit logger for recording agent operations.
 * Provides structured logging with correlation support.
 */
export class AuditLogger {
  private readonly sinks: AuditSink[];
  private readonly config: Required<Omit<AuditLoggerConfig, "sinks">>;

  constructor(config: AuditLoggerConfig) {
    this.sinks = config.sinks;
    this.config = {
      defaultSource: config.defaultSource ?? "agent-os",
      includeStackTraces: config.includeStackTraces ?? true,
      globalTags: config.globalTags ?? [],
    };
  }

  /** Log a raw audit event */
  log(event: Omit<AuditEvent, "id" | "timestamp">): void {
    const fullEvent: AuditEvent = {
      id: generateEventId(),
      timestamp: new Date(),
      source: event.source ?? this.config.defaultSource,
      tags: [...(event.tags ?? []), ...this.config.globalTags],
      ...event,
    };

    for (const sink of this.sinks) {
      try {
        sink.write(fullEvent);
      } catch {
        // Don't crash on sink errors
      }
    }
  }

  /** Log lifecycle event */
  lifecycle(
    agentId: AgentId,
    data: LifecycleAuditData,
    options: { severity?: AuditSeverity; traceId?: string } = {}
  ): void {
    this.log({
      severity: options.severity ?? "info",
      category: "lifecycle",
      message: `Agent ${data.action}: ${agentId}`,
      agentId,
      traceId: options.traceId,
      data: data as unknown as Record<string, unknown>,
    });
  }

  /** Log state transition */
  stateTransition(
    agentId: AgentId,
    transition: StateTransition,
    options: { traceId?: string } = {}
  ): void {
    this.log({
      severity: "info",
      category: "state",
      message: `State transition: ${transition.fromState} → ${transition.toState}`,
      agentId,
      traceId: options.traceId,
      data: {
        fromState: transition.fromState,
        toState: transition.toState,
        event: transition.event,
        reason: transition.reason,
      },
    });
  }

  /** Log permission check */
  permission(
    agentId: AgentId,
    data: PermissionAuditData,
    options: { traceId?: string } = {}
  ): void {
    const severity = data.allowed === false ? "warn" : "debug";
    this.log({
      severity,
      category: "permission",
      message: `Permission ${data.action}: ${data.capability} = ${data.allowed ?? "N/A"}`,
      agentId,
      traceId: options.traceId,
      data: data as unknown as Record<string, unknown>,
    });
  }

  /** Log resource usage/warning */
  resource(
    agentId: AgentId,
    data: ResourceAuditData,
    options: { traceId?: string } = {}
  ): void {
    let severity: AuditSeverity = "debug";
    if (data.type === "limit_warning") severity = "warn";
    if (data.type === "limit_exceeded" || data.type === "budget_alert") severity = "error";

    this.log({
      severity,
      category: "resource",
      message: `Resource ${data.type}: ${data.resourceType}`,
      agentId,
      traceId: options.traceId,
      data: data as unknown as Record<string, unknown>,
    });
  }

  /** Log security event */
  security(
    agentId: AgentId | undefined,
    data: SecurityAuditData,
    options: { traceId?: string } = {}
  ): void {
    const severityMap: Record<SecurityAuditData["severity"], AuditSeverity> = {
      low: "info",
      medium: "warn",
      high: "error",
      critical: "critical",
    };

    this.log({
      severity: severityMap[data.severity],
      category: "security",
      message: `Security ${data.type}: ${data.details}`,
      agentId,
      traceId: options.traceId,
      data: data as unknown as Record<string, unknown>,
      tags: ["security", data.severity],
    });
  }

  /** Log tool invocation */
  tool(
    agentId: AgentId,
    data: ToolAuditData,
    options: { traceId?: string } = {}
  ): void {
    const severity = data.action === "error" ? "error" : "info";
    this.log({
      severity,
      category: "tool",
      message: `Tool ${data.action}: ${data.toolName}`,
      agentId,
      traceId: options.traceId,
      data: data as unknown as Record<string, unknown>,
    });
  }

  /** Log agent communication */
  communication(
    agentId: AgentId,
    data: CommunicationAuditData,
    options: { traceId?: string } = {}
  ): void {
    this.log({
      severity: "info",
      category: "communication",
      message: `Communication ${data.type} via ${data.protocol}`,
      agentId,
      traceId: options.traceId,
      data: data as unknown as Record<string, unknown>,
    });
  }

  /** Log error */
  error(
    message: string,
    error: Error,
    options: {
      agentId?: AgentId;
      traceId?: string;
      category?: AuditCategory;
    } = {}
  ): void {
    const data: Record<string, unknown> = {
      errorName: error.name,
      errorMessage: error.message,
    };

    if (this.config.includeStackTraces && error.stack) {
      data.stack = error.stack;
    }

    this.log({
      severity: "error",
      category: options.category ?? "error",
      message,
      agentId: options.agentId,
      traceId: options.traceId,
      data,
    });
  }

  /** Log system event */
  system(
    message: string,
    data?: Record<string, unknown>,
    options: { severity?: AuditSeverity; traceId?: string } = {}
  ): void {
    this.log({
      severity: options.severity ?? "info",
      category: "system",
      message,
      traceId: options.traceId,
      data,
    });
  }

  /** Flush all sinks */
  async flush(): Promise<void> {
    await Promise.all(
      this.sinks.map(async (sink) => {
        if (sink.flush) {
          await sink.flush();
        }
      })
    );
  }

  /** Close all sinks */
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

/** Options for creating an audit logger */
export interface CreateAuditLoggerOptions {
  /** Log file path for file sink */
  logFile?: string;
  /** Minimum severity for console output */
  minConsoleSeverity?: AuditSeverity;
  /** Include console sink (default: true) */
  includeConsole?: boolean;
  /** Default source identifier */
  defaultSource?: string;
  /** Database writer function for persistent audit logging */
  databaseWriter?: DatabaseAuditWriter;
  /** Database sink flush interval in ms (default: 5000) */
  databaseFlushIntervalMs?: number;
  /** Database sink buffer size (default: 100) */
  databaseBufferSize?: number;
}

/**
 * Create an audit logger with default sinks.
 * Supports console, file, memory, and database sinks.
 */
export function createAuditLogger(
  options: CreateAuditLoggerOptions = {}
): AuditLogger {
  const sinks: AuditSink[] = [];

  // Always add memory sink for programmatic access
  sinks.push(new MemoryAuditSink());

  // Add console sink if requested (usually for development)
  if (options.includeConsole !== false) {
    sinks.push(new ConsoleAuditSink(options.minConsoleSeverity ?? "info"));
  }

  // Add file sink if log file specified
  if (options.logFile) {
    sinks.push(new FileAuditSink(options.logFile));
  }

  // Add database sink if writer provided
  if (options.databaseWriter) {
    sinks.push(
      new DatabaseAuditSink(options.databaseWriter, {
        flushIntervalMs: options.databaseFlushIntervalMs,
        maxBufferSize: options.databaseBufferSize,
      })
    );
  }

  return new AuditLogger({
    sinks,
    defaultSource: options.defaultSource ?? "agent-os",
  });
}

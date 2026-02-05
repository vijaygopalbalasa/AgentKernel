// Distributed Tracing
// Provides trace/span context propagation for observability

import { z } from "zod";
import { createLogger } from "./logger.js";

const log = createLogger({ name: "tracing" });

// ─── TYPES ──────────────────────────────────────────────────

export interface SpanContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  sampled: boolean;
}

export interface SpanData {
  name: string;
  context: SpanContext;
  startTime: number;
  endTime?: number;
  status: "ok" | "error" | "unset";
  attributes: Record<string, string | number | boolean>;
  events: SpanEvent[];
}

export interface SpanEvent {
  name: string;
  timestamp: number;
  attributes?: Record<string, string | number | boolean>;
}

export const TracingConfigSchema = z.object({
  enabled: z.boolean().optional().default(true),
  serviceName: z.string().optional().default("agentkernel"),
  serviceVersion: z.string().optional().default("0.1.0"),
  sampleRate: z.number().min(0).max(1).optional().default(1.0),
  exporterUrl: z.string().url().optional(),
  maxSpansPerTrace: z.number().min(1).optional().default(1000),
  /** Additional resource attributes for the OTLP exporter */
  resourceAttributes: z.record(z.string()).optional(),
  /** Batch export interval in milliseconds */
  batchExportIntervalMs: z.number().min(100).optional().default(5000),
  /** Maximum batch size for export */
  maxExportBatchSize: z.number().min(1).optional().default(512),
});

export type TracingConfig = z.infer<typeof TracingConfigSchema>;

// ─── SPAN CLASS ──────────────────────────────────────────────

/**
 * Represents a single span in a trace.
 */
export class Span {
  private data: SpanData;
  private ended = false;

  constructor(
    name: string,
    context: SpanContext,
    private onEnd?: (span: Span) => void,
  ) {
    this.data = {
      name,
      context,
      startTime: performance.now(),
      status: "unset",
      attributes: {},
      events: [],
    };
  }

  /**
   * Get span context.
   */
  get context(): SpanContext {
    return { ...this.data.context };
  }

  /**
   * Get span name.
   */
  get name(): string {
    return this.data.name;
  }

  /**
   * Get trace ID.
   */
  get traceId(): string {
    return this.data.context.traceId;
  }

  /**
   * Get span ID.
   */
  get spanId(): string {
    return this.data.context.spanId;
  }

  /**
   * Set an attribute on the span.
   */
  setAttribute(key: string, value: string | number | boolean): this {
    if (!this.ended) {
      this.data.attributes[key] = value;
    }
    return this;
  }

  /**
   * Set multiple attributes.
   */
  setAttributes(attributes: Record<string, string | number | boolean>): this {
    if (!this.ended) {
      Object.assign(this.data.attributes, attributes);
    }
    return this;
  }

  /**
   * Add an event to the span.
   */
  addEvent(name: string, attributes?: Record<string, string | number | boolean>): this {
    if (!this.ended) {
      this.data.events.push({
        name,
        timestamp: performance.now(),
        attributes,
      });
    }
    return this;
  }

  /**
   * Set status to OK.
   */
  setStatusOk(): this {
    if (!this.ended) {
      this.data.status = "ok";
    }
    return this;
  }

  /**
   * Set status to error.
   */
  setStatusError(message?: string): this {
    if (!this.ended) {
      this.data.status = "error";
      if (message) {
        this.setAttribute("error.message", message);
      }
    }
    return this;
  }

  /**
   * Record an exception.
   */
  recordException(error: Error): this {
    if (!this.ended) {
      this.setStatusError(error.message);
      this.addEvent("exception", {
        "exception.type": error.name,
        "exception.message": error.message,
        "exception.stacktrace": error.stack ?? "",
      });
    }
    return this;
  }

  /**
   * End the span.
   */
  end(): void {
    if (this.ended) return;

    this.data.endTime = performance.now();
    this.ended = true;

    if (this.data.status === "unset") {
      this.data.status = "ok";
    }

    if (this.onEnd) {
      this.onEnd(this);
    }
  }

  /**
   * Get span duration in milliseconds.
   */
  get duration(): number | undefined {
    if (!this.data.endTime) return undefined;
    return this.data.endTime - this.data.startTime;
  }

  /**
   * Check if span has ended.
   */
  get isEnded(): boolean {
    return this.ended;
  }

  /**
   * Get span data.
   */
  getData(): SpanData {
    return { ...this.data };
  }
}

// ─── TRACER ──────────────────────────────────────────────────

/**
 * Tracer for creating spans.
 */
export class Tracer {
  private config: TracingConfig;
  private activeSpans: Map<string, Span> = new Map();
  private completedSpans: SpanData[] = [];
  private exportInterval?: ReturnType<typeof setInterval>;

  constructor(config: Partial<TracingConfig> = {}) {
    this.config = TracingConfigSchema.parse(config);
  }

  /**
   * Start a new root span.
   */
  startSpan(name: string, parentContext?: SpanContext): Span {
    if (!this.config.enabled || !this.shouldSample()) {
      return new NoopSpan(name);
    }

    const context: SpanContext = {
      traceId: parentContext?.traceId ?? this.generateTraceId(),
      spanId: this.generateSpanId(),
      parentSpanId: parentContext?.spanId,
      sampled: true,
    };

    const span = new Span(name, context, (completedSpan) => {
      this.onSpanEnd(completedSpan);
    });

    this.activeSpans.set(context.spanId, span);
    return span;
  }

  /**
   * Start a child span.
   */
  startChildSpan(name: string, parent: Span): Span {
    return this.startSpan(name, parent.context);
  }

  /**
   * Run a function with a span.
   */
  async trace<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    parentContext?: SpanContext,
  ): Promise<T> {
    const span = this.startSpan(name, parentContext);
    try {
      const result = await fn(span);
      span.setStatusOk();
      return result;
    } catch (error) {
      if (error instanceof Error) {
        span.recordException(error);
      } else {
        span.setStatusError(String(error));
      }
      throw error;
    } finally {
      span.end();
    }
  }

  /**
   * Run a sync function with a span.
   */
  traceSync<T>(name: string, fn: (span: Span) => T, parentContext?: SpanContext): T {
    const span = this.startSpan(name, parentContext);
    try {
      const result = fn(span);
      span.setStatusOk();
      return result;
    } catch (error) {
      if (error instanceof Error) {
        span.recordException(error);
      } else {
        span.setStatusError(String(error));
      }
      throw error;
    } finally {
      span.end();
    }
  }

  /**
   * Get all completed spans.
   */
  getCompletedSpans(): SpanData[] {
    return [...this.completedSpans];
  }

  /**
   * Clear completed spans.
   */
  clearCompletedSpans(): void {
    this.completedSpans = [];
  }

  /**
   * Get active span count.
   */
  get activeSpanCount(): number {
    return this.activeSpans.size;
  }

  /**
   * Start periodic export.
   */
  startExport(intervalMs?: number): void {
    if (this.exportInterval) return;

    const interval = intervalMs ?? this.config.batchExportIntervalMs;
    this.exportInterval = setInterval(() => {
      this.export().catch((e) => {
        log.error("Failed to export traces", { error: e });
      });
    }, interval);
  }

  /**
   * Stop periodic export.
   */
  stopExport(): void {
    if (this.exportInterval) {
      clearInterval(this.exportInterval);
      this.exportInterval = undefined;
    }
  }

  /**
   * Export completed spans.
   */
  async export(): Promise<void> {
    if (!this.config.exporterUrl || this.completedSpans.length === 0) {
      return;
    }

    const spans = this.completedSpans;
    this.completedSpans = [];

    try {
      // Convert to OTLP-compatible format
      const resourceAttrs = [
        { key: "service.name", value: { stringValue: this.config.serviceName } },
        { key: "service.version", value: { stringValue: this.config.serviceVersion } },
        { key: "telemetry.sdk.name", value: { stringValue: "agentkernel-tracing" } },
        { key: "telemetry.sdk.language", value: { stringValue: "nodejs" } },
      ];
      if (this.config.resourceAttributes) {
        for (const [key, val] of Object.entries(this.config.resourceAttributes)) {
          resourceAttrs.push({ key, value: { stringValue: val } });
        }
      }
      const payload = {
        resourceSpans: [
          {
            resource: {
              attributes: resourceAttrs,
            },
            scopeSpans: [
              {
                spans: spans.map((span) => ({
                  traceId: span.context.traceId,
                  spanId: span.context.spanId,
                  parentSpanId: span.context.parentSpanId,
                  name: span.name,
                  startTimeUnixNano: span.startTime * 1e6,
                  endTimeUnixNano: (span.endTime ?? span.startTime) * 1e6,
                  status: { code: span.status === "error" ? 2 : 1 },
                  attributes: Object.entries(span.attributes).map(([key, value]) => ({
                    key,
                    value:
                      typeof value === "string"
                        ? { stringValue: value }
                        : typeof value === "number"
                          ? { intValue: value }
                          : { boolValue: value },
                  })),
                  events: span.events.map((event) => ({
                    name: event.name,
                    timeUnixNano: event.timestamp * 1e6,
                    attributes: event.attributes
                      ? Object.entries(event.attributes).map(([key, value]) => ({
                          key,
                          value:
                            typeof value === "string"
                              ? { stringValue: value }
                              : typeof value === "number"
                                ? { intValue: value }
                                : { boolValue: value },
                        }))
                      : [],
                  })),
                })),
              },
            ],
          },
        ],
      };

      await fetch(this.config.exporterUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      log.debug("Exported traces", { count: spans.length });
    } catch (error) {
      // Put spans back for retry
      this.completedSpans = [...spans, ...this.completedSpans];
      throw error;
    }
  }

  private onSpanEnd(span: Span): void {
    this.activeSpans.delete(span.spanId);
    this.completedSpans.push(span.getData());

    // Trim if too many spans
    if (this.completedSpans.length > this.config.maxSpansPerTrace) {
      this.completedSpans = this.completedSpans.slice(-this.config.maxSpansPerTrace);
    }
  }

  private shouldSample(): boolean {
    return Math.random() < this.config.sampleRate;
  }

  private generateTraceId(): string {
    return this.generateHexString(32);
  }

  private generateSpanId(): string {
    return this.generateHexString(16);
  }

  private generateHexString(length: number): string {
    const bytes = new Uint8Array(length / 2);
    crypto.getRandomValues(bytes);
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
}

/**
 * No-op span for when tracing is disabled or not sampled.
 */
class NoopSpan extends Span {
  constructor(name: string) {
    super(
      name,
      {
        traceId: "00000000000000000000000000000000",
        spanId: "0000000000000000",
        sampled: false,
      },
      undefined,
    );
  }

  override setAttribute(): this {
    return this;
  }

  override setAttributes(): this {
    return this;
  }

  override addEvent(): this {
    return this;
  }

  override setStatusOk(): this {
    return this;
  }

  override setStatusError(): this {
    return this;
  }

  override recordException(): this {
    return this;
  }

  override end(): void {
    // No-op
  }
}

// ─── CONTEXT PROPAGATION ─────────────────────────────────────

/**
 * W3C Trace Context header names.
 */
export const TRACE_PARENT_HEADER = "traceparent";
export const TRACE_STATE_HEADER = "tracestate";

/**
 * Parse W3C traceparent header.
 */
export function parseTraceParent(header: string): SpanContext | null {
  // Format: version-traceId-parentId-flags
  const match = header.match(/^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/);
  if (!match) return null;

  const traceId = match[2];
  const spanId = match[3];
  const flags = match[4];

  if (!traceId || !spanId || !flags) return null;

  const sampled = (Number.parseInt(flags, 16) & 0x01) === 1;

  return { traceId, spanId, sampled };
}

/**
 * Generate W3C traceparent header.
 */
export function generateTraceParent(context: SpanContext): string {
  const version = "00";
  const flags = context.sampled ? "01" : "00";
  return `${version}-${context.traceId}-${context.spanId}-${flags}`;
}

/**
 * Extract trace context from headers.
 */
export function extractTraceContext(
  headers: Record<string, string | undefined>,
): SpanContext | null {
  const traceParent = headers[TRACE_PARENT_HEADER] ?? headers.traceparent;
  if (!traceParent) return null;

  return parseTraceParent(traceParent);
}

/**
 * Inject trace context into headers.
 */
export function injectTraceContext(context: SpanContext, headers: Record<string, string>): void {
  headers[TRACE_PARENT_HEADER] = generateTraceParent(context);
}

// ─── GLOBAL TRACER ───────────────────────────────────────────

let globalTracer: Tracer | undefined;

/**
 * Get or create the global tracer.
 */
export function getTracer(config?: Partial<TracingConfig>): Tracer {
  if (!globalTracer) {
    globalTracer = new Tracer(config);
  }
  return globalTracer;
}

/**
 * Reset the global tracer.
 */
export function resetTracer(): void {
  if (globalTracer) {
    globalTracer.stopExport();
    globalTracer = undefined;
  }
}

/**
 * Initialize tracing for production use.
 * Creates the global tracer and starts periodic OTLP export if an exporter URL is configured.
 */
export function initTracing(config: Partial<TracingConfig> = {}): Tracer {
  const tracer = getTracer(config);
  const parsed = TracingConfigSchema.parse(config);
  if (parsed.exporterUrl) {
    tracer.startExport();
    log.info("Tracing initialized with OTLP export", {
      exporterUrl: parsed.exporterUrl,
      sampleRate: parsed.sampleRate,
      serviceName: parsed.serviceName,
    });
  } else {
    log.info("Tracing initialized (no exporter configured)", {
      sampleRate: parsed.sampleRate,
    });
  }
  return tracer;
}

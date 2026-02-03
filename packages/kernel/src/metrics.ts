// Metrics Collection and Reporting
// Provides counters, gauges, histograms, and exporters

import { z } from "zod";
import { createLogger } from "./logger.js";

const log = createLogger({ name: "metrics" });

// ─── TYPES ──────────────────────────────────────────────────

export type MetricType = "counter" | "gauge" | "histogram";

export interface MetricLabels {
  [key: string]: string;
}

export interface MetricValue {
  value: number;
  timestamp: number;
  labels: MetricLabels;
}

export interface MetricDefinition {
  name: string;
  type: MetricType;
  help: string;
  labels: string[];
}

export const MetricsConfigSchema = z.object({
  enabled: z.boolean().optional().default(true),
  prefix: z.string().optional().default("agent_os"),
  defaultLabels: z.record(z.string()).optional().default({}),
  histogramBuckets: z.array(z.number()).optional().default([0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]),
});

export type MetricsConfig = z.infer<typeof MetricsConfigSchema>;

// ─── METRIC CLASSES ──────────────────────────────────────────

/**
 * Counter metric - monotonically increasing value.
 */
export class Counter {
  private values: Map<string, number> = new Map();

  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly labelNames: string[] = []
  ) {}

  /**
   * Increment the counter.
   */
  inc(labels: MetricLabels = {}, value = 1): void {
    const key = this.labelsToKey(labels);
    const current = this.values.get(key) ?? 0;
    this.values.set(key, current + value);
  }

  /**
   * Get current value.
   */
  get(labels: MetricLabels = {}): number {
    return this.values.get(this.labelsToKey(labels)) ?? 0;
  }

  /**
   * Reset the counter.
   */
  reset(): void {
    this.values.clear();
  }

  /**
   * Get all values with labels.
   */
  getAll(): Array<{ labels: MetricLabels; value: number }> {
    const results: Array<{ labels: MetricLabels; value: number }> = [];
    for (const [key, value] of this.values) {
      results.push({ labels: this.keyToLabels(key), value });
    }
    return results;
  }

  private labelsToKey(labels: MetricLabels): string {
    return this.labelNames.map((name) => labels[name] ?? "").join("|");
  }

  private keyToLabels(key: string): MetricLabels {
    const values = key.split("|");
    const labels: MetricLabels = {};
    this.labelNames.forEach((name, i) => {
      if (values[i]) labels[name] = values[i];
    });
    return labels;
  }
}

/**
 * Gauge metric - value that can go up and down.
 */
export class Gauge {
  private values: Map<string, number> = new Map();

  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly labelNames: string[] = []
  ) {}

  /**
   * Set the gauge value.
   */
  set(labels: MetricLabels, value: number): void;
  set(value: number): void;
  set(labelsOrValue: MetricLabels | number, value?: number): void {
    if (typeof labelsOrValue === "number") {
      this.values.set("", labelsOrValue);
    } else {
      const key = this.labelsToKey(labelsOrValue);
      this.values.set(key, value!);
    }
  }

  /**
   * Increment the gauge.
   */
  inc(labels: MetricLabels = {}, value = 1): void {
    const key = this.labelsToKey(labels);
    const current = this.values.get(key) ?? 0;
    this.values.set(key, current + value);
  }

  /**
   * Decrement the gauge.
   */
  dec(labels: MetricLabels = {}, value = 1): void {
    const key = this.labelsToKey(labels);
    const current = this.values.get(key) ?? 0;
    this.values.set(key, current - value);
  }

  /**
   * Get current value.
   */
  get(labels: MetricLabels = {}): number {
    return this.values.get(this.labelsToKey(labels)) ?? 0;
  }

  /**
   * Reset the gauge.
   */
  reset(): void {
    this.values.clear();
  }

  /**
   * Get all values with labels.
   */
  getAll(): Array<{ labels: MetricLabels; value: number }> {
    const results: Array<{ labels: MetricLabels; value: number }> = [];
    for (const [key, value] of this.values) {
      results.push({ labels: this.keyToLabels(key), value });
    }
    return results;
  }

  private labelsToKey(labels: MetricLabels): string {
    return this.labelNames.map((name) => labels[name] ?? "").join("|");
  }

  private keyToLabels(key: string): MetricLabels {
    const values = key.split("|");
    const labels: MetricLabels = {};
    this.labelNames.forEach((name, i) => {
      if (values[i]) labels[name] = values[i];
    });
    return labels;
  }
}

/**
 * Histogram metric - distribution of values.
 */
export class Histogram {
  private buckets: number[];
  private counts: Map<string, Map<number, number>> = new Map();
  private sums: Map<string, number> = new Map();
  private totals: Map<string, number> = new Map();

  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly labelNames: string[] = [],
    buckets: number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
  ) {
    this.buckets = [...buckets].sort((a, b) => a - b);
    this.buckets.push(Infinity); // +Inf bucket
  }

  /**
   * Observe a value.
   */
  observe(labels: MetricLabels, value: number): void;
  observe(value: number): void;
  observe(labelsOrValue: MetricLabels | number, value?: number): void {
    let labels: MetricLabels;
    let observedValue: number;

    if (typeof labelsOrValue === "number") {
      labels = {};
      observedValue = labelsOrValue;
    } else {
      labels = labelsOrValue;
      observedValue = value!;
    }

    const key = this.labelsToKey(labels);

    // Update buckets
    let bucketCounts = this.counts.get(key);
    if (!bucketCounts) {
      bucketCounts = new Map();
      for (const bucket of this.buckets) {
        bucketCounts.set(bucket, 0);
      }
      this.counts.set(key, bucketCounts);
    }

    for (const bucket of this.buckets) {
      if (observedValue <= bucket) {
        bucketCounts.set(bucket, (bucketCounts.get(bucket) ?? 0) + 1);
      }
    }

    // Update sum and count
    this.sums.set(key, (this.sums.get(key) ?? 0) + observedValue);
    this.totals.set(key, (this.totals.get(key) ?? 0) + 1);
  }

  /**
   * Create a timer for measuring duration.
   */
  startTimer(labels: MetricLabels = {}): () => number {
    const start = performance.now();
    return () => {
      const duration = (performance.now() - start) / 1000; // Convert to seconds
      this.observe(labels, duration);
      return duration;
    };
  }

  /**
   * Get histogram data.
   */
  get(labels: MetricLabels = {}): {
    buckets: Array<{ le: number; count: number }>;
    sum: number;
    count: number;
  } {
    const key = this.labelsToKey(labels);
    const bucketCounts = this.counts.get(key);

    const result = {
      buckets: this.buckets.map((le) => ({
        le,
        count: bucketCounts?.get(le) ?? 0,
      })),
      sum: this.sums.get(key) ?? 0,
      count: this.totals.get(key) ?? 0,
    };

    return result;
  }

  /**
   * Reset the histogram.
   */
  reset(): void {
    this.counts.clear();
    this.sums.clear();
    this.totals.clear();
  }

  private labelsToKey(labels: MetricLabels): string {
    return this.labelNames.map((name) => labels[name] ?? "").join("|");
  }
}

// ─── METRICS REGISTRY ────────────────────────────────────────

/**
 * Registry for all metrics.
 */
export class MetricsRegistry {
  private config: MetricsConfig;
  private counters: Map<string, Counter> = new Map();
  private gauges: Map<string, Gauge> = new Map();
  private histograms: Map<string, Histogram> = new Map();

  constructor(config: Partial<MetricsConfig> = {}) {
    this.config = MetricsConfigSchema.parse(config);
  }

  /**
   * Create or get a counter.
   */
  counter(name: string, help: string, labelNames: string[] = []): Counter {
    const fullName = `${this.config.prefix}_${name}`;
    let counter = this.counters.get(fullName);
    if (!counter) {
      counter = new Counter(fullName, help, labelNames);
      this.counters.set(fullName, counter);
    }
    return counter;
  }

  /**
   * Create or get a gauge.
   */
  gauge(name: string, help: string, labelNames: string[] = []): Gauge {
    const fullName = `${this.config.prefix}_${name}`;
    let gauge = this.gauges.get(fullName);
    if (!gauge) {
      gauge = new Gauge(fullName, help, labelNames);
      this.gauges.set(fullName, gauge);
    }
    return gauge;
  }

  /**
   * Create or get a histogram.
   */
  histogram(name: string, help: string, labelNames: string[] = [], buckets?: number[]): Histogram {
    const fullName = `${this.config.prefix}_${name}`;
    let histogram = this.histograms.get(fullName);
    if (!histogram) {
      histogram = new Histogram(fullName, help, labelNames, buckets ?? this.config.histogramBuckets);
      this.histograms.set(fullName, histogram);
    }
    return histogram;
  }

  /**
   * Reset all metrics.
   */
  reset(): void {
    for (const counter of this.counters.values()) counter.reset();
    for (const gauge of this.gauges.values()) gauge.reset();
    for (const histogram of this.histograms.values()) histogram.reset();
  }

  /**
   * Get all metrics in Prometheus format.
   */
  toPrometheusFormat(): string {
    const lines: string[] = [];

    // Counters
    for (const counter of this.counters.values()) {
      lines.push(`# HELP ${counter.name} ${counter.help}`);
      lines.push(`# TYPE ${counter.name} counter`);
      for (const { labels, value } of counter.getAll()) {
        const labelStr = this.formatLabels(labels);
        lines.push(`${counter.name}${labelStr} ${value}`);
      }
    }

    // Gauges
    for (const gauge of this.gauges.values()) {
      lines.push(`# HELP ${gauge.name} ${gauge.help}`);
      lines.push(`# TYPE ${gauge.name} gauge`);
      for (const { labels, value } of gauge.getAll()) {
        const labelStr = this.formatLabels(labels);
        lines.push(`${gauge.name}${labelStr} ${value}`);
      }
    }

    // Histograms
    for (const histogram of this.histograms.values()) {
      lines.push(`# HELP ${histogram.name} ${histogram.help}`);
      lines.push(`# TYPE ${histogram.name} histogram`);

      const data = histogram.get();
      for (const bucket of data.buckets) {
        const le = bucket.le === Infinity ? "+Inf" : bucket.le.toString();
        lines.push(`${histogram.name}_bucket{le="${le}"} ${bucket.count}`);
      }
      lines.push(`${histogram.name}_sum ${data.sum}`);
      lines.push(`${histogram.name}_count ${data.count}`);
    }

    return lines.join("\n");
  }

  /**
   * Get all metrics as JSON.
   */
  toJSON(): {
    counters: Record<string, Array<{ labels: MetricLabels; value: number }>>;
    gauges: Record<string, Array<{ labels: MetricLabels; value: number }>>;
    histograms: Record<
      string,
      { buckets: Array<{ le: number; count: number }>; sum: number; count: number }
    >;
  } {
    const counters: Record<string, Array<{ labels: MetricLabels; value: number }>> = {};
    const gauges: Record<string, Array<{ labels: MetricLabels; value: number }>> = {};
    const histograms: Record<
      string,
      { buckets: Array<{ le: number; count: number }>; sum: number; count: number }
    > = {};

    for (const [name, counter] of this.counters) {
      counters[name] = counter.getAll();
    }
    for (const [name, gauge] of this.gauges) {
      gauges[name] = gauge.getAll();
    }
    for (const [name, histogram] of this.histograms) {
      histograms[name] = histogram.get();
    }

    return { counters, gauges, histograms };
  }

  private formatLabels(labels: MetricLabels): string {
    const merged = { ...this.config.defaultLabels, ...labels };
    const entries = Object.entries(merged);
    if (entries.length === 0) return "";
    const labelPairs = entries.map(([k, v]) => `${k}="${v}"`);
    return `{${labelPairs.join(",")}}`;
  }
}

// ─── GLOBAL REGISTRY ─────────────────────────────────────────

let globalRegistry: MetricsRegistry | undefined;

/**
 * Get or create the global metrics registry.
 */
export function getMetricsRegistry(config?: Partial<MetricsConfig>): MetricsRegistry {
  if (!globalRegistry) {
    globalRegistry = new MetricsRegistry(config);
  }
  return globalRegistry;
}

/**
 * Reset the global metrics registry.
 */
export function resetMetricsRegistry(): void {
  globalRegistry = undefined;
}

// ─── BUILT-IN METRICS ────────────────────────────────────────

/**
 * Standard metrics for Agent OS.
 */
export function createStandardMetrics(registry: MetricsRegistry) {
  return {
    // Request metrics
    requestsTotal: registry.counter("requests_total", "Total number of requests", [
      "method",
      "path",
      "status",
    ]),
    requestDuration: registry.histogram(
      "request_duration_seconds",
      "Request duration in seconds",
      ["method", "path"]
    ),
    requestsInFlight: registry.gauge("requests_in_flight", "Number of requests in flight"),

    // Agent metrics
    agentsActive: registry.gauge("agents_active", "Number of active agents", ["state"]),
    agentTasksTotal: registry.counter("agent_tasks_total", "Total agent tasks", [
      "agent_id",
      "status",
    ]),
    agentTaskDuration: registry.histogram(
      "agent_task_duration_seconds",
      "Agent task duration in seconds",
      ["agent_id"]
    ),

    // LLM metrics
    llmRequestsTotal: registry.counter("llm_requests_total", "Total LLM API requests", [
      "provider",
      "model",
      "status",
    ]),
    llmTokensTotal: registry.counter("llm_tokens_total", "Total LLM tokens used", [
      "provider",
      "model",
      "type",
    ]),
    llmRequestDuration: registry.histogram(
      "llm_request_duration_seconds",
      "LLM request duration in seconds",
      ["provider", "model"]
    ),

    // Circuit breaker metrics
    circuitBreakerState: registry.gauge("circuit_breaker_state", "Circuit breaker state (0=closed, 1=open, 2=half-open)", [
      "circuit",
    ]),
    circuitBreakerRejections: registry.counter(
      "circuit_breaker_rejections_total",
      "Circuit breaker rejections",
      ["circuit"]
    ),

    // Error metrics
    errorsTotal: registry.counter("errors_total", "Total errors", ["type", "component"]),

    // Memory metrics
    memoriesStored: registry.gauge("memories_stored", "Number of memories stored", ["agent_id"]),

    // Event bus metrics
    eventsPublished: registry.counter("events_published_total", "Total events published", ["type"]),
    eventsProcessed: registry.counter("events_processed_total", "Total events processed", [
      "type",
      "status",
    ]),
  };
}

// ─── PROCESS METRICS ─────────────────────────────────────────

/**
 * Collect Node.js process metrics.
 */
export function collectProcessMetrics(registry: MetricsRegistry): void {
  const memoryGauge = registry.gauge("process_memory_bytes", "Process memory usage", ["type"]);
  const cpuGauge = registry.gauge("process_cpu_seconds_total", "Total CPU time", ["type"]);
  const uptimeGauge = registry.gauge("process_uptime_seconds", "Process uptime in seconds");
  const handleGauge = registry.gauge("process_handles_total", "Number of active handles");

  const update = () => {
    const memory = process.memoryUsage();
    memoryGauge.set({ type: "rss" }, memory.rss);
    memoryGauge.set({ type: "heapTotal" }, memory.heapTotal);
    memoryGauge.set({ type: "heapUsed" }, memory.heapUsed);
    memoryGauge.set({ type: "external" }, memory.external);

    const cpu = process.cpuUsage();
    cpuGauge.set({ type: "user" }, cpu.user / 1e6);
    cpuGauge.set({ type: "system" }, cpu.system / 1e6);

    uptimeGauge.set(process.uptime());

    // @ts-expect-error - _getActiveHandles is internal
    if (typeof process._getActiveHandles === "function") {
      // @ts-expect-error - _getActiveHandles is internal
      handleGauge.set(process._getActiveHandles().length);
    }
  };

  // Initial collection
  update();

  // Periodic collection every 15 seconds
  setInterval(update, 15000);

  log.debug("Process metrics collection started");
}

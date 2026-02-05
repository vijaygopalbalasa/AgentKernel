// Metrics Tests
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Counter,
  Gauge,
  Histogram,
  MetricsRegistry,
  createStandardMetrics,
  getMetricsRegistry,
  resetMetricsRegistry,
} from "./metrics.js";

describe("Counter", () => {
  let counter: Counter;

  beforeEach(() => {
    counter = new Counter("test_counter", "A test counter", ["method", "status"]);
  });

  it("should start at 0", () => {
    expect(counter.get()).toBe(0);
  });

  it("should increment by 1 by default", () => {
    counter.inc();
    expect(counter.get()).toBe(1);
  });

  it("should increment by specified value", () => {
    counter.inc({}, 5);
    expect(counter.get()).toBe(5);
  });

  it("should track different labels separately", () => {
    counter.inc({ method: "GET", status: "200" });
    counter.inc({ method: "POST", status: "201" });
    counter.inc({ method: "GET", status: "200" });

    expect(counter.get({ method: "GET", status: "200" })).toBe(2);
    expect(counter.get({ method: "POST", status: "201" })).toBe(1);
  });

  it("should reset all values", () => {
    counter.inc({ method: "GET", status: "200" });
    counter.inc({ method: "POST", status: "201" });

    counter.reset();

    expect(counter.get({ method: "GET", status: "200" })).toBe(0);
    expect(counter.get({ method: "POST", status: "201" })).toBe(0);
  });

  it("should return all values", () => {
    counter.inc({ method: "GET", status: "200" }, 5);
    counter.inc({ method: "POST", status: "201" }, 3);

    const all = counter.getAll();
    expect(all).toHaveLength(2);
    expect(all.some((v) => v.labels.method === "GET" && v.value === 5)).toBe(true);
    expect(all.some((v) => v.labels.method === "POST" && v.value === 3)).toBe(true);
  });
});

describe("Gauge", () => {
  let gauge: Gauge;

  beforeEach(() => {
    gauge = new Gauge("test_gauge", "A test gauge", ["instance"]);
  });

  it("should start at 0", () => {
    expect(gauge.get()).toBe(0);
  });

  it("should set value", () => {
    gauge.set(42);
    expect(gauge.get()).toBe(42);
  });

  it("should set value with labels", () => {
    gauge.set({ instance: "a" }, 10);
    gauge.set({ instance: "b" }, 20);

    expect(gauge.get({ instance: "a" })).toBe(10);
    expect(gauge.get({ instance: "b" })).toBe(20);
  });

  it("should increment", () => {
    gauge.set(10);
    gauge.inc();
    expect(gauge.get()).toBe(11);
  });

  it("should decrement", () => {
    gauge.set(10);
    gauge.dec();
    expect(gauge.get()).toBe(9);
  });

  it("should increment with labels", () => {
    gauge.set({ instance: "a" }, 10);
    gauge.inc({ instance: "a" }, 5);
    expect(gauge.get({ instance: "a" })).toBe(15);
  });

  it("should reset all values", () => {
    gauge.set({ instance: "a" }, 10);
    gauge.set({ instance: "b" }, 20);

    gauge.reset();

    expect(gauge.get({ instance: "a" })).toBe(0);
    expect(gauge.get({ instance: "b" })).toBe(0);
  });
});

describe("Histogram", () => {
  let histogram: Histogram;

  beforeEach(() => {
    histogram = new Histogram(
      "test_histogram",
      "A test histogram",
      ["endpoint"],
      [0.1, 0.5, 1, 2.5, 5],
    );
  });

  it("should observe values", () => {
    histogram.observe(0.25);
    histogram.observe(0.75);
    histogram.observe(1.5);

    const data = histogram.get();
    expect(data.count).toBe(3);
    expect(data.sum).toBe(2.5);
  });

  it("should populate buckets correctly", () => {
    histogram.observe(0.05); // In 0.1, 0.5, 1, 2.5, 5, +Inf
    histogram.observe(0.3); // In 0.5, 1, 2.5, 5, +Inf
    histogram.observe(0.8); // In 1, 2.5, 5, +Inf
    histogram.observe(2.0); // In 2.5, 5, +Inf
    histogram.observe(10.0); // Only in +Inf

    const data = histogram.get();
    const buckets = data.buckets;

    expect(buckets.find((b) => b.le === 0.1)?.count).toBe(1);
    expect(buckets.find((b) => b.le === 0.5)?.count).toBe(2);
    expect(buckets.find((b) => b.le === 1)?.count).toBe(3);
    expect(buckets.find((b) => b.le === 2.5)?.count).toBe(4);
    expect(buckets.find((b) => b.le === 5)?.count).toBe(4);
    expect(buckets.find((b) => b.le === Number.POSITIVE_INFINITY)?.count).toBe(5);
  });

  it("should observe with labels", () => {
    histogram.observe({ endpoint: "/api" }, 0.5);
    histogram.observe({ endpoint: "/api" }, 0.5);
    histogram.observe({ endpoint: "/health" }, 0.1);

    const apiData = histogram.get({ endpoint: "/api" });
    const healthData = histogram.get({ endpoint: "/health" });

    expect(apiData.count).toBe(2);
    expect(healthData.count).toBe(1);
  });

  it("should create a timer", async () => {
    const endTimer = histogram.startTimer();

    await new Promise((resolve) => setTimeout(resolve, 50));

    const duration = endTimer();

    expect(duration).toBeGreaterThan(0.04);
    expect(duration).toBeLessThan(0.2);

    const data = histogram.get();
    expect(data.count).toBe(1);
    expect(data.sum).toBeGreaterThan(0.04);
  });

  it("should reset all data", () => {
    histogram.observe(1);
    histogram.observe(2);

    histogram.reset();

    const data = histogram.get();
    expect(data.count).toBe(0);
    expect(data.sum).toBe(0);
  });
});

describe("MetricsRegistry", () => {
  let registry: MetricsRegistry;

  beforeEach(() => {
    registry = new MetricsRegistry({ prefix: "test" });
    resetMetricsRegistry();
  });

  it("should create counter with prefix", () => {
    const counter = registry.counter("requests", "Total requests");
    expect(counter.name).toBe("test_requests");
  });

  it("should return same counter for same name", () => {
    const counter1 = registry.counter("requests", "Total requests");
    const counter2 = registry.counter("requests", "Total requests");
    expect(counter1).toBe(counter2);
  });

  it("should create gauge with prefix", () => {
    const gauge = registry.gauge("temperature", "Current temperature");
    expect(gauge.name).toBe("test_temperature");
  });

  it("should create histogram with prefix", () => {
    const histogram = registry.histogram("duration", "Duration in seconds");
    expect(histogram.name).toBe("test_duration");
  });

  it("should reset all metrics", () => {
    const counter = registry.counter("counter", "Counter");
    const gauge = registry.gauge("gauge", "Gauge");
    const histogram = registry.histogram("histogram", "Histogram");

    counter.inc({}, 5);
    gauge.set(10);
    histogram.observe(1);

    registry.reset();

    expect(counter.get()).toBe(0);
    expect(gauge.get()).toBe(0);
    expect(histogram.get().count).toBe(0);
  });

  describe("toPrometheusFormat", () => {
    it("should format counters", () => {
      const counter = registry.counter("requests_total", "Total requests", ["method"]);
      counter.inc({ method: "GET" });
      counter.inc({ method: "POST" });

      const output = registry.toPrometheusFormat();

      expect(output).toContain("# HELP test_requests_total Total requests");
      expect(output).toContain("# TYPE test_requests_total counter");
      expect(output).toContain('test_requests_total{method="GET"}');
      expect(output).toContain('test_requests_total{method="POST"}');
    });

    it("should format gauges", () => {
      const gauge = registry.gauge("temperature", "Current temperature");
      gauge.set(23.5);

      const output = registry.toPrometheusFormat();

      expect(output).toContain("# HELP test_temperature Current temperature");
      expect(output).toContain("# TYPE test_temperature gauge");
      expect(output).toContain("test_temperature 23.5");
    });

    it("should format histograms", () => {
      const histogram = registry.histogram("duration", "Duration", [], [0.1, 0.5, 1]);
      histogram.observe(0.25);

      const output = registry.toPrometheusFormat();

      expect(output).toContain("# HELP test_duration Duration");
      expect(output).toContain("# TYPE test_duration histogram");
      expect(output).toContain('test_duration_bucket{le="0.1"}');
      expect(output).toContain('test_duration_bucket{le="+Inf"}');
      expect(output).toContain("test_duration_sum");
      expect(output).toContain("test_duration_count");
    });
  });

  describe("toJSON", () => {
    it("should export metrics as JSON", () => {
      const counter = registry.counter("requests", "Requests");
      counter.inc({}, 5);

      const json = registry.toJSON();

      expect(json.counters).toHaveProperty("test_requests");
      const series = json.counters.test_requests;
      expect(series).toBeDefined();
      const first = series?.[0];
      expect(first).toBeDefined();
      if (!first) return;
      expect(first.value).toBe(5);
    });
  });
});

describe("Global Registry", () => {
  afterEach(() => {
    resetMetricsRegistry();
  });

  it("should return same instance", () => {
    const registry1 = getMetricsRegistry();
    const registry2 = getMetricsRegistry();

    expect(registry1).toBe(registry2);
  });

  it("should reset global registry", () => {
    const registry1 = getMetricsRegistry();
    resetMetricsRegistry();
    const registry2 = getMetricsRegistry();

    expect(registry1).not.toBe(registry2);
  });
});

describe("Standard Metrics", () => {
  it("should create all standard metrics", () => {
    const registry = new MetricsRegistry();
    const metrics = createStandardMetrics(registry);

    expect(metrics.requestsTotal).toBeDefined();
    expect(metrics.requestDuration).toBeDefined();
    expect(metrics.agentsActive).toBeDefined();
    expect(metrics.llmRequestsTotal).toBeDefined();
    expect(metrics.errorsTotal).toBeDefined();
  });

  it("should be usable for tracking", () => {
    const registry = new MetricsRegistry();
    const metrics = createStandardMetrics(registry);

    metrics.requestsTotal.inc({ method: "GET", path: "/api", status: "200" });
    metrics.agentsActive.set({ state: "running" }, 5);

    expect(metrics.requestsTotal.get({ method: "GET", path: "/api", status: "200" })).toBe(1);
    expect(metrics.agentsActive.get({ state: "running" })).toBe(5);
  });
});

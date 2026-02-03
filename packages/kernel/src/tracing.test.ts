// Tracing Tests
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  Span,
  Tracer,
  parseTraceParent,
  generateTraceParent,
  extractTraceContext,
  injectTraceContext,
  getTracer,
  resetTracer,
  type SpanContext,
} from "./tracing.js";

function getFirst<T>(items: T[]): T {
  const first = items[0];
  if (!first) {
    throw new Error("Expected at least one item");
  }
  return first;
}

describe("Span", () => {
  let span: Span;

  beforeEach(() => {
    span = new Span("test-span", {
      traceId: "1234567890abcdef1234567890abcdef",
      spanId: "1234567890abcdef",
      sampled: true,
    });
  });

  it("should have correct context", () => {
    expect(span.traceId).toBe("1234567890abcdef1234567890abcdef");
    expect(span.spanId).toBe("1234567890abcdef");
    expect(span.name).toBe("test-span");
  });

  it("should set attributes", () => {
    span.setAttribute("key", "value");
    span.setAttribute("count", 42);
    span.setAttribute("active", true);

    const data = span.getData();
    expect(data.attributes["key"]).toBe("value");
    expect(data.attributes["count"]).toBe(42);
    expect(data.attributes["active"]).toBe(true);
  });

  it("should set multiple attributes", () => {
    span.setAttributes({
      a: "1",
      b: 2,
      c: true,
    });

    const data = span.getData();
    expect(data.attributes["a"]).toBe("1");
    expect(data.attributes["b"]).toBe(2);
    expect(data.attributes["c"]).toBe(true);
  });

  it("should add events", () => {
    span.addEvent("event1");
    span.addEvent("event2", { detail: "info" });

    const data = span.getData();
    expect(data.events).toHaveLength(2);
    expect(getFirst(data.events).name).toBe("event1");
    const secondEvent = data.events[1];
    expect(secondEvent).toBeDefined();
    if (!secondEvent) return;
    expect(secondEvent.name).toBe("event2");
    expect(secondEvent.attributes?.detail).toBe("info");
  });

  it("should set status OK", () => {
    span.setStatusOk();
    span.end();

    const data = span.getData();
    expect(data.status).toBe("ok");
  });

  it("should set status error", () => {
    span.setStatusError("Something went wrong");
    span.end();

    const data = span.getData();
    expect(data.status).toBe("error");
    expect(data.attributes["error.message"]).toBe("Something went wrong");
  });

  it("should record exception", () => {
    const error = new Error("Test error");
    span.recordException(error);
    span.end();

    const data = span.getData();
    expect(data.status).toBe("error");
    expect(data.events.some((e) => e.name === "exception")).toBe(true);
  });

  it("should track duration", async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    span.end();

    expect(span.duration).toBeGreaterThan(40);
    expect(span.duration).toBeLessThan(200);
  });

  it("should not allow modifications after end", () => {
    span.end();
    span.setAttribute("key", "value");

    const data = span.getData();
    expect(data.attributes["key"]).toBeUndefined();
  });

  it("should be chainable", () => {
    const result = span
      .setAttribute("a", "1")
      .setAttribute("b", "2")
      .addEvent("event")
      .setStatusOk();

    expect(result).toBe(span);
  });
});

describe("Tracer", () => {
  let tracer: Tracer;

  beforeEach(() => {
    tracer = new Tracer({ enabled: true, sampleRate: 1.0 });
    resetTracer();
  });

  afterEach(() => {
    tracer.stopExport();
  });

  it("should create root spans", () => {
    const span = tracer.startSpan("root-span");

    expect(span.traceId).toHaveLength(32);
    expect(span.spanId).toHaveLength(16);
    expect(span.context.parentSpanId).toBeUndefined();
  });

  it("should create child spans", () => {
    const parent = tracer.startSpan("parent");
    const child = tracer.startChildSpan("child", parent);

    expect(child.traceId).toBe(parent.traceId);
    expect(child.context.parentSpanId).toBe(parent.spanId);
  });

  it("should track active spans", () => {
    const span1 = tracer.startSpan("span1");
    const span2 = tracer.startSpan("span2");

    expect(tracer.activeSpanCount).toBe(2);

    span1.end();
    expect(tracer.activeSpanCount).toBe(1);

    span2.end();
    expect(tracer.activeSpanCount).toBe(0);
  });

  it("should collect completed spans", () => {
    const span = tracer.startSpan("test");
    span.setAttribute("key", "value");
    span.end();

    const completed = tracer.getCompletedSpans();
    expect(completed).toHaveLength(1);
    expect(getFirst(completed).name).toBe("test");
  });

  it("should clear completed spans", () => {
    const span = tracer.startSpan("test");
    span.end();

    tracer.clearCompletedSpans();

    expect(tracer.getCompletedSpans()).toHaveLength(0);
  });

  describe("trace", () => {
    it("should wrap async function", async () => {
      const result = await tracer.trace("async-op", async (span) => {
        span.setAttribute("step", "running");
        return 42;
      });

      expect(result).toBe(42);

      const completed = tracer.getCompletedSpans();
      expect(completed).toHaveLength(1);
      expect(getFirst(completed).status).toBe("ok");
    });

    it("should capture errors", async () => {
      const error = new Error("Async error");

      await expect(
        tracer.trace("failing-op", async () => {
          throw error;
        })
      ).rejects.toThrow("Async error");

      const completed = tracer.getCompletedSpans();
      expect(completed).toHaveLength(1);
      expect(getFirst(completed).status).toBe("error");
    });
  });

  describe("traceSync", () => {
    it("should wrap sync function", () => {
      const result = tracer.traceSync("sync-op", (span) => {
        span.setAttribute("step", "running");
        return 42;
      });

      expect(result).toBe(42);

      const completed = tracer.getCompletedSpans();
      expect(completed).toHaveLength(1);
      expect(getFirst(completed).status).toBe("ok");
    });

    it("should capture sync errors", () => {
      expect(() => {
        tracer.traceSync("failing-op", () => {
          throw new Error("Sync error");
        });
      }).toThrow("Sync error");

      const completed = tracer.getCompletedSpans();
      expect(completed).toHaveLength(1);
      expect(getFirst(completed).status).toBe("error");
    });
  });

  describe("sampling", () => {
    it("should respect sample rate 0", () => {
      const noSampleTracer = new Tracer({ sampleRate: 0 });
      const span = noSampleTracer.startSpan("test");

      expect(span.context.sampled).toBe(false);
    });

    it("should respect sample rate 1", () => {
      const alwaysSampleTracer = new Tracer({ sampleRate: 1 });
      const span = alwaysSampleTracer.startSpan("test");

      expect(span.context.sampled).toBe(true);
    });
  });

  describe("disabled tracer", () => {
    it("should create noop spans", () => {
      const disabledTracer = new Tracer({ enabled: false });
      const span = disabledTracer.startSpan("test");

      span.setAttribute("key", "value");
      span.end();

      expect(disabledTracer.getCompletedSpans()).toHaveLength(0);
    });
  });
});

describe("Context Propagation", () => {
  describe("parseTraceParent", () => {
    it("should parse valid traceparent", () => {
      const header = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
      const context = parseTraceParent(header);

      expect(context).not.toBeNull();
      expect(context?.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
      expect(context?.spanId).toBe("b7ad6b7169203331");
      expect(context?.sampled).toBe(true);
    });

    it("should parse unsampled traceparent", () => {
      const header = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00";
      const context = parseTraceParent(header);

      expect(context?.sampled).toBe(false);
    });

    it("should return null for invalid header", () => {
      expect(parseTraceParent("invalid")).toBeNull();
      expect(parseTraceParent("00-short-short-00")).toBeNull();
      expect(parseTraceParent("")).toBeNull();
    });
  });

  describe("generateTraceParent", () => {
    it("should generate valid traceparent", () => {
      const context: SpanContext = {
        traceId: "0af7651916cd43dd8448eb211c80319c",
        spanId: "b7ad6b7169203331",
        sampled: true,
      };

      const header = generateTraceParent(context);

      expect(header).toBe("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");
    });

    it("should handle unsampled context", () => {
      const context: SpanContext = {
        traceId: "0af7651916cd43dd8448eb211c80319c",
        spanId: "b7ad6b7169203331",
        sampled: false,
      };

      const header = generateTraceParent(context);

      expect(header).toContain("-00");
    });
  });

  describe("extractTraceContext", () => {
    it("should extract from headers", () => {
      const headers = {
        traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
      };

      const context = extractTraceContext(headers);

      expect(context).not.toBeNull();
      expect(context?.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
    });

    it("should return null if no traceparent", () => {
      const context = extractTraceContext({});

      expect(context).toBeNull();
    });
  });

  describe("injectTraceContext", () => {
    it("should inject into headers", () => {
      const context: SpanContext = {
        traceId: "0af7651916cd43dd8448eb211c80319c",
        spanId: "b7ad6b7169203331",
        sampled: true,
      };

      const headers: Record<string, string> = {};
      injectTraceContext(context, headers);

      expect(headers["traceparent"]).toBeDefined();
      expect(headers["traceparent"]).toContain(context.traceId);
    });
  });
});

describe("Global Tracer", () => {
  afterEach(() => {
    resetTracer();
  });

  it("should return same instance", () => {
    const tracer1 = getTracer();
    const tracer2 = getTracer();

    expect(tracer1).toBe(tracer2);
  });

  it("should reset global tracer", () => {
    const tracer1 = getTracer();
    resetTracer();
    const tracer2 = getTracer();

    expect(tracer1).not.toBe(tracer2);
  });
});

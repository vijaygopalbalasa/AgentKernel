import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rm, readFile } from "fs/promises";
import {
  AuditLogger,
  MemoryAuditSink,
  FileAuditSink,
  ConsoleAuditSink,
  DatabaseAuditSink,
  createAuditLogger,
  type AuditEvent,
  type DatabaseAuditRecord,
} from "../audit.js";

function getFirst<T>(items: T[]): T {
  const first = items[0];
  if (!first) {
    throw new Error("Expected at least one item");
  }
  return first;
}

describe("MemoryAuditSink", () => {
  let sink: MemoryAuditSink;

  beforeEach(() => {
    sink = new MemoryAuditSink();
  });

  describe("write", () => {
    it("should store audit events", () => {
      const event: AuditEvent = {
        id: "test-1",
        timestamp: new Date(),
        severity: "info",
        category: "lifecycle",
        message: "Test event",
      };

      sink.write(event);
      expect(sink.count).toBe(1);
    });

    it("should trim events when exceeding max", () => {
      const smallSink = new MemoryAuditSink(5);

      for (let i = 0; i < 10; i++) {
        smallSink.write({
          id: `test-${i}`,
          timestamp: new Date(),
          severity: "info",
          category: "lifecycle",
          message: `Event ${i}`,
        });
      }

      expect(smallSink.count).toBe(5);
    });
  });

  describe("getEvents", () => {
    it("should return all events", () => {
      sink.write({
        id: "test-1",
        timestamp: new Date(),
        severity: "info",
        category: "lifecycle",
        message: "Event 1",
      });
      sink.write({
        id: "test-2",
        timestamp: new Date(),
        severity: "warn",
        category: "security",
        message: "Event 2",
      });

      const events = sink.getEvents();
      expect(events).toHaveLength(2);
    });
  });

  describe("getByCategory", () => {
    it("should filter by category", () => {
      sink.write({
        id: "test-1",
        timestamp: new Date(),
        severity: "info",
        category: "lifecycle",
        message: "Lifecycle event",
      });
      sink.write({
        id: "test-2",
        timestamp: new Date(),
        severity: "warn",
        category: "security",
        message: "Security event",
      });

      const lifecycleEvents = sink.getByCategory("lifecycle");
      expect(lifecycleEvents).toHaveLength(1);
      expect(getFirst(lifecycleEvents).category).toBe("lifecycle");
    });
  });

  describe("getByAgentId", () => {
    it("should filter by agent ID", () => {
      sink.write({
        id: "test-1",
        timestamp: new Date(),
        severity: "info",
        category: "lifecycle",
        message: "Event 1",
        agentId: "agent-1",
      });
      sink.write({
        id: "test-2",
        timestamp: new Date(),
        severity: "info",
        category: "lifecycle",
        message: "Event 2",
        agentId: "agent-2",
      });

      const agent1Events = sink.getByAgentId("agent-1");
      expect(agent1Events).toHaveLength(1);
      expect(getFirst(agent1Events).agentId).toBe("agent-1");
    });
  });

  describe("getBySeverity", () => {
    it("should filter by severity", () => {
      sink.write({
        id: "test-1",
        timestamp: new Date(),
        severity: "info",
        category: "lifecycle",
        message: "Info event",
      });
      sink.write({
        id: "test-2",
        timestamp: new Date(),
        severity: "error",
        category: "error",
        message: "Error event",
      });

      const errorEvents = sink.getBySeverity("error");
      expect(errorEvents).toHaveLength(1);
      expect(getFirst(errorEvents).severity).toBe("error");
    });
  });

  describe("getInTimeRange", () => {
    it("should filter by time range", () => {
      const now = new Date();
      const past = new Date(now.getTime() - 10000);
      const future = new Date(now.getTime() + 10000);

      sink.write({
        id: "test-1",
        timestamp: past,
        severity: "info",
        category: "lifecycle",
        message: "Past event",
      });
      sink.write({
        id: "test-2",
        timestamp: now,
        severity: "info",
        category: "lifecycle",
        message: "Now event",
      });
      sink.write({
        id: "test-3",
        timestamp: future,
        severity: "info",
        category: "lifecycle",
        message: "Future event",
      });

      const rangeEvents = sink.getInTimeRange(
        new Date(now.getTime() - 5000),
        new Date(now.getTime() + 5000)
      );
      expect(rangeEvents).toHaveLength(1);
      expect(getFirst(rangeEvents).id).toBe("test-2");
    });
  });

  describe("clear", () => {
    it("should clear all events", () => {
      sink.write({
        id: "test-1",
        timestamp: new Date(),
        severity: "info",
        category: "lifecycle",
        message: "Event",
      });

      sink.clear();
      expect(sink.count).toBe(0);
    });
  });
});

describe("FileAuditSink", () => {
  const testFile = "/tmp/agent-os-test-audit.log";
  let sink: FileAuditSink;

  beforeEach(async () => {
    // Use larger buffer size so write() doesn't auto-flush
    sink = new FileAuditSink(testFile, { flushIntervalMs: 0, maxBufferSize: 100 });
    await rm(testFile, { force: true });
  });

  afterEach(async () => {
    await sink.close();
    await rm(testFile, { force: true });
  });

  describe("write and flush", () => {
    it("should write events to file", async () => {
      sink.write({
        id: "test-1",
        timestamp: new Date(),
        severity: "info",
        category: "lifecycle",
        message: "Test event",
      });

      await sink.flush();

      const content = await readFile(testFile, "utf-8");
      expect(content).toContain("test-1");
      expect(content).toContain("Test event");
    });

    it("should write multiple events", async () => {
      sink.write({
        id: "test-1",
        timestamp: new Date(),
        severity: "info",
        category: "lifecycle",
        message: "Event 1",
      });
      sink.write({
        id: "test-2",
        timestamp: new Date(),
        severity: "warn",
        category: "security",
        message: "Event 2",
      });

      await sink.flush();

      const content = await readFile(testFile, "utf-8");
      expect(content).toContain("test-1");
      expect(content).toContain("test-2");
    });
  });
});

describe("ConsoleAuditSink", () => {
  it("should create with default severity", () => {
    const sink = new ConsoleAuditSink();
    expect(sink).toBeInstanceOf(ConsoleAuditSink);
  });

  it("should create with custom severity", () => {
    const sink = new ConsoleAuditSink("error");
    expect(sink).toBeInstanceOf(ConsoleAuditSink);
  });
});

describe("AuditLogger", () => {
  let logger: AuditLogger;
  let memorySink: MemoryAuditSink;

  beforeEach(() => {
    memorySink = new MemoryAuditSink();
    logger = new AuditLogger({ sinks: [memorySink] });
  });

  describe("log", () => {
    it("should log events with auto-generated ID and timestamp", () => {
      logger.log({
        severity: "info",
        category: "lifecycle",
        message: "Test event",
      });

      const events = memorySink.getEvents();
      expect(events).toHaveLength(1);
      const firstEvent = getFirst(events);
      expect(firstEvent.id).toMatch(/^audit_/);
      expect(firstEvent.timestamp).toBeInstanceOf(Date);
    });
  });

  describe("lifecycle", () => {
    it("should log lifecycle events", () => {
      logger.lifecycle("agent-1", { action: "spawn" });

      const events = memorySink.getByCategory("lifecycle");
      expect(events).toHaveLength(1);
      const firstEvent = getFirst(events);
      expect(firstEvent.agentId).toBe("agent-1");
      expect(firstEvent.message).toContain("spawn");
    });
  });

  describe("stateTransition", () => {
    it("should log state transitions", () => {
      logger.stateTransition("agent-1", {
        fromState: "created",
        toState: "initializing",
        event: "INITIALIZE",
        timestamp: new Date(),
      });

      const events = memorySink.getByCategory("state");
      expect(events).toHaveLength(1);
      expect(getFirst(events).message).toContain("created → initializing");
    });
  });

  describe("permission", () => {
    it("should log permission checks", () => {
      logger.permission("agent-1", {
        action: "check",
        capability: "llm:chat",
        allowed: true,
      });

      const events = memorySink.getByCategory("permission");
      expect(events).toHaveLength(1);
    });

    it("should use warning severity for denied permissions", () => {
      logger.permission("agent-1", {
        action: "check",
        capability: "shell:execute",
        allowed: false,
        reason: "Not granted",
      });

      const events = memorySink.getByCategory("permission");
      expect(getFirst(events).severity).toBe("warn");
    });
  });

  describe("resource", () => {
    it("should log resource usage", () => {
      logger.resource("agent-1", {
        type: "usage",
        resourceType: "tokens",
        current: 1000,
        limit: 10000,
      });

      const events = memorySink.getByCategory("resource");
      expect(events).toHaveLength(1);
    });

    it("should use error severity for limit exceeded", () => {
      logger.resource("agent-1", {
        type: "limit_exceeded",
        resourceType: "tokens",
        current: 11000,
        limit: 10000,
      });

      const events = memorySink.getByCategory("resource");
      expect(getFirst(events).severity).toBe("error");
    });
  });

  describe("security", () => {
    it("should log security events", () => {
      logger.security("agent-1", {
        type: "injection",
        severity: "high",
        details: "Potential prompt injection detected",
        blocked: true,
      });

      const events = memorySink.getByCategory("security");
      expect(events).toHaveLength(1);
      expect(getFirst(events).severity).toBe("error");
    });
  });

  describe("tool", () => {
    it("should log tool invocations", () => {
      logger.tool("agent-1", {
        toolName: "file_read",
        action: "invoke",
        inputSummary: "/path/to/file",
      });

      const events = memorySink.getByCategory("tool");
      expect(events).toHaveLength(1);
    });
  });

  describe("communication", () => {
    it("should log communication events", () => {
      logger.communication("agent-1", {
        type: "send",
        protocol: "a2a",
        targetAgentId: "agent-2",
      });

      const events = memorySink.getByCategory("communication");
      expect(events).toHaveLength(1);
    });
  });

  describe("error", () => {
    it("should log errors", () => {
      logger.error("Something went wrong", new Error("Test error"), {
        agentId: "agent-1",
      });

      const events = memorySink.getByCategory("error");
      expect(events).toHaveLength(1);
      expect(getFirst(events).data).toHaveProperty("errorMessage", "Test error");
    });
  });

  describe("system", () => {
    it("should log system events", () => {
      logger.system("System started", { version: "1.0.0" });

      const events = memorySink.getByCategory("system");
      expect(events).toHaveLength(1);
    });
  });

  describe("flush", () => {
    it("should flush all sinks", async () => {
      await expect(logger.flush()).resolves.not.toThrow();
    });
  });

  describe("close", () => {
    it("should close all sinks", async () => {
      await expect(logger.close()).resolves.not.toThrow();
    });
  });
});

describe("DatabaseAuditSink", () => {
  let sink: DatabaseAuditSink;
  let writtenRecords: DatabaseAuditRecord[];

  const mockWriter = vi.fn(async (records: DatabaseAuditRecord[]) => {
    writtenRecords.push(...records);
  });

  beforeEach(() => {
    writtenRecords = [];
    mockWriter.mockClear();
    sink = new DatabaseAuditSink(mockWriter, { flushIntervalMs: 0, maxBufferSize: 100 });
  });

  afterEach(async () => {
    await sink.close();
  });

  describe("write and flush", () => {
    it("should write events to database via writer function", async () => {
      sink.write({
        id: "test-1",
        timestamp: new Date(),
        severity: "info",
        category: "lifecycle",
        message: "Test event",
        agentId: "agent-1",
      });

      await sink.flush();

      expect(mockWriter).toHaveBeenCalledTimes(1);
      expect(writtenRecords).toHaveLength(1);
      expect(writtenRecords[0]?.action).toBe("lifecycle");
      expect(writtenRecords[0]?.outcome).toBe("success");
    });

    it("should batch multiple events", async () => {
      sink.write({
        id: "test-1",
        timestamp: new Date(),
        severity: "info",
        category: "lifecycle",
        message: "Event 1",
      });
      sink.write({
        id: "test-2",
        timestamp: new Date(),
        severity: "warn",
        category: "security",
        message: "Event 2",
      });

      await sink.flush();

      expect(mockWriter).toHaveBeenCalledTimes(1);
      expect(writtenRecords).toHaveLength(2);
    });
  });

  describe("event to record mapping", () => {
    it("should map lifecycle events correctly", async () => {
      sink.write({
        id: "test-1",
        timestamp: new Date(),
        severity: "info",
        category: "lifecycle",
        message: "Agent spawned",
        agentId: "agent-1",
        data: { action: "spawn" },
      });

      await sink.flush();

      const record = writtenRecords[0];
      expect(record?.action).toBe("lifecycle.spawn");
      expect(record?.resource_type).toBe("agent");
      expect(record?.resource_id).toBe("agent-1");
      expect(record?.outcome).toBe("success");
    });

    it("should map tool events correctly", async () => {
      sink.write({
        id: "test-1",
        timestamp: new Date(),
        severity: "info",
        category: "tool",
        message: "Tool invoked",
        agentId: "agent-1",
        data: { action: "invoke", toolName: "file_read" },
      });

      await sink.flush();

      const record = writtenRecords[0];
      expect(record?.action).toBe("tool.invoke");
      expect(record?.resource_type).toBe("tool");
      expect(record?.resource_id).toBe("file_read");
    });

    it("should map permission events correctly", async () => {
      sink.write({
        id: "test-1",
        timestamp: new Date(),
        severity: "warn",
        category: "permission",
        message: "Permission denied",
        agentId: "agent-1",
        data: { action: "check", capability: "shell:execute", allowed: false },
      });

      await sink.flush();

      const record = writtenRecords[0];
      expect(record?.action).toBe("permission.check");
      expect(record?.resource_type).toBe("permission");
      expect(record?.resource_id).toBe("shell:execute");
      expect(record?.outcome).toBe("denied");
    });

    it("should map error events correctly", async () => {
      sink.write({
        id: "test-1",
        timestamp: new Date(),
        severity: "error",
        category: "error",
        message: "Something failed",
        agentId: "agent-1",
      });

      await sink.flush();

      const record = writtenRecords[0];
      expect(record?.outcome).toBe("failure");
    });

    it("should map security blocked events correctly", async () => {
      sink.write({
        id: "test-1",
        timestamp: new Date(),
        severity: "warn",
        category: "security",
        message: "Injection blocked",
        data: { type: "injection", blocked: true },
      });

      await sink.flush();

      const record = writtenRecords[0];
      expect(record?.action).toBe("security.injection");
      expect(record?.outcome).toBe("blocked");
    });

    it("should include full event data in details", async () => {
      sink.write({
        id: "test-1",
        timestamp: new Date(),
        severity: "info",
        category: "lifecycle",
        message: "Test event",
        agentId: "agent-1",
        traceId: "trace-123",
        source: "test-source",
        tags: ["test", "audit"],
      });

      await sink.flush();

      const record = writtenRecords[0];
      expect(record?.details).toHaveProperty("id", "test-1");
      expect(record?.details).toHaveProperty("message", "Test event");
      expect(record?.details).toHaveProperty("agentId", "agent-1");
      expect(record?.details).toHaveProperty("traceId", "trace-123");
      expect(record?.details).toHaveProperty("source", "test-source");
      expect(record?.details).toHaveProperty("tags", ["test", "audit"]);
    });
  });

  describe("auto-flush on buffer full", () => {
    it("should auto-flush when buffer exceeds max size", async () => {
      const smallSink = new DatabaseAuditSink(mockWriter, {
        flushIntervalMs: 0,
        maxBufferSize: 3
      });

      smallSink.write({
        id: "test-1",
        timestamp: new Date(),
        severity: "info",
        category: "lifecycle",
        message: "Event 1",
      });
      smallSink.write({
        id: "test-2",
        timestamp: new Date(),
        severity: "info",
        category: "lifecycle",
        message: "Event 2",
      });
      smallSink.write({
        id: "test-3",
        timestamp: new Date(),
        severity: "info",
        category: "lifecycle",
        message: "Event 3",
      });

      // Wait for auto-flush
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockWriter).toHaveBeenCalled();
      expect(writtenRecords.length).toBeGreaterThanOrEqual(3);

      await smallSink.close();
    });
  });

  describe("error handling", () => {
    it("should handle writer errors gracefully", async () => {
      const failingWriter = vi.fn(async () => {
        throw new Error("Database error");
      });
      const failingSink = new DatabaseAuditSink(failingWriter, {
        flushIntervalMs: 0,
        maxBufferSize: 100,
      });

      failingSink.write({
        id: "test-1",
        timestamp: new Date(),
        severity: "info",
        category: "lifecycle",
        message: "Event 1",
      });

      // Should not throw
      await expect(failingSink.flush()).resolves.not.toThrow();

      await failingSink.close();
    });
  });

  describe("close", () => {
    it("should flush remaining events on close", async () => {
      sink.write({
        id: "test-1",
        timestamp: new Date(),
        severity: "info",
        category: "lifecycle",
        message: "Event 1",
      });

      await sink.close();

      expect(mockWriter).toHaveBeenCalled();
      expect(writtenRecords).toHaveLength(1);
    });

    it("should not accept new events after close", async () => {
      await sink.close();

      sink.write({
        id: "test-1",
        timestamp: new Date(),
        severity: "info",
        category: "lifecycle",
        message: "Event after close",
      });

      await sink.flush();

      expect(writtenRecords).toHaveLength(0);
    });
  });
});

describe("createAuditLogger", () => {
  it("should create logger with default options", () => {
    const logger = createAuditLogger();
    expect(logger).toBeInstanceOf(AuditLogger);
  });

  it("should create logger with custom options", () => {
    const logger = createAuditLogger({
      minConsoleSeverity: "warn",
      includeConsole: false,
      defaultSource: "test-app",
    });
    expect(logger).toBeInstanceOf(AuditLogger);
  });

  it("should create logger with database writer", () => {
    const mockWriter = vi.fn(async () => {});
    const logger = createAuditLogger({
      databaseWriter: mockWriter,
      includeConsole: false,
    });
    expect(logger).toBeInstanceOf(AuditLogger);
  });

  it("should create logger with all options", () => {
    const mockWriter = vi.fn(async () => {});
    const logger = createAuditLogger({
      logFile: "/tmp/test-audit.log",
      minConsoleSeverity: "error",
      includeConsole: true,
      defaultSource: "full-test",
      databaseWriter: mockWriter,
      databaseFlushIntervalMs: 1000,
      databaseBufferSize: 50,
    });
    expect(logger).toBeInstanceOf(AuditLogger);
  });
});

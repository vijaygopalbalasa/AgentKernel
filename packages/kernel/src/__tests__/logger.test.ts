import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  initLogger,
  createLogger,
  getLogger,
  flushLogs,
  shutdownLogger,
  isLevelEnabled,
  LOG_LEVELS,
  type Logger,
} from "../logger.js";

describe("Logger", () => {
  describe("LOG_LEVELS", () => {
    it("should have all log levels in correct order", () => {
      expect(LOG_LEVELS).toEqual(["trace", "debug", "info", "warn", "error", "fatal"]);
    });
  });

  describe("createLogger", () => {
    it("should create a logger with default level", () => {
      const logger = createLogger({ name: "test" });
      expect(logger).toBeDefined();
      expect(logger.info).toBeInstanceOf(Function);
      expect(logger.debug).toBeInstanceOf(Function);
      expect(logger.error).toBeInstanceOf(Function);
    });

    it("should create a logger with custom level", () => {
      const logger = createLogger({ name: "test", level: "debug" });
      expect(logger.level).toBe("debug");
    });

    it("should create child loggers", () => {
      const parent = createLogger({ name: "parent" });
      const child = parent.child({ requestId: "123" });
      expect(child).toBeDefined();
      expect(child.info).toBeInstanceOf(Function);
    });
  });

  describe("getLogger", () => {
    it("should return a logger instance", () => {
      const logger = getLogger();
      expect(logger).toBeDefined();
      expect(logger.info).toBeInstanceOf(Function);
    });

    it("should return the same instance on multiple calls", () => {
      const logger1 = getLogger();
      const logger2 = getLogger();
      // They share the same underlying pino instance
      expect(logger1.level).toBe(logger2.level);
    });
  });

  describe("isLevelEnabled", () => {
    it("should return true for levels at or above current level", () => {
      const logger = createLogger({ name: "test", level: "info" });

      expect(isLevelEnabled(logger, "info")).toBe(true);
      expect(isLevelEnabled(logger, "warn")).toBe(true);
      expect(isLevelEnabled(logger, "error")).toBe(true);
      expect(isLevelEnabled(logger, "fatal")).toBe(true);
    });

    it("should return false for levels below current level", () => {
      const logger = createLogger({ name: "test", level: "info" });

      expect(isLevelEnabled(logger, "debug")).toBe(false);
      expect(isLevelEnabled(logger, "trace")).toBe(false);
    });

    it("should handle debug level correctly", () => {
      const logger = createLogger({ name: "test", level: "debug" });

      expect(isLevelEnabled(logger, "trace")).toBe(false);
      expect(isLevelEnabled(logger, "debug")).toBe(true);
      expect(isLevelEnabled(logger, "info")).toBe(true);
    });
  });

  describe("Logger methods", () => {
    it("should have all expected methods", () => {
      const logger = getLogger();

      expect(typeof logger.trace).toBe("function");
      expect(typeof logger.debug).toBe("function");
      expect(typeof logger.info).toBe("function");
      expect(typeof logger.warn).toBe("function");
      expect(typeof logger.error).toBe("function");
      expect(typeof logger.fatal).toBe("function");
      expect(typeof logger.child).toBe("function");
      expect(typeof logger.flush).toBe("function");
    });

    it("should accept message without context", () => {
      const logger = getLogger();
      // Should not throw
      expect(() => logger.info("test message")).not.toThrow();
    });

    it("should accept message with context", () => {
      const logger = getLogger();
      // Should not throw
      expect(() => logger.info("test message", { key: "value" })).not.toThrow();
    });
  });

  describe("flushLogs", () => {
    it("should not throw", () => {
      expect(() => flushLogs()).not.toThrow();
    });
  });

  describe("shutdownLogger", () => {
    it("should complete without error", async () => {
      await expect(shutdownLogger()).resolves.not.toThrow();
    });
  });

  describe("initLogger", () => {
    it("should initialize logger with config", () => {
      const logger = initLogger({
        level: "debug",
        pretty: false,
      });

      expect(logger).toBeDefined();
      expect(logger.level).toBe("debug");
    });

    it("should support file output config", () => {
      const logger = initLogger({
        level: "info",
        pretty: false,
        file: "/tmp/test.log",
      });

      expect(logger).toBeDefined();
    });
  });
});

describe("Logger child bindings", () => {
  it("should pass bindings to child logger", () => {
    const parent = createLogger({ name: "parent" });
    const child = parent.child({
      requestId: "req-123",
      userId: "user-456",
    });

    // Child should be functional
    expect(child.info).toBeInstanceOf(Function);
    expect(child.child).toBeInstanceOf(Function);
  });

  it("should allow nested child loggers", () => {
    const root = createLogger({ name: "root" });
    const level1 = root.child({ level: 1 });
    const level2 = level1.child({ level: 2 });
    const level3 = level2.child({ level: 3 });

    expect(level3.info).toBeInstanceOf(Function);
  });
});

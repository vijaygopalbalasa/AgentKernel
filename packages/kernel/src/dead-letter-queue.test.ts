// Dead Letter Queue Tests
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DeadLetterQueue,
  InMemoryDlqStorage,
  getDeadLetterQueue,
  resetDeadLetterQueue,
  type DeadLetter,
} from "./dead-letter-queue.js";

describe("InMemoryDlqStorage", () => {
  let storage: InMemoryDlqStorage;

  beforeEach(() => {
    storage = new InMemoryDlqStorage();
  });

  it("should add and retrieve a letter", async () => {
    const letter: DeadLetter = {
      id: "test-1",
      originalEvent: { type: "test", data: "hello" },
      errorMessage: "Test error",
      retryCount: 0,
      createdAt: new Date(),
      status: "pending",
    };

    await storage.add(letter);
    const retrieved = await storage.get("test-1");

    expect(retrieved).toEqual(letter);
  });

  it("should return null for non-existent letter", async () => {
    const result = await storage.get("non-existent");
    expect(result).toBeNull();
  });

  it("should update a letter", async () => {
    const letter: DeadLetter = {
      id: "test-1",
      originalEvent: { type: "test" },
      errorMessage: "Test error",
      retryCount: 0,
      createdAt: new Date(),
      status: "pending",
    };

    await storage.add(letter);
    await storage.update("test-1", { status: "retrying", retryCount: 1 });

    const updated = await storage.get("test-1");
    expect(updated?.status).toBe("retrying");
    expect(updated?.retryCount).toBe(1);
  });

  it("should list letters with filtering", async () => {
    const letters: DeadLetter[] = [
      { id: "1", originalEvent: {}, errorMessage: "", retryCount: 0, createdAt: new Date(), status: "pending" },
      { id: "2", originalEvent: {}, errorMessage: "", retryCount: 0, createdAt: new Date(), status: "resolved" },
      { id: "3", originalEvent: {}, errorMessage: "", retryCount: 0, createdAt: new Date(), status: "pending" },
    ];

    for (const letter of letters) {
      await storage.add(letter);
    }

    const pending = await storage.list({ status: "pending" });
    expect(pending).toHaveLength(2);
  });

  it("should list letters with pagination", async () => {
    for (let i = 0; i < 10; i++) {
      await storage.add({
        id: `letter-${i}`,
        originalEvent: {},
        errorMessage: "",
        retryCount: 0,
        createdAt: new Date(Date.now() - i * 1000),
        status: "pending",
      });
    }

    const page1 = await storage.list({ limit: 3, offset: 0 });
    const page2 = await storage.list({ limit: 3, offset: 3 });

    expect(page1).toHaveLength(3);
    expect(page2).toHaveLength(3);
    const firstPage = page1[0];
    const secondPage = page2[0];
    expect(firstPage).toBeDefined();
    expect(secondPage).toBeDefined();
    if (!firstPage || !secondPage) return;
    expect(firstPage.id).not.toBe(secondPage.id);
  });

  it("should count letters by status", async () => {
    await storage.add({ id: "1", originalEvent: {}, errorMessage: "", retryCount: 0, createdAt: new Date(), status: "pending" });
    await storage.add({ id: "2", originalEvent: {}, errorMessage: "", retryCount: 0, createdAt: new Date(), status: "pending" });
    await storage.add({ id: "3", originalEvent: {}, errorMessage: "", retryCount: 0, createdAt: new Date(), status: "resolved" });

    expect(await storage.count("pending")).toBe(2);
    expect(await storage.count("resolved")).toBe(1);
    expect(await storage.count()).toBe(3);
  });

  it("should delete a letter", async () => {
    await storage.add({ id: "1", originalEvent: {}, errorMessage: "", retryCount: 0, createdAt: new Date(), status: "pending" });

    await storage.delete("1");

    expect(await storage.get("1")).toBeNull();
  });

  it("should purge old letters", async () => {
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000); // 10 days ago
    const newDate = new Date();

    await storage.add({ id: "old", originalEvent: {}, errorMessage: "", retryCount: 0, createdAt: oldDate, status: "pending" });
    await storage.add({ id: "new", originalEvent: {}, errorMessage: "", retryCount: 0, createdAt: newDate, status: "pending" });

    const purged = await storage.purge();

    expect(purged).toBe(1);
    expect(await storage.get("old")).toBeNull();
    expect(await storage.get("new")).not.toBeNull();
  });

  it("should clear all letters", async () => {
    await storage.add({ id: "1", originalEvent: {}, errorMessage: "", retryCount: 0, createdAt: new Date(), status: "pending" });
    await storage.add({ id: "2", originalEvent: {}, errorMessage: "", retryCount: 0, createdAt: new Date(), status: "pending" });

    storage.clear();

    expect(await storage.count()).toBe(0);
  });
});

describe("DeadLetterQueue", () => {
  let dlq: DeadLetterQueue;
  let storage: InMemoryDlqStorage;

  beforeEach(() => {
    storage = new InMemoryDlqStorage();
    dlq = new DeadLetterQueue(storage, {
      maxRetries: 3,
      retryDelay: 1000, // Must be >= 1000
      backoffMultiplier: 2,
    });
  });

  afterEach(() => {
    dlq.stopAutoRetry();
  });

  describe("add", () => {
    it("should add event to DLQ and return ID", async () => {
      const result = await dlq.add({ type: "test.event", data: "hello" }, "Processing failed");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(typeof result.value).toBe("string");
      }
    });

    it("should store metadata with the letter", async () => {
      const result = await dlq.add(
        { type: "test.event" },
        "Error",
        { source: "agent-1", priority: "high" }
      );

      if (result.ok) {
        const letter = await dlq.get(result.value);
        expect(letter?.metadata).toEqual({ source: "agent-1", priority: "high" });
      }
    });
  });

  describe("get and list", () => {
    it("should retrieve letter by ID", async () => {
      const addResult = await dlq.add({ type: "test" }, "Error");
      if (!addResult.ok) throw new Error("Add failed");

      const letter = await dlq.get(addResult.value);

      expect(letter).not.toBeNull();
      expect(letter?.errorMessage).toBe("Error");
    });

    it("should list letters with filtering", async () => {
      await dlq.add({ type: "test1" }, "Error 1");
      await dlq.add({ type: "test2" }, "Error 2");

      const letters = await dlq.list({ status: "pending" });

      expect(letters).toHaveLength(2);
    });

    it("should count letters", async () => {
      await dlq.add({ type: "test1" }, "Error 1");
      await dlq.add({ type: "test2" }, "Error 2");

      const count = await dlq.count("pending");

      expect(count).toBe(2);
    });
  });

  describe("retry", () => {
    it("should return error for non-existent letter", async () => {
      const result = await dlq.retry("non-existent");

      expect(result.ok).toBe(false);
    });

    it("should not retry resolved letters", async () => {
      const addResult = await dlq.add({ type: "test" }, "Error");
      if (!addResult.ok) throw new Error("Add failed");

      await dlq.resolve(addResult.value);

      const result = await dlq.retry(addResult.value);
      expect(result.ok).toBe(false);
    });

    it("should not retry abandoned letters", async () => {
      const addResult = await dlq.add({ type: "test" }, "Error");
      if (!addResult.ok) throw new Error("Add failed");

      await dlq.abandon(addResult.value);

      const result = await dlq.retry(addResult.value);
      expect(result.ok).toBe(false);
    });

    it("should abandon after max retries", async () => {
      const dlqWithLowRetries = new DeadLetterQueue(storage, { maxRetries: 1 });

      const addResult = await dlqWithLowRetries.add({ type: "test" }, "Error");
      if (!addResult.ok) throw new Error("Add failed");

      // Manually set retry count to max
      await storage.update(addResult.value, { retryCount: 1 });

      const result = await dlqWithLowRetries.retry(addResult.value);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(false);

      const letter = await dlqWithLowRetries.get(addResult.value);
      expect(letter?.status).toBe("abandoned");
    });

    it("should use registered retry handler", async () => {
      const handler = vi.fn().mockResolvedValue(true);
      dlq.registerRetryHandler("test.event", handler);

      const addResult = await dlq.add({ type: "test.event", data: "hello" }, "Error");
      if (!addResult.ok) throw new Error("Add failed");

      const result = await dlq.retry(addResult.value);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(true);
      expect(handler).toHaveBeenCalled();

      const letter = await dlq.get(addResult.value);
      expect(letter?.status).toBe("resolved");
    });

    it("should handle retry handler failure", async () => {
      const handler = vi.fn().mockRejectedValue(new Error("Retry failed"));
      dlq.registerRetryHandler("test.event", handler);

      const addResult = await dlq.add({ type: "test.event" }, "Original error");
      if (!addResult.ok) throw new Error("Add failed");

      const result = await dlq.retry(addResult.value);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(false);

      const letter = await dlq.get(addResult.value);
      expect(letter?.status).toBe("pending");
      expect(letter?.errorMessage).toContain("Retry failed");
    });

    it("should return false if no handler registered", async () => {
      const addResult = await dlq.add({ type: "unknown.event" }, "Error");
      if (!addResult.ok) throw new Error("Add failed");

      const result = await dlq.retry(addResult.value);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(false);
    });
  });

  describe("resolve and abandon", () => {
    it("should mark letter as resolved", async () => {
      const addResult = await dlq.add({ type: "test" }, "Error");
      if (!addResult.ok) throw new Error("Add failed");

      const result = await dlq.resolve(addResult.value);

      expect(result.ok).toBe(true);

      const letter = await dlq.get(addResult.value);
      expect(letter?.status).toBe("resolved");
    });

    it("should mark letter as abandoned", async () => {
      const addResult = await dlq.add({ type: "test" }, "Error");
      if (!addResult.ok) throw new Error("Add failed");

      const result = await dlq.abandon(addResult.value);

      expect(result.ok).toBe(true);

      const letter = await dlq.get(addResult.value);
      expect(letter?.status).toBe("abandoned");
    });
  });

  describe("purge", () => {
    it("should purge old letters", async () => {
      const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);

      await storage.add({
        id: "old-letter",
        originalEvent: {},
        errorMessage: "",
        retryCount: 0,
        createdAt: oldDate,
        status: "pending",
      });

      const result = await dlq.purge();

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(1);
    });
  });

  describe("getStats", () => {
    it("should return statistics", async () => {
      await dlq.add({ type: "test1" }, "Error 1");
      await dlq.add({ type: "test2" }, "Error 2");

      const addResult = await dlq.add({ type: "test3" }, "Error 3");
      if (addResult.ok) await dlq.resolve(addResult.value);

      const stats = await dlq.getStats();

      expect(stats.pending).toBe(2);
      expect(stats.resolved).toBe(1);
      expect(stats.total).toBe(3);
    });
  });

  describe("auto retry", () => {
    it("should start and stop auto retry", () => {
      dlq.startAutoRetry(50);
      dlq.startAutoRetry(50); // Idempotent

      dlq.stopAutoRetry();
    });

    it("should process retries automatically", async () => {
      const handler = vi.fn().mockResolvedValue(true);
      dlq.registerRetryHandler("test.event", handler);

      await dlq.add({ type: "test.event" }, "Error");

      dlq.startAutoRetry(50);

      await new Promise((resolve) => setTimeout(resolve, 150));

      dlq.stopAutoRetry();

      expect(handler).toHaveBeenCalled();
    });
  });
});

describe("Global DLQ", () => {
  afterEach(() => {
    resetDeadLetterQueue();
  });

  it("should get or create global DLQ", () => {
    const dlq1 = getDeadLetterQueue();
    const dlq2 = getDeadLetterQueue();

    expect(dlq1).toBe(dlq2);
  });

  it("should reset global DLQ", () => {
    const dlq1 = getDeadLetterQueue();
    resetDeadLetterQueue();
    const dlq2 = getDeadLetterQueue();

    expect(dlq1).not.toBe(dlq2);
  });

  it("should accept custom storage", () => {
    const customStorage = new InMemoryDlqStorage();
    const dlq = getDeadLetterQueue(customStorage);

    expect(dlq).toBeDefined();
  });
});

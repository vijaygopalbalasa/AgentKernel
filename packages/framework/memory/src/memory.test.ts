// Memory System tests
import { describe, it, expect, beforeEach } from "vitest";
import { MemoryManager } from "./manager.js";
import { InMemoryStore } from "./store.js";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function getFirst<T>(items: T[]): T {
  const first = items[0];
  if (!first) {
    throw new Error("Expected at least one item");
  }
  return first;
}

describe("MemoryManager", () => {
  let manager: MemoryManager;
  const agentId = "test-agent-001";

  beforeEach(() => {
    manager = new MemoryManager({ store: new InMemoryStore() });
  });

  describe("Episodic Memory", () => {
    it("should record and recall episodes", async () => {
      const result = await manager.recordEpisode(
        agentId,
        "User asked about weather",
        "Conversation about daily planning",
        { outcome: "Provided weather forecast", success: true }
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toMatch(UUID_REGEX);

      const recallResult = await manager.recallEpisodes(agentId, "weather");
      expect(recallResult.ok).toBe(true);
      if (!recallResult.ok) return;

      expect(recallResult.value.length).toBe(1);
      const firstRecall = getFirst(recallResult.value);
      expect(firstRecall.event).toBe("User asked about weather");
      expect(firstRecall.success).toBe(true);
    });

    it("should calculate importance based on success/failure", async () => {
      const successResult = await manager.recordEpisode(agentId, "Task completed", "context", { success: true });
      const failResult = await manager.recordEpisode(agentId, "Task failed", "context", { success: false });

      expect(successResult.ok).toBe(true);
      expect(failResult.ok).toBe(true);

      const recallResult = await manager.recallEpisodes(agentId, "Task", { limit: 10 });
      expect(recallResult.ok).toBe(true);
      if (!recallResult.ok) return;

      const episodes = recallResult.value;
      const successEp = episodes.find((e) => e.success === true);
      const failEp = episodes.find((e) => e.success === false);

      // Failures should have higher importance (learning opportunities)
      expect(failEp!.importance).toBeGreaterThan(successEp!.importance);
    });

    it("should reject invalid episode input", async () => {
      const result = await manager.recordEpisode(agentId, "", "context"); // Empty event
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("Semantic Memory", () => {
    it("should store and query facts", async () => {
      const r1 = await manager.storeFact(agentId, "User", "prefers", "dark mode");
      const r2 = await manager.storeFact(agentId, "User", "lives in", "San Francisco");

      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);

      const factsResult = await manager.queryKnowledge(agentId, "User");
      expect(factsResult.ok).toBe(true);
      if (!factsResult.ok) return;
      expect(factsResult.value.length).toBe(2);
    });

    it("should find specific facts", async () => {
      const storeResult = await manager.storeFact(agentId, "John", "age", "30");
      expect(storeResult.ok).toBe(true);

      const findResult = await manager.findFact(agentId, "John", "age");
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;
      expect(findResult.value).not.toBeNull();
      expect(findResult.value!.object).toBe("30");
    });

    it("should update existing facts", async () => {
      const r1 = await manager.storeFact(agentId, "Temperature", "is", "cold");
      const r2 = await manager.storeFact(agentId, "Temperature", "is", "warm");

      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);

      const factsResult = await manager.queryKnowledge(agentId, "Temperature");
      expect(factsResult.ok).toBe(true);
      if (!factsResult.ok) return;
      expect(factsResult.value.length).toBe(1);
      expect(getFirst(factsResult.value).object).toBe("warm");
    });

    it("should store knowledge triples", async () => {
      const result = await manager.storeKnowledge(agentId, [
        { subject: "Python", predicate: "is a", object: "programming language" },
        { subject: "Python", predicate: "used for", object: "data science" },
      ]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(2);

      const factsResult = await manager.queryKnowledge(agentId, "Python");
      expect(factsResult.ok).toBe(true);
      if (!factsResult.ok) return;
      expect(factsResult.value.length).toBe(2);
    });

    it("should reject invalid fact input", async () => {
      const result = await manager.storeFact(agentId, "", "predicate", "object"); // Empty subject
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("Procedural Memory", () => {
    it("should learn and find procedures", async () => {
      const result = await manager.learnProcedure(
        agentId,
        "Send Email",
        "Procedure for sending an email",
        "User asks to send an email",
        [
          { order: 1, action: "Open email client", tool: "email" },
          { order: 2, action: "Compose message" },
          { order: 3, action: "Send", onError: "retry" },
        ]
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toMatch(UUID_REGEX);

      const findResult = await manager.findProcedure(agentId, "Send Email");
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;
      expect(findResult.value).not.toBeNull();
      expect(findResult.value!.steps.length).toBe(3);
      expect(findResult.value!.version).toBe(1);
    });

    it("should update existing procedures", async () => {
      const r1 = await manager.learnProcedure(agentId, "Greet", "Say hello", "User arrives", [
        { order: 1, action: "Say hello" },
      ]);
      expect(r1.ok).toBe(true);

      const r2 = await manager.learnProcedure(agentId, "Greet", "Say hello nicely", "User arrives", [
        { order: 1, action: "Say hello" },
        { order: 2, action: "Ask how they are" },
      ]);
      expect(r2.ok).toBe(true);

      const findResult = await manager.findProcedure(agentId, "Greet");
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;
      expect(findResult.value!.version).toBe(2);
      expect(findResult.value!.steps.length).toBe(2);
    });

    it("should match procedures to situations", async () => {
      const learnResult = await manager.learnProcedure(agentId, "Code Review", "Review code changes", "Review pull request", [
        { order: 1, action: "Check diff" },
      ]);
      expect(learnResult.ok).toBe(true);

      // Simple substring search - query should contain words from procedure
      const matchResult = await manager.matchProcedures(agentId, "Review");
      expect(matchResult.ok).toBe(true);
      if (!matchResult.ok) return;
      expect(matchResult.value.length).toBeGreaterThan(0);
      expect(getFirst(matchResult.value).name).toBe("Code Review");
    });

    it("should track execution success rate", async () => {
      const learnResult = await manager.learnProcedure(agentId, "Test Proc", "Test", "test", [
        { order: 1, action: "Do" },
      ]);
      expect(learnResult.ok).toBe(true);
      if (!learnResult.ok) return;

      // Record some executions
      const e1 = await manager.recordProcedureExecution(learnResult.value, true);
      const e2 = await manager.recordProcedureExecution(learnResult.value, true);
      const e3 = await manager.recordProcedureExecution(learnResult.value, false);

      expect(e1.ok).toBe(true);
      expect(e2.ok).toBe(true);
      expect(e3.ok).toBe(true);

      const findResult = await manager.findProcedure(agentId, "Test Proc");
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;
      expect(findResult.value!.executionCount).toBe(3);
      // Success rate should be between initial 1.0 and actual 0.67
      expect(findResult.value!.successRate).toBeLessThan(1.0);
      expect(findResult.value!.successRate).toBeGreaterThan(0.6);
    });

    it("should reject invalid procedure input", async () => {
      const result = await manager.learnProcedure(agentId, "", "desc", "trigger", []); // Empty name
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("Working Memory", () => {
    it("should manage working memory context", () => {
      manager.setCurrentTask(agentId, "Write a report");
      manager.addToWorkingMemory(agentId, "User prefers bullet points", "semantic", 0.8);
      manager.addToWorkingMemory(agentId, "Previous report was 5 pages", "episodic", 0.6);

      const wm = manager.getWorkingMemory(agentId);
      expect(wm.currentTask).toBe("Write a report");
      expect(wm.context.length).toBe(2);
      // Sorted by relevance
      expect(getFirst(wm.context).relevance).toBe(0.8);
    });

    it("should respect working memory capacity", () => {
      const smallManager = new MemoryManager({
        store: new InMemoryStore(),
        workingMemoryCapacity: 2,
      });

      smallManager.addToWorkingMemory(agentId, "Item 1", "external", 0.5);
      smallManager.addToWorkingMemory(agentId, "Item 2", "external", 0.8);
      smallManager.addToWorkingMemory(agentId, "Item 3", "external", 0.3);

      const wm = smallManager.getWorkingMemory(agentId);
      expect(wm.context.length).toBe(2);
      // Should keep highest relevance items
      expect(getFirst(wm.context).relevance).toBe(0.8);
      const secondItem = wm.context[1];
      expect(secondItem).toBeDefined();
      if (!secondItem) return;
      expect(secondItem.relevance).toBe(0.5);
    });
  });

  describe("Unified Recall", () => {
    it("should recall across all memory types", async () => {
      const e1 = await manager.recordEpisode(agentId, "Discussed coding", "Tech conversation");
      const e2 = await manager.storeFact(agentId, "Python", "is", "popular");
      const e3 = await manager.learnProcedure(agentId, "Debug", "Debug code", "Error found", [
        { order: 1, action: "Check logs" },
      ]);

      expect(e1.ok).toBe(true);
      expect(e2.ok).toBe(true);
      expect(e3.ok).toBe(true);

      const result = await manager.recall(agentId, "coding", { limit: 10 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.memories.length).toBeGreaterThan(0);
    });

    it("should include working memory when requested", async () => {
      manager.addToWorkingMemory(agentId, "Current context", "external", 0.9);

      const result = await manager.recall(agentId, "test", { includeWorkingMemory: true });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.workingMemory).toBeDefined();
      expect(result.value.workingMemory!.context.length).toBe(1);
    });
  });

  describe("Stats & Maintenance", () => {
    it("should return accurate stats", async () => {
      const e1 = await manager.recordEpisode(agentId, "Event 1", "ctx");
      const e2 = await manager.recordEpisode(agentId, "Event 2", "ctx");
      const e3 = await manager.storeFact(agentId, "A", "is", "B");
      const e4 = await manager.learnProcedure(agentId, "Proc", "desc", "trigger", []);

      expect(e1.ok).toBe(true);
      expect(e2.ok).toBe(true);
      expect(e3.ok).toBe(true);
      expect(e4.ok).toBe(true);

      const statsResult = await manager.getStats(agentId);
      expect(statsResult.ok).toBe(true);
      if (!statsResult.ok) return;
      expect(statsResult.value.episodicCount).toBe(2);
      expect(statsResult.value.semanticCount).toBe(1);
      expect(statsResult.value.proceduralCount).toBe(1);
      expect(statsResult.value.totalCount).toBe(4);
    });

    it("should clear all memories", async () => {
      const e1 = await manager.recordEpisode(agentId, "Event", "ctx");
      const e2 = await manager.storeFact(agentId, "A", "is", "B");

      expect(e1.ok).toBe(true);
      expect(e2.ok).toBe(true);

      const clearResult = await manager.clearMemories(agentId);
      expect(clearResult.ok).toBe(true);

      const statsResult = await manager.getStats(agentId);
      expect(statsResult.ok).toBe(true);
      if (!statsResult.ok) return;
      expect(statsResult.value.totalCount).toBe(0);
    });
  });
});

// Memory System tests
import { describe, it, expect, beforeEach } from "vitest";
import { MemoryManager } from "./manager.js";
import { InMemoryStore } from "./store.js";

describe("MemoryManager", () => {
  let manager: MemoryManager;
  const agentId = "test-agent-001";

  beforeEach(() => {
    manager = new MemoryManager({ store: new InMemoryStore() });
  });

  describe("Episodic Memory", () => {
    it("should record and recall episodes", async () => {
      const id = await manager.recordEpisode(
        agentId,
        "User asked about weather",
        "Conversation about daily planning",
        { outcome: "Provided weather forecast", success: true }
      );

      expect(id).toMatch(/^ep-/);

      const episodes = await manager.recallEpisodes(agentId, "weather");
      expect(episodes.length).toBe(1);
      expect(episodes[0].event).toBe("User asked about weather");
      expect(episodes[0].success).toBe(true);
    });

    it("should calculate importance based on success/failure", async () => {
      await manager.recordEpisode(agentId, "Task completed", "context", { success: true });
      await manager.recordEpisode(agentId, "Task failed", "context", { success: false });

      const episodes = await manager.recallEpisodes(agentId, "Task", { limit: 10 });
      const successEp = episodes.find((e) => e.success === true);
      const failEp = episodes.find((e) => e.success === false);

      // Failures should have higher importance (learning opportunities)
      expect(failEp!.importance).toBeGreaterThan(successEp!.importance);
    });
  });

  describe("Semantic Memory", () => {
    it("should store and query facts", async () => {
      await manager.storeFact(agentId, "User", "prefers", "dark mode");
      await manager.storeFact(agentId, "User", "lives in", "San Francisco");

      const facts = await manager.queryKnowledge(agentId, "User");
      expect(facts.length).toBe(2);
    });

    it("should find specific facts", async () => {
      await manager.storeFact(agentId, "John", "age", "30");

      const fact = await manager.findFact(agentId, "John", "age");
      expect(fact).not.toBeNull();
      expect(fact!.object).toBe("30");
    });

    it("should update existing facts", async () => {
      await manager.storeFact(agentId, "Temperature", "is", "cold");
      await manager.storeFact(agentId, "Temperature", "is", "warm");

      const facts = await manager.queryKnowledge(agentId, "Temperature");
      expect(facts.length).toBe(1);
      expect(facts[0].object).toBe("warm");
    });

    it("should store knowledge triples", async () => {
      const ids = await manager.storeKnowledge(agentId, [
        { subject: "Python", predicate: "is a", object: "programming language" },
        { subject: "Python", predicate: "used for", object: "data science" },
      ]);

      expect(ids.length).toBe(2);

      const facts = await manager.queryKnowledge(agentId, "Python");
      expect(facts.length).toBe(2);
    });
  });

  describe("Procedural Memory", () => {
    it("should learn and find procedures", async () => {
      const id = await manager.learnProcedure(
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

      expect(id).toMatch(/^proc-/);

      const procedure = await manager.findProcedure(agentId, "Send Email");
      expect(procedure).not.toBeNull();
      expect(procedure!.steps.length).toBe(3);
      expect(procedure!.version).toBe(1);
    });

    it("should update existing procedures", async () => {
      await manager.learnProcedure(agentId, "Greet", "Say hello", "User arrives", [
        { order: 1, action: "Say hello" },
      ]);

      await manager.learnProcedure(agentId, "Greet", "Say hello nicely", "User arrives", [
        { order: 1, action: "Say hello" },
        { order: 2, action: "Ask how they are" },
      ]);

      const procedure = await manager.findProcedure(agentId, "Greet");
      expect(procedure!.version).toBe(2);
      expect(procedure!.steps.length).toBe(2);
    });

    it("should match procedures to situations", async () => {
      await manager.learnProcedure(agentId, "Code Review", "Review code changes", "Review pull request", [
        { order: 1, action: "Check diff" },
      ]);

      // Simple substring search - query should contain words from procedure
      const matches = await manager.matchProcedures(agentId, "Review");
      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0].name).toBe("Code Review");
    });

    it("should track execution success rate", async () => {
      const id = await manager.learnProcedure(agentId, "Test Proc", "Test", "test", [
        { order: 1, action: "Do" },
      ]);

      // Record some executions
      await manager.recordProcedureExecution(id, true);
      await manager.recordProcedureExecution(id, true);
      await manager.recordProcedureExecution(id, false);

      const procedure = await manager.findProcedure(agentId, "Test Proc");
      expect(procedure!.executionCount).toBe(3);
      // Success rate should be between initial 1.0 and actual 0.67
      expect(procedure!.successRate).toBeLessThan(1.0);
      expect(procedure!.successRate).toBeGreaterThan(0.6);
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
      expect(wm.context[0].relevance).toBe(0.8);
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
      expect(wm.context[0].relevance).toBe(0.8);
      expect(wm.context[1].relevance).toBe(0.5);
    });
  });

  describe("Unified Recall", () => {
    it("should recall across all memory types", async () => {
      await manager.recordEpisode(agentId, "Discussed coding", "Tech conversation");
      await manager.storeFact(agentId, "Python", "is", "popular");
      await manager.learnProcedure(agentId, "Debug", "Debug code", "Error found", [
        { order: 1, action: "Check logs" },
      ]);

      const result = await manager.recall(agentId, "coding", { limit: 10 });
      expect(result.memories.length).toBeGreaterThan(0);
    });

    it("should include working memory when requested", async () => {
      manager.addToWorkingMemory(agentId, "Current context", "external", 0.9);

      const result = await manager.recall(agentId, "test", { includeWorkingMemory: true });
      expect(result.workingMemory).toBeDefined();
      expect(result.workingMemory!.context.length).toBe(1);
    });
  });

  describe("Stats & Maintenance", () => {
    it("should return accurate stats", async () => {
      await manager.recordEpisode(agentId, "Event 1", "ctx");
      await manager.recordEpisode(agentId, "Event 2", "ctx");
      await manager.storeFact(agentId, "A", "is", "B");
      await manager.learnProcedure(agentId, "Proc", "desc", "trigger", []);

      const stats = await manager.getStats(agentId);
      expect(stats.episodicCount).toBe(2);
      expect(stats.semanticCount).toBe(1);
      expect(stats.proceduralCount).toBe(1);
      expect(stats.totalCount).toBe(4);
    });

    it("should clear all memories", async () => {
      await manager.recordEpisode(agentId, "Event", "ctx");
      await manager.storeFact(agentId, "A", "is", "B");

      await manager.clearMemories(agentId);

      const stats = await manager.getStats(agentId);
      expect(stats.totalCount).toBe(0);
    });
  });
});

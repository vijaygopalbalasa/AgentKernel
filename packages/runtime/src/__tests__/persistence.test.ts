import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm } from "fs/promises";
import { join } from "path";
import {
  MemoryPersistenceStorage,
  FilePersistenceStorage,
  PersistenceManager,
  createMemoryPersistence,
  createFilePersistence,
  type AgentCheckpoint,
  CHECKPOINT_VERSION,
} from "../persistence.js";
import type { ResourceUsage } from "../agent-context.js";

const createTestCheckpoint = (agentId: string): Omit<AgentCheckpoint, "version" | "agentId" | "timestamp"> => ({
  state: "ready",
  stateHistory: [
    {
      fromState: "created",
      toState: "initializing",
      event: "INITIALIZE",
      timestamp: new Date(),
    },
    {
      fromState: "initializing",
      toState: "ready",
      event: "READY",
      timestamp: new Date(),
    },
  ],
  usage: {
    inputTokens: 1000,
    outputTokens: 500,
    requestCount: 10,
    estimatedCostUSD: 0.05,
    currentMemoryMB: 100,
    activeRequests: 0,
    tokensThisMinute: 200,
    minuteWindowStart: new Date(),
  } as ResourceUsage,
  manifest: {
    name: "test-agent",
    version: "1.0.0",
    description: "Test agent",
  },
  env: { NODE_ENV: "test" },
  createdAt: new Date(),
  capabilities: [
    {
      capability: "llm:chat",
      grant: {
        capability: "llm:chat",
        grantedBy: "system",
        grantedAt: new Date(),
        expiresAt: null,
      },
    },
  ],
  customData: { key: "value" },
});

describe("MemoryPersistenceStorage", () => {
  let storage: MemoryPersistenceStorage;

  beforeEach(() => {
    storage = new MemoryPersistenceStorage();
  });

  describe("save", () => {
    it("should save a checkpoint", async () => {
      const checkpoint: AgentCheckpoint = {
        version: CHECKPOINT_VERSION,
        agentId: "agent-1",
        timestamp: new Date(),
        ...createTestCheckpoint("agent-1"),
      };

      await storage.save("agent-1", checkpoint);
      expect(await storage.exists("agent-1")).toBe(true);
    });
  });

  describe("load", () => {
    it("should load a saved checkpoint", async () => {
      const checkpoint: AgentCheckpoint = {
        version: CHECKPOINT_VERSION,
        agentId: "agent-1",
        timestamp: new Date(),
        ...createTestCheckpoint("agent-1"),
      };

      await storage.save("agent-1", checkpoint);
      const loaded = await storage.load("agent-1");

      expect(loaded).not.toBeNull();
      expect(loaded!.agentId).toBe("agent-1");
      expect(loaded!.state).toBe("ready");
      expect(loaded!.timestamp).toBeInstanceOf(Date);
    });

    it("should return null for non-existent checkpoint", async () => {
      const result = await storage.load("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("delete", () => {
    it("should delete a checkpoint", async () => {
      const checkpoint: AgentCheckpoint = {
        version: CHECKPOINT_VERSION,
        agentId: "agent-1",
        timestamp: new Date(),
        ...createTestCheckpoint("agent-1"),
      };

      await storage.save("agent-1", checkpoint);
      await storage.delete("agent-1");
      expect(await storage.exists("agent-1")).toBe(false);
    });
  });

  describe("list", () => {
    it("should list all checkpoints", async () => {
      await storage.save("agent-1", {
        version: CHECKPOINT_VERSION,
        agentId: "agent-1",
        timestamp: new Date(),
        ...createTestCheckpoint("agent-1"),
      });
      await storage.save("agent-2", {
        version: CHECKPOINT_VERSION,
        agentId: "agent-2",
        timestamp: new Date(),
        ...createTestCheckpoint("agent-2"),
      });

      const list = await storage.list();
      expect(list).toContain("agent-1");
      expect(list).toContain("agent-2");
    });
  });

  describe("clear", () => {
    it("should clear all checkpoints", async () => {
      await storage.save("agent-1", {
        version: CHECKPOINT_VERSION,
        agentId: "agent-1",
        timestamp: new Date(),
        ...createTestCheckpoint("agent-1"),
      });

      storage.clear();
      const list = await storage.list();
      expect(list).toHaveLength(0);
    });
  });
});

describe("FilePersistenceStorage", () => {
  const testDir = "/tmp/agent-os-test-persistence";
  let storage: FilePersistenceStorage;

  beforeEach(async () => {
    storage = new FilePersistenceStorage({ baseDir: testDir, prettyPrint: true });
    await rm(testDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("save and load", () => {
    it("should save and load checkpoint", async () => {
      const checkpoint: AgentCheckpoint = {
        version: CHECKPOINT_VERSION,
        agentId: "agent-1",
        timestamp: new Date(),
        ...createTestCheckpoint("agent-1"),
      };

      await storage.save("agent-1", checkpoint);
      const loaded = await storage.load("agent-1");

      expect(loaded).not.toBeNull();
      expect(loaded!.agentId).toBe("agent-1");
      expect(loaded!.state).toBe("ready");
    });

    it("should restore Date objects", async () => {
      const checkpoint: AgentCheckpoint = {
        version: CHECKPOINT_VERSION,
        agentId: "agent-1",
        timestamp: new Date(),
        ...createTestCheckpoint("agent-1"),
      };

      await storage.save("agent-1", checkpoint);
      const loaded = await storage.load("agent-1");

      expect(loaded!.timestamp).toBeInstanceOf(Date);
      expect(loaded!.createdAt).toBeInstanceOf(Date);
      const firstHistory = loaded!.stateHistory[0];
      expect(firstHistory).toBeDefined();
      if (!firstHistory) return;
      expect(firstHistory.timestamp).toBeInstanceOf(Date);
    });
  });

  describe("delete", () => {
    it("should delete checkpoint file", async () => {
      const checkpoint: AgentCheckpoint = {
        version: CHECKPOINT_VERSION,
        agentId: "agent-1",
        timestamp: new Date(),
        ...createTestCheckpoint("agent-1"),
      };

      await storage.save("agent-1", checkpoint);
      await storage.delete("agent-1");
      expect(await storage.exists("agent-1")).toBe(false);
    });

    it("should not throw when deleting non-existent file", async () => {
      await expect(storage.delete("nonexistent")).resolves.not.toThrow();
    });
  });

  describe("list", () => {
    it("should list checkpoint files", async () => {
      await storage.save("agent-1", {
        version: CHECKPOINT_VERSION,
        agentId: "agent-1",
        timestamp: new Date(),
        ...createTestCheckpoint("agent-1"),
      });

      const list = await storage.list();
      expect(list).toContain("agent-1");
    });
  });
});

describe("PersistenceManager", () => {
  let manager: PersistenceManager;
  let storage: MemoryPersistenceStorage;

  beforeEach(() => {
    storage = new MemoryPersistenceStorage();
    manager = new PersistenceManager({ storage });
  });

  describe("checkpoint", () => {
    it("should create checkpoint with version and timestamp", async () => {
      await manager.checkpoint("agent-1", createTestCheckpoint("agent-1"));

      const checkpoint = await manager.recover("agent-1");
      expect(checkpoint).not.toBeNull();
      expect(checkpoint!.version).toBe(CHECKPOINT_VERSION);
      expect(checkpoint!.timestamp).toBeInstanceOf(Date);
    });
  });

  describe("recover", () => {
    it("should recover checkpoint", async () => {
      await manager.checkpoint("agent-1", createTestCheckpoint("agent-1"));
      const recovered = await manager.recover("agent-1");

      expect(recovered).not.toBeNull();
      expect(recovered!.state).toBe("ready");
    });

    it("should return null for non-existent checkpoint", async () => {
      const result = await manager.recover("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("deleteCheckpoint", () => {
    it("should delete checkpoint", async () => {
      await manager.checkpoint("agent-1", createTestCheckpoint("agent-1"));
      await manager.deleteCheckpoint("agent-1");

      const hasCheckpoint = await manager.hasCheckpoint("agent-1");
      expect(hasCheckpoint).toBe(false);
    });
  });

  describe("listCheckpoints", () => {
    it("should list all checkpoints", async () => {
      await manager.checkpoint("agent-1", createTestCheckpoint("agent-1"));
      await manager.checkpoint("agent-2", createTestCheckpoint("agent-2"));

      const list = await manager.listCheckpoints();
      expect(list).toContain("agent-1");
      expect(list).toContain("agent-2");
    });
  });

  describe("hasCheckpoint", () => {
    it("should return true for existing checkpoint", async () => {
      await manager.checkpoint("agent-1", createTestCheckpoint("agent-1"));
      expect(await manager.hasCheckpoint("agent-1")).toBe(true);
    });

    it("should return false for non-existent checkpoint", async () => {
      expect(await manager.hasCheckpoint("nonexistent")).toBe(false);
    });
  });

  describe("createCheckpointData", () => {
    it("should create checkpoint data from context", () => {
      const context = {
        id: "agent-1",
        metadata: { name: "test", version: "1.0.0" },
        state: "ready" as const,
        limits: {
          maxTokensPerRequest: 4096,
          tokensPerMinute: 100000,
          maxMemoryMB: 512,
          maxConcurrentRequests: 5,
          costBudgetUSD: 0,
        },
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          requestCount: 0,
          estimatedCostUSD: 0,
          currentMemoryMB: 0,
          activeRequests: 0,
          tokensThisMinute: 0,
          minuteWindowStart: new Date(),
        },
        createdAt: new Date(),
        lastStateChange: new Date(),
        env: {},
      };

      const data = manager.createCheckpointData(
        context,
        [],
        { name: "test", version: "1.0.0" },
        [],
        { custom: "data" }
      );

      expect(data.state).toBe("ready");
      expect(data.customData).toEqual({ custom: "data" });
    });
  });
});

describe("factory functions", () => {
  it("createMemoryPersistence should create manager with memory storage", () => {
    const manager = createMemoryPersistence();
    expect(manager).toBeInstanceOf(PersistenceManager);
  });

  it("createFilePersistence should create manager with file storage", () => {
    const manager = createFilePersistence("/tmp/test");
    expect(manager).toBeInstanceOf(PersistenceManager);
  });
});

// State Persistence Tests
// Tests for PostgreSQL-backed state storage

import type { Database } from "@agentkernel/kernel";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CapabilityToken,
  type PersistedAgentState,
  PostgresCapabilityStore,
  PostgresRateLimitStore,
  PostgresStatePersistence,
  type RateLimitBucket,
  createPersistenceStores,
} from "../state-persistence.js";

// Mock database
function createMockDatabase(): Database {
  const mockData: Map<string, Record<string, unknown>> = new Map();

  return {
    query: vi.fn(async (queryFn) => {
      // Return empty array by default
      return [];
    }),
    queryOne: vi.fn(async (queryFn) => {
      return null;
    }),
    transaction: vi.fn(async (fn) => {
      return fn({} as never);
    }),
    isConnected: vi.fn(async () => true),
    getStats: vi.fn(() => ({ total: 1, idle: 1, active: 0, pending: 0, slowQueries: 0 })),
    close: vi.fn(async () => {}),
    connectionReady: Promise.resolve(),
    migrate: vi.fn(async () => ({ applied: 0, migrations: [], errors: [] })),
    sql: {} as never,
  } as unknown as Database;
}

describe("PostgresStatePersistence", () => {
  let db: Database;
  let persistence: PostgresStatePersistence;

  beforeEach(() => {
    db = createMockDatabase();
    persistence = new PostgresStatePersistence(db);
  });

  describe("saveState", () => {
    it("should call database query", async () => {
      await persistence.saveState("agent-1", "running", { foo: "bar" });
      expect(db.query).toHaveBeenCalled();
    });

    it("should save state without metadata", async () => {
      await persistence.saveState("agent-1", "idle");
      expect(db.query).toHaveBeenCalled();
    });

    it("should handle all valid states", async () => {
      const states = [
        "created",
        "initializing",
        "running",
        "paused",
        "stopped",
        "error",
        "terminated",
      ] as const;
      for (const state of states) {
        await persistence.saveState("agent-1", state);
      }
      expect(db.query).toHaveBeenCalledTimes(states.length);
    });
  });

  describe("loadState", () => {
    it("should return null for non-existent agent", async () => {
      const result = await persistence.loadState("non-existent");
      expect(result).toBeNull();
    });

    it("should call database queryOne", async () => {
      await persistence.loadState("agent-1");
      expect(db.queryOne).toHaveBeenCalled();
    });
  });

  describe("deleteState", () => {
    it("should call database query", async () => {
      await persistence.deleteState("agent-1");
      expect(db.query).toHaveBeenCalled();
    });
  });

  describe("listStates", () => {
    it("should call database query with defaults", async () => {
      await persistence.listStates();
      expect(db.query).toHaveBeenCalled();
    });

    it("should accept limit and offset options", async () => {
      await persistence.listStates({ limit: 50, offset: 10 });
      expect(db.query).toHaveBeenCalled();
    });
  });
});

describe("PostgresCapabilityStore", () => {
  let db: Database;
  let store: PostgresCapabilityStore;

  beforeEach(() => {
    db = createMockDatabase();
    store = new PostgresCapabilityStore(db);
  });

  describe("grantCapability", () => {
    it("should create a capability token", async () => {
      const token = await store.grantCapability("agent-1", "llm:chat");

      expect(token).toBeDefined();
      expect(token.token).toBeDefined();
      expect(token.agentId).toBe("agent-1");
      expect(token.capability).toBe("llm:chat");
      expect(token.grantedBy).toBe("system");
      expect(token.grantedAt).toBeInstanceOf(Date);
      expect(token.revokedAt).toBeNull();
    });

    it("should accept custom grantedBy", async () => {
      const token = await store.grantCapability("agent-1", "llm:chat", {
        grantedBy: "admin-agent",
      });

      expect(token.grantedBy).toBe("admin-agent");
    });

    it("should accept expiresAt", async () => {
      const expiresAt = new Date(Date.now() + 3600000);
      const token = await store.grantCapability("agent-1", "llm:chat", {
        expiresAt,
      });

      expect(token.expiresAt).toEqual(expiresAt);
    });

    it("should accept constraints", async () => {
      const token = await store.grantCapability("agent-1", "llm:chat", {
        constraints: { maxPerMinute: 10 },
      });

      expect(token.constraints).toEqual({ maxPerMinute: 10 });
    });

    it("should generate unique tokens", async () => {
      const token1 = await store.grantCapability("agent-1", "llm:chat");
      const token2 = await store.grantCapability("agent-1", "llm:chat");

      expect(token1.token).not.toBe(token2.token);
    });

    it("should handle all capability types", async () => {
      const capabilities = [
        "llm:chat",
        "llm:stream",
        "memory:read",
        "memory:write",
        "file:read",
        "file:write",
        "network:http",
        "shell:execute",
      ];

      for (const cap of capabilities) {
        const token = await store.grantCapability("agent-1", cap as never);
        expect(token.capability).toBe(cap);
      }
    });
  });

  describe("validateCapability", () => {
    it("should call database queryOne", async () => {
      await store.validateCapability("token-123", "llm:chat");
      expect(db.queryOne).toHaveBeenCalled();
    });

    it("should return false for non-existent token", async () => {
      const valid = await store.validateCapability("non-existent", "llm:chat");
      expect(valid).toBe(false);
    });
  });

  describe("revokeCapability", () => {
    it("should call database query", async () => {
      await store.revokeCapability("token-123");
      expect(db.query).toHaveBeenCalled();
    });
  });

  describe("revokeAllCapabilities", () => {
    it("should call database query", async () => {
      await store.revokeAllCapabilities("agent-1");
      expect(db.query).toHaveBeenCalled();
    });
  });

  describe("listCapabilities", () => {
    it("should call database query", async () => {
      await store.listCapabilities("agent-1");
      expect(db.query).toHaveBeenCalled();
    });
  });
});

describe("PostgresRateLimitStore", () => {
  let db: Database;
  let store: PostgresRateLimitStore;

  beforeEach(() => {
    db = createMockDatabase();
    store = new PostgresRateLimitStore(db);
  });

  describe("getBucket", () => {
    it("should create new bucket with defaults if not exists", async () => {
      const bucket = await store.getBucket("agent-1", "tool_calls");

      expect(bucket).toBeDefined();
      expect(bucket.agentId).toBe("agent-1");
      expect(bucket.bucketType).toBe("tool_calls");
      expect(bucket.capacity).toBeGreaterThan(0);
      expect(bucket.refillRate).toBeGreaterThan(0);
    });

    it("should handle all bucket types", async () => {
      const types = ["tool_calls", "tokens", "messages"] as const;

      for (const type of types) {
        const bucket = await store.getBucket("agent-1", type);
        expect(bucket.bucketType).toBe(type);
      }
    });

    it("should provide different defaults for different bucket types", async () => {
      const toolBucket = await store.getBucket("agent-1", "tool_calls");
      const tokenBucket = await store.getBucket("agent-1", "tokens");
      const messageBucket = await store.getBucket("agent-1", "messages");

      // Each type should have different capacity
      expect(toolBucket.capacity).not.toBe(tokenBucket.capacity);
      expect(tokenBucket.capacity).toBeGreaterThan(messageBucket.capacity);
    });
  });

  describe("saveBucket", () => {
    it("should call database query", async () => {
      const bucket: RateLimitBucket = {
        agentId: "agent-1",
        bucketType: "tool_calls",
        tokens: 50,
        capacity: 60,
        refillRate: 1,
        lastRefill: new Date(),
      };

      await store.saveBucket(bucket);
      expect(db.query).toHaveBeenCalled();
    });
  });

  describe("resetBuckets", () => {
    it("should call database query", async () => {
      await store.resetBuckets("agent-1");
      expect(db.query).toHaveBeenCalled();
    });
  });
});

describe("createPersistenceStores", () => {
  it("should create all three stores", () => {
    const db = createMockDatabase();
    const stores = createPersistenceStores(db);

    expect(stores.statePersistence).toBeInstanceOf(PostgresStatePersistence);
    expect(stores.capabilityStore).toBeInstanceOf(PostgresCapabilityStore);
    expect(stores.rateLimitStore).toBeInstanceOf(PostgresRateLimitStore);
  });
});

describe("Type definitions", () => {
  describe("PersistedAgentState", () => {
    it("should define correct shape", () => {
      const state: PersistedAgentState = {
        agentId: "agent-1",
        state: "running",
        metadata: { foo: "bar" },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      expect(state.agentId).toBe("agent-1");
      expect(state.state).toBe("running");
    });
  });

  describe("CapabilityToken", () => {
    it("should define correct shape", () => {
      const token: CapabilityToken = {
        token: "abc123",
        agentId: "agent-1",
        capability: "llm:chat",
        grantedBy: "system",
        grantedAt: new Date(),
        expiresAt: null,
        revokedAt: null,
        constraints: { maxPerMinute: 10 },
      };

      expect(token.token).toBe("abc123");
      expect(token.capability).toBe("llm:chat");
    });
  });

  describe("RateLimitBucket", () => {
    it("should define correct shape", () => {
      const bucket: RateLimitBucket = {
        agentId: "agent-1",
        bucketType: "tool_calls",
        tokens: 50,
        capacity: 60,
        refillRate: 1,
        lastRefill: new Date(),
      };

      expect(bucket.agentId).toBe("agent-1");
      expect(bucket.bucketType).toBe("tool_calls");
    });
  });
});

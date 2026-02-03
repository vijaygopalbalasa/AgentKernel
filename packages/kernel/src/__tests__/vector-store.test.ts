import { describe, it, expect, vi } from "vitest";

// Mock @qdrant/js-client-rest so tests never make real network calls
vi.mock("@qdrant/js-client-rest", () => {
  class MockQdrantClient {
    getCollections = vi.fn().mockRejectedValue(new Error("mock: no Qdrant"));
    getCollection = vi.fn().mockRejectedValue(new Error("mock: no Qdrant"));
    createCollection = vi.fn().mockResolvedValue(undefined);
    createPayloadIndex = vi.fn().mockResolvedValue(undefined);
    collectionExists = vi.fn().mockResolvedValue(false);
    upsert = vi.fn().mockResolvedValue(undefined);
    search = vi.fn().mockResolvedValue([]);
    retrieve = vi.fn().mockResolvedValue([]);
    delete = vi.fn().mockResolvedValue(undefined);
    count = vi.fn().mockResolvedValue({ count: 0 });
  }
  return { QdrantClient: MockQdrantClient };
});

import {
  createVectorStore,
  checkVectorStoreHealth,
  waitForVectorStore,
  type VectorStore,
  type VectorPoint,
  type SearchResult,
  type SearchFilter,
  type CollectionInfo,
  type Embedding,
} from "../vector-store.js";
import type { QdrantConfig } from "../config.js";

// Note: These tests verify API contracts without requiring a real Qdrant connection.
// Integration tests with real Qdrant should be in a separate test suite.

describe("VectorStore Module API Contracts", () => {
  const mockConfig: QdrantConfig = {
    host: "localhost",
    port: 6333,
    apiKey: undefined,
    https: false,
    collection: "test_collection",
    vectorSize: 1536,
  };

  describe("createVectorStore", () => {
    it("should return a VectorStore object with all required methods", () => {
      const store = createVectorStore(mockConfig);

      // Verify interface completeness
      expect(store).toHaveProperty("ensureCollection");
      expect(store).toHaveProperty("upsert");
      expect(store).toHaveProperty("upsertBatch");
      expect(store).toHaveProperty("search");
      expect(store).toHaveProperty("get");
      expect(store).toHaveProperty("getBatch");
      expect(store).toHaveProperty("delete");
      expect(store).toHaveProperty("deleteBatch");
      expect(store).toHaveProperty("deleteByFilter");
      expect(store).toHaveProperty("count");
      expect(store).toHaveProperty("isHealthy");
      expect(store).toHaveProperty("getInfo");
      expect(store).toHaveProperty("close");

      // Verify types are functions
      expect(typeof store.ensureCollection).toBe("function");
      expect(typeof store.upsert).toBe("function");
      expect(typeof store.upsertBatch).toBe("function");
      expect(typeof store.search).toBe("function");
      expect(typeof store.get).toBe("function");
      expect(typeof store.getBatch).toBe("function");
      expect(typeof store.delete).toBe("function");
      expect(typeof store.deleteBatch).toBe("function");
      expect(typeof store.deleteByFilter).toBe("function");
      expect(typeof store.count).toBe("function");
      expect(typeof store.isHealthy).toBe("function");
      expect(typeof store.getInfo).toBe("function");
      expect(typeof store.close).toBe("function");
    });

    it("should accept optional logger parameter", () => {
      const mockLogger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };

      // Should not throw
      expect(() => createVectorStore(mockConfig, mockLogger as any)).not.toThrow();
    });
  });

  describe("VectorStore.isHealthy", () => {
    it("should return a Promise<boolean>", async () => {
      const store = createVectorStore(mockConfig);
      // Without a live Qdrant, isHealthy returns false
      const result = await store.isHealthy();
      expect(typeof result).toBe("boolean");
      expect(result).toBe(false);
    }, 10000);

    it("should return false when Qdrant is not available", async () => {
      const store = createVectorStore({
        ...mockConfig,
        host: "nonexistent-host-12345",
      });

      const healthy = await store.isHealthy();
      expect(healthy).toBe(false);
    }, 10000);
  });

  describe("VectorStore.close", () => {
    it("should complete without error", async () => {
      const store = createVectorStore(mockConfig);
      await expect(store.close()).resolves.not.toThrow();
    });
  });

  describe("checkVectorStoreHealth", () => {
    it("should return health status object", async () => {
      const store = createVectorStore(mockConfig);
      const health = await checkVectorStoreHealth(store);

      expect(health).toHaveProperty("healthy");
      expect(health).toHaveProperty("latencyMs");
      expect(typeof health.healthy).toBe("boolean");
      expect(typeof health.latencyMs).toBe("number");
    }, 10000);

    it("should include error when unhealthy", async () => {
      const store = createVectorStore({
        ...mockConfig,
        host: "nonexistent-host-12345",
      });

      const health = await checkVectorStoreHealth(store);
      expect(health.healthy).toBe(false);
      expect(health.error).toBeDefined();
    }, 10000);
  });

  describe("waitForVectorStore", () => {
    it("should return false when Qdrant never connects", async () => {
      const store = createVectorStore({
        ...mockConfig,
        host: "nonexistent-host-12345",
      });

      const result = await waitForVectorStore(store, {
        maxRetries: 1,
        retryDelayMs: 10,
      });

      expect(result).toBe(false);
    });

    it("should accept logger option", async () => {
      const mockLogger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };

      const store = createVectorStore(mockConfig);

      await waitForVectorStore(store, {
        maxRetries: 1,
        retryDelayMs: 10,
        logger: mockLogger as any,
      });

      // Logger should have been called
      expect(mockLogger.debug).toHaveBeenCalled();
    }, 10000);
  });
});

describe("Type Definitions", () => {
  describe("Embedding type", () => {
    it("should be an array of numbers", () => {
      const embedding: Embedding = [0.1, 0.2, 0.3, 0.4, 0.5];
      expect(Array.isArray(embedding)).toBe(true);
      expect(embedding.every((n) => typeof n === "number")).toBe(true);
    });

    it("should support 1536 dimensions (OpenAI)", () => {
      const embedding: Embedding = new Array(1536).fill(0).map(() => Math.random());
      expect(embedding.length).toBe(1536);
    });
  });

  describe("VectorPoint type", () => {
    it("should have correct structure", () => {
      const point: VectorPoint = {
        id: "point-123",
        vector: [0.1, 0.2, 0.3],
        payload: {
          agentId: "agent-1",
          type: "episodic",
          content: "test content",
        },
      };

      expect(point.id).toBe("point-123");
      expect(Array.isArray(point.vector)).toBe(true);
      expect(point.payload.agentId).toBe("agent-1");
    });
  });

  describe("SearchResult type", () => {
    it("should have correct structure", () => {
      const result: SearchResult = {
        id: "result-123",
        score: 0.95,
        payload: {
          content: "matched content",
        },
      };

      expect(result.id).toBe("result-123");
      expect(result.score).toBe(0.95);
      expect(result.payload.content).toBe("matched content");
    });

    it("should have score between 0 and 1", () => {
      const result: SearchResult = {
        id: "result",
        score: 0.75,
        payload: {},
      };

      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
    });
  });

  describe("SearchFilter type", () => {
    it("should support match filter", () => {
      const filter: SearchFilter = {
        field: "agentId",
        match: "agent-123",
      };

      expect(filter.field).toBe("agentId");
      expect(filter.match).toBe("agent-123");
    });

    it("should support matchAny filter", () => {
      const filter: SearchFilter = {
        field: "type",
        matchAny: ["episodic", "semantic"],
      };

      expect(filter.matchAny).toEqual(["episodic", "semantic"]);
    });

    it("should support range filter", () => {
      const filter: SearchFilter = {
        field: "importance",
        range: {
          gte: 0.5,
          lte: 1.0,
        },
      };

      expect(filter.range?.gte).toBe(0.5);
      expect(filter.range?.lte).toBe(1.0);
    });
  });

  describe("CollectionInfo type", () => {
    it("should have correct structure", () => {
      const info: CollectionInfo = {
        name: "test_collection",
        pointsCount: 1000,
        vectorsCount: 1000,
        status: "green",
        vectorSize: 1536,
      };

      expect(info.name).toBe("test_collection");
      expect(info.pointsCount).toBe(1000);
      expect(info.status).toBe("green");
      expect(info.vectorSize).toBe(1536);
    });

    it("should support different statuses", () => {
      const statuses: CollectionInfo["status"][] = ["green", "yellow", "red"];

      for (const status of statuses) {
        const info: CollectionInfo = {
          name: "test",
          pointsCount: 0,
          vectorsCount: 0,
          status,
          vectorSize: 1536,
        };
        expect(info.status).toBe(status);
      }
    });
  });
});

describe("Search Options", () => {
  it("should support limit option", () => {
    const options: Parameters<VectorStore["search"]>[1] = {
      limit: 10,
    };
    expect(options.limit).toBe(10);
  });

  it("should support filter option", () => {
    const options: Parameters<VectorStore["search"]>[1] = {
      filter: [
        { field: "agentId", match: "agent-1" },
        { field: "importance", range: { gte: 0.5 } },
      ],
    };
    expect(options.filter?.length).toBe(2);
  });

  it("should support scoreThreshold option", () => {
    const options: Parameters<VectorStore["search"]>[1] = {
      scoreThreshold: 0.7,
    };
    expect(options.scoreThreshold).toBe(0.7);
  });

  it("should support all options combined", () => {
    const options: Parameters<VectorStore["search"]>[1] = {
      limit: 20,
      filter: [{ field: "type", match: "episodic" }],
      scoreThreshold: 0.5,
    };

    expect(options.limit).toBe(20);
    expect(options.filter?.length).toBe(1);
    expect(options.scoreThreshold).toBe(0.5);
  });
});

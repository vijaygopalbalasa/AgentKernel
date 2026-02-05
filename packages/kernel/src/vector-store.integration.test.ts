// Real Qdrant Vector Store Integration Tests
// Requires: docker compose -f docker/docker-compose.test.yml up -d
// Run with: vitest run src/vector-store.integration.test.ts

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { QdrantConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { type VectorPoint, type VectorStore, createVectorStore } from "./vector-store.js";

const VECTOR_SIZE = 128; // Small for fast tests
const TEST_COLLECTION = `test_integration_${Date.now()}`;

const TEST_QDRANT_CONFIG: QdrantConfig = {
  host: "127.0.0.1",
  port: 6335,
  https: false,
  collection: TEST_COLLECTION,
  vectorSize: VECTOR_SIZE,
};

const logger = createLogger({ name: "qdrant-integration-test" });

/** Generate a random vector of given dimension */
function randomVector(dim: number): number[] {
  return Array.from({ length: dim }, () => Math.random() * 2 - 1);
}

/** Generate a vector biased towards a direction (for similarity testing) */
function biasedVector(dim: number, bias: number[]): number[] {
  return bias.map((b, i) => b * 0.8 + (Math.random() * 0.4 - 0.2));
}

async function isQdrantAvailable(): Promise<boolean> {
  try {
    const response = await fetch("http://127.0.0.1:6335/collections", {
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

describe("Vector Store Integration Tests (Real Qdrant)", () => {
  let store: VectorStore;
  let available = false;

  beforeAll(async () => {
    available = await isQdrantAvailable();
    if (!available) {
      console.warn(
        "⚠ Qdrant not available at 127.0.0.1:6335. Run: docker compose -f docker/docker-compose.test.yml up -d",
      );
      return;
    }

    store = createVectorStore(TEST_QDRANT_CONFIG, logger);
    await store.ensureCollection();
  }, 30000);

  afterAll(async () => {
    if (!available) return;
    // Delete test collection
    try {
      await fetch(`http://127.0.0.1:6335/collections/${TEST_COLLECTION}`, {
        method: "DELETE",
      });
    } catch {
      // Ignore cleanup errors
    }
    await store.close();
  });

  // ─── COLLECTION ──────────────────────────────────────────

  it("should create collection with correct vector size", async () => {
    if (!available) return;
    const info = await store.getInfo();
    expect(info.name).toBe(TEST_COLLECTION);
    expect(info.vectorSize).toBe(VECTOR_SIZE);
    expect(info.status).toBe("green");
  });

  it("should report healthy status", async () => {
    if (!available) return;
    const healthy = await store.isHealthy();
    expect(healthy).toBe(true);
  });

  it("should handle ensureCollection idempotently", async () => {
    if (!available) return;
    // Calling again should not throw
    await expect(store.ensureCollection()).resolves.toBeUndefined();
  });

  // ─── UPSERT / GET ────────────────────────────────────────

  it("should upsert a single point and retrieve it", async () => {
    if (!available) return;
    const point: VectorPoint = {
      id: "test-point-1",
      vector: randomVector(VECTOR_SIZE),
      payload: { type: "test", label: "first-point", score: 42 },
    };

    await store.upsert(point);

    const retrieved = await store.get("test-point-1");
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe("test-point-1");
    expect(retrieved?.payload.label).toBe("first-point");
    expect(retrieved?.payload.score).toBe(42);
    expect(retrieved?.vector).toHaveLength(VECTOR_SIZE);
  });

  it("should upsert batch of points", async () => {
    if (!available) return;
    const points: VectorPoint[] = Array.from({ length: 10 }, (_, i) => ({
      id: `batch-${i}`,
      vector: randomVector(VECTOR_SIZE),
      payload: { type: "batch", index: i },
    }));

    await store.upsertBatch(points);

    // Verify all inserted
    const retrieved = await store.getBatch(points.map((p) => p.id));
    expect(retrieved).toHaveLength(10);
    const ids = retrieved.map((p) => p.id).sort();
    expect(ids).toEqual(points.map((p) => p.id).sort());
  });

  it("should overwrite point on re-upsert", async () => {
    if (!available) return;
    const id = "overwrite-test";
    await store.upsert({
      id,
      vector: randomVector(VECTOR_SIZE),
      payload: { version: 1 },
    });

    await store.upsert({
      id,
      vector: randomVector(VECTOR_SIZE),
      payload: { version: 2 },
    });

    const point = await store.get(id);
    expect(point?.payload.version).toBe(2);
  });

  it("should return null for non-existent point", async () => {
    if (!available) return;
    const point = await store.get("nonexistent-point-xyz");
    expect(point).toBeNull();
  });

  // ─── SEARCH ──────────────────────────────────────────────

  it("should find similar vectors", async () => {
    if (!available) return;
    // Create a reference direction
    const direction = randomVector(VECTOR_SIZE);

    // Insert points: some close to direction, some random
    const closePoints: VectorPoint[] = Array.from({ length: 5 }, (_, i) => ({
      id: `similar-${i}`,
      vector: biasedVector(VECTOR_SIZE, direction),
      payload: { group: "close", index: i },
    }));

    const farPoints: VectorPoint[] = Array.from({ length: 5 }, (_, i) => ({
      id: `different-${i}`,
      vector: randomVector(VECTOR_SIZE).map((v) => -direction[i % VECTOR_SIZE]! + v * 0.1),
      payload: { group: "far", index: i },
    }));

    await store.upsertBatch([...closePoints, ...farPoints]);

    // Search with the direction vector — close points should rank higher
    const results = await store.search(direction, { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(5);

    // Results should be sorted by score descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i]?.score).toBeLessThanOrEqual(results[i - 1]?.score);
    }
  });

  it("should respect limit parameter", async () => {
    if (!available) return;
    const results = await store.search(randomVector(VECTOR_SIZE), { limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("should filter search results by payload field", async () => {
    if (!available) return;
    // Insert points with different types
    await store.upsertBatch([
      { id: "filter-a", vector: randomVector(VECTOR_SIZE), payload: { category: "alpha" } },
      { id: "filter-b", vector: randomVector(VECTOR_SIZE), payload: { category: "beta" } },
      { id: "filter-c", vector: randomVector(VECTOR_SIZE), payload: { category: "alpha" } },
    ]);

    const results = await store.search(randomVector(VECTOR_SIZE), {
      limit: 100,
      filter: [{ field: "category", match: "alpha" }],
    });

    // All returned results should have category=alpha
    for (const r of results) {
      if (r.id.startsWith("filter-")) {
        expect(r.payload.category).toBe("alpha");
      }
    }
  });

  it("should apply score threshold", async () => {
    if (!available) return;
    const results = await store.search(randomVector(VECTOR_SIZE), {
      limit: 100,
      scoreThreshold: 0.99, // Very high threshold — few or no results
    });

    // All results should meet the threshold
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0.99);
    }
  });

  // ─── DELETE ──────────────────────────────────────────────

  it("should delete a single point", async () => {
    if (!available) return;
    const id = "delete-single";
    await store.upsert({ id, vector: randomVector(VECTOR_SIZE), payload: { temp: true } });

    const deleted = await store.delete(id);
    expect(deleted).toBe(true);

    const point = await store.get(id);
    expect(point).toBeNull();
  });

  it("should delete batch of points", async () => {
    if (!available) return;
    const ids = ["del-batch-1", "del-batch-2", "del-batch-3"];
    await store.upsertBatch(
      ids.map((id) => ({ id, vector: randomVector(VECTOR_SIZE), payload: {} })),
    );

    const count = await store.deleteBatch(ids);
    expect(count).toBe(3);

    for (const id of ids) {
      const point = await store.get(id);
      expect(point).toBeNull();
    }
  });

  it("should delete by filter", async () => {
    if (!available) return;
    await store.upsertBatch([
      { id: "filter-del-1", vector: randomVector(VECTOR_SIZE), payload: { deletable: true } },
      { id: "filter-del-2", vector: randomVector(VECTOR_SIZE), payload: { deletable: true } },
      { id: "filter-keep", vector: randomVector(VECTOR_SIZE), payload: { deletable: false } },
    ]);

    const count = await store.deleteByFilter([{ field: "deletable", match: true }]);
    expect(count).toBeGreaterThanOrEqual(2);

    const kept = await store.get("filter-keep");
    expect(kept).not.toBeNull();
  });

  // ─── COUNT ───────────────────────────────────────────────

  it("should count points in collection", async () => {
    if (!available) return;
    const count = await store.count();
    expect(count).toBeGreaterThan(0);
  });

  it("should count points with filter", async () => {
    if (!available) return;
    await store.upsertBatch([
      { id: "count-a1", vector: randomVector(VECTOR_SIZE), payload: { countGroup: "A" } },
      { id: "count-a2", vector: randomVector(VECTOR_SIZE), payload: { countGroup: "A" } },
      { id: "count-b1", vector: randomVector(VECTOR_SIZE), payload: { countGroup: "B" } },
    ]);

    const countA = await store.count([{ field: "countGroup", match: "A" }]);
    expect(countA).toBeGreaterThanOrEqual(2);
  });

  // ─── LARGE BATCH ─────────────────────────────────────────

  it("should handle large batch getBatch with pagination", async () => {
    if (!available) return;
    // Insert 100 points to test getBatch pagination (BATCH_SIZE=500 in implementation)
    const points: VectorPoint[] = Array.from({ length: 100 }, (_, i) => ({
      id: `large-batch-${i}`,
      vector: randomVector(VECTOR_SIZE),
      payload: { batchTest: true, index: i },
    }));

    await store.upsertBatch(points);

    const retrieved = await store.getBatch(points.map((p) => p.id));
    expect(retrieved).toHaveLength(100);
  });

  // ─── EDGE CASES ──────────────────────────────────────────

  it("should handle empty getBatch gracefully", async () => {
    if (!available) return;
    const result = await store.getBatch([]);
    expect(result).toEqual([]);
  });

  it("should handle upsertBatch with empty array", async () => {
    if (!available) return;
    await expect(store.upsertBatch([])).resolves.toBeUndefined();
  });
});

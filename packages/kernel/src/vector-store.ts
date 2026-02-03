// Qdrant vector store client for semantic memory
// Handles embeddings storage and similarity search

import { QdrantClient } from "@qdrant/js-client-rest";
import type { QdrantConfig } from "./config.js";
import type { Logger } from "./logger.js";

/** Vector embedding */
export type Embedding = number[];

/** Point to store in Qdrant */
export interface VectorPoint {
  /** Unique identifier */
  id: string;
  /** Vector embedding */
  vector: Embedding;
  /** Payload data */
  payload: Record<string, unknown>;
}

/** Search result from Qdrant */
export interface SearchResult {
  /** Point ID */
  id: string;
  /** Similarity score (0-1, higher is more similar) */
  score: number;
  /** Payload data */
  payload: Record<string, unknown>;
}

/** Filter condition for search */
export interface SearchFilter {
  /** Field to filter on */
  field: string;
  /** Match value */
  match?: unknown;
  /** Match any of these values */
  matchAny?: unknown[];
  /** Range filter */
  range?: {
    gte?: number;
    gt?: number;
    lte?: number;
    lt?: number;
  };
}

/** Vector store interface */
export interface VectorStore {
  /** Ensure collection exists with correct schema */
  ensureCollection(): Promise<void>;

  /** Upsert a single point */
  upsert(point: VectorPoint): Promise<void>;

  /** Upsert multiple points */
  upsertBatch(points: VectorPoint[]): Promise<void>;

  /** Search for similar vectors */
  search(
    vector: Embedding,
    options?: {
      limit?: number;
      filter?: SearchFilter[];
      scoreThreshold?: number;
    }
  ): Promise<SearchResult[]>;

  /** Get point by ID */
  get(id: string): Promise<VectorPoint | null>;

  /** Get multiple points by IDs */
  getBatch(ids: string[]): Promise<VectorPoint[]>;

  /** Delete point by ID */
  delete(id: string): Promise<boolean>;

  /** Delete multiple points by IDs */
  deleteBatch(ids: string[]): Promise<number>;

  /** Delete points matching filter */
  deleteByFilter(filter: SearchFilter[]): Promise<number>;

  /** Count points in collection */
  count(filter?: SearchFilter[]): Promise<number>;

  /** Check if collection is healthy */
  isHealthy(): Promise<boolean>;

  /** Get collection info */
  getInfo(): Promise<CollectionInfo>;

  /** Close connection */
  close(): Promise<void>;
}

/** Collection information */
export interface CollectionInfo {
  /** Collection name */
  name: string;
  /** Number of points */
  pointsCount: number;
  /** Number of vectors */
  vectorsCount: number;
  /** Index status */
  status: "green" | "yellow" | "red";
  /** Vector dimension */
  vectorSize: number;
}

/** Convert our filter format to Qdrant filter format */
function buildQdrantFilter(filters: SearchFilter[]): object {
  if (filters.length === 0) return {};

  const must: object[] = [];

  for (const filter of filters) {
    if (filter.match !== undefined) {
      must.push({
        key: filter.field,
        match: { value: filter.match },
      });
    } else if (filter.matchAny) {
      must.push({
        key: filter.field,
        match: { any: filter.matchAny },
      });
    } else if (filter.range) {
      must.push({
        key: filter.field,
        range: filter.range,
      });
    }
  }

  return must.length > 0 ? { must } : {};
}

/** Create a vector store client */
export function createVectorStore(config: QdrantConfig, logger?: Logger): VectorStore {
  const log = logger ?? {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  const client = new QdrantClient({
    host: config.host,
    port: config.port,
    apiKey: config.apiKey,
    https: config.https,
  });

  const collectionName = config.collection;
  const vectorSize = config.vectorSize;

  const store: VectorStore = {
    async ensureCollection(): Promise<void> {
      try {
        // Check if collection exists
        const collections = await client.getCollections();
        const exists = collections.collections.some(
          (c) => c.name === collectionName
        );

        if (!exists) {
          log.info("Creating Qdrant collection", { name: collectionName, vectorSize });

          await client.createCollection(collectionName, {
            vectors: {
              size: vectorSize,
              distance: "Cosine",
            },
            optimizers_config: {
              default_segment_number: 2,
              memmap_threshold: 20000,
            },
            replication_factor: 1,
          });

          // Create payload indexes for common filter fields
          await client.createPayloadIndex(collectionName, {
            field_name: "agentId",
            field_schema: "keyword",
          });

          await client.createPayloadIndex(collectionName, {
            field_name: "type",
            field_schema: "keyword",
          });

          await client.createPayloadIndex(collectionName, {
            field_name: "createdAt",
            field_schema: "datetime",
          });

          log.info("Qdrant collection created", { name: collectionName });
        } else {
          log.debug("Qdrant collection exists", { name: collectionName });
        }
      } catch (error) {
        log.error("Failed to ensure collection", { error: String(error) });
        throw error;
      }
    },

    async upsert(point: VectorPoint): Promise<void> {
      await client.upsert(collectionName, {
        wait: true,
        points: [
          {
            id: point.id,
            vector: point.vector,
            payload: point.payload,
          },
        ],
      });
    },

    async upsertBatch(points: VectorPoint[]): Promise<void> {
      if (points.length === 0) return;

      // Batch in chunks of 100
      const batchSize = 100;
      for (let i = 0; i < points.length; i += batchSize) {
        const batch = points.slice(i, i + batchSize);
        await client.upsert(collectionName, {
          wait: true,
          points: batch.map((p) => ({
            id: p.id,
            vector: p.vector,
            payload: p.payload,
          })),
        });
      }
    },

    async search(
      vector: Embedding,
      options: {
        limit?: number;
        filter?: SearchFilter[];
        scoreThreshold?: number;
      } = {}
    ): Promise<SearchResult[]> {
      const { limit = 10, filter = [], scoreThreshold = 0 } = options;

      const results = await client.search(collectionName, {
        vector,
        limit,
        filter: filter.length > 0 ? buildQdrantFilter(filter) : undefined,
        score_threshold: scoreThreshold,
        with_payload: true,
      });

      return results.map((r) => ({
        id: String(r.id),
        score: r.score,
        payload: (r.payload ?? {}) as Record<string, unknown>,
      }));
    },

    async get(id: string): Promise<VectorPoint | null> {
      try {
        const results = await client.retrieve(collectionName, {
          ids: [id],
          with_payload: true,
          with_vector: true,
        });

        if (results.length === 0) return null;

        const point = results[0]!;
        return {
          id: String(point.id),
          vector: point.vector as Embedding,
          payload: (point.payload ?? {}) as Record<string, unknown>,
        };
      } catch {
        return null;
      }
    },

    async getBatch(ids: string[]): Promise<VectorPoint[]> {
      if (ids.length === 0) return [];

      try {
        const results = await client.retrieve(collectionName, {
          ids,
          with_payload: true,
          with_vector: true,
        });

        return results.map((point) => ({
          id: String(point.id),
          vector: point.vector as Embedding,
          payload: (point.payload ?? {}) as Record<string, unknown>,
        }));
      } catch {
        return [];
      }
    },

    async delete(id: string): Promise<boolean> {
      try {
        await client.delete(collectionName, {
          wait: true,
          points: [id],
        });
        return true;
      } catch {
        return false;
      }
    },

    async deleteBatch(ids: string[]): Promise<number> {
      if (ids.length === 0) return 0;

      try {
        await client.delete(collectionName, {
          wait: true,
          points: ids,
        });
        return ids.length;
      } catch {
        return 0;
      }
    },

    async deleteByFilter(filter: SearchFilter[]): Promise<number> {
      if (filter.length === 0) return 0;

      try {
        // Count before delete
        const countBefore = await store.count(filter);

        await client.delete(collectionName, {
          wait: true,
          filter: buildQdrantFilter(filter),
        });

        return countBefore;
      } catch {
        return 0;
      }
    },

    async count(filter?: SearchFilter[]): Promise<number> {
      try {
        const result = await client.count(collectionName, {
          filter: filter && filter.length > 0 ? buildQdrantFilter(filter) : undefined,
          exact: true,
        });
        return result.count;
      } catch {
        return 0;
      }
    },

    async isHealthy(): Promise<boolean> {
      try {
        await client.getCollections();
        return true;
      } catch {
        return false;
      }
    },

    async getInfo(): Promise<CollectionInfo> {
      const info = await client.getCollection(collectionName);
      return {
        name: collectionName,
        pointsCount: info.points_count ?? 0,
        vectorsCount: info.indexed_vectors_count ?? info.points_count ?? 0,
        status: info.status === "green" ? "green" : info.status === "yellow" ? "yellow" : "red",
        vectorSize: vectorSize,
      };
    },

    async close(): Promise<void> {
      // QdrantClient doesn't have a close method
      log.info("Vector store connection closed");
    },
  };

  return store;
}

/** Vector store health check */
export async function checkVectorStoreHealth(store: VectorStore): Promise<{
  healthy: boolean;
  latencyMs: number;
  pointsCount?: number;
  error?: string;
}> {
  const start = Date.now();
  try {
    const healthy = await store.isHealthy();
    if (!healthy) {
      return {
        healthy: false,
        latencyMs: Date.now() - start,
        error: "Vector store not responding",
      };
    }

    const info = await store.getInfo();
    return {
      healthy: true,
      latencyMs: Date.now() - start,
      pointsCount: info.pointsCount,
    };
  } catch (error) {
    return {
      healthy: false,
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Wait for vector store to be ready */
export async function waitForVectorStore(
  store: VectorStore,
  options: {
    maxRetries?: number;
    retryDelayMs?: number;
    logger?: Logger;
  } = {}
): Promise<boolean> {
  const { maxRetries = 30, retryDelayMs = 1000, logger } = options;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const healthy = await store.isHealthy();
    if (healthy) {
      logger?.info("Vector store ready", { attempt });
      return true;
    }

    logger?.debug("Waiting for vector store", { attempt, maxRetries });
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }

  logger?.error("Vector store not ready after max retries", { maxRetries });
  return false;
}

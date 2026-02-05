// Per-Agent Rate Limiter — Token bucket algorithm with persistence
// Enforces rate limits at the agent level with smooth refill

import type { RateLimitBucket, RateLimitStore } from "./state-persistence.js";

// ─── TYPES ────────────────────────────────────────────────────────────────

/** Rate limit configuration */
export interface RateLimitConfig {
  /** Tool calls per minute */
  toolCallsPerMinute: number;
  /** Tokens (LLM) per minute */
  tokensPerMinute: number;
  /** Messages per minute */
  messagesPerMinute: number;
  /** Burst multiplier (allows temporary burst above limit) */
  burstMultiplier: number;
  /** Persistence interval in milliseconds (default: 10000) */
  persistenceIntervalMs?: number;
}

/** Result of a rate limit check */
export interface RateLimitResult {
  /** Whether the operation is allowed */
  allowed: boolean;
  /** Remaining tokens in the bucket */
  remaining: number;
  /** Milliseconds until the bucket refills enough for this operation */
  retryAfterMs?: number;
  /** Current bucket state */
  bucket?: TokenBucketState;
}

/** Token bucket state for debugging/monitoring */
export interface TokenBucketState {
  tokens: number;
  capacity: number;
  refillRate: number;
  lastRefill: Date;
}

/** Bucket type */
export type BucketType = "tool" | "token" | "message";

// ─── DEFAULT CONFIG ───────────────────────────────────────────────────────

export const DEFAULT_RATE_LIMIT_CONFIG: Required<RateLimitConfig> = {
  toolCallsPerMinute: 60,
  tokensPerMinute: 100000,
  messagesPerMinute: 30,
  burstMultiplier: 2,
  persistenceIntervalMs: 10000,
};

// ─── TOKEN BUCKET ─────────────────────────────────────────────────────────

/**
 * Token bucket with smooth refill.
 * Tokens are added continuously over time, not in discrete intervals.
 */
export class TokenBucket {
  private _tokens: number;
  private _capacity: number;
  private _refillRate: number; // tokens per second
  private _lastRefill: Date;
  private _lastPersist: Date;
  private readonly persistenceIntervalMs: number;

  constructor(
    capacity: number,
    refillRate: number,
    initialTokens?: number,
    lastRefill?: Date,
    persistenceIntervalMs = 10000,
  ) {
    this._capacity = capacity;
    this._refillRate = refillRate;
    this._tokens = initialTokens ?? capacity;
    this._lastRefill = lastRefill ?? new Date();
    this._lastPersist = new Date();
    this.persistenceIntervalMs = persistenceIntervalMs;
  }

  /** Get current token count (after refill) */
  get tokens(): number {
    this.refill();
    return this._tokens;
  }

  /** Get bucket capacity */
  get capacity(): number {
    return this._capacity;
  }

  /** Get refill rate (tokens per second) */
  get refillRate(): number {
    return this._refillRate;
  }

  /** Get last refill time */
  get lastRefill(): Date {
    return this._lastRefill;
  }

  /**
   * Try to consume tokens from the bucket.
   * Returns true if successful, false if not enough tokens.
   */
  tryConsume(count: number): boolean {
    this.refill();
    if (this._tokens >= count) {
      this._tokens -= count;
      return true;
    }
    return false;
  }

  /**
   * Calculate time until bucket has enough tokens.
   */
  getTimeToRefill(count: number): number {
    this.refill();
    if (this._tokens >= count) {
      return 0;
    }
    const needed = count - this._tokens;
    return Math.ceil((needed / this._refillRate) * 1000);
  }

  /**
   * Check if bucket should be persisted.
   * Returns true if enough time has passed since last persist.
   */
  shouldPersist(): boolean {
    return Date.now() - this._lastPersist.getTime() > this.persistenceIntervalMs;
  }

  /** Mark bucket as persisted */
  markPersisted(): void {
    this._lastPersist = new Date();
  }

  /** Get current state for persistence/debugging */
  getState(): TokenBucketState {
    this.refill();
    return {
      tokens: this._tokens,
      capacity: this._capacity,
      refillRate: this._refillRate,
      lastRefill: this._lastRefill,
    };
  }

  /** Create from persisted state */
  static fromState(state: TokenBucketState, persistenceIntervalMs?: number): TokenBucket {
    return new TokenBucket(
      state.capacity,
      state.refillRate,
      state.tokens,
      state.lastRefill,
      persistenceIntervalMs,
    );
  }

  /** Refill tokens based on elapsed time */
  private refill(): void {
    const now = new Date();
    const elapsed = (now.getTime() - this._lastRefill.getTime()) / 1000;
    if (elapsed > 0) {
      const tokensToAdd = elapsed * this._refillRate;
      this._tokens = Math.min(this._capacity, this._tokens + tokensToAdd);
      this._lastRefill = now;
    }
  }
}

// ─── AGENT RATE LIMITER ───────────────────────────────────────────────────

/**
 * Per-agent rate limiter with optional persistence.
 */
export class AgentRateLimiter {
  private readonly buckets: Map<string, TokenBucket> = new Map();
  private readonly config: Required<RateLimitConfig>;
  private readonly persistence?: RateLimitStore;

  constructor(config: Partial<RateLimitConfig> = {}, persistence?: RateLimitStore) {
    // Merge config with defaults, ensuring persistenceIntervalMs is always set
    this.config = {
      ...DEFAULT_RATE_LIMIT_CONFIG,
      ...config,
      persistenceIntervalMs:
        config.persistenceIntervalMs ?? DEFAULT_RATE_LIMIT_CONFIG.persistenceIntervalMs,
    };
    this.persistence = persistence;
  }

  /**
   * Check and consume rate limit tokens.
   * Returns whether the operation is allowed.
   */
  async checkLimit(agentId: string, type: BucketType, count = 1): Promise<RateLimitResult> {
    const bucket = await this.getOrCreateBucket(agentId, type);

    const allowed = bucket.tryConsume(count);

    if (!allowed) {
      return {
        allowed: false,
        remaining: bucket.tokens,
        retryAfterMs: bucket.getTimeToRefill(count),
        bucket: bucket.getState(),
      };
    }

    // Persist periodically
    if (this.persistence && bucket.shouldPersist()) {
      await this.persistBucket(agentId, type, bucket);
      bucket.markPersisted();
    }

    return {
      allowed: true,
      remaining: bucket.tokens,
      bucket: bucket.getState(),
    };
  }

  /**
   * Check rate limit without consuming tokens.
   */
  async peekLimit(agentId: string, type: BucketType, count = 1): Promise<RateLimitResult> {
    const bucket = await this.getOrCreateBucket(agentId, type);
    const state = bucket.getState();

    return {
      allowed: state.tokens >= count,
      remaining: state.tokens,
      retryAfterMs: state.tokens >= count ? undefined : bucket.getTimeToRefill(count),
      bucket: state,
    };
  }

  /**
   * Reset rate limits for an agent.
   */
  async resetLimits(agentId: string): Promise<void> {
    // Clear in-memory buckets
    for (const type of ["tool", "token", "message"] as BucketType[]) {
      const key = this.getBucketKey(agentId, type);
      this.buckets.delete(key);
    }

    // Clear persisted buckets
    if (this.persistence) {
      await this.persistence.resetBuckets(agentId);
    }
  }

  /**
   * Get current rate limit status for an agent.
   */
  async getStatus(agentId: string): Promise<Record<BucketType, TokenBucketState>> {
    const tool = await this.getOrCreateBucket(agentId, "tool");
    const token = await this.getOrCreateBucket(agentId, "token");
    const message = await this.getOrCreateBucket(agentId, "message");

    return {
      tool: tool.getState(),
      token: token.getState(),
      message: message.getState(),
    };
  }

  /**
   * Flush all buckets to persistence.
   */
  async flush(): Promise<void> {
    if (!this.persistence) return;

    for (const [key, bucket] of this.buckets) {
      const [agentId, type] = key.split(":");
      if (agentId && type) {
        await this.persistBucket(agentId, type as BucketType, bucket);
      }
    }
  }

  /** Get or create a bucket for an agent/type */
  private async getOrCreateBucket(agentId: string, type: BucketType): Promise<TokenBucket> {
    const key = this.getBucketKey(agentId, type);
    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = await this.loadOrCreateBucket(agentId, type);
      this.buckets.set(key, bucket);
    }

    return bucket;
  }

  /** Load bucket from persistence or create new */
  private async loadOrCreateBucket(agentId: string, type: BucketType): Promise<TokenBucket> {
    const config = this.getBucketConfig(type);

    if (this.persistence) {
      const bucketType = this.typeToBucketType(type);
      const persisted = await this.persistence.getBucket(agentId, bucketType);

      return new TokenBucket(
        config.capacity,
        config.refillRate,
        persisted.tokens,
        persisted.lastRefill,
        this.config.persistenceIntervalMs,
      );
    }

    return new TokenBucket(
      config.capacity,
      config.refillRate,
      undefined,
      undefined,
      this.config.persistenceIntervalMs,
    );
  }

  /** Persist bucket state */
  private async persistBucket(
    agentId: string,
    type: BucketType,
    bucket: TokenBucket,
  ): Promise<void> {
    if (!this.persistence) return;

    const state = bucket.getState();
    await this.persistence.saveBucket({
      agentId,
      bucketType: this.typeToBucketType(type),
      tokens: state.tokens,
      capacity: state.capacity,
      refillRate: state.refillRate,
      lastRefill: state.lastRefill,
    });
  }

  /** Get bucket configuration for type */
  private getBucketConfig(type: BucketType): { capacity: number; refillRate: number } {
    const burst = this.config.burstMultiplier;
    switch (type) {
      case "tool":
        return {
          capacity: this.config.toolCallsPerMinute * burst,
          refillRate: this.config.toolCallsPerMinute / 60,
        };
      case "token":
        return {
          capacity: this.config.tokensPerMinute * burst,
          refillRate: this.config.tokensPerMinute / 60,
        };
      case "message":
        return {
          capacity: this.config.messagesPerMinute * burst,
          refillRate: this.config.messagesPerMinute / 60,
        };
    }
  }

  /** Convert bucket type to persistence format */
  private typeToBucketType(type: BucketType): "tool_calls" | "tokens" | "messages" {
    switch (type) {
      case "tool":
        return "tool_calls";
      case "token":
        return "tokens";
      case "message":
        return "messages";
    }
  }

  /** Get bucket key for Map */
  private getBucketKey(agentId: string, type: BucketType): string {
    return `${agentId}:${type}`;
  }
}

// ─── FACTORY FUNCTION ─────────────────────────────────────────────────────

/**
 * Create an agent rate limiter with default configuration.
 */
export function createAgentRateLimiter(
  config?: Partial<RateLimitConfig>,
  persistence?: RateLimitStore,
): AgentRateLimiter {
  return new AgentRateLimiter(config, persistence);
}

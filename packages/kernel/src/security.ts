// Security Utilities
// Input validation, secrets management, rate limiting, audit logging

import { type Result, err, ok } from "@agentkernel/shared";
import { z } from "zod";
import { createLogger } from "./logger.js";

const log = createLogger({ name: "security" });

// ─── INPUT VALIDATION ────────────────────────────────────────

/**
 * Validates and sanitizes input using a Zod schema.
 */
export function validateInput<T>(
  schema: z.ZodSchema<T>,
  input: unknown,
  context?: string,
): Result<T, z.ZodError> {
  const result = schema.safeParse(input);
  if (result.success) {
    return ok(result.data);
  }

  log.warn("Input validation failed", {
    context,
    errors: result.error.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    })),
  });

  return err(result.error);
}

/**
 * Common validation schemas for reuse.
 */
export const ValidationSchemas = {
  // Agent ID: alphanumeric with hyphens, 1-64 chars
  agentId: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/, "Invalid agent ID format"),

  // Task ID: UUID format
  taskId: z.string().uuid("Invalid task ID format"),

  // Event type: namespaced format (e.g., "agent.started")
  eventType: z.string().regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/, "Invalid event type format"),

  // URL: valid URL format
  url: z.string().url("Invalid URL format"),

  // Email: valid email format
  email: z.string().email("Invalid email format"),

  // Safe string: no control characters or script injection
  safeString: z.string().regex(/^[^<>{}]*$/, "String contains unsafe characters"),

  // Positive integer
  positiveInt: z.number().int().positive(),

  // Non-negative integer
  nonNegativeInt: z.number().int().nonnegative(),

  // Timestamp: ISO 8601 date string
  timestamp: z.string().datetime({ offset: true }),

  // JSON object (for metadata)
  jsonObject: z.record(z.unknown()),
};

/**
 * Sanitize a string by removing potentially dangerous characters.
 */
export function sanitizeString(input: string): string {
  return input
    .replace(/[<>]/g, "") // Remove angle brackets
    .replace(/javascript:/gi, "") // Remove javascript: protocol
    .replace(/on\w+=/gi, "") // Remove event handlers
    .trim();
}

/**
 * Sanitize an object recursively.
 */
export function sanitizeObject<T extends Record<string, unknown>>(obj: T): T {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string") {
      result[key] = sanitizeString(value);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        typeof item === "string"
          ? sanitizeString(item)
          : typeof item === "object" && item !== null
            ? sanitizeObject(item as Record<string, unknown>)
            : item,
      );
    } else if (typeof value === "object" && value !== null) {
      result[key] = sanitizeObject(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }

  return result as T;
}

// ─── SECRETS MANAGEMENT ──────────────────────────────────────

export interface SecretReference {
  type: "env" | "vault" | "file";
  key: string;
  /** Optional vault name for multi-vault setups */
  vault?: string;
}

export const SecretReferenceSchema = z.object({
  type: z.enum(["env", "vault", "file"]),
  key: z.string().min(1),
  vault: z.string().optional(),
});

/**
 * Interface for vault secret providers.
 * Implement this interface to integrate with HashiCorp Vault, AWS Secrets Manager, etc.
 */
export interface VaultProvider {
  /** Unique name for this vault provider */
  name: string;
  /** Resolve a secret by key */
  getSecret(key: string): Promise<Result<string, Error>>;
  /** Check if the vault is healthy/reachable */
  healthCheck(): Promise<boolean>;
}

/**
 * Simple environment-based vault provider.
 * Maps vault keys to environment variables with a configurable prefix.
 */
export class EnvVaultProvider implements VaultProvider {
  readonly name: string;
  private readonly prefix: string;

  constructor(name = "env-vault", prefix = "VAULT_SECRET_") {
    this.name = name;
    this.prefix = prefix;
  }

  async getSecret(key: string): Promise<Result<string, Error>> {
    const envKey = `${this.prefix}${key.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
    const value = process.env[envKey];
    if (value === undefined) {
      return err(new Error(`Vault secret not found: ${key} (env: ${envKey})`));
    }
    return ok(value);
  }

  async healthCheck(): Promise<boolean> {
    return true; // Environment is always available
  }
}

// Registry of vault providers
const vaultProviders: Map<string, VaultProvider> = new Map();

/**
 * Register a vault provider for use with vault secret references.
 */
export function registerVaultProvider(provider: VaultProvider): void {
  vaultProviders.set(provider.name, provider);
  log.info("Vault provider registered", { name: provider.name });
}

/**
 * Unregister a vault provider.
 */
export function unregisterVaultProvider(name: string): boolean {
  const removed = vaultProviders.delete(name);
  if (removed) {
    log.info("Vault provider unregistered", { name });
  }
  return removed;
}

/**
 * Get a registered vault provider by name.
 */
export function getVaultProvider(name: string): VaultProvider | undefined {
  return vaultProviders.get(name);
}

/**
 * Get the default vault provider (first registered, or undefined).
 */
export function getDefaultVaultProvider(): VaultProvider | undefined {
  const first = vaultProviders.values().next();
  return first.done ? undefined : first.value;
}

/**
 * Clear all vault providers.
 */
export function clearVaultProviders(): void {
  vaultProviders.clear();
}

/**
 * Secret patterns that should never appear in logs or outputs.
 */
const SECRET_PATTERNS = [
  /api[_-]?key/i,
  /secret[_-]?key/i,
  /password/i,
  /token/i,
  /credential/i,
  /private[_-]?key/i,
  /auth[_-]?token/i,
  /bearer/i,
  /jwt/i,
  /ssh[_-]?key/i,
];

/**
 * Check if a key name looks like it contains a secret.
 */
export function isSecretKey(key: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(key));
}

/**
 * Resolve a secret from its reference.
 *
 * For vault secrets, you must first register a vault provider using `registerVaultProvider()`.
 * See the VaultProvider interface for implementation details.
 *
 * @example
 * ```ts
 * // Register a vault provider
 * registerVaultProvider(new EnvVaultProvider("my-vault", "SECRET_"));
 *
 * // Resolve a vault secret
 * const result = await resolveSecret({ type: "vault", key: "api-key" });
 * ```
 */
export async function resolveSecret(ref: SecretReference): Promise<Result<string, Error>> {
  try {
    switch (ref.type) {
      case "env": {
        const value = process.env[ref.key];
        if (value === undefined) {
          return err(new Error(`Environment variable not found: ${ref.key}`));
        }
        return ok(value);
      }

      case "vault": {
        const provider = ref.vault ? getVaultProvider(ref.vault) : getDefaultVaultProvider();

        if (!provider) {
          return err(
            new Error(
              "No vault provider registered. " +
                "Register a provider using registerVaultProvider() before resolving vault secrets. " +
                "You can use EnvVaultProvider for environment-based secrets, or implement VaultProvider " +
                "for HashiCorp Vault, AWS Secrets Manager, or other secret stores.",
            ),
          );
        }

        return provider.getSecret(ref.key);
      }

      case "file": {
        const fs = await import("node:fs/promises");
        const content = await fs.readFile(ref.key, "utf-8");
        return ok(content.trim());
      }

      default:
        return err(new Error(`Unknown secret type: ${ref.type}`));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(new Error(`Failed to resolve secret: ${message}`));
  }
}

/**
 * Mask a secret value for safe logging.
 */
export function maskSecret(value: string, visibleChars = 4): string {
  if (value.length <= visibleChars * 2) {
    return "*".repeat(value.length);
  }
  const start = value.slice(0, visibleChars);
  const end = value.slice(-visibleChars);
  const masked = "*".repeat(Math.min(value.length - visibleChars * 2, 8));
  return `${start}${masked}${end}`;
}

/**
 * Redact secrets from an object before logging.
 */
export function redactSecrets<T extends Record<string, unknown>>(obj: T): T {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (isSecretKey(key)) {
      result[key] = typeof value === "string" ? maskSecret(value) : "[REDACTED]";
    } else if (typeof value === "string" && isSecretKey(key)) {
      result[key] = maskSecret(value);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        typeof item === "object" && item !== null
          ? redactSecrets(item as Record<string, unknown>)
          : item,
      );
    } else if (typeof value === "object" && value !== null) {
      result[key] = redactSecrets(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }

  return result as T;
}

// ─── RATE LIMITING ───────────────────────────────────────────

export interface RateLimitConfig {
  windowMs: number; // Time window in milliseconds
  maxRequests: number; // Max requests per window
  keyPrefix?: string; // Prefix for rate limit keys
}

export const RateLimitConfigSchema = z.object({
  windowMs: z.number().min(1000).optional().default(60000), // 1 minute default
  maxRequests: z.number().min(1).optional().default(100),
  keyPrefix: z.string().optional().default("ratelimit"),
});

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

/**
 * In-memory rate limiter for development/testing.
 */
export class RateLimiter {
  private config: RateLimitConfig;
  private entries: Map<string, RateLimitEntry> = new Map();
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(config: Partial<RateLimitConfig> = {}) {
    this.config = RateLimitConfigSchema.parse(config);
    this.startCleanup();
  }

  /**
   * Check if a request is allowed for the given key.
   */
  isAllowed(key: string): { allowed: boolean; remaining: number; resetAt: number } {
    const fullKey = `${this.config.keyPrefix}:${key}`;
    const now = Date.now();

    let entry = this.entries.get(fullKey);

    // Reset if window expired
    if (!entry || now >= entry.resetAt) {
      entry = {
        count: 0,
        resetAt: now + this.config.windowMs,
      };
    }

    const remaining = Math.max(0, this.config.maxRequests - entry.count);
    const allowed = entry.count < this.config.maxRequests;

    return { allowed, remaining, resetAt: entry.resetAt };
  }

  /**
   * Record a request for the given key.
   */
  record(key: string): { allowed: boolean; remaining: number; resetAt: number } {
    const fullKey = `${this.config.keyPrefix}:${key}`;
    const now = Date.now();

    let entry = this.entries.get(fullKey);

    // Reset if window expired
    if (!entry || now >= entry.resetAt) {
      entry = {
        count: 0,
        resetAt: now + this.config.windowMs,
      };
    }

    entry.count++;
    this.entries.set(fullKey, entry);

    const remaining = Math.max(0, this.config.maxRequests - entry.count);
    const allowed = entry.count <= this.config.maxRequests;

    if (!allowed) {
      log.warn("Rate limit exceeded", {
        key,
        count: entry.count,
        maxRequests: this.config.maxRequests,
        resetAt: new Date(entry.resetAt).toISOString(),
      });
    }

    return { allowed, remaining, resetAt: entry.resetAt };
  }

  /**
   * Reset rate limit for a specific key.
   */
  reset(key: string): void {
    const fullKey = `${this.config.keyPrefix}:${key}`;
    this.entries.delete(fullKey);
  }

  /**
   * Reset all rate limits.
   */
  resetAll(): void {
    this.entries.clear();
  }

  /**
   * Get current stats for a key.
   */
  getStats(key: string): { count: number; remaining: number; resetAt: number } | null {
    const fullKey = `${this.config.keyPrefix}:${key}`;
    const entry = this.entries.get(fullKey);

    if (!entry || Date.now() >= entry.resetAt) {
      return null;
    }

    return {
      count: entry.count,
      remaining: Math.max(0, this.config.maxRequests - entry.count),
      resetAt: entry.resetAt,
    };
  }

  /**
   * Start periodic cleanup of expired entries.
   */
  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.entries.entries()) {
        if (now >= entry.resetAt) {
          this.entries.delete(key);
        }
      }
    }, this.config.windowMs);
  }

  /**
   * Stop the rate limiter and cleanup.
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.entries.clear();
  }
}

/**
 * Interface for a Redis-compatible client.
 * Accepts ioredis or any client with these methods.
 */
export interface RedisLike {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<number>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
}

/**
 * Redis-backed rate limiter for distributed deployments.
 * Uses INCR + PEXPIRE for atomic window-based counting.
 */
export class RedisRateLimiter {
  private config: RateLimitConfig;
  private redis: RedisLike;

  constructor(redis: RedisLike, config: Partial<RateLimitConfig> = {}) {
    this.config = RateLimitConfigSchema.parse(config);
    this.redis = redis;
  }

  /**
   * Record a request and check if it is allowed.
   */
  async record(key: string): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
    const windowMs = this.config.windowMs;
    const now = Date.now();
    const windowKey = `${this.config.keyPrefix}:${key}:${Math.floor(now / windowMs)}`;

    const count = await this.redis.incr(windowKey);
    if (count === 1) {
      await this.redis.pexpire(windowKey, windowMs);
    }

    const allowed = count <= this.config.maxRequests;
    const remaining = Math.max(0, this.config.maxRequests - count);
    const resetAt = (Math.floor(now / windowMs) + 1) * windowMs;

    if (!allowed) {
      log.warn("Rate limit exceeded (Redis)", {
        key,
        count,
        maxRequests: this.config.maxRequests,
        resetAt: new Date(resetAt).toISOString(),
      });
    }

    return { allowed, remaining, resetAt };
  }

  /**
   * Check if a request would be allowed (read-only).
   */
  async isAllowed(key: string): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
    const windowMs = this.config.windowMs;
    const now = Date.now();
    const windowKey = `${this.config.keyPrefix}:${key}:${Math.floor(now / windowMs)}`;

    const raw = await this.redis.get(windowKey);
    const count = raw ? Number.parseInt(raw, 10) : 0;

    const allowed = count < this.config.maxRequests;
    const remaining = Math.max(0, this.config.maxRequests - count);
    const resetAt = (Math.floor(now / windowMs) + 1) * windowMs;

    return { allowed, remaining, resetAt };
  }

  /**
   * Reset rate limit for a specific key.
   */
  async reset(key: string): Promise<void> {
    const windowMs = this.config.windowMs;
    const now = Date.now();
    const windowKey = `${this.config.keyPrefix}:${key}:${Math.floor(now / windowMs)}`;
    await this.redis.del(windowKey);
  }

  /**
   * Get current stats for a key.
   */
  async getStats(
    key: string,
  ): Promise<{ count: number; remaining: number; resetAt: number } | null> {
    const windowMs = this.config.windowMs;
    const now = Date.now();
    const windowKey = `${this.config.keyPrefix}:${key}:${Math.floor(now / windowMs)}`;

    const raw = await this.redis.get(windowKey);
    if (!raw) return null;

    const count = Number.parseInt(raw, 10);
    return {
      count,
      remaining: Math.max(0, this.config.maxRequests - count),
      resetAt: (Math.floor(now / windowMs) + 1) * windowMs,
    };
  }

  destroy(): void {
    // No-op — Redis connection lifecycle is managed externally
  }
}

/**
 * Factory: create a rate limiter backed by Redis if available, otherwise in-memory.
 */
export function createRateLimiter(
  config: Partial<RateLimitConfig> = {},
  redis?: RedisLike,
): RateLimiter | RedisRateLimiter {
  if (redis) {
    return new RedisRateLimiter(redis, config);
  }
  return new RateLimiter(config);
}

// Global rate limiters by purpose
const rateLimiters: Map<string, RateLimiter> = new Map();

/**
 * Get or create a rate limiter for a specific purpose.
 */
export function getRateLimiter(name: string, config?: Partial<RateLimitConfig>): RateLimiter {
  let limiter = rateLimiters.get(name);
  if (!limiter) {
    limiter = new RateLimiter(config);
    rateLimiters.set(name, limiter);
  }
  return limiter;
}

/**
 * Destroy all rate limiters.
 */
export function destroyAllRateLimiters(): void {
  for (const limiter of rateLimiters.values()) {
    limiter.destroy();
  }
  rateLimiters.clear();
}

// ─── AUDIT LOGGING ───────────────────────────────────────────

export type AuditAction =
  | "agent.create"
  | "agent.delete"
  | "agent.start"
  | "agent.stop"
  | "agent.update"
  | "task.create"
  | "task.complete"
  | "task.fail"
  | "permission.grant"
  | "permission.revoke"
  | "secret.access"
  | "config.change"
  | "auth.login"
  | "auth.logout"
  | "auth.failed"
  | "data.export"
  | "data.delete";

export interface AuditEntry {
  timestamp: Date;
  action: AuditAction;
  actor: string; // Who performed the action (agent ID, user ID, or "system")
  target?: string; // What was acted upon
  details?: Record<string, unknown>;
  outcome: "success" | "failure";
  ip?: string;
  userAgent?: string;
}

export const AuditEntrySchema = z.object({
  timestamp: z.date(),
  action: z.string(),
  actor: z.string(),
  target: z.string().optional(),
  details: z.record(z.unknown()).optional(),
  outcome: z.enum(["success", "failure"]),
  ip: z.string().optional(),
  userAgent: z.string().optional(),
});

export interface AuditStorage {
  write(entry: AuditEntry): Promise<void>;
  query(filter: {
    actor?: string;
    action?: AuditAction;
    target?: string;
    from?: Date;
    to?: Date;
    limit?: number;
    offset?: number;
  }): Promise<AuditEntry[]>;
}

/**
 * In-memory audit storage for development/testing.
 */
export class InMemoryAuditStorage implements AuditStorage {
  private entries: AuditEntry[] = [];
  private maxEntries: number;

  constructor(maxEntries = 10000) {
    this.maxEntries = maxEntries;
  }

  async write(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);

    // Trim old entries if exceeding max
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
  }

  async query(filter: {
    actor?: string;
    action?: AuditAction;
    target?: string;
    from?: Date;
    to?: Date;
    limit?: number;
    offset?: number;
  }): Promise<AuditEntry[]> {
    let results = [...this.entries];

    if (filter.actor) {
      results = results.filter((e) => e.actor === filter.actor);
    }
    if (filter.action) {
      results = results.filter((e) => e.action === filter.action);
    }
    if (filter.target) {
      results = results.filter((e) => e.target === filter.target);
    }
    if (filter.from) {
      results = results.filter((e) => e.timestamp >= filter.from!);
    }
    if (filter.to) {
      results = results.filter((e) => e.timestamp <= filter.to!);
    }

    // Sort by timestamp descending
    results.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? 100;

    return results.slice(offset, offset + limit);
  }

  clear(): void {
    this.entries = [];
  }

  getAll(): AuditEntry[] {
    return [...this.entries];
  }
}

/**
 * Audit logger for recording sensitive operations.
 */
export class AuditLogger {
  private storage: AuditStorage;

  constructor(storage: AuditStorage) {
    this.storage = storage;
  }

  /**
   * Log an audit entry.
   */
  async log(
    action: AuditAction,
    actor: string,
    outcome: "success" | "failure",
    options?: {
      target?: string;
      details?: Record<string, unknown>;
      ip?: string;
      userAgent?: string;
    },
  ): Promise<void> {
    const entry: AuditEntry = {
      timestamp: new Date(),
      action,
      actor,
      outcome,
      target: options?.target,
      details: options?.details ? redactSecrets(options.details) : undefined,
      ip: options?.ip,
      userAgent: options?.userAgent,
    };

    await this.storage.write(entry);

    // Also log to structured logger for real-time monitoring
    const logFn = outcome === "success" ? log.info.bind(log) : log.warn.bind(log);
    logFn("Audit event", {
      action,
      actor,
      target: options?.target,
      outcome,
    });
  }

  /**
   * Query audit log.
   */
  async query(filter: {
    actor?: string;
    action?: AuditAction;
    target?: string;
    from?: Date;
    to?: Date;
    limit?: number;
    offset?: number;
  }): Promise<AuditEntry[]> {
    return this.storage.query(filter);
  }
}

// Global audit logger
let globalAuditLogger: AuditLogger | undefined;

/**
 * Get or create the global audit logger.
 */
export function getAuditLogger(storage?: AuditStorage): AuditLogger {
  if (!globalAuditLogger) {
    globalAuditLogger = new AuditLogger(storage ?? new InMemoryAuditStorage());
  }
  return globalAuditLogger;
}

/**
 * Reset the global audit logger.
 */
export function resetAuditLogger(): void {
  globalAuditLogger = undefined;
}

// ─── SECURITY HEADERS ────────────────────────────────────────

/**
 * Security headers for HTTP responses.
 */
export const SecurityHeaders = {
  // Prevent XSS attacks
  "X-Content-Type-Options": "nosniff",
  "X-XSS-Protection": "1; mode=block",

  // Prevent clickjacking
  "X-Frame-Options": "DENY",

  // Control referrer information
  "Referrer-Policy": "strict-origin-when-cross-origin",

  // Content Security Policy
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'",

  // Strict Transport Security (HTTPS only)
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",

  // Prevent MIME type sniffing
  "X-Permitted-Cross-Domain-Policies": "none",
};

/**
 * CORS configuration.
 */
export interface CorsConfig {
  origins: string[] | "*";
  methods: string[];
  allowedHeaders: string[];
  exposedHeaders: string[];
  credentials: boolean;
  maxAge: number;
}

export const CorsConfigSchema = z.object({
  origins: z
    .union([z.array(z.string()), z.literal("*")])
    .optional()
    .default(["http://localhost:3000"]),
  methods: z.array(z.string()).optional().default(["GET", "POST", "PUT", "DELETE", "OPTIONS"]),
  allowedHeaders: z
    .array(z.string())
    .optional()
    .default(["Content-Type", "Authorization", "X-Request-ID"]),
  exposedHeaders: z.array(z.string()).optional().default(["X-Request-ID", "X-RateLimit-Remaining"]),
  credentials: z.boolean().optional().default(false),
  maxAge: z.number().optional().default(86400), // 24 hours
});

/**
 * Generate CORS headers based on configuration.
 */
export function getCorsHeaders(config: CorsConfig, origin?: string): Record<string, string> {
  const headers: Record<string, string> = {};

  // Access-Control-Allow-Origin
  if (config.origins === "*") {
    headers["Access-Control-Allow-Origin"] = "*";
  } else if (origin && config.origins.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers.Vary = "Origin";
  }

  // Access-Control-Allow-Methods
  headers["Access-Control-Allow-Methods"] = config.methods.join(", ");

  // Access-Control-Allow-Headers
  headers["Access-Control-Allow-Headers"] = config.allowedHeaders.join(", ");

  // Access-Control-Expose-Headers
  if (config.exposedHeaders.length > 0) {
    headers["Access-Control-Expose-Headers"] = config.exposedHeaders.join(", ");
  }

  // Access-Control-Allow-Credentials
  if (config.credentials) {
    headers["Access-Control-Allow-Credentials"] = "true";
  }

  // Access-Control-Max-Age
  headers["Access-Control-Max-Age"] = config.maxAge.toString();

  return headers;
}

// ─── REQUEST VALIDATION ──────────────────────────────────────

/**
 * Validate that a request has required headers.
 */
export function validateRequestHeaders(
  headers: Record<string, string | undefined>,
  required: string[],
): Result<void, Error> {
  const missing = required.filter((h) => !headers[h.toLowerCase()]);
  if (missing.length > 0) {
    return err(new Error(`Missing required headers: ${missing.join(", ")}`));
  }
  return ok(undefined);
}

/**
 * Validate content type.
 */
export function validateContentType(
  contentType: string | undefined,
  allowed: string[],
): Result<void, Error> {
  if (!contentType) {
    return err(new Error("Missing Content-Type header"));
  }

  const type = contentType.split(";")[0]?.trim() ?? "";
  if (!allowed.includes(type)) {
    return err(new Error(`Invalid Content-Type: ${type}. Allowed: ${allowed.join(", ")}`));
  }

  return ok(undefined);
}

/**
 * Validate request size.
 */
export function validateRequestSize(size: number, maxSize: number): Result<void, Error> {
  if (size > maxSize) {
    return err(new Error(`Request size ${size} exceeds maximum ${maxSize}`));
  }
  return ok(undefined);
}

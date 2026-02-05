// Configuration — loads from YAML + environment variables
// Layered config: defaults → YAML file → env vars → CLI args

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/** Weak passwords that should never be used in production */
const WEAK_PASSWORDS = [
  "agentkernel",
  "password",
  "secret",
  "admin",
  "root",
  "test",
  "123456",
  "postgres",
];

/** Database configuration */
export const DatabaseConfigSchema = z.object({
  host: z.string().default("localhost"),
  port: z.number().default(5432),
  database: z.string().default("agentkernel"),
  user: z.string().default("agentkernel"),
  password: z.string().default("agentkernel"),
  maxConnections: z.number().default(100),
  idleTimeout: z.number().default(30000),
  ssl: z.boolean().default(false),
});

/**
 * Validate database configuration for production use.
 * Throws if using weak credentials in production.
 */
export function validateDatabaseConfigForProduction(config: DatabaseConfig): void {
  const isProduction =
    process.env.NODE_ENV === "production" || process.env.ENFORCE_PRODUCTION_HARDENING === "true";

  if (!isProduction) {
    return; // Skip validation in development
  }

  // Check for weak passwords
  if (WEAK_PASSWORDS.includes(config.password.toLowerCase())) {
    throw new Error(
      `[SECURITY] Database password '${config.password}' is too weak for production. Use a strong password (min 16 characters, mixed case, numbers, symbols).`,
    );
  }

  // Check minimum password length
  if (config.password.length < 16) {
    throw new Error("[SECURITY] Database password must be at least 16 characters in production.");
  }

  // Require SSL in production
  if (!config.ssl) {
    console.warn(
      "[SECURITY WARNING] Database SSL is disabled. " +
        "Enable SSL for production deployments to encrypt database connections.",
    );
  }
}

/** Qdrant vector store configuration */
export const QdrantConfigSchema = z.object({
  host: z.string().default("localhost"),
  port: z.number().default(6333),
  apiKey: z.string().optional(),
  https: z.boolean().default(false),
  collection: z.string().default("agentkernel_memory"),
  vectorSize: z.number().default(1536),
});

/** Redis Sentinel node */
export const RedisSentinelNodeSchema = z.object({
  host: z.string(),
  port: z.number(),
});

/** Redis configuration */
export const RedisConfigSchema = z.object({
  host: z.string().default("localhost"),
  port: z.number().default(6379),
  password: z.string().optional(),
  db: z.number().default(0),
  keyPrefix: z.string().default("agentkernel:"),
  /** Connection mode: standalone (default), sentinel for HA failover, cluster for sharding */
  mode: z.enum(["standalone", "sentinel", "cluster"]).default("standalone"),
  /** Sentinel nodes (required when mode=sentinel) */
  sentinels: z.array(RedisSentinelNodeSchema).optional(),
  /** Sentinel master name (required when mode=sentinel) */
  sentinelName: z.string().optional(),
  /** Cluster nodes as host:port strings (required when mode=cluster) */
  clusterNodes: z.array(z.string()).optional(),
});

/** Gateway configuration */
export const GatewayConfigSchema = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.number().default(18800),
  wsPath: z.string().default("/ws"),
  authToken: z.string().optional(),
  corsOrigins: z.array(z.string()).default([]),
  maxPayloadSize: z.number().default(10 * 1024 * 1024),
  maxConnections: z.number().int().min(1).default(500),
  messageRateLimit: z.number().int().min(1).default(600),
});

/** Logging configuration */
export const LoggingConfigSchema = z.object({
  level: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  pretty: z.boolean().default(process.env.NODE_ENV !== "production"),
  file: z.string().optional(),
});

/** LLM Provider configuration */
export const ProviderConfigSchema = z.object({
  anthropic: z
    .object({
      apiKey: z.string().optional(),
      baseUrl: z.string().optional(),
      defaultModel: z.string().default("claude-sonnet-4-20250514"),
      maxRetries: z.number().default(3),
      timeout: z.number().default(60000),
    })
    .default({}),
  openai: z
    .object({
      apiKey: z.string().optional(),
      baseUrl: z.string().optional(),
      defaultModel: z.string().default("gpt-4o"),
      maxRetries: z.number().default(3),
      timeout: z.number().default(60000),
    })
    .default({}),
  google: z
    .object({
      apiKey: z.string().optional(),
      defaultModel: z.string().default("gemini-2.0-flash"),
      maxRetries: z.number().default(3),
      timeout: z.number().default(60000),
    })
    .default({}),
  ollama: z
    .object({
      baseUrl: z.string().default("http://localhost:11434"),
      defaultModel: z.string().default("llama3.2"),
      timeout: z.number().default(120000),
    })
    .default({}),
});

/** Agent runtime configuration */
export const RuntimeConfigSchema = z.object({
  maxAgents: z.number().default(100),
  defaultMemoryLimit: z.number().default(512 * 1024 * 1024),
  defaultCpuLimit: z.number().default(1),
  heartbeatInterval: z.number().default(30000),
  shutdownTimeout: z.number().default(10000),
  workDir: z.string().default(".agentkernel"),
});

/** Full configuration schema */
export const ConfigSchema = z.object({
  database: DatabaseConfigSchema.default({}),
  qdrant: QdrantConfigSchema.default({}),
  redis: RedisConfigSchema.default({}),
  gateway: GatewayConfigSchema.default({}),
  logging: LoggingConfigSchema.default({}),
  providers: ProviderConfigSchema.default({}),
  runtime: RuntimeConfigSchema.default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;
export type QdrantConfig = z.infer<typeof QdrantConfigSchema>;
export type RedisConfig = z.infer<typeof RedisConfigSchema>;
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

/** Helper for type-safe configuration in agentkernel.config.ts files. */
export function defineConfig(config: Partial<Config>): Partial<Config> {
  return config;
}

/** Environment variable mappings */
const ENV_MAPPINGS: Record<string, string> = {
  DATABASE_HOST: "database.host",
  DATABASE_PORT: "database.port",
  DATABASE_NAME: "database.database",
  DATABASE_USER: "database.user",
  DATABASE_PASSWORD: "database.password",
  DATABASE_SSL: "database.ssl",
  QDRANT_HOST: "qdrant.host",
  QDRANT_PORT: "qdrant.port",
  QDRANT_API_KEY: "qdrant.apiKey",
  QDRANT_HTTPS: "qdrant.https",
  REDIS_HOST: "redis.host",
  REDIS_PORT: "redis.port",
  REDIS_PASSWORD: "redis.password",
  REDIS_DB: "redis.db",
  REDIS_MODE: "redis.mode",
  REDIS_SENTINEL_NAME: "redis.sentinelName",
  GATEWAY_HOST: "gateway.host",
  GATEWAY_PORT: "gateway.port",
  GATEWAY_AUTH_TOKEN: "gateway.authToken",
  GATEWAY_MAX_PAYLOAD_BYTES: "gateway.maxPayloadSize",
  GATEWAY_MAX_CONNECTIONS: "gateway.maxConnections",
  GATEWAY_MESSAGE_RATE_LIMIT: "gateway.messageRateLimit",
  LOG_LEVEL: "logging.level",
  LOG_PRETTY: "logging.pretty",
  LOG_FILE: "logging.file",
  ANTHROPIC_API_KEY: "providers.anthropic.apiKey",
  OPENAI_API_KEY: "providers.openai.apiKey",
  GOOGLE_AI_API_KEY: "providers.google.apiKey",
  GOOGLE_API_KEY: "providers.google.apiKey",
  OLLAMA_URL: "providers.ollama.baseUrl",
  OLLAMA_BASE_URL: "providers.ollama.baseUrl",
};

function parseDatabaseUrl(urlValue: string): Partial<DatabaseConfig> {
  try {
    const url = new URL(urlValue);
    return {
      host: url.hostname,
      port: url.port ? Number(url.port) : 5432,
      database: url.pathname.replace(/^\//, "") || "agentkernel",
      user: decodeURIComponent(url.username || "agentkernel"),
      password: decodeURIComponent(url.password || ""),
      ssl: url.searchParams.get("sslmode") === "require" || url.searchParams.get("ssl") === "true",
    };
  } catch {
    return {};
  }
}

function parseRedisUrl(urlValue: string): Partial<RedisConfig> {
  try {
    const url = new URL(urlValue);
    return {
      host: url.hostname,
      port: url.port ? Number(url.port) : 6379,
      password: url.password ? decodeURIComponent(url.password) : undefined,
      db: url.pathname ? Number(url.pathname.replace("/", "")) || 0 : 0,
    };
  } catch {
    return {};
  }
}

function parseQdrantUrl(urlValue: string): Partial<QdrantConfig> {
  try {
    const url = new URL(urlValue);
    return {
      host: url.hostname,
      port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 6333,
      https: url.protocol === "https:",
      apiKey: url.searchParams.get("apiKey") ?? url.searchParams.get("api_key") ?? undefined,
    };
  } catch {
    return {};
  }
}

/** Set a nested value in an object using dot notation */
function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let current = obj;

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!;
    if (!(key in current)) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }

  const lastKey = keys[keys.length - 1]!;
  current[lastKey] = value;
}

/** Parse environment value to appropriate type */
function parseEnvValue(value: string): unknown {
  if (value.toLowerCase() === "true") return true;
  if (value.toLowerCase() === "false") return false;
  const num = Number(value);
  if (!Number.isNaN(num) && value.trim() !== "") return num;
  return value;
}

/** Load configuration from YAML file */
function loadYamlConfig(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) {
    return {};
  }

  try {
    const content = readFileSync(configPath, "utf-8");
    return parseYaml(content) ?? {};
  } catch {
    return {};
  }
}

/** Load configuration from a TypeScript or ESM config file (async). */
async function loadTsConfig(configPath: string): Promise<Record<string, unknown>> {
  const absPath = resolve(configPath);
  if (!existsSync(absPath)) {
    return {};
  }

  try {
    const fileUrl = pathToFileURL(absPath).href;
    const mod = (await import(fileUrl)) as Record<string, unknown>;
    const exported = (mod.default ?? mod.config ?? {}) as Record<string, unknown>;
    if (typeof exported === "object" && exported !== null && !Array.isArray(exported)) {
      return exported;
    }
    return {};
  } catch {
    return {};
  }
}

/** Check if a config path uses a TypeScript extension. */
function isTsConfig(configPath: string): boolean {
  const ext = configPath.split(".").pop()?.toLowerCase() ?? "";
  return ext === "ts" || ext === "mts";
}

/** Resolve an environment value, supporting *_FILE secrets */
function resolveEnvValue(envKey: string): string | undefined {
  const direct = process.env[envKey];
  if (direct !== undefined) return direct;
  const fileKey = `${envKey}_FILE`;
  const filePath = process.env[fileKey];
  if (!filePath) return undefined;
  try {
    return readFileSync(filePath, "utf-8").trim();
  } catch {
    return undefined;
  }
}

/** Load configuration from environment variables */
function loadEnvConfig(): Record<string, unknown> {
  const config: Record<string, unknown> = {};

  const databaseUrl = resolveEnvValue("DATABASE_URL");
  if (databaseUrl) {
    const parsed = parseDatabaseUrl(databaseUrl);
    for (const [key, value] of Object.entries(parsed)) {
      if (value !== undefined) {
        setNestedValue(config, `database.${key}`, value);
      }
    }
  }

  const redisUrl = resolveEnvValue("REDIS_URL");
  if (redisUrl) {
    const parsed = parseRedisUrl(redisUrl);
    for (const [key, value] of Object.entries(parsed)) {
      if (value !== undefined) {
        setNestedValue(config, `redis.${key}`, value);
      }
    }
  }

  const qdrantUrl = resolveEnvValue("QDRANT_URL");
  if (qdrantUrl) {
    const parsed = parseQdrantUrl(qdrantUrl);
    for (const [key, value] of Object.entries(parsed)) {
      if (value !== undefined) {
        setNestedValue(config, `qdrant.${key}`, value);
      }
    }
  }

  for (const [envKey, configPath] of Object.entries(ENV_MAPPINGS)) {
    const value = resolveEnvValue(envKey);
    if (value !== undefined) {
      setNestedValue(config, configPath, parseEnvValue(value));
    }
  }

  // Parse REDIS_SENTINELS: "host1:port1,host2:port2" or JSON array
  const sentinelsRaw = resolveEnvValue("REDIS_SENTINELS");
  if (sentinelsRaw) {
    try {
      const parsed = JSON.parse(sentinelsRaw);
      if (Array.isArray(parsed)) {
        setNestedValue(config, "redis.sentinels", parsed);
      }
    } catch {
      const sentinels = sentinelsRaw.split(",").map((s) => {
        const [host, portStr] = s.trim().split(":");
        return { host: host ?? "localhost", port: Number(portStr) || 26379 };
      });
      setNestedValue(config, "redis.sentinels", sentinels);
    }
  }

  // Parse REDIS_CLUSTER_NODES: "host1:port1,host2:port2"
  const clusterNodesRaw = resolveEnvValue("REDIS_CLUSTER_NODES");
  if (clusterNodesRaw) {
    try {
      const parsed = JSON.parse(clusterNodesRaw);
      if (Array.isArray(parsed)) {
        setNestedValue(config, "redis.clusterNodes", parsed);
      }
    } catch {
      setNestedValue(
        config,
        "redis.clusterNodes",
        clusterNodesRaw.split(",").map((s) => s.trim()),
      );
    }
  }

  return config;
}

/** Deep merge two objects */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };

  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value !== null) {
      if (typeof value === "object" && !Array.isArray(value)) {
        result[key] = deepMerge(
          (result[key] as Record<string, unknown>) ?? {},
          value as Record<string, unknown>,
        );
      } else {
        result[key] = value;
      }
    }
  }

  return result;
}

/** Configuration manager */
export class ConfigManager {
  private config: Config | null = null;
  private configPath: string;

  constructor(configPath?: string) {
    this.configPath = configPath ?? this.findConfigFile();
  }

  private findConfigFile(): string {
    const locations = [
      "agentkernel.config.yaml",
      "agentkernel.config.yml",
      join(process.cwd(), "agentkernel.config.yaml"),
      join(process.cwd(), ".agentkernel", "config.yaml"),
      "agentkernel.config.ts",
      "agentkernel.config.mts",
      join(process.cwd(), "agentkernel.config.ts"),
      join(process.cwd(), ".agentkernel", "config.ts"),
    ];

    for (const loc of locations) {
      if (existsSync(loc)) {
        return loc;
      }
    }

    return "agentkernel.config.yaml";
  }

  /** Find config file, preferring TS over YAML for async loading. */
  private findConfigFileAsync(): string {
    const locations = [
      "agentkernel.config.ts",
      "agentkernel.config.mts",
      join(process.cwd(), "agentkernel.config.ts"),
      join(process.cwd(), ".agentkernel", "config.ts"),
      "agentkernel.config.yaml",
      "agentkernel.config.yml",
      join(process.cwd(), "agentkernel.config.yaml"),
      join(process.cwd(), ".agentkernel", "config.yaml"),
    ];

    for (const loc of locations) {
      if (existsSync(loc)) {
        return loc;
      }
    }

    return "agentkernel.config.yaml";
  }

  load(overrides: Partial<Config> = {}): Config {
    if (isTsConfig(this.configPath)) {
      throw new Error(
        `TypeScript config file detected (${this.configPath}). Use loadConfigAsync() or ConfigManager.loadAsync() instead of the synchronous load().`,
      );
    }
    const yamlConfig = loadYamlConfig(this.configPath);
    const envConfig = loadEnvConfig();

    const merged = deepMerge(
      deepMerge(yamlConfig, envConfig),
      overrides as Record<string, unknown>,
    );

    const result = ConfigSchema.parse(merged);
    this.config = result;
    if (isProductionHardeningEnabled()) {
      assertProductionHardening(result);
    }

    return result;
  }

  /** Load configuration with support for TypeScript config files. */
  async loadAsync(overrides: Partial<Config> = {}): Promise<Config> {
    const asyncPath = this.findConfigFileAsync();
    const fileConfig = isTsConfig(asyncPath)
      ? await loadTsConfig(asyncPath)
      : loadYamlConfig(asyncPath);
    const envConfig = loadEnvConfig();

    const merged = deepMerge(
      deepMerge(fileConfig, envConfig),
      overrides as Record<string, unknown>,
    );

    const result = ConfigSchema.parse(merged);
    this.config = result;
    if (isProductionHardeningEnabled()) {
      assertProductionHardening(result);
    }
    return result;
  }

  get(): Config {
    if (!this.config) {
      return this.load();
    }
    return this.config;
  }

  getSection<K extends keyof Config>(section: K): Config[K] {
    return this.get()[section];
  }

  isProviderConfigured(provider: keyof ProviderConfig): boolean {
    const config = this.get();
    const providerConfig = config.providers[provider];

    if (provider === "ollama") {
      return true;
    }

    return "apiKey" in providerConfig && !!providerConfig.apiKey;
  }

  getConfiguredProviders(): string[] {
    const providers: string[] = [];
    const config = this.get();

    if (config.providers.anthropic.apiKey) providers.push("anthropic");
    if (config.providers.openai.apiKey) providers.push("openai");
    if (config.providers.google.apiKey) providers.push("google");
    providers.push("ollama");

    return providers;
  }
}

let globalConfig: ConfigManager | null = null;

export function getConfig(): ConfigManager {
  if (!globalConfig) {
    globalConfig = new ConfigManager();
  }
  return globalConfig;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  return getConfig().load(overrides);
}

/** Load configuration with support for TypeScript config files. */
export async function loadConfigAsync(overrides: Partial<Config> = {}): Promise<Config> {
  return getConfig().loadAsync(overrides);
}

export function createConfigManager(configPath?: string): ConfigManager {
  return new ConfigManager(configPath);
}

function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
}

export function isProductionHardeningEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyEnv(env.ENFORCE_PRODUCTION_HARDENING);
}

export function getProductionHardeningIssues(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const issues: string[] = [];

  const nodeEnv = env.NODE_ENV ?? "development";
  if (nodeEnv !== "production") {
    issues.push('NODE_ENV must be set to "production".');
  }

  const permissionSecret = env.PERMISSION_SECRET;
  if (!permissionSecret || permissionSecret.length < 32) {
    issues.push("PERMISSION_SECRET must be set and at least 32 characters.");
  } else {
    const lowered = permissionSecret.toLowerCase();
    if (lowered.includes("change-me") || lowered.includes("your-") || lowered.includes("example")) {
      issues.push("PERMISSION_SECRET appears to be a placeholder value. Set a real secret.");
    }
  }

  if (config.logging.level === "debug" || config.logging.level === "trace") {
    issues.push('LOG_LEVEL must not be "debug" or "trace" in production.');
  }

  const weakDbPasswords = new Set([
    "",
    "agentkernel",
    "agentkernel_test",
    "agentos",
    "agentos_test",
    "agentpass",
  ]);
  if (weakDbPasswords.has(config.database.password)) {
    issues.push("DATABASE_PASSWORD must not use default/placeholder values.");
  }

  if (!isLocalHost(config.database.host) && !config.database.ssl) {
    issues.push("DATABASE_SSL must be true when DATABASE_HOST is not local.");
  }

  if (!isLocalHost(config.redis.host) && !config.redis.password) {
    issues.push("REDIS_PASSWORD must be set when REDIS_HOST is not local.");
  }

  if (!isLocalHost(config.qdrant.host) && !config.qdrant.https) {
    issues.push("QDRANT_HTTPS must be true when QDRANT_HOST is not local.");
  }

  return issues;
}

export function assertProductionHardening(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const issues = getProductionHardeningIssues(config, env);
  if (issues.length === 0) return;

  const message = [
    "Production hardening checks failed:",
    ...issues.map((issue) => `- ${issue}`),
  ].join("\n");
  throw new Error(message);
}

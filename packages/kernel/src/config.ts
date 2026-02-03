// Configuration — loads from YAML + environment variables
// Layered config: defaults → YAML file → env vars → CLI args

import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { join } from "node:path";

/** Database configuration */
export const DatabaseConfigSchema = z.object({
  host: z.string().default("localhost"),
  port: z.number().default(5432),
  database: z.string().default("agent_os"),
  user: z.string().default("agent_os"),
  password: z.string().default(""),
  maxConnections: z.number().default(20),
  idleTimeout: z.number().default(30000),
  ssl: z.boolean().default(false),
});

/** Qdrant vector store configuration */
export const QdrantConfigSchema = z.object({
  host: z.string().default("localhost"),
  port: z.number().default(6333),
  apiKey: z.string().optional(),
  https: z.boolean().default(false),
  collection: z.string().default("agent_os_memory"),
  vectorSize: z.number().default(1536),
});

/** Redis configuration */
export const RedisConfigSchema = z.object({
  host: z.string().default("localhost"),
  port: z.number().default(6379),
  password: z.string().optional(),
  db: z.number().default(0),
  keyPrefix: z.string().default("agent_os:"),
});

/** Gateway configuration */
export const GatewayConfigSchema = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.number().default(18800),
  wsPath: z.string().default("/ws"),
  authToken: z.string().optional(),
  corsOrigins: z.array(z.string()).default(["*"]),
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
  anthropic: z.object({
    apiKey: z.string().optional(),
    baseUrl: z.string().optional(),
    defaultModel: z.string().default("claude-sonnet-4-20250514"),
    maxRetries: z.number().default(3),
    timeout: z.number().default(60000),
  }).default({}),
  openai: z.object({
    apiKey: z.string().optional(),
    baseUrl: z.string().optional(),
    defaultModel: z.string().default("gpt-4o"),
    maxRetries: z.number().default(3),
    timeout: z.number().default(60000),
  }).default({}),
  google: z.object({
    apiKey: z.string().optional(),
    defaultModel: z.string().default("gemini-2.0-flash"),
    maxRetries: z.number().default(3),
    timeout: z.number().default(60000),
  }).default({}),
  ollama: z.object({
    baseUrl: z.string().default("http://localhost:11434"),
    defaultModel: z.string().default("llama3.2"),
    timeout: z.number().default(120000),
  }).default({}),
});

/** Agent runtime configuration */
export const RuntimeConfigSchema = z.object({
  maxAgents: z.number().default(100),
  defaultMemoryLimit: z.number().default(512 * 1024 * 1024),
  defaultCpuLimit: z.number().default(1),
  heartbeatInterval: z.number().default(30000),
  shutdownTimeout: z.number().default(10000),
  workDir: z.string().default(".agent-os"),
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
      database: url.pathname.replace(/^\//, "") || "agent_os",
      user: decodeURIComponent(url.username || "agent_os"),
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
  if (!isNaN(num) && value.trim() !== "") return num;
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

/** Load configuration from environment variables */
function loadEnvConfig(): Record<string, unknown> {
  const config: Record<string, unknown> = {};

  if (process.env.DATABASE_URL) {
    const parsed = parseDatabaseUrl(process.env.DATABASE_URL);
    for (const [key, value] of Object.entries(parsed)) {
      if (value !== undefined) {
        setNestedValue(config, `database.${key}`, value);
      }
    }
  }

  if (process.env.REDIS_URL) {
    const parsed = parseRedisUrl(process.env.REDIS_URL);
    for (const [key, value] of Object.entries(parsed)) {
      if (value !== undefined) {
        setNestedValue(config, `redis.${key}`, value);
      }
    }
  }

  if (process.env.QDRANT_URL) {
    const parsed = parseQdrantUrl(process.env.QDRANT_URL);
    for (const [key, value] of Object.entries(parsed)) {
      if (value !== undefined) {
        setNestedValue(config, `qdrant.${key}`, value);
      }
    }
  }

  for (const [envKey, configPath] of Object.entries(ENV_MAPPINGS)) {
    const value = process.env[envKey];
    if (value !== undefined) {
      setNestedValue(config, configPath, parseEnvValue(value));
    }
  }

  return config;
}

/** Deep merge two objects */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };

  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value !== null) {
      if (typeof value === "object" && !Array.isArray(value)) {
        result[key] = deepMerge(
          (result[key] as Record<string, unknown>) ?? {},
          value as Record<string, unknown>
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
      "agent-os.config.yaml",
      "agent-os.config.yml",
      join(process.cwd(), "agent-os.config.yaml"),
      join(process.cwd(), ".agent-os", "config.yaml"),
    ];

    for (const loc of locations) {
      if (existsSync(loc)) {
        return loc;
      }
    }

    return "agent-os.config.yaml";
  }

  load(overrides: Partial<Config> = {}): Config {
    const yamlConfig = loadYamlConfig(this.configPath);
    const envConfig = loadEnvConfig();

    const merged = deepMerge(
      deepMerge(yamlConfig, envConfig),
      overrides as Record<string, unknown>
    );

    const result = ConfigSchema.parse(merged);
    this.config = result;

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

export function createConfigManager(configPath?: string): ConfigManager {
  return new ConfigManager(configPath);
}

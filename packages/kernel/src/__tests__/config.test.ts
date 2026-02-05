import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type Config,
  ConfigManager,
  ConfigSchema,
  assertProductionHardening,
  createConfigManager,
  getConfig,
  getProductionHardeningIssues,
  isProductionHardeningEnabled,
  loadConfig,
} from "../config.js";

describe("ConfigSchema", () => {
  it("should parse empty config with defaults", () => {
    const result = ConfigSchema.parse({});

    expect(result.database.host).toBe("localhost");
    expect(result.database.port).toBe(5432);
    expect(result.database.database).toBe("agentkernel");
    expect(result.qdrant.host).toBe("localhost");
    expect(result.qdrant.port).toBe(6333);
    expect(result.redis.host).toBe("localhost");
    expect(result.redis.port).toBe(6379);
    expect(result.gateway.port).toBe(18800);
    expect(result.logging.level).toBe("info");
  });

  it("should parse partial config and merge with defaults", () => {
    const result = ConfigSchema.parse({
      database: { host: "db.example.com", port: 5433 },
      logging: { level: "debug" },
    });

    expect(result.database.host).toBe("db.example.com");
    expect(result.database.port).toBe(5433);
    expect(result.database.database).toBe("agentkernel"); // default
    expect(result.logging.level).toBe("debug");
  });

  it("should validate provider configs", () => {
    const result = ConfigSchema.parse({
      providers: {
        anthropic: { apiKey: "sk-ant-xxx" },
        openai: { apiKey: "sk-xxx" },
      },
    });

    expect(result.providers.anthropic.apiKey).toBe("sk-ant-xxx");
    expect(result.providers.anthropic.defaultModel).toBe("claude-sonnet-4-20250514");
    expect(result.providers.openai.apiKey).toBe("sk-xxx");
    expect(result.providers.openai.defaultModel).toBe("gpt-4o");
  });

  it("should reject invalid log levels", () => {
    expect(() => {
      ConfigSchema.parse({
        logging: { level: "invalid" },
      });
    }).toThrow();
  });
});

describe("ConfigManager", () => {
  const testDir = join(process.cwd(), ".test-config");
  const testConfigPath = join(testDir, "test-config.yaml");

  beforeEach(() => {
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
    // Clear env vars that interfere with default-checking tests
    Reflect.deleteProperty(process.env, "DATABASE_HOST");
    Reflect.deleteProperty(process.env, "DATABASE_PORT");
    Reflect.deleteProperty(process.env, "DATABASE_URL");
    Reflect.deleteProperty(process.env, "LOG_LEVEL");
    Reflect.deleteProperty(process.env, "ANTHROPIC_API_KEY");
    Reflect.deleteProperty(process.env, "ENFORCE_PRODUCTION_HARDENING");
    Reflect.deleteProperty(process.env, "PERMISSION_SECRET");
    Reflect.deleteProperty(process.env, "NODE_ENV");
  });

  afterEach(() => {
    if (existsSync(testConfigPath)) {
      unlinkSync(testConfigPath);
    }
    // Reset environment variables
    Reflect.deleteProperty(process.env, "DATABASE_HOST");
    Reflect.deleteProperty(process.env, "DATABASE_PORT");
    Reflect.deleteProperty(process.env, "DATABASE_URL");
    Reflect.deleteProperty(process.env, "LOG_LEVEL");
    Reflect.deleteProperty(process.env, "ANTHROPIC_API_KEY");
    Reflect.deleteProperty(process.env, "ENFORCE_PRODUCTION_HARDENING");
    Reflect.deleteProperty(process.env, "PERMISSION_SECRET");
    Reflect.deleteProperty(process.env, "NODE_ENV");
  });

  it("should load defaults when no config file exists", () => {
    const manager = new ConfigManager(join(testDir, "nonexistent.yaml"));
    const config = manager.load();

    expect(config.database.host).toBe("localhost");
    expect(config.logging.level).toBe("info");
  });

  it("should load config from YAML file", () => {
    const yamlContent = `
database:
  host: yaml-host
  port: 5555
logging:
  level: debug
`;
    writeFileSync(testConfigPath, yamlContent);

    const manager = new ConfigManager(testConfigPath);
    const config = manager.load();

    expect(config.database.host).toBe("yaml-host");
    expect(config.database.port).toBe(5555);
    expect(config.logging.level).toBe("debug");
  });

  it("should override YAML with environment variables", () => {
    const yamlContent = `
database:
  host: yaml-host
  port: 5555
`;
    writeFileSync(testConfigPath, yamlContent);

    process.env.DATABASE_HOST = "env-host";
    process.env.DATABASE_PORT = "6666";

    const manager = new ConfigManager(testConfigPath);
    const config = manager.load();

    expect(config.database.host).toBe("env-host");
    expect(config.database.port).toBe(6666);
  });

  it("should override all with programmatic overrides", () => {
    process.env.DATABASE_HOST = "env-host";

    const manager = new ConfigManager(testConfigPath);
    const config = manager.load({
      database: { host: "override-host" },
    } as Partial<Config>);

    expect(config.database.host).toBe("override-host");
  });

  it("should parse boolean env values", () => {
    process.env.LOG_PRETTY = "true";

    const manager = new ConfigManager(testConfigPath);
    const config = manager.load();

    expect(config.logging.pretty).toBe(true);
  });

  it("should cache config after first load", () => {
    const manager = new ConfigManager(testConfigPath);
    const config1 = manager.load();
    const config2 = manager.get();

    expect(config1).toBe(config2);
  });

  it("should get config sections", () => {
    const manager = new ConfigManager(testConfigPath);
    manager.load();

    const dbConfig = manager.getSection("database");
    expect(dbConfig.host).toBe("localhost");

    const loggingConfig = manager.getSection("logging");
    expect(loggingConfig.level).toBe("info");
  });

  it("should detect configured providers", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";

    const manager = new ConfigManager(testConfigPath);
    manager.load();

    expect(manager.isProviderConfigured("anthropic")).toBe(true);
    expect(manager.isProviderConfigured("openai")).toBe(false);
    expect(manager.isProviderConfigured("ollama")).toBe(true); // Always true
  });

  it("should list configured providers", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.OPENAI_API_KEY = "sk-test";

    const manager = new ConfigManager(testConfigPath);
    manager.load();

    const providers = manager.getConfiguredProviders();
    expect(providers).toContain("anthropic");
    expect(providers).toContain("openai");
    expect(providers).toContain("ollama");
    expect(providers).not.toContain("google");
  });
});

describe("Config module functions", () => {
  it("should create config manager with createConfigManager", () => {
    const manager = createConfigManager();
    expect(manager).toBeInstanceOf(ConfigManager);
  });

  it("should load config with loadConfig", () => {
    const config = loadConfig();
    expect(config.database).toBeDefined();
    expect(config.logging).toBeDefined();
  });

  it("should get global config with getConfig", () => {
    const config1 = getConfig();
    const config2 = getConfig();
    // Should return the same instance
    expect(config1).toBe(config2);
  });
});

describe("Production hardening", () => {
  beforeEach(() => {
    Reflect.deleteProperty(process.env, "ENFORCE_PRODUCTION_HARDENING");
    Reflect.deleteProperty(process.env, "PERMISSION_SECRET");
    Reflect.deleteProperty(process.env, "NODE_ENV");
  });

  afterEach(() => {
    Reflect.deleteProperty(process.env, "ENFORCE_PRODUCTION_HARDENING");
    Reflect.deleteProperty(process.env, "PERMISSION_SECRET");
    Reflect.deleteProperty(process.env, "NODE_ENV");
  });

  it("should detect hardening enablement flag", () => {
    process.env.ENFORCE_PRODUCTION_HARDENING = "true";
    expect(isProductionHardeningEnabled()).toBe(true);
    process.env.ENFORCE_PRODUCTION_HARDENING = "false";
    expect(isProductionHardeningEnabled()).toBe(false);
  });

  it("should report issues for insecure defaults", () => {
    process.env.NODE_ENV = "production";
    process.env.PERMISSION_SECRET = "s".repeat(32);
    const config = ConfigSchema.parse({});
    const issues = getProductionHardeningIssues(config);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((issue) => issue.includes("DATABASE_PASSWORD"))).toBe(true);
  });

  it("should enforce hardening when enabled during load", () => {
    process.env.NODE_ENV = "production";
    process.env.PERMISSION_SECRET = "s".repeat(32);
    process.env.ENFORCE_PRODUCTION_HARDENING = "true";
    const manager = new ConfigManager(join(process.cwd(), ".test-config", "nonexistent.yaml"));
    expect(() => manager.load()).toThrow(/Production hardening checks failed/);
  });

  it("should pass for a hardened configuration", () => {
    process.env.NODE_ENV = "production";
    process.env.PERMISSION_SECRET = "s".repeat(48);
    const config = ConfigSchema.parse({
      database: {
        host: "db.example.com",
        ssl: true,
        user: "ak_user",
        password: "super-secret-password",
        database: "agentkernel_prod",
      },
      redis: {
        host: "redis.example.com",
        password: "redis-secret",
      },
      qdrant: {
        host: "qdrant.example.com",
        https: true,
      },
      logging: {
        level: "info",
      },
    });

    expect(() => assertProductionHardening(config)).not.toThrow();
  });
});

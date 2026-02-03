// Security Utilities Tests
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { z } from "zod";
import {
  validateInput,
  ValidationSchemas,
  sanitizeString,
  sanitizeObject,
  isSecretKey,
  resolveSecret,
  maskSecret,
  redactSecrets,
  EnvVaultProvider,
  registerVaultProvider,
  unregisterVaultProvider,
  getVaultProvider,
  getDefaultVaultProvider,
  clearVaultProviders,
  RateLimiter,
  getRateLimiter,
  destroyAllRateLimiters,
  AuditLogger,
  InMemoryAuditStorage,
  getAuditLogger,
  resetAuditLogger,
  SecurityHeaders,
  getCorsHeaders,
  validateRequestHeaders,
  validateContentType,
  validateRequestSize,
  type AuditAction,
  type VaultProvider,
} from "./security.js";

function getFirst<T>(items: T[]): T {
  const first = items[0];
  if (!first) {
    throw new Error("Expected at least one item");
  }
  return first;
}

describe("Input Validation", () => {
  describe("validateInput", () => {
    it("should validate and return data on success", () => {
      const schema = z.object({ name: z.string() });
      const result = validateInput(schema, { name: "test" });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({ name: "test" });
      }
    });

    it("should return error on validation failure", () => {
      const schema = z.object({ name: z.string() });
      const result = validateInput(schema, { name: 123 });

      expect(result.ok).toBe(false);
    });

    it("should log validation failures with context", () => {
      const schema = z.object({ id: z.string().uuid() });
      const result = validateInput(schema, { id: "invalid" }, "test-context");

      expect(result.ok).toBe(false);
    });
  });

  describe("ValidationSchemas", () => {
    it("agentId should validate correctly", () => {
      expect(ValidationSchemas.agentId.safeParse("agent-1").success).toBe(true);
      expect(ValidationSchemas.agentId.safeParse("my_agent").success).toBe(false);
      expect(ValidationSchemas.agentId.safeParse("").success).toBe(false);
      expect(ValidationSchemas.agentId.safeParse("a".repeat(65)).success).toBe(false);
    });

    it("taskId should validate UUIDs", () => {
      expect(ValidationSchemas.taskId.safeParse("550e8400-e29b-41d4-a716-446655440000").success).toBe(true);
      expect(ValidationSchemas.taskId.safeParse("not-a-uuid").success).toBe(false);
    });

    it("eventType should validate namespaced format", () => {
      expect(ValidationSchemas.eventType.safeParse("agent.started").success).toBe(true);
      expect(ValidationSchemas.eventType.safeParse("task.completed").success).toBe(true);
      expect(ValidationSchemas.eventType.safeParse("Agent.Started").success).toBe(false);
      expect(ValidationSchemas.eventType.safeParse("invalid_event").success).toBe(false);
    });

    it("safeString should reject unsafe characters", () => {
      expect(ValidationSchemas.safeString.safeParse("hello world").success).toBe(true);
      expect(ValidationSchemas.safeString.safeParse("<script>").success).toBe(false);
      expect(ValidationSchemas.safeString.safeParse("{malicious}").success).toBe(false);
    });
  });

  describe("sanitizeString", () => {
    it("should remove angle brackets", () => {
      expect(sanitizeString("<script>alert('xss')</script>")).toBe("scriptalert('xss')/script");
    });

    it("should remove javascript: protocol", () => {
      expect(sanitizeString("javascript:alert(1)")).toBe("alert(1)");
    });

    it("should remove event handlers", () => {
      expect(sanitizeString("onclick=alert(1)")).toBe("alert(1)");
      expect(sanitizeString("onload=malicious()")).toBe("malicious()");
    });

    it("should trim whitespace", () => {
      expect(sanitizeString("  hello  ")).toBe("hello");
    });
  });

  describe("sanitizeObject", () => {
    it("should sanitize string values", () => {
      const input = { name: "<script>xss</script>" };
      const result = sanitizeObject(input);
      expect(result.name).toBe("scriptxss/script");
    });

    it("should handle nested objects", () => {
      const input = { user: { name: "<b>bold</b>" } };
      const result = sanitizeObject(input);
      expect(result.user.name).toBe("bbold/b");
    });

    it("should handle arrays", () => {
      const input = { tags: ["<tag>", "normal"] };
      const result = sanitizeObject(input);
      expect(result.tags).toEqual(["tag", "normal"]);
    });

    it("should preserve non-string values", () => {
      const input = { count: 42, active: true };
      const result = sanitizeObject(input);
      expect(result).toEqual({ count: 42, active: true });
    });
  });
});

describe("Secrets Management", () => {
  describe("isSecretKey", () => {
    it("should identify secret keys", () => {
      expect(isSecretKey("api_key")).toBe(true);
      expect(isSecretKey("API_KEY")).toBe(true);
      expect(isSecretKey("apiKey")).toBe(true);
      expect(isSecretKey("secret_key")).toBe(true);
      expect(isSecretKey("password")).toBe(true);
      expect(isSecretKey("auth_token")).toBe(true);
      expect(isSecretKey("private_key")).toBe(true);
    });

    it("should not flag non-secret keys", () => {
      expect(isSecretKey("username")).toBe(false);
      expect(isSecretKey("email")).toBe(false);
      expect(isSecretKey("name")).toBe(false);
      expect(isSecretKey("id")).toBe(false);
    });
  });

  describe("resolveSecret", () => {
    afterEach(() => {
      clearVaultProviders();
    });

    it("should resolve environment variable secrets", async () => {
      process.env.TEST_SECRET = "secret-value";

      const result = await resolveSecret({ type: "env", key: "TEST_SECRET" });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("secret-value");
      }

      delete process.env.TEST_SECRET;
    });

    it("should return error for missing env var", async () => {
      const result = await resolveSecret({ type: "env", key: "NONEXISTENT_VAR" });

      expect(result.ok).toBe(false);
    });

    it("should return error when no vault provider registered", async () => {
      const result = await resolveSecret({ type: "vault", key: "secret/data/test" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("No vault provider registered");
      }
    });

    it("should resolve vault secrets with registered provider", async () => {
      process.env.VAULT_SECRET_API_KEY = "my-api-key";
      registerVaultProvider(new EnvVaultProvider("test-vault", "VAULT_SECRET_"));

      const result = await resolveSecret({ type: "vault", key: "api-key" });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("my-api-key");
      }

      delete process.env.VAULT_SECRET_API_KEY;
    });

    it("should resolve vault secrets from named provider", async () => {
      process.env.PRIMARY_DB_PASSWORD = "primary-pass";
      process.env.SECONDARY_DB_PASSWORD = "secondary-pass";

      registerVaultProvider(new EnvVaultProvider("primary", "PRIMARY_"));
      registerVaultProvider(new EnvVaultProvider("secondary", "SECONDARY_"));

      const result1 = await resolveSecret({ type: "vault", key: "db-password", vault: "primary" });
      const result2 = await resolveSecret({ type: "vault", key: "db-password", vault: "secondary" });

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);
      if (result1.ok && result2.ok) {
        expect(result1.value).toBe("primary-pass");
        expect(result2.value).toBe("secondary-pass");
      }

      delete process.env.PRIMARY_DB_PASSWORD;
      delete process.env.SECONDARY_DB_PASSWORD;
    });
  });

  describe("Vault Providers", () => {
    afterEach(() => {
      clearVaultProviders();
    });

    it("should register and retrieve vault providers", () => {
      const provider = new EnvVaultProvider("my-vault");
      registerVaultProvider(provider);

      expect(getVaultProvider("my-vault")).toBe(provider);
    });

    it("should return undefined for unregistered provider", () => {
      expect(getVaultProvider("nonexistent")).toBeUndefined();
    });

    it("should unregister vault providers", () => {
      registerVaultProvider(new EnvVaultProvider("test"));
      expect(getVaultProvider("test")).toBeDefined();

      const result = unregisterVaultProvider("test");
      expect(result).toBe(true);
      expect(getVaultProvider("test")).toBeUndefined();
    });

    it("should return false when unregistering nonexistent provider", () => {
      const result = unregisterVaultProvider("nonexistent");
      expect(result).toBe(false);
    });

    it("should get default vault provider", () => {
      expect(getDefaultVaultProvider()).toBeUndefined();

      const provider = new EnvVaultProvider("default");
      registerVaultProvider(provider);

      expect(getDefaultVaultProvider()).toBe(provider);
    });

    it("should clear all vault providers", () => {
      registerVaultProvider(new EnvVaultProvider("vault1"));
      registerVaultProvider(new EnvVaultProvider("vault2"));

      clearVaultProviders();

      expect(getVaultProvider("vault1")).toBeUndefined();
      expect(getVaultProvider("vault2")).toBeUndefined();
    });
  });

  describe("EnvVaultProvider", () => {
    it("should resolve secrets with custom prefix", async () => {
      process.env.CUSTOM_MY_SECRET = "custom-value";
      const provider = new EnvVaultProvider("custom", "CUSTOM_");

      const result = await provider.getSecret("my-secret");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("custom-value");
      }

      delete process.env.CUSTOM_MY_SECRET;
    });

    it("should normalize key names", async () => {
      process.env.VAULT_SECRET_DATABASE_URL = "postgres://localhost";
      const provider = new EnvVaultProvider("default", "VAULT_SECRET_");

      const result = await provider.getSecret("database-url");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("postgres://localhost");
      }

      delete process.env.VAULT_SECRET_DATABASE_URL;
    });

    it("should return error for missing secret", async () => {
      const provider = new EnvVaultProvider("test");

      const result = await provider.getSecret("nonexistent");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("not found");
      }
    });

    it("should always pass health check", async () => {
      const provider = new EnvVaultProvider("test");
      const healthy = await provider.healthCheck();
      expect(healthy).toBe(true);
    });
  });

  describe("maskSecret", () => {
    it("should mask middle of secret", () => {
      expect(maskSecret("abcdefghijklmnop")).toBe("abcd********mnop");
    });

    it("should fully mask short secrets", () => {
      expect(maskSecret("abc")).toBe("***");
      expect(maskSecret("abcd")).toBe("****");
    });

    it("should respect visible chars parameter", () => {
      expect(maskSecret("abcdefghij", 2)).toBe("ab******ij");
    });
  });

  describe("redactSecrets", () => {
    it("should redact secret keys", () => {
      const input = { api_key: "sk-12345678901234567890", name: "test" };
      const result = redactSecrets(input);

      expect(result.name).toBe("test");
      expect(result.api_key).not.toBe("sk-12345678901234567890");
      expect(result.api_key).toContain("*");
    });

    it("should handle nested objects", () => {
      const input = { config: { password: "secret123" } };
      const result = redactSecrets(input);

      expect((result.config as Record<string, string>).password).toContain("*");
    });

    it("should handle arrays", () => {
      const input = { items: [{ token: "abc123" }] };
      const result = redactSecrets(input);

      const firstItem = getFirst(result.items as Array<Record<string, string>>);
      expect(firstItem.token).toContain("*");
    });
  });
});

describe("Rate Limiting", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({
      windowMs: 1000,
      maxRequests: 5,
    });
  });

  afterEach(() => {
    limiter.destroy();
    destroyAllRateLimiters();
  });

  describe("isAllowed", () => {
    it("should allow requests within limit", () => {
      const result = limiter.isAllowed("test-key");
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(5);
    });
  });

  describe("record", () => {
    it("should track request count", () => {
      limiter.record("test-key");
      limiter.record("test-key");

      const stats = limiter.getStats("test-key");
      expect(stats?.count).toBe(2);
      expect(stats?.remaining).toBe(3);
    });

    it("should reject requests over limit", () => {
      for (let i = 0; i < 5; i++) {
        limiter.record("test-key");
      }

      const result = limiter.record("test-key");
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it("should reset after window expires", async () => {
      for (let i = 0; i < 5; i++) {
        limiter.record("test-key");
      }

      await new Promise((resolve) => setTimeout(resolve, 1100));

      const result = limiter.record("test-key");
      expect(result.allowed).toBe(true);
    });
  });

  describe("reset", () => {
    it("should reset specific key", () => {
      limiter.record("key1");
      limiter.record("key2");

      limiter.reset("key1");

      expect(limiter.getStats("key1")).toBeNull();
      expect(limiter.getStats("key2")).not.toBeNull();
    });
  });

  describe("resetAll", () => {
    it("should reset all keys", () => {
      limiter.record("key1");
      limiter.record("key2");

      limiter.resetAll();

      expect(limiter.getStats("key1")).toBeNull();
      expect(limiter.getStats("key2")).toBeNull();
    });
  });

  describe("getRateLimiter", () => {
    it("should return same instance for same name", () => {
      const limiter1 = getRateLimiter("test");
      const limiter2 = getRateLimiter("test");

      expect(limiter1).toBe(limiter2);
    });

    it("should return different instances for different names", () => {
      const limiter1 = getRateLimiter("test1");
      const limiter2 = getRateLimiter("test2");

      expect(limiter1).not.toBe(limiter2);
    });
  });
});

describe("Audit Logging", () => {
  let storage: InMemoryAuditStorage;
  let logger: AuditLogger;

  beforeEach(() => {
    storage = new InMemoryAuditStorage();
    logger = new AuditLogger(storage);
    resetAuditLogger();
  });

  describe("AuditLogger", () => {
    it("should log audit entries", async () => {
      await logger.log("agent.create", "user-1", "success", {
        target: "agent-1",
        details: { name: "Test Agent" },
      });

      const entries = await logger.query({});
      expect(entries).toHaveLength(1);
      const firstEntry = getFirst(entries);
      expect(firstEntry.action).toBe("agent.create");
      expect(firstEntry.actor).toBe("user-1");
      expect(firstEntry.outcome).toBe("success");
    });

    it("should redact secrets in details", async () => {
      await logger.log("config.change", "admin", "success", {
        details: { api_key: "sk-secret123456789012" },
      });

      const entries = await logger.query({});
      expect(getFirst(entries).details?.api_key).toContain("*");
    });

    it("should query by actor", async () => {
      await logger.log("agent.create", "user-1", "success");
      await logger.log("agent.delete", "user-2", "success");

      const entries = await logger.query({ actor: "user-1" });
      expect(entries).toHaveLength(1);
      expect(getFirst(entries).actor).toBe("user-1");
    });

    it("should query by action", async () => {
      await logger.log("agent.create", "user-1", "success");
      await logger.log("agent.delete", "user-1", "success");

      const entries = await logger.query({ action: "agent.create" });
      expect(entries).toHaveLength(1);
      expect(getFirst(entries).action).toBe("agent.create");
    });

    it("should query by date range", async () => {
      const now = new Date();
      await logger.log("agent.create", "user-1", "success");

      const entries = await logger.query({
        from: new Date(now.getTime() - 1000),
        to: new Date(now.getTime() + 1000),
      });
      expect(entries).toHaveLength(1);
    });
  });

  describe("InMemoryAuditStorage", () => {
    it("should limit entries to max size", async () => {
      const smallStorage = new InMemoryAuditStorage(5);

      for (let i = 0; i < 10; i++) {
        await smallStorage.write({
          timestamp: new Date(),
          action: "agent.create" as AuditAction,
          actor: `user-${i}`,
          outcome: "success",
        });
      }

      const all = smallStorage.getAll();
      expect(all).toHaveLength(5);
    });
  });

  describe("getAuditLogger", () => {
    it("should return same instance", () => {
      const logger1 = getAuditLogger();
      const logger2 = getAuditLogger();

      expect(logger1).toBe(logger2);
    });
  });
});

describe("Security Headers", () => {
  it("should have XSS protection headers", () => {
    expect(SecurityHeaders["X-XSS-Protection"]).toBeDefined();
    expect(SecurityHeaders["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("should have clickjacking protection", () => {
    expect(SecurityHeaders["X-Frame-Options"]).toBe("DENY");
  });

  it("should have CSP header", () => {
    expect(SecurityHeaders["Content-Security-Policy"]).toBeDefined();
  });

  it("should have HSTS header", () => {
    expect(SecurityHeaders["Strict-Transport-Security"]).toContain("max-age");
  });
});

describe("CORS", () => {
  describe("getCorsHeaders", () => {
    it("should allow wildcard origin", () => {
      const config = {
        origins: "*" as const,
        methods: ["GET", "POST"],
        allowedHeaders: ["Content-Type"],
        exposedHeaders: [],
        credentials: false,
        maxAge: 3600,
      };

      const headers = getCorsHeaders(config);
      expect(headers["Access-Control-Allow-Origin"]).toBe("*");
    });

    it("should allow specific origin", () => {
      const config = {
        origins: ["http://localhost:3000", "https://app.example.com"],
        methods: ["GET", "POST"],
        allowedHeaders: ["Content-Type"],
        exposedHeaders: [],
        credentials: true,
        maxAge: 3600,
      };

      const headers = getCorsHeaders(config, "http://localhost:3000");
      expect(headers["Access-Control-Allow-Origin"]).toBe("http://localhost:3000");
      expect(headers["Vary"]).toBe("Origin");
    });

    it("should not set origin for disallowed origins", () => {
      const config = {
        origins: ["http://localhost:3000"],
        methods: ["GET"],
        allowedHeaders: [],
        exposedHeaders: [],
        credentials: false,
        maxAge: 3600,
      };

      const headers = getCorsHeaders(config, "http://evil.com");
      expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
    });

    it("should set credentials header when enabled", () => {
      const config = {
        origins: "*" as const,
        methods: ["GET"],
        allowedHeaders: [],
        exposedHeaders: [],
        credentials: true,
        maxAge: 3600,
      };

      const headers = getCorsHeaders(config);
      expect(headers["Access-Control-Allow-Credentials"]).toBe("true");
    });
  });
});

describe("Request Validation", () => {
  describe("validateRequestHeaders", () => {
    it("should pass with all required headers", () => {
      const headers = {
        "content-type": "application/json",
        authorization: "Bearer token",
      };

      const result = validateRequestHeaders(headers, ["Content-Type", "Authorization"]);
      expect(result.ok).toBe(true);
    });

    it("should fail with missing headers", () => {
      const headers = {
        "content-type": "application/json",
      };

      const result = validateRequestHeaders(headers, ["Content-Type", "Authorization"]);
      expect(result.ok).toBe(false);
    });
  });

  describe("validateContentType", () => {
    it("should pass with allowed content type", () => {
      const result = validateContentType("application/json", ["application/json", "text/plain"]);
      expect(result.ok).toBe(true);
    });

    it("should pass with content type containing charset", () => {
      const result = validateContentType("application/json; charset=utf-8", ["application/json"]);
      expect(result.ok).toBe(true);
    });

    it("should fail with disallowed content type", () => {
      const result = validateContentType("text/html", ["application/json"]);
      expect(result.ok).toBe(false);
    });

    it("should fail with missing content type", () => {
      const result = validateContentType(undefined, ["application/json"]);
      expect(result.ok).toBe(false);
    });
  });

  describe("validateRequestSize", () => {
    it("should pass within limit", () => {
      const result = validateRequestSize(1024, 10240);
      expect(result.ok).toBe(true);
    });

    it("should fail over limit", () => {
      const result = validateRequestSize(20480, 10240);
      expect(result.ok).toBe(false);
    });
  });
});

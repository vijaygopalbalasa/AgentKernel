// Security utilities tests
import { describe, it, expect } from "vitest";
import {
  parseAllowedPaths,
  parseAllowedDomains,
  parseBoolean,
  normalizePath,
  isPathWithin,
  isPathAllowed,
  isDomainAllowed,
  stableStringify,
  signManifestPayload,
  verifyManifestSignature,
  extractHostname,
  validateProductionSecurity,
} from "./security-utils.js";

describe("parseAllowedPaths", () => {
  it("should return empty array for undefined", () => {
    expect(parseAllowedPaths(undefined)).toEqual([]);
  });

  it("should return empty array for empty string", () => {
    expect(parseAllowedPaths("")).toEqual([]);
  });

  it("should parse single path", () => {
    expect(parseAllowedPaths("/tmp")).toEqual(["/tmp"]);
  });

  it("should parse multiple paths", () => {
    expect(parseAllowedPaths("/tmp,/home/user,/var/data")).toEqual([
      "/tmp",
      "/home/user",
      "/var/data",
    ]);
  });

  it("should trim whitespace", () => {
    expect(parseAllowedPaths("  /tmp  ,  /home  ")).toEqual(["/tmp", "/home"]);
  });

  it("should filter empty entries", () => {
    expect(parseAllowedPaths("/tmp,,/home,")).toEqual(["/tmp", "/home"]);
  });
});

describe("parseAllowedDomains", () => {
  it("should return empty array for undefined", () => {
    expect(parseAllowedDomains(undefined)).toEqual([]);
  });

  it("should return empty array for empty string", () => {
    expect(parseAllowedDomains("")).toEqual([]);
  });

  it("should parse single domain", () => {
    expect(parseAllowedDomains("example.com")).toEqual(["example.com"]);
  });

  it("should parse multiple domains", () => {
    expect(parseAllowedDomains("api.example.com,*.trusted.com,localhost")).toEqual([
      "api.example.com",
      "*.trusted.com",
      "localhost",
    ]);
  });

  it("should lowercase domains", () => {
    expect(parseAllowedDomains("API.Example.COM")).toEqual(["api.example.com"]);
  });

  it("should trim whitespace", () => {
    expect(parseAllowedDomains("  example.com  ,  api.test.com  ")).toEqual([
      "example.com",
      "api.test.com",
    ]);
  });
});

describe("parseBoolean", () => {
  it("should return fallback for undefined", () => {
    expect(parseBoolean(undefined, true)).toBe(true);
    expect(parseBoolean(undefined, false)).toBe(false);
  });

  it("should parse true values", () => {
    expect(parseBoolean("true", false)).toBe(true);
    expect(parseBoolean("TRUE", false)).toBe(true);
    expect(parseBoolean("1", false)).toBe(true);
    expect(parseBoolean("yes", false)).toBe(true);
    expect(parseBoolean("y", false)).toBe(true);
  });

  it("should parse false values", () => {
    expect(parseBoolean("false", true)).toBe(false);
    expect(parseBoolean("FALSE", true)).toBe(false);
    expect(parseBoolean("0", true)).toBe(false);
    expect(parseBoolean("no", true)).toBe(false);
    expect(parseBoolean("n", true)).toBe(false);
  });

  it("should return fallback for invalid values", () => {
    expect(parseBoolean("invalid", true)).toBe(true);
    expect(parseBoolean("invalid", false)).toBe(false);
  });
});

describe("normalizePath", () => {
  it("should resolve relative paths", () => {
    const result = normalizePath("./test");
    expect(result).toContain("test");
    expect(result).not.toContain("./");
  });

  it("should handle absolute paths", () => {
    const result = normalizePath("/absolute/path");
    expect(result).toBe("/absolute/path");
  });
});

describe("isPathWithin", () => {
  it("should return true for exact match", () => {
    expect(isPathWithin("/tmp", "/tmp")).toBe(true);
  });

  it("should return true for path within directory", () => {
    expect(isPathWithin("/tmp/file.txt", "/tmp")).toBe(true);
    expect(isPathWithin("/tmp/subdir/file.txt", "/tmp")).toBe(true);
  });

  it("should return false for path outside directory", () => {
    expect(isPathWithin("/home/file.txt", "/tmp")).toBe(false);
  });

  it("should return false for similar prefix but different directory", () => {
    // /tmp-other should NOT be within /tmp
    expect(isPathWithin("/tmp-other/file.txt", "/tmp")).toBe(false);
  });
});

describe("isPathAllowed", () => {
  it("should allow any path when allowAll is true", () => {
    expect(isPathAllowed("/any/path", [], true)).toBe(true);
  });

  it("should deny all paths when allowlist is empty and allowAll is false", () => {
    expect(isPathAllowed("/tmp/file.txt", [], false)).toBe(false);
  });

  it("should allow paths within allowed directories", () => {
    const allowed = ["/tmp", "/home/user/data"];
    expect(isPathAllowed("/tmp/file.txt", allowed, false)).toBe(true);
    expect(isPathAllowed("/home/user/data/file.txt", allowed, false)).toBe(true);
  });

  it("should deny paths outside allowed directories", () => {
    const allowed = ["/tmp", "/home/user/data"];
    expect(isPathAllowed("/etc/passwd", allowed, false)).toBe(false);
    expect(isPathAllowed("/home/user/secret", allowed, false)).toBe(false);
  });

  it("should handle multiple allowed paths", () => {
    const allowed = ["/tmp", "/var/log", "/opt/app"];
    expect(isPathAllowed("/tmp/test", allowed, false)).toBe(true);
    expect(isPathAllowed("/var/log/app.log", allowed, false)).toBe(true);
    expect(isPathAllowed("/opt/app/config", allowed, false)).toBe(true);
    expect(isPathAllowed("/root/secret", allowed, false)).toBe(false);
  });
});

describe("isDomainAllowed", () => {
  it("should allow any domain when allowAll is true", () => {
    expect(isDomainAllowed("evil.com", [], true)).toBe(true);
  });

  it("should deny all domains when allowlist is empty and allowAll is false", () => {
    expect(isDomainAllowed("example.com", [], false)).toBe(false);
  });

  it("should allow exact domain matches", () => {
    const allowed = ["api.example.com", "trusted.org"];
    expect(isDomainAllowed("api.example.com", allowed, false)).toBe(true);
    expect(isDomainAllowed("trusted.org", allowed, false)).toBe(true);
  });

  it("should deny non-matching domains", () => {
    const allowed = ["api.example.com"];
    expect(isDomainAllowed("evil.com", allowed, false)).toBe(false);
    expect(isDomainAllowed("other.example.com", allowed, false)).toBe(false);
  });

  it("should support wildcard domains", () => {
    const allowed = ["*.example.com"];
    expect(isDomainAllowed("api.example.com", allowed, false)).toBe(true);
    expect(isDomainAllowed("sub.api.example.com", allowed, false)).toBe(true);
    expect(isDomainAllowed("example.com", allowed, false)).toBe(true); // base domain matches too
  });

  it("should not match wildcard across different domains", () => {
    const allowed = ["*.example.com"];
    expect(isDomainAllowed("notexample.com", allowed, false)).toBe(false);
    expect(isDomainAllowed("evil.com", allowed, false)).toBe(false);
  });

  it("should be case-insensitive", () => {
    const allowed = ["api.example.com"];
    expect(isDomainAllowed("API.EXAMPLE.COM", allowed, false)).toBe(true);
    expect(isDomainAllowed("Api.Example.Com", allowed, false)).toBe(true);
  });

  it("should handle mixed exact and wildcard domains", () => {
    const allowed = ["api.example.com", "*.trusted.org", "localhost"];
    expect(isDomainAllowed("api.example.com", allowed, false)).toBe(true);
    expect(isDomainAllowed("sub.trusted.org", allowed, false)).toBe(true);
    expect(isDomainAllowed("localhost", allowed, false)).toBe(true);
    expect(isDomainAllowed("evil.com", allowed, false)).toBe(false);
  });
});

describe("stableStringify", () => {
  it("should handle primitives", () => {
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify(123)).toBe("123");
    expect(stableStringify("hello")).toBe('"hello"');
    expect(stableStringify(true)).toBe("true");
  });

  it("should handle arrays", () => {
    expect(stableStringify([1, 2, 3])).toBe("[1,2,3]");
    expect(stableStringify(["a", "b"])).toBe('["a","b"]');
  });

  it("should sort object keys deterministically", () => {
    const obj1 = { b: 2, a: 1 };
    const obj2 = { a: 1, b: 2 };
    expect(stableStringify(obj1)).toBe(stableStringify(obj2));
  });

  it("should handle nested objects", () => {
    const obj = { z: { b: 2, a: 1 }, a: 1 };
    const result = stableStringify(obj);
    expect(result).toContain('"a":1');
    expect(result).toContain('"z"');
  });

  it("should handle dates", () => {
    const date = new Date("2026-01-01T00:00:00Z");
    const result = stableStringify(date);
    expect(result).toContain("2026-01-01");
  });
});

describe("signManifestPayload", () => {
  it("should generate consistent signature", () => {
    const manifest = { id: "test", name: "Test Agent" };
    const secret = "test-secret";

    const sig1 = signManifestPayload(manifest, secret);
    const sig2 = signManifestPayload(manifest, secret);

    expect(sig1).toBe(sig2);
  });

  it("should generate different signature for different payloads", () => {
    const secret = "test-secret";
    const manifest1 = { id: "test1", name: "Test Agent 1" };
    const manifest2 = { id: "test2", name: "Test Agent 2" };

    const sig1 = signManifestPayload(manifest1, secret);
    const sig2 = signManifestPayload(manifest2, secret);

    expect(sig1).not.toBe(sig2);
  });

  it("should generate different signature for different secrets", () => {
    const manifest = { id: "test", name: "Test Agent" };

    const sig1 = signManifestPayload(manifest, "secret1");
    const sig2 = signManifestPayload(manifest, "secret2");

    expect(sig1).not.toBe(sig2);
  });

  it("should ignore existing signature in payload", () => {
    const manifest1 = { id: "test", name: "Test Agent" };
    const manifest2 = { id: "test", name: "Test Agent", signature: "existing" };
    const secret = "test-secret";

    const sig1 = signManifestPayload(manifest1, secret);
    const sig2 = signManifestPayload(manifest2, secret);

    expect(sig1).toBe(sig2);
  });
});

describe("verifyManifestSignature", () => {
  it("should verify valid signature", () => {
    const secret = "test-secret";
    const manifest = { id: "test", name: "Test Agent" };
    const signature = signManifestPayload(manifest, secret);
    const signedManifest = { ...manifest, signature };

    const result = verifyManifestSignature(signedManifest, secret);

    expect(result.ok).toBe(true);
  });

  it("should reject missing signature", () => {
    const manifest = { id: "test", name: "Test Agent" };

    const result = verifyManifestSignature(manifest, "secret");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("missing");
  });

  it("should reject invalid signature", () => {
    const manifest = { id: "test", name: "Test Agent", signature: "invalid" };

    const result = verifyManifestSignature(manifest, "secret");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("mismatch");
  });

  it("should reject signature with wrong secret", () => {
    const manifest = { id: "test", name: "Test Agent" };
    const signature = signManifestPayload(manifest, "correct-secret");
    const signedManifest = { ...manifest, signature };

    const result = verifyManifestSignature(signedManifest, "wrong-secret");

    expect(result.ok).toBe(false);
  });
});

describe("extractHostname", () => {
  it("should extract hostname from URL", () => {
    expect(extractHostname("https://api.example.com/path")).toBe("api.example.com");
    expect(extractHostname("http://localhost:3000")).toBe("localhost");
    expect(extractHostname("https://sub.domain.co.uk/page")).toBe("sub.domain.co.uk");
  });

  it("should return null for invalid URL", () => {
    expect(extractHostname("not-a-url")).toBe(null);
    expect(extractHostname("")).toBe(null);
  });
});

describe("validateProductionSecurity", () => {
  it("should pass validation in non-production", () => {
    const result = validateProductionSecurity({
      allowedPaths: [],
      allowedDomains: [],
      allowAllPaths: false,
      allowAllDomains: false,
      isProduction: false,
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("should require allowlists in production", () => {
    const result = validateProductionSecurity({
      allowedPaths: [],
      allowedDomains: [],
      allowAllPaths: false,
      allowAllDomains: false,
      isProduction: true,
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toContain("ALLOWED_PATHS");
    expect(result.errors[1]).toContain("ALLOWED_DOMAINS");
  });

  it("should accept explicit allowlists in production", () => {
    const result = validateProductionSecurity({
      allowedPaths: ["/tmp"],
      allowedDomains: ["example.com"],
      allowAllPaths: false,
      allowAllDomains: false,
      isProduction: true,
    });

    expect(result.valid).toBe(true);
  });

  it("should accept allow-all flags in production", () => {
    const result = validateProductionSecurity({
      allowedPaths: [],
      allowedDomains: [],
      allowAllPaths: true,
      allowAllDomains: true,
      isProduction: true,
    });

    expect(result.valid).toBe(true);
  });

  it("should require both path and domain configuration", () => {
    const result = validateProductionSecurity({
      allowedPaths: ["/tmp"],
      allowedDomains: [],
      allowAllPaths: false,
      allowAllDomains: false,
      isProduction: true,
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("ALLOWED_DOMAINS");
  });
});

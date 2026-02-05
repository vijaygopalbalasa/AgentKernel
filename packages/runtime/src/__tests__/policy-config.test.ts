import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PolicyConfigError,
  createFileRule,
  createNetworkRule,
  createSecretRule,
  createShellRule,
  expandEnvVars,
  expandEnvVarsInObject,
  loadPolicySetFromFile,
  loadPolicySetFromFiles,
  mergePolicySets,
  validatePolicySet,
} from "../policy-config.js";
import type { PolicySet } from "../policy-engine.js";

// ─── TEST HELPERS ──────────────────────────────────────────────────────────

let testDir: string;

function createTestFile(name: string, content: string): string {
  const filePath = join(testDir, name);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

// ─── TESTS ─────────────────────────────────────────────────────────────────

describe("expandEnvVars", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.TEST_VAR = "test_value";
    process.env.EMPTY_VAR = "";
    process.env.NUMBER_VAR = "42";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should expand simple variable", () => {
    expect(expandEnvVars("Hello ${TEST_VAR}")).toBe("Hello test_value");
  });

  it("should expand multiple variables", () => {
    expect(expandEnvVars("${TEST_VAR} and ${NUMBER_VAR}")).toBe("test_value and 42");
  });

  it("should return empty string for undefined variable", () => {
    expect(expandEnvVars("${UNDEFINED_VAR}")).toBe("");
  });

  it("should use default value when variable is undefined", () => {
    expect(expandEnvVars("${UNDEFINED_VAR:-default}")).toBe("default");
  });

  it("should use variable value when defined, ignoring default", () => {
    expect(expandEnvVars("${TEST_VAR:-default}")).toBe("test_value");
  });

  it("should use empty variable value instead of default", () => {
    expect(expandEnvVars("${EMPTY_VAR:-default}")).toBe("");
  });

  it("should handle complex default values", () => {
    expect(expandEnvVars("${UNDEFINED:-http://localhost:8080}")).toBe("http://localhost:8080");
  });

  it("should handle nested-looking patterns (not actually nested)", () => {
    expect(expandEnvVars("${TEST_VAR} ${UNDEFINED:-${NOT_NESTED}}")).toBe(
      "test_value ${NOT_NESTED}",
    );
  });

  it("should preserve text without variables", () => {
    expect(expandEnvVars("No variables here")).toBe("No variables here");
  });

  it("should handle variable at start", () => {
    expect(expandEnvVars("${TEST_VAR} end")).toBe("test_value end");
  });

  it("should handle variable at end", () => {
    expect(expandEnvVars("start ${TEST_VAR}")).toBe("start test_value");
  });

  it("should accept custom env object", () => {
    const customEnv = { CUSTOM: "custom_value" };
    expect(expandEnvVars("${CUSTOM}", customEnv)).toBe("custom_value");
  });
});

describe("expandEnvVarsInObject", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.HOST = "localhost";
    process.env.PORT = "8080";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should expand variables in string values", () => {
    const obj = { url: "http://${HOST}:${PORT}" };
    expect(expandEnvVarsInObject(obj)).toEqual({ url: "http://localhost:8080" });
  });

  it("should handle nested objects", () => {
    const obj = {
      server: {
        host: "${HOST}",
        port: "${PORT}",
      },
    };
    expect(expandEnvVarsInObject(obj)).toEqual({
      server: {
        host: "localhost",
        port: "8080",
      },
    });
  });

  it("should handle arrays", () => {
    const obj = { hosts: ["${HOST}", "other"] };
    expect(expandEnvVarsInObject(obj)).toEqual({ hosts: ["localhost", "other"] });
  });

  it("should preserve non-string values", () => {
    const obj = { count: 42, enabled: true, empty: null };
    expect(expandEnvVarsInObject(obj)).toEqual(obj);
  });

  it("should handle null and undefined", () => {
    expect(expandEnvVarsInObject(null)).toBeNull();
    expect(expandEnvVarsInObject(undefined)).toBeUndefined();
  });
});

describe("loadPolicySetFromFile", () => {
  beforeEach(() => {
    testDir = join(tmpdir(), `policy-config-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("should load YAML policy file", () => {
    const content = `
name: test-policy
defaultDecision: block
fileRules:
  - id: allow-tmp
    type: file
    decision: allow
    priority: 50
    enabled: true
    pathPatterns:
      - /tmp/**
    operations:
      - read
      - write
`;
    const filePath = createTestFile("policy.yaml", content);
    const policy = loadPolicySetFromFile(filePath);

    expect(policy.name).toBe("test-policy");
    expect(policy.defaultDecision).toBe("block");
    expect(policy.fileRules).toHaveLength(1);
    expect(policy.fileRules?.[0].id).toBe("allow-tmp");
  });

  it("should load JSON policy file", () => {
    const content = JSON.stringify({
      name: "json-policy",
      defaultDecision: "allow",
      networkRules: [
        {
          id: "allow-api",
          type: "network",
          decision: "allow",
          priority: 100,
          enabled: true,
          hostPatterns: ["api.example.com"],
        },
      ],
    });
    const filePath = createTestFile("policy.json", content);
    const policy = loadPolicySetFromFile(filePath);

    expect(policy.name).toBe("json-policy");
    expect(policy.networkRules).toHaveLength(1);
  });

  it("should expand environment variables", () => {
    process.env.TEST_PATH = "/custom/path";
    const content = `
name: env-policy
fileRules:
  - id: custom
    type: file
    decision: allow
    priority: 50
    enabled: true
    pathPatterns:
      - \${TEST_PATH}/**
    operations:
      - read
`;
    const filePath = createTestFile("policy.yaml", content);
    const policy = loadPolicySetFromFile(filePath);

    expect(policy.fileRules?.[0].pathPatterns).toContain("/custom/path/**");
    Reflect.deleteProperty(process.env, "TEST_PATH");
  });

  it("should disable env var expansion when option is false", () => {
    const content = `
name: no-expand
description: \${NOT_EXPANDED}
`;
    const filePath = createTestFile("policy.yaml", content);
    const policy = loadPolicySetFromFile(filePath, { expandEnvVars: false });

    expect(policy.description).toBe("${NOT_EXPANDED}");
  });

  it("should throw PolicyConfigError for missing file", () => {
    expect(() => loadPolicySetFromFile("/nonexistent/path.yaml")).toThrow(PolicyConfigError);
  });

  it("should throw PolicyConfigError for invalid YAML", () => {
    const content = `
name: invalid
  - broken yaml structure
 indentation: wrong
`;
    const filePath = createTestFile("invalid.yaml", content);
    expect(() => loadPolicySetFromFile(filePath)).toThrow(PolicyConfigError);
  });

  it("should throw PolicyConfigError for invalid policy structure", () => {
    const content = `
name: 12345
defaultDecision: invalid_value
`;
    const filePath = createTestFile("invalid.yaml", content);
    expect(() => loadPolicySetFromFile(filePath)).toThrow(PolicyConfigError);
  });

  it("should process includes", () => {
    // Create base policy
    const baseContent = `
name: base
defaultDecision: block
fileRules:
  - id: base-rule
    type: file
    decision: block
    priority: 100
    enabled: true
    pathPatterns:
      - ~/.ssh/**
    operations:
      - read
`;
    createTestFile("base.yaml", baseContent);

    // Create main policy with include
    const mainContent = `
includes:
  - ./base.yaml
name: main
fileRules:
  - id: main-rule
    type: file
    decision: allow
    priority: 50
    enabled: true
    pathPatterns:
      - /workspace/**
    operations:
      - read
      - write
`;
    const mainPath = createTestFile("main.yaml", mainContent);
    const policy = loadPolicySetFromFile(mainPath);

    expect(policy.name).toBe("main"); // Main overrides base
    expect(policy.defaultDecision).toBe("block"); // Inherited from base
    expect(policy.fileRules).toHaveLength(2); // Both rules included
  });
});

describe("loadPolicySetFromFiles", () => {
  beforeEach(() => {
    testDir = join(tmpdir(), `policy-config-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("should return empty object for empty array", () => {
    expect(loadPolicySetFromFiles([])).toEqual({});
  });

  it("should load single file", () => {
    const content = "name: single";
    const filePath = createTestFile("single.yaml", content);
    const policy = loadPolicySetFromFiles([filePath]);

    expect(policy.name).toBe("single");
  });

  it("should merge multiple files with later overriding earlier", () => {
    const base = `
name: base
defaultDecision: allow
fileRules:
  - id: rule-1
    type: file
    decision: allow
    priority: 50
    enabled: true
    pathPatterns: [/base/**]
    operations: [read]
`;
    const override = `
name: override
fileRules:
  - id: rule-1
    type: file
    decision: block
    priority: 100
    enabled: true
    pathPatterns: [/override/**]
    operations: [read, write]
  - id: rule-2
    type: file
    decision: allow
    priority: 50
    enabled: true
    pathPatterns: [/new/**]
    operations: [read]
`;
    const basePath = createTestFile("base.yaml", base);
    const overridePath = createTestFile("override.yaml", override);
    const policy = loadPolicySetFromFiles([basePath, overridePath]);

    expect(policy.name).toBe("override");
    expect(policy.defaultDecision).toBe("allow");
    expect(policy.fileRules).toHaveLength(2);

    const rule1 = policy.fileRules?.find((r) => r.id === "rule-1");
    expect(rule1?.decision).toBe("block"); // Overridden
    expect(rule1?.pathPatterns).toContain("/override/**");
  });
});

describe("mergePolicySets", () => {
  it("should return empty object for no arguments", () => {
    expect(mergePolicySets()).toEqual({});
  });

  it("should return same policy for single argument", () => {
    const policy: Partial<PolicySet> = { name: "test" };
    expect(mergePolicySets(policy)).toEqual(policy);
  });

  it("should merge simple fields (last wins)", () => {
    const policy1: Partial<PolicySet> = { name: "first", defaultDecision: "allow" };
    const policy2: Partial<PolicySet> = { name: "second" };
    const merged = mergePolicySets(policy1, policy2);

    expect(merged.name).toBe("second");
    expect(merged.defaultDecision).toBe("allow"); // Preserved from first
  });

  it("should merge rules by ID", () => {
    const policy1: Partial<PolicySet> = {
      fileRules: [
        {
          id: "rule-1",
          type: "file",
          decision: "allow",
          priority: 50,
          enabled: true,
          pathPatterns: ["/a"],
        },
      ],
    };
    const policy2: Partial<PolicySet> = {
      fileRules: [
        {
          id: "rule-1",
          type: "file",
          decision: "block",
          priority: 100,
          enabled: true,
          pathPatterns: ["/b"],
        },
        {
          id: "rule-2",
          type: "file",
          decision: "allow",
          priority: 50,
          enabled: true,
          pathPatterns: ["/c"],
        },
      ],
    };
    const merged = mergePolicySets(policy1, policy2);

    expect(merged.fileRules).toHaveLength(2);
    expect(merged.fileRules?.find((r) => r.id === "rule-1")?.decision).toBe("block");
  });
});

describe("validatePolicySet", () => {
  it("should return empty array for valid policy", () => {
    const policy: Partial<PolicySet> = {
      name: "valid",
      defaultDecision: "block",
      fileRules: [
        {
          id: "rule-1",
          type: "file",
          decision: "allow",
          priority: 50,
          enabled: true,
          pathPatterns: ["/tmp"],
        },
      ],
    };
    expect(validatePolicySet(policy)).toEqual([]);
  });

  it("should detect duplicate rule IDs", () => {
    const policy: Partial<PolicySet> = {
      fileRules: [
        {
          id: "same",
          type: "file",
          decision: "allow",
          priority: 50,
          enabled: true,
          pathPatterns: ["/a"],
        },
        {
          id: "same",
          type: "file",
          decision: "block",
          priority: 100,
          enabled: true,
          pathPatterns: ["/b"],
        },
      ],
    };
    const issues = validatePolicySet(policy);

    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("error");
    expect(issues[0].ruleId).toBe("same");
  });

  it("should warn about conflicting rules at same priority", () => {
    const policy: Partial<PolicySet> = {
      fileRules: [
        {
          id: "rule-1",
          type: "file",
          decision: "allow",
          priority: 50,
          enabled: true,
          pathPatterns: ["/a"],
        },
        {
          id: "rule-2",
          type: "file",
          decision: "block",
          priority: 50,
          enabled: true,
          pathPatterns: ["/b"],
        },
      ],
    };
    const issues = validatePolicySet(policy);

    expect(
      issues.some((i) => i.severity === "warning" && i.message.includes("different decisions")),
    ).toBe(true);
  });

  it("should warn about permissive default with no blocking rules", () => {
    const policy: Partial<PolicySet> = {
      defaultDecision: "allow",
      fileRules: [
        {
          id: "rule-1",
          type: "file",
          decision: "allow",
          priority: 50,
          enabled: true,
          pathPatterns: ["/a"],
        },
      ],
    };
    const issues = validatePolicySet(policy);

    expect(issues.some((i) => i.message.includes("very permissive"))).toBe(true);
  });
});

describe("Rule creation helpers", () => {
  it("should create file rule with defaults", () => {
    const rule = createFileRule("test", "allow", ["/tmp/**"]);

    expect(rule.id).toBe("test");
    expect(rule.type).toBe("file");
    expect(rule.decision).toBe("allow");
    expect(rule.priority).toBe(50);
    expect(rule.enabled).toBe(true);
    expect(rule.pathPatterns).toContain("/tmp/**");
  });

  it("should create file rule with custom options", () => {
    const rule = createFileRule("test", "block", ["/etc/**"], {
      operations: ["read"],
      priority: 100,
      description: "Block etc",
      enabled: false,
    });

    expect(rule.priority).toBe(100);
    expect(rule.description).toBe("Block etc");
    expect(rule.enabled).toBe(false);
    expect(rule.operations).toEqual(["read"]);
  });

  it("should create network rule", () => {
    const rule = createNetworkRule("api", "allow", ["api.example.com"], {
      ports: [443],
      protocols: ["https"],
    });

    expect(rule.type).toBe("network");
    expect(rule.hostPatterns).toContain("api.example.com");
    expect(rule.ports).toContain(443);
    expect(rule.protocols).toContain("https");
  });

  it("should create shell rule", () => {
    const rule = createShellRule("git", "allow", ["git *"], {
      argPatterns: ["--no-verify"],
    });

    expect(rule.type).toBe("shell");
    expect(rule.commandPatterns).toContain("git *");
    expect(rule.argPatterns).toContain("--no-verify");
  });

  it("should create secret rule", () => {
    const rule = createSecretRule("api-keys", "approve", ["*_API_KEY"]);

    expect(rule.type).toBe("secret");
    expect(rule.namePatterns).toContain("*_API_KEY");
    expect(rule.decision).toBe("approve");
  });
});

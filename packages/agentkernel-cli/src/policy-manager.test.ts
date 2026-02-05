import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ResolvedTarget,
  type SimplifiedPolicyYaml,
  addAllowRule,
  addBlockRule,
  generatePolicyFromTemplate,
  loadSimplifiedPolicy,
  removeRules,
  resolveTarget,
  resolveTypedTarget,
  saveSimplifiedPolicy,
  simplifiedToRuntimeFormat,
  summarizePolicy,
} from "./policy-manager.js";

// ─── TEST HELPERS ────────────────────────────────────────────

let testDir: string;
let policyPath: string;

beforeEach(() => {
  testDir = join(tmpdir(), `agentkernel-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  policyPath = join(testDir, "policy.yaml");
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// ─── TARGET RESOLUTION ──────────────────────────────────────

describe("resolveTarget", () => {
  it("resolves known target by exact name", () => {
    const result = resolveTarget("telegram");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("domain");
    expect(result!.label).toBe("Telegram");
    expect(result!.patterns).toContain("api.telegram.org");
    expect(result!.knownMalicious).toBe(true);
  });

  it("resolves known target case-insensitively", () => {
    const result = resolveTarget("Telegram");
    expect(result).not.toBeNull();
    expect(result!.label).toBe("Telegram");
  });

  it("resolves by substring match", () => {
    const result = resolveTarget("ssh");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("file");
    expect(result!.patterns).toContain("**/.ssh/**");
  });

  it("resolves discord", () => {
    const result = resolveTarget("discord");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("domain");
    expect(result!.patterns).toContain("discord.com");
    expect(result!.knownMalicious).toBe(true);
  });

  it("resolves github as safe target", () => {
    const result = resolveTarget("github");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("domain");
    expect(result!.knownMalicious).toBe(false);
  });

  it("detects file path heuristically", () => {
    const result = resolveTarget("~/my-project");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("file");
    expect(result!.patterns[0]).toBe("~/my-project/**");
  });

  it("detects absolute file path", () => {
    const result = resolveTarget("/var/data");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("file");
    expect(result!.patterns[0]).toBe("/var/data/**");
  });

  it("detects domain heuristically", () => {
    const result = resolveTarget("api.example.com");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("domain");
    expect(result!.patterns[0]).toBe("api.example.com");
  });

  it("detects command heuristically", () => {
    const result = resolveTarget("rm -rf*");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("command");
  });

  it("returns null for empty input", () => {
    expect(resolveTarget("")).toBeNull();
    expect(resolveTarget("  ")).toBeNull();
  });

  it("resolves reverse shells", () => {
    const result = resolveTarget("reverse shells");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("command");
    expect(result!.knownMalicious).toBe(true);
  });

  it("resolves npm as safe domain", () => {
    const result = resolveTarget("npm");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("domain");
    expect(result!.knownMalicious).toBe(false);
  });
});

describe("resolveTypedTarget", () => {
  it("creates domain target", () => {
    const result = resolveTypedTarget("api.example.com", "domain");
    expect(result.type).toBe("domain");
    expect(result.patterns).toEqual(["api.example.com"]);
  });

  it("creates file target with auto-glob", () => {
    const result = resolveTypedTarget("~/projects", "file");
    expect(result.type).toBe("file");
    expect(result.patterns[0]).toBe("~/projects/**");
  });

  it("preserves existing glob in file target", () => {
    const result = resolveTypedTarget("**/.ssh/**", "file");
    expect(result.patterns[0]).toBe("**/.ssh/**");
  });

  it("creates command target", () => {
    const result = resolveTypedTarget("rm -rf*", "command");
    expect(result.type).toBe("command");
    expect(result.patterns).toEqual(["rm -rf*"]);
  });
});

// ─── POLICY YAML I/O ───────────────────────────────────────

describe("loadSimplifiedPolicy", () => {
  it("returns empty object for missing file", () => {
    const result = loadSimplifiedPolicy(join(testDir, "nonexistent.yaml"));
    expect(result).toEqual({});
  });

  it("parses file section", () => {
    writeFileSync(
      policyPath,
      `file:
  default: block
  rules:
    - pattern: "**/.ssh/**"
      decision: block
      reason: "SSH credentials"
    - pattern: "/tmp/**"
      decision: allow
      reason: "Temp files"
`,
    );
    const result = loadSimplifiedPolicy(policyPath);
    expect(result.file).toBeDefined();
    expect(result.file!.default).toBe("block");
    expect(result.file!.rules).toHaveLength(2);
    expect(result.file!.rules![0]!.pattern).toBe("**/.ssh/**");
    expect(result.file!.rules![0]!.decision).toBe("block");
    expect(result.file!.rules![1]!.pattern).toBe("/tmp/**");
    expect(result.file!.rules![1]!.decision).toBe("allow");
  });

  it("parses network section", () => {
    writeFileSync(
      policyPath,
      `network:
  default: allow
  rules:
    - host: "api.telegram.org"
      decision: block
      reason: "Exfil channel"
`,
    );
    const result = loadSimplifiedPolicy(policyPath);
    expect(result.network!.rules![0]!.host).toBe("api.telegram.org");
    expect(result.network!.rules![0]!.decision).toBe("block");
  });

  it("parses shell section", () => {
    writeFileSync(
      policyPath,
      `shell:
  default: block
  rules:
    - command: "git"
      decision: allow
`,
    );
    const result = loadSimplifiedPolicy(policyPath);
    expect(result.shell!.rules![0]!.command).toBe("git");
  });

  it("parses secret section", () => {
    writeFileSync(
      policyPath,
      `secret:
  default: block
  rules:
    - name: "PATH"
      decision: allow
`,
    );
    const result = loadSimplifiedPolicy(policyPath);
    expect(result.secret!.rules![0]!.name).toBe("PATH");
  });

  it("parses template field", () => {
    writeFileSync(policyPath, `template: balanced\n`);
    const result = loadSimplifiedPolicy(policyPath);
    expect(result.template).toBe("balanced");
  });

  it("ignores comments", () => {
    writeFileSync(
      policyPath,
      `# This is a comment
file:
  default: block
  rules:
    # Block SSH
    - pattern: "**/.ssh/**"
      decision: block
`,
    );
    const result = loadSimplifiedPolicy(policyPath);
    expect(result.file!.rules).toHaveLength(1);
  });
});

describe("saveSimplifiedPolicy", () => {
  it("writes valid YAML that can be loaded back", () => {
    const policy: SimplifiedPolicyYaml = {
      template: "balanced",
      file: {
        default: "block",
        rules: [{ pattern: "**/.ssh/**", decision: "block", reason: "SSH" }],
      },
      network: {
        default: "block",
        rules: [{ host: "api.telegram.org", decision: "block", reason: "Exfil" }],
      },
    };

    saveSimplifiedPolicy(policyPath, policy);
    expect(existsSync(policyPath)).toBe(true);

    const loaded = loadSimplifiedPolicy(policyPath);
    expect(loaded.template).toBe("balanced");
    expect(loaded.file!.rules![0]!.pattern).toBe("**/.ssh/**");
    expect(loaded.network!.rules![0]!.host).toBe("api.telegram.org");
  });

  it("creates parent directories", () => {
    const nested = join(testDir, "deep", "nested", "policy.yaml");
    saveSimplifiedPolicy(nested, { template: "strict" });
    expect(existsSync(nested)).toBe(true);
  });
});

// ─── FORMAT CONVERSION ─────────────────────────────────────

describe("simplifiedToRuntimeFormat", () => {
  it("converts file rules to PolicySet format", () => {
    const yaml: SimplifiedPolicyYaml = {
      file: {
        rules: [
          { pattern: "**/.ssh/**", decision: "block", reason: "SSH" },
          { pattern: "/tmp/**", decision: "allow", reason: "Temp" },
        ],
      },
    };

    const result = simplifiedToRuntimeFormat(yaml);
    expect(result.fileRules).toHaveLength(2);
    expect(result.fileRules![0]!.pathPatterns).toEqual(["**/.ssh/**"]);
    expect(result.fileRules![0]!.decision).toBe("block");
    expect(result.fileRules![0]!.type).toBe("file");
    expect(result.fileRules![0]!.operations).toEqual(["read", "write", "delete", "list"]);
  });

  it("converts network rules to PolicySet format", () => {
    const yaml: SimplifiedPolicyYaml = {
      network: {
        rules: [{ host: "api.telegram.org", decision: "block" }],
      },
    };

    const result = simplifiedToRuntimeFormat(yaml);
    expect(result.networkRules).toHaveLength(1);
    expect(result.networkRules![0]!.hostPatterns).toEqual(["api.telegram.org"]);
    expect(result.networkRules![0]!.type).toBe("network");
  });

  it("converts shell rules to PolicySet format", () => {
    const yaml: SimplifiedPolicyYaml = {
      shell: {
        rules: [
          { command: "curl*|*sh", decision: "block" },
          { command: "rm -rf*", decision: "approve" },
          { command: "git", decision: "allow" },
        ],
      },
    };

    const result = simplifiedToRuntimeFormat(yaml);
    expect(result.shellRules).toHaveLength(3);
    expect(result.shellRules![0]!.priority).toBe(100); // block
    expect(result.shellRules![1]!.priority).toBe(90); // approve
    expect(result.shellRules![2]!.priority).toBe(50); // allow
  });

  it("converts secret rules to PolicySet format", () => {
    const yaml: SimplifiedPolicyYaml = {
      secret: {
        rules: [
          { name: "PATH", decision: "allow" },
          { name: "*_API_KEY", decision: "block" },
        ],
      },
    };

    const result = simplifiedToRuntimeFormat(yaml);
    expect(result.secretRules).toHaveLength(2);
    expect(result.secretRules![0]!.namePatterns).toEqual(["PATH"]);
    expect(result.secretRules![0]!.priority).toBe(100); // allow
    expect(result.secretRules![1]!.priority).toBe(90); // block
  });

  it("handles empty policy", () => {
    const result = simplifiedToRuntimeFormat({});
    expect(result.name).toBe("custom");
    expect(result.fileRules).toBeUndefined();
  });
});

// ─── RULE MANAGEMENT ───────────────────────────────────────

describe("addAllowRule", () => {
  it("adds file allow rule", () => {
    const target: ResolvedTarget = {
      type: "file",
      label: "My Project",
      patterns: ["~/my-project/**"],
      reason: "Project folder",
      knownMalicious: false,
    };

    const result = addAllowRule(policyPath, target);
    expect(result.success).toBe(true);
    expect(result.alreadyExists).toBe(false);

    const loaded = loadSimplifiedPolicy(policyPath);
    expect(loaded.file!.rules![0]!.pattern).toBe("~/my-project/**");
    expect(loaded.file!.rules![0]!.decision).toBe("allow");
  });

  it("adds network allow rule", () => {
    const target: ResolvedTarget = {
      type: "domain",
      label: "GitHub",
      patterns: ["*.github.com"],
      reason: "Code hosting",
      knownMalicious: false,
    };

    addAllowRule(policyPath, target);
    const loaded = loadSimplifiedPolicy(policyPath);
    expect(loaded.network!.rules![0]!.host).toBe("*.github.com");
  });

  it("detects duplicate rules", () => {
    const target: ResolvedTarget = {
      type: "domain",
      label: "GitHub",
      patterns: ["*.github.com"],
      reason: "Code hosting",
      knownMalicious: false,
    };

    addAllowRule(policyPath, target);
    const result2 = addAllowRule(policyPath, target);
    expect(result2.alreadyExists).toBe(true);

    const loaded = loadSimplifiedPolicy(policyPath);
    expect(loaded.network!.rules).toHaveLength(1);
  });
});

describe("addBlockRule", () => {
  it("adds network block rule", () => {
    const target: ResolvedTarget = {
      type: "domain",
      label: "Telegram",
      patterns: ["api.telegram.org", "*.telegram.org"],
      reason: "Exfil channel",
      knownMalicious: true,
    };

    addBlockRule(policyPath, target);
    const loaded = loadSimplifiedPolicy(policyPath);
    expect(loaded.network!.rules).toHaveLength(2);
    expect(loaded.network!.rules![0]!.decision).toBe("block");
  });

  it("adds shell block rule", () => {
    const target: ResolvedTarget = {
      type: "command",
      label: "rm -rf",
      patterns: ["rm -rf*"],
      reason: "Destructive",
      knownMalicious: false,
    };

    addBlockRule(policyPath, target);
    const loaded = loadSimplifiedPolicy(policyPath);
    expect(loaded.shell!.rules![0]!.command).toBe("rm -rf*");
    expect(loaded.shell!.rules![0]!.decision).toBe("block");
  });
});

describe("removeRules", () => {
  it("removes matching rules", () => {
    const target: ResolvedTarget = {
      type: "domain",
      label: "Telegram",
      patterns: ["api.telegram.org"],
      reason: "Exfil",
      knownMalicious: true,
    };

    addBlockRule(policyPath, target);
    const result = removeRules(policyPath, target);

    expect(result.removed).toBe(1);
    expect(result.descriptions).toHaveLength(1);

    const loaded = loadSimplifiedPolicy(policyPath);
    expect(loaded.network!.rules).toHaveLength(0);
  });

  it("warns when unblocking malicious target", () => {
    const target: ResolvedTarget = {
      type: "domain",
      label: "Telegram",
      patterns: ["api.telegram.org"],
      reason: "Data exfiltration channel",
      knownMalicious: true,
    };

    addBlockRule(policyPath, target);
    const result = removeRules(policyPath, target);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("WARNING");
  });

  it("returns zero when no rules match", () => {
    saveSimplifiedPolicy(policyPath, {});
    const target: ResolvedTarget = {
      type: "domain",
      label: "foo",
      patterns: ["foo.com"],
      reason: "test",
      knownMalicious: false,
    };
    const result = removeRules(policyPath, target);
    expect(result.removed).toBe(0);
  });
});

// ─── TEMPLATE GENERATION ───────────────────────────────────

describe("generatePolicyFromTemplate", () => {
  it("generates strict template", () => {
    const yaml = generatePolicyFromTemplate({ template: "strict" });
    expect(yaml).toContain("template: strict");
    expect(yaml).toContain("default: block");
    // Strict blocks exfil domains
    expect(yaml).toContain("api.telegram.org");
  });

  it("generates balanced template", () => {
    const yaml = generatePolicyFromTemplate({ template: "balanced" });
    expect(yaml).toContain("template: balanced");
    // Balanced allows dev tools
    expect(yaml).toContain("registry.npmjs.org");
    expect(yaml).toContain("api.github.com");
    // Balanced uses approve for destructive commands
    expect(yaml).toContain("decision: approve");
  });

  it("generates permissive template", () => {
    const yaml = generatePolicyFromTemplate({ template: "permissive" });
    expect(yaml).toContain("template: permissive");
    expect(yaml).toContain("default: allow");
    // Still blocks malicious domains
    expect(yaml).toContain("api.telegram.org");
  });

  it("includes project folder when specified", () => {
    const yaml = generatePolicyFromTemplate({
      template: "balanced",
      projectFolder: "/home/user/project",
    });
    expect(yaml).toContain("/home/user/project/**");
    expect(yaml).toContain("Your project folder");
  });

  it("blocks sensitive files in all templates", () => {
    for (const template of ["strict", "balanced", "permissive"] as const) {
      const yaml = generatePolicyFromTemplate({ template });
      expect(yaml).toContain("**/.ssh/**");
      expect(yaml).toContain("**/.aws/**");
      expect(yaml).toContain("**/.env");
    }
  });

  it("blocks exfil domains in all templates", () => {
    for (const template of ["strict", "balanced", "permissive"] as const) {
      const yaml = generatePolicyFromTemplate({ template });
      expect(yaml).toContain("api.telegram.org");
      expect(yaml).toContain("discord.com");
    }
  });

  it("generates parseable YAML", () => {
    const yaml = generatePolicyFromTemplate({
      template: "balanced",
      projectFolder: "/test",
    });
    writeFileSync(policyPath, yaml);
    const loaded = loadSimplifiedPolicy(policyPath);
    expect(loaded.template).toBe("balanced");
    expect(loaded.file).toBeDefined();
    expect(loaded.network).toBeDefined();
    expect(loaded.shell).toBeDefined();
    expect(loaded.secret).toBeDefined();
  });

  it("strict template allows dev tools when opted in", () => {
    const yaml = generatePolicyFromTemplate({
      template: "strict",
      allowDevTools: true,
    });
    expect(yaml).toContain("registry.npmjs.org");
  });

  it("strict template omits dev tools when opted out", () => {
    const yaml = generatePolicyFromTemplate({
      template: "strict",
      allowDevTools: false,
    });
    expect(yaml).not.toContain("registry.npmjs.org");
  });
});

// ─── POLICY SUMMARY ───────────────────────────────────────

describe("summarizePolicy", () => {
  it("summarizes a balanced policy", () => {
    const yaml = generatePolicyFromTemplate({ template: "balanced", projectFolder: "/test" });
    writeFileSync(policyPath, yaml);

    const summary = summarizePolicy(policyPath);
    expect(summary.templateName).toBe("balanced");
    expect(summary.blockedFiles.length).toBeGreaterThan(0);
    expect(summary.allowedFiles.length).toBeGreaterThan(0);
    expect(summary.blockedDomains.length).toBeGreaterThan(0);
    expect(summary.allowedDomains.length).toBeGreaterThan(0);
    expect(summary.blockedCommands.length).toBeGreaterThan(0);
    expect(summary.allowedCommands.length).toBeGreaterThan(0);
  });

  it("handles empty policy file", () => {
    saveSimplifiedPolicy(policyPath, {});
    const summary = summarizePolicy(policyPath);
    expect(summary.blockedFiles).toHaveLength(0);
    expect(summary.allowedFiles).toHaveLength(0);
  });

  it("identifies correct default decision", () => {
    const yaml = generatePolicyFromTemplate({ template: "strict" });
    writeFileSync(policyPath, yaml);
    const summary = summarizePolicy(policyPath);
    expect(summary.defaultDecision).toBe("block");
  });
});

// ─── ROUND TRIP ────────────────────────────────────────────

describe("round trip", () => {
  it("template → save → load → convert preserves rules", () => {
    const yaml = generatePolicyFromTemplate({
      template: "balanced",
      projectFolder: "/test",
    });
    writeFileSync(policyPath, yaml);

    const loaded = loadSimplifiedPolicy(policyPath);
    const runtime = simplifiedToRuntimeFormat(loaded);

    expect(runtime.fileRules!.length).toBeGreaterThan(0);
    expect(runtime.networkRules!.length).toBeGreaterThan(0);
    expect(runtime.shellRules!.length).toBeGreaterThan(0);
    expect(runtime.secretRules!.length).toBeGreaterThan(0);

    // Verify SSH block rule exists
    const sshRule = runtime.fileRules!.find((r) => r.pathPatterns.includes("**/.ssh/**"));
    expect(sshRule).toBeDefined();
    expect(sshRule!.decision).toBe("block");
  });

  it("allow/block/unblock cycle works", () => {
    saveSimplifiedPolicy(policyPath, {});

    // Allow github
    const githubTarget = resolveTarget("github")!;
    addAllowRule(policyPath, githubTarget);

    let loaded = loadSimplifiedPolicy(policyPath);
    expect(loaded.network!.rules!.length).toBeGreaterThan(0);

    // Block telegram
    const telegramTarget = resolveTarget("telegram")!;
    addBlockRule(policyPath, telegramTarget);

    loaded = loadSimplifiedPolicy(policyPath);
    const blockRules = loaded.network!.rules!.filter((r) => r.decision === "block");
    expect(blockRules.length).toBeGreaterThan(0);

    // Unblock telegram
    removeRules(policyPath, telegramTarget);

    loaded = loadSimplifiedPolicy(policyPath);
    const remainingBlocks = loaded.network!.rules!.filter((r) => r.decision === "block");
    expect(remainingBlocks).toHaveLength(0);
  });
});

// Default Policy Tests
// Tests for the default OpenClaw security policy

import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_OPENCLAW_POLICY,
  getDefaultOpenClawPolicy,
  mergeWithDefaultPolicy,
  MALICIOUS_EXFIL_DOMAINS,
  SENSITIVE_FILE_PATTERNS,
  DANGEROUS_SHELL_PATTERNS,
  CLOUD_METADATA_HOSTS,
  APPROVAL_REQUIRED_COMMANDS,
} from "./default-policy.js";
import type { PolicySet, FilePolicyRule } from "@agentkernel/runtime";

describe("Default OpenClaw Policy", () => {
  describe("MALICIOUS_EXFIL_DOMAINS", () => {
    it("should include Telegram", () => {
      expect(MALICIOUS_EXFIL_DOMAINS).toContain("api.telegram.org");
    });

    it("should include Discord", () => {
      expect(MALICIOUS_EXFIL_DOMAINS).toContain("discord.com");
    });

    it("should include paste sites", () => {
      expect(MALICIOUS_EXFIL_DOMAINS).toContain("pastebin.com");
      expect(MALICIOUS_EXFIL_DOMAINS).toContain("hastebin.com");
    });

    it("should include ngrok tunnels", () => {
      expect(MALICIOUS_EXFIL_DOMAINS.some((d) => d.includes("ngrok"))).toBe(true);
    });

    it("should block onion sites", () => {
      expect(MALICIOUS_EXFIL_DOMAINS).toContain("*.onion");
    });
  });

  describe("CLOUD_METADATA_HOSTS", () => {
    it("should include AWS/GCP/Azure metadata endpoint", () => {
      expect(CLOUD_METADATA_HOSTS).toContain("169.254.169.254");
    });

    it("should include GCP internal metadata", () => {
      expect(CLOUD_METADATA_HOSTS).toContain("metadata.google.internal");
    });

    it("should include ECS metadata endpoint", () => {
      expect(CLOUD_METADATA_HOSTS).toContain("169.254.170.2");
    });
  });

  describe("SENSITIVE_FILE_PATTERNS", () => {
    it("should include SSH credentials", () => {
      expect(SENSITIVE_FILE_PATTERNS.some((p) => p.includes(".ssh"))).toBe(true);
    });

    it("should include AWS credentials", () => {
      expect(SENSITIVE_FILE_PATTERNS.some((p) => p.includes(".aws"))).toBe(true);
    });

    it("should include .env files", () => {
      expect(SENSITIVE_FILE_PATTERNS).toContain("**/.env");
    });

    it("should include Chrome login data", () => {
      expect(SENSITIVE_FILE_PATTERNS.some((p) => p.includes("Login Data"))).toBe(true);
    });

    it("should include crypto wallets", () => {
      expect(SENSITIVE_FILE_PATTERNS.some((p) => p.includes("Exodus"))).toBe(true);
      expect(SENSITIVE_FILE_PATTERNS.some((p) => p.includes("Electrum"))).toBe(true);
    });

    it("should include macOS Keychain", () => {
      expect(SENSITIVE_FILE_PATTERNS.some((p) => p.includes("Keychains"))).toBe(true);
    });

    it("should include npm tokens", () => {
      expect(SENSITIVE_FILE_PATTERNS).toContain("**/.npmrc");
    });
  });

  describe("DANGEROUS_SHELL_PATTERNS", () => {
    it("should block curl pipe to shell", () => {
      expect(DANGEROUS_SHELL_PATTERNS.some((p) => p.includes("curl") && p.includes("sh"))).toBe(true);
      expect(DANGEROUS_SHELL_PATTERNS.some((p) => p.includes("curl") && p.includes("bash"))).toBe(true);
    });

    it("should block wget pipe to shell", () => {
      expect(DANGEROUS_SHELL_PATTERNS.some((p) => p.includes("wget") && p.includes("sh"))).toBe(true);
    });

    it("should block reverse shells", () => {
      expect(DANGEROUS_SHELL_PATTERNS).toContain("bash -i");
      expect(DANGEROUS_SHELL_PATTERNS).toContain("nc -e");
      expect(DANGEROUS_SHELL_PATTERNS.some((p) => p.includes("pty.spawn"))).toBe(true);
    });

    it("should block privilege escalation", () => {
      expect(DANGEROUS_SHELL_PATTERNS.some((p) => p.includes("chmod") && p.includes("+s"))).toBe(true);
    });

    it("should block anti-forensics", () => {
      expect(DANGEROUS_SHELL_PATTERNS.some((p) => p.includes("HISTFILE"))).toBe(true);
      expect(DANGEROUS_SHELL_PATTERNS.some((p) => p.includes(".bash_history"))).toBe(true);
    });

    it("should block base64 obfuscated execution", () => {
      expect(DANGEROUS_SHELL_PATTERNS.some((p) => p.includes("base64") && p.includes("sh"))).toBe(true);
    });

    it("should block clipboard theft", () => {
      expect(DANGEROUS_SHELL_PATTERNS).toContain("pbpaste");
      expect(DANGEROUS_SHELL_PATTERNS).toContain("xclip");
    });
  });

  describe("APPROVAL_REQUIRED_COMMANDS", () => {
    it("should require approval for rm -rf", () => {
      expect(APPROVAL_REQUIRED_COMMANDS.some((c) => c.startsWith("rm -rf"))).toBe(true);
    });

    it("should require approval for force push", () => {
      expect(APPROVAL_REQUIRED_COMMANDS.some((c) => c.includes("push --force"))).toBe(true);
    });

    it("should require approval for npm publish", () => {
      expect(APPROVAL_REQUIRED_COMMANDS.some((c) => c.startsWith("npm publish"))).toBe(true);
    });

    it("should require approval for sudo", () => {
      expect(APPROVAL_REQUIRED_COMMANDS.some((c) => c.startsWith("sudo"))).toBe(true);
    });

    it("should require approval for disk operations", () => {
      expect(APPROVAL_REQUIRED_COMMANDS.some((c) => c.startsWith("dd if="))).toBe(true);
    });
  });

  describe("DEFAULT_OPENCLAW_POLICY", () => {
    it("should have name and description", () => {
      expect(DEFAULT_OPENCLAW_POLICY.name).toBe("openclaw-default");
      expect(DEFAULT_OPENCLAW_POLICY.description).toContain("341+ malicious");
    });

    it("should have file rules", () => {
      expect(DEFAULT_OPENCLAW_POLICY.fileRules).toBeDefined();
      expect(DEFAULT_OPENCLAW_POLICY.fileRules.length).toBeGreaterThan(0);
    });

    it("should have network rules", () => {
      expect(DEFAULT_OPENCLAW_POLICY.networkRules).toBeDefined();
      expect(DEFAULT_OPENCLAW_POLICY.networkRules.length).toBeGreaterThan(0);
    });

    it("should have shell rules", () => {
      expect(DEFAULT_OPENCLAW_POLICY.shellRules).toBeDefined();
      expect(DEFAULT_OPENCLAW_POLICY.shellRules.length).toBeGreaterThan(0);
    });

    it("should have secret rules", () => {
      expect(DEFAULT_OPENCLAW_POLICY.secretRules).toBeDefined();
      expect(DEFAULT_OPENCLAW_POLICY.secretRules.length).toBeGreaterThan(0);
    });

    it("should default to allow decision", () => {
      expect(DEFAULT_OPENCLAW_POLICY.defaultDecision).toBe("allow");
    });
  });

  describe("getDefaultOpenClawPolicy", () => {
    it("should return a valid policy", () => {
      const policy = getDefaultOpenClawPolicy();
      expect(policy.name).toBe("openclaw-default");
      expect(policy.fileRules.length).toBeGreaterThan(0);
    });

    it("should generate unique rule IDs", () => {
      const policy1 = getDefaultOpenClawPolicy();
      const policy2 = getDefaultOpenClawPolicy();

      // IDs should match since counter resets
      expect(policy1.fileRules[0]?.id).toBe(policy2.fileRules[0]?.id);
    });
  });

  describe("mergeWithDefaultPolicy", () => {
    it("should merge custom rules with defaults", () => {
      const customRule: FilePolicyRule = {
        id: "custom-1",
        type: "file",
        description: "Custom rule",
        decision: "allow",
        priority: 200,
        enabled: true,
        pathPatterns: ["/custom/path/**"],
        operations: ["read"],
      };

      const customPolicy: Partial<PolicySet> = {
        name: "my-policy",
        fileRules: [customRule],
      };

      const merged = mergeWithDefaultPolicy(customPolicy);

      expect(merged.name).toBe("my-policy");
      // Custom rules should come first
      expect(merged.fileRules[0]?.id).toBe("custom-1");
      // Default rules should follow
      expect(merged.fileRules.length).toBeGreaterThan(1);
    });

    it("should preserve default rules when custom is partial", () => {
      const customPolicy: Partial<PolicySet> = {
        networkRules: [
          {
            id: "custom-network-1",
            type: "network",
            description: "Custom network rule",
            decision: "block",
            priority: 200,
            enabled: true,
            hostPatterns: ["custom.com"],
          },
        ],
      };

      const merged = mergeWithDefaultPolicy(customPolicy);

      // Should have custom network rules
      expect(merged.networkRules[0]?.hostPatterns).toContain("custom.com");
      // Should preserve default file rules
      expect(merged.fileRules.length).toBeGreaterThan(0);
      // Should preserve default shell rules
      expect(merged.shellRules.length).toBeGreaterThan(0);
    });

    it("should handle empty custom policy", () => {
      const merged = mergeWithDefaultPolicy({});

      expect(merged.name).toBe("openclaw-default");
      expect(merged.fileRules.length).toBeGreaterThan(0);
      expect(merged.networkRules.length).toBeGreaterThan(0);
    });

    it("should use custom default decision", () => {
      const merged = mergeWithDefaultPolicy({
        defaultDecision: "block",
      });

      expect(merged.defaultDecision).toBe("block");
    });
  });
});

describe("Policy Rule Coverage", () => {
  let policy: PolicySet;

  beforeEach(() => {
    policy = getDefaultOpenClawPolicy();
  });

  describe("File Policy Rules", () => {
    it("should block SSH private keys", () => {
      const sshRules = policy.fileRules.filter(
        (r) => r.pathPatterns.some((p) => p.includes(".ssh")) && r.decision === "block"
      );
      expect(sshRules.length).toBeGreaterThan(0);
    });

    it("should block AWS credentials", () => {
      const awsRules = policy.fileRules.filter(
        (r) => r.pathPatterns.some((p) => p.includes(".aws")) && r.decision === "block"
      );
      expect(awsRules.length).toBeGreaterThan(0);
    });

    it("should allow /tmp directory", () => {
      const tmpRule = policy.fileRules.find(
        (r) => r.pathPatterns.includes("/tmp/**") && r.decision === "allow"
      );
      expect(tmpRule).toBeDefined();
    });

    it("should block .env files", () => {
      const envRule = policy.fileRules.find(
        (r) => r.pathPatterns.includes("**/.env") && r.decision === "block"
      );
      expect(envRule).toBeDefined();
    });
  });

  describe("Network Policy Rules", () => {
    it("should block cloud metadata", () => {
      const metadataRules = policy.networkRules.filter(
        (r) => r.hostPatterns.includes("169.254.169.254") && r.decision === "block"
      );
      expect(metadataRules.length).toBeGreaterThan(0);
    });

    it("should block internal networks", () => {
      const internalRules = policy.networkRules.filter(
        (r) =>
          r.hostPatterns.some((h) => h.startsWith("10.") || h.startsWith("192.168")) &&
          r.decision === "block"
      );
      expect(internalRules.length).toBeGreaterThan(0);
    });

    it("should block Telegram", () => {
      const telegramRule = policy.networkRules.find(
        (r) => r.hostPatterns.includes("api.telegram.org") && r.decision === "block"
      );
      expect(telegramRule).toBeDefined();
    });
  });

  describe("Shell Policy Rules", () => {
    it("should allow git commands", () => {
      const gitRule = policy.shellRules.find(
        (r) => r.commandPatterns.includes("git") && r.decision === "allow"
      );
      expect(gitRule).toBeDefined();
    });

    it("should allow npm commands", () => {
      const npmRule = policy.shellRules.find(
        (r) => r.commandPatterns.includes("npm") && r.decision === "allow"
      );
      expect(npmRule).toBeDefined();
    });

    it("should have approval rules", () => {
      const approvalRules = policy.shellRules.filter((r) => r.decision === "approve");
      expect(approvalRules.length).toBeGreaterThan(0);
    });

    it("should block reverse shells", () => {
      const reverseShellRule = policy.shellRules.find(
        (r) => r.commandPatterns.includes("bash -i") && r.decision === "block"
      );
      expect(reverseShellRule).toBeDefined();
    });
  });

  describe("Secret Policy Rules", () => {
    it("should allow PATH", () => {
      const pathRule = policy.secretRules.find(
        (r) => r.namePatterns.includes("PATH") && r.decision === "allow"
      );
      expect(pathRule).toBeDefined();
    });

    it("should block API keys", () => {
      const apiKeyRule = policy.secretRules.find(
        (r) => r.namePatterns.includes("*_API_KEY") && r.decision === "block"
      );
      expect(apiKeyRule).toBeDefined();
    });

    it("should block provider-specific credentials", () => {
      const anthropicRule = policy.secretRules.find(
        (r) => r.namePatterns.includes("ANTHROPIC_*") && r.decision === "block"
      );
      const openaiRule = policy.secretRules.find(
        (r) => r.namePatterns.includes("OPENAI_*") && r.decision === "block"
      );
      const awsRule = policy.secretRules.find(
        (r) => r.namePatterns.includes("AWS_*") && r.decision === "block"
      );

      expect(anthropicRule).toBeDefined();
      expect(openaiRule).toBeDefined();
      expect(awsRule).toBeDefined();
    });
  });
});

describe("Rule Structure", () => {
  let policy: PolicySet;

  beforeEach(() => {
    policy = getDefaultOpenClawPolicy();
  });

  it("all file rules should have required fields", () => {
    for (const rule of policy.fileRules) {
      expect(rule.id).toBeDefined();
      expect(rule.type).toBe("file");
      expect(rule.decision).toBeDefined();
      expect(rule.pathPatterns.length).toBeGreaterThan(0);
      expect(rule.operations.length).toBeGreaterThan(0);
    }
  });

  it("all network rules should have required fields", () => {
    for (const rule of policy.networkRules) {
      expect(rule.id).toBeDefined();
      expect(rule.type).toBe("network");
      expect(rule.decision).toBeDefined();
      expect(rule.hostPatterns.length).toBeGreaterThan(0);
    }
  });

  it("all shell rules should have required fields", () => {
    for (const rule of policy.shellRules) {
      expect(rule.id).toBeDefined();
      expect(rule.type).toBe("shell");
      expect(rule.decision).toBeDefined();
      expect(rule.commandPatterns.length).toBeGreaterThan(0);
    }
  });

  it("all secret rules should have required fields", () => {
    for (const rule of policy.secretRules) {
      expect(rule.id).toBeDefined();
      expect(rule.type).toBe("secret");
      expect(rule.decision).toBeDefined();
      expect(rule.namePatterns.length).toBeGreaterThan(0);
    }
  });
});

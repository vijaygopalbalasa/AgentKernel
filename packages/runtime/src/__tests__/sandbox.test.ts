import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  AgentSandbox,
  SandboxRegistry,
  type Capability,
  DEFAULT_CAPABILITIES,
  DANGEROUS_CAPABILITIES,
  DEFAULT_SANDBOX_CONFIG,
} from "../sandbox.js";

describe("AgentSandbox", () => {
  let sandbox: AgentSandbox;

  beforeEach(() => {
    sandbox = new AgentSandbox("test-agent");
  });

  describe("initialization", () => {
    it("should create sandbox with default capabilities", () => {
      const capabilities = sandbox.getCapabilities();
      for (const cap of DEFAULT_CAPABILITIES) {
        expect(capabilities).toContain(cap);
      }
    });

    it("should respect custom config", () => {
      const customSandbox = new AgentSandbox("test", {
        defaultCapabilities: ["file:read"],
        enforcePermissions: false,
      });
      expect(customSandbox.getCapabilities()).toContain("file:read");
    });
  });

  describe("grant", () => {
    it("should grant a capability", () => {
      sandbox.grant("file:write", "system");
      expect(sandbox.has("file:write")).toBe(true);
    });

    it("should grant with expiration", () => {
      const future = new Date(Date.now() + 3600000); // 1 hour from now
      sandbox.grant("file:write", "system", { expiresAt: future });
      expect(sandbox.has("file:write")).toBe(true);
    });

    it("should grant with constraints", () => {
      sandbox.grant("file:read", "system", {
        constraints: {
          allowedPaths: ["/home/user/data"],
          maxPerMinute: 100,
        },
      });
      expect(sandbox.has("file:read")).toBe(true);
    });
  });

  describe("revoke", () => {
    it("should revoke a capability", () => {
      sandbox.grant("file:write", "system");
      expect(sandbox.has("file:write")).toBe(true);

      const result = sandbox.revoke("file:write");
      expect(result).toBe(true);
      expect(sandbox.has("file:write")).toBe(false);
    });

    it("should return false when revoking non-existent capability", () => {
      const result = sandbox.revoke("shell:execute");
      expect(result).toBe(false);
    });
  });

  describe("has", () => {
    it("should return true for granted capability", () => {
      expect(sandbox.has("llm:chat")).toBe(true);
    });

    it("should return false for non-granted capability", () => {
      expect(sandbox.has("shell:execute")).toBe(false);
    });

    it("should return false for expired capability", () => {
      const past = new Date(Date.now() - 1000);
      sandbox.grant("file:write", "system", { expiresAt: past });
      expect(sandbox.has("file:write")).toBe(false);
    });
  });

  describe("check", () => {
    it("should allow granted capability", () => {
      const result = sandbox.check("llm:chat");
      expect(result.allowed).toBe(true);
    });

    it("should deny non-granted capability", () => {
      const result = sandbox.check("shell:execute");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("not granted");
    });

    it("should enforce rate limits", () => {
      sandbox.grant("network:http", "system", {
        constraints: { maxPerMinute: 2 },
      });

      expect(sandbox.check("network:http").allowed).toBe(true);
      expect(sandbox.check("network:http").allowed).toBe(true);
      const result = sandbox.check("network:http");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Rate limit");
    });

    it("should track remaining quota", () => {
      sandbox.grant("network:http", "system", {
        constraints: { maxPerMinute: 5 },
      });

      const result = sandbox.check("network:http");
      expect(result.remainingQuota?.perMinute).toBe(4);
    });

    it("should allow everything in permissive mode", () => {
      const permissiveSandbox = new AgentSandbox("test", {
        enforcePermissions: false,
        defaultCapabilities: [],
      });
      const result = permissiveSandbox.check("shell:execute");
      expect(result.allowed).toBe(true);
    });

    it("should record audit entries", () => {
      sandbox.check("llm:chat");
      sandbox.check("shell:execute");

      const auditLog = sandbox.getAuditLog();
      expect(auditLog).toHaveLength(2);
      const firstEntry = auditLog[0];
      expect(firstEntry).toBeDefined();
      if (!firstEntry) return;
      expect(firstEntry.capability).toBe("llm:chat");
      expect(firstEntry.allowed).toBe(true);
      const secondEntry = auditLog[1];
      expect(secondEntry).toBeDefined();
      if (!secondEntry) return;
      expect(secondEntry.capability).toBe("shell:execute");
      expect(secondEntry.allowed).toBe(false);
    });
  });

  describe("checkPathConstraint", () => {
    it("should allow paths in allowed list", () => {
      sandbox.grant("file:read", "system", {
        constraints: { allowedPaths: ["/home/user/data"] },
      });

      const result = sandbox.checkPathConstraint("file:read", "/home/user/data/file.txt");
      expect(result.allowed).toBe(true);
    });

    it("should deny paths not in allowed list", () => {
      sandbox.grant("file:read", "system", {
        constraints: { allowedPaths: ["/home/user/data"] },
      });

      const result = sandbox.checkPathConstraint("file:read", "/etc/passwd");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("not in allowed paths");
    });

    it("should deny blocked paths", () => {
      sandbox.grant("file:read", "system", {
        constraints: { blockedPaths: ["/etc", "/var/log"] },
      });

      const result = sandbox.checkPathConstraint("file:read", "/etc/passwd");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("blocked");
    });
  });

  describe("checkHostConstraint", () => {
    it("should allow hosts in allowed list", () => {
      sandbox.grant("network:http", "system", {
        constraints: { allowedHosts: ["api.example.com"] },
      });

      const result = sandbox.checkHostConstraint("network:http", "api.example.com");
      expect(result.allowed).toBe(true);
    });

    it("should allow subdomains of allowed hosts", () => {
      sandbox.grant("network:http", "system", {
        constraints: { allowedHosts: ["example.com"] },
      });

      const result = sandbox.checkHostConstraint("network:http", "api.example.com");
      expect(result.allowed).toBe(true);
    });

    it("should deny blocked hosts", () => {
      sandbox.grant("network:http", "system", {
        constraints: { blockedHosts: ["malicious.com"] },
      });

      const result = sandbox.checkHostConstraint("network:http", "malicious.com");
      expect(result.allowed).toBe(false);
    });
  });

  describe("serialization", () => {
    it("should serialize to JSON", () => {
      sandbox.grant("file:write", "system");
      const json = sandbox.toJSON();

      expect(json.agentId).toBe("test-agent");
      expect(json.grants.length).toBeGreaterThan(0);
    });

    it("should restore from JSON", () => {
      sandbox.grant("file:write", "system");
      const json = sandbox.toJSON();

      const restored = AgentSandbox.fromJSON(json);
      expect(restored.has("file:write")).toBe(true);
    });
  });

  describe("audit log", () => {
    it("should clear audit log", () => {
      sandbox.check("llm:chat");
      sandbox.check("shell:execute");
      expect(sandbox.getAuditLog().length).toBe(2);

      sandbox.clearAuditLog();
      expect(sandbox.getAuditLog().length).toBe(0);
    });

    it("should limit audit log entries", () => {
      sandbox.check("llm:chat", { context: "test" });
      const log = sandbox.getAuditLog(1);
      expect(log.length).toBe(1);
    });
  });
});

describe("SandboxRegistry", () => {
  let registry: SandboxRegistry;

  beforeEach(() => {
    registry = new SandboxRegistry();
  });

  it("should create sandbox for agent", () => {
    const sandbox = registry.create("agent-1");
    expect(sandbox).toBeInstanceOf(AgentSandbox);
  });

  it("should get sandbox by agent ID", () => {
    registry.create("agent-1");
    const sandbox = registry.get("agent-1");
    expect(sandbox).toBeDefined();
  });

  it("should return undefined for non-existent agent", () => {
    const sandbox = registry.get("nonexistent");
    expect(sandbox).toBeUndefined();
  });

  it("should remove sandbox", () => {
    registry.create("agent-1");
    const result = registry.remove("agent-1");
    expect(result).toBe(true);
    expect(registry.get("agent-1")).toBeUndefined();
  });

  it("should check permissions globally", () => {
    registry.create("agent-1");
    registry.create("agent-2");

    const results = registry.checkGlobal("llm:chat");
    expect(results.size).toBe(2);
    expect(results.get("agent-1")?.allowed).toBe(true);
    expect(results.get("agent-2")?.allowed).toBe(true);
  });
});

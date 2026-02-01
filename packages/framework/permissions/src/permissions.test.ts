// Permissions System tests
import { describe, it, expect, beforeEach } from "vitest";
import { CapabilityManager } from "./capabilities.js";

describe("CapabilityManager", () => {
  let manager: CapabilityManager;

  beforeEach(() => {
    manager = new CapabilityManager("test-secret");
  });

  describe("Grant", () => {
    it("should grant capabilities to agents", () => {
      const token = manager.grant({
        agentId: "agent-001",
        permissions: [{ category: "memory", actions: ["read", "write"] }],
        purpose: "Memory access for task",
        durationMs: 60000,
      });

      expect(token.id).toMatch(/^cap-/);
      expect(token.agentId).toBe("agent-001");
      expect(token.permissions.length).toBe(1);
      expect(token.signature).toBeDefined();
    });

    it("should set expiration time", () => {
      const token = manager.grant({
        agentId: "agent-001",
        permissions: [{ category: "tools", actions: ["execute"] }],
        purpose: "Tool use",
        durationMs: 5000,
      });

      const expectedExpiry = token.issuedAt.getTime() + 5000;
      expect(token.expiresAt.getTime()).toBe(expectedExpiry);
    });
  });

  describe("Check", () => {
    it("should allow permitted actions", () => {
      manager.grant({
        agentId: "agent-001",
        permissions: [{ category: "memory", actions: ["read", "write"] }],
        purpose: "Test",
      });

      const result = manager.check("agent-001", "memory", "read");
      expect(result.allowed).toBe(true);
      expect(result.matchedToken).toBeDefined();
    });

    it("should deny unpermitted actions", () => {
      manager.grant({
        agentId: "agent-001",
        permissions: [{ category: "memory", actions: ["read"] }],
        purpose: "Read only",
      });

      const result = manager.check("agent-001", "memory", "write");
      expect(result.allowed).toBe(false);
    });

    it("should deny actions for different categories", () => {
      manager.grant({
        agentId: "agent-001",
        permissions: [{ category: "memory", actions: ["read", "write"] }],
        purpose: "Memory only",
      });

      const result = manager.check("agent-001", "filesystem", "read");
      expect(result.allowed).toBe(false);
    });

    it("should deny for agents without capabilities", () => {
      const result = manager.check("unknown-agent", "memory", "read");
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("No capabilities granted");
    });
  });

  describe("Resource Patterns", () => {
    it("should match exact resources", () => {
      manager.grant({
        agentId: "agent-001",
        permissions: [{ category: "filesystem", actions: ["read"], resource: "/data/file.txt" }],
        purpose: "Specific file access",
      });

      expect(manager.check("agent-001", "filesystem", "read", "/data/file.txt").allowed).toBe(true);
      expect(manager.check("agent-001", "filesystem", "read", "/other/file.txt").allowed).toBe(false);
    });

    it("should match glob patterns", () => {
      manager.grant({
        agentId: "agent-001",
        permissions: [{ category: "filesystem", actions: ["read"], resource: "/data/*" }],
        purpose: "Data folder access",
      });

      expect(manager.check("agent-001", "filesystem", "read", "/data/file.txt").allowed).toBe(true);
      expect(manager.check("agent-001", "filesystem", "read", "/data/nested/file.txt").allowed).toBe(false);
    });

    it("should allow without resource constraint when pattern not specified", () => {
      manager.grant({
        agentId: "agent-001",
        permissions: [{ category: "filesystem", actions: ["read"] }],
        purpose: "Full filesystem read access",
      });

      expect(manager.check("agent-001", "filesystem", "read", "/any/path/file.txt").allowed).toBe(true);
      expect(manager.check("agent-001", "filesystem", "read", "/data/nested/deep/file.txt").allowed).toBe(true);
    });
  });

  describe("Delegation", () => {
    it("should allow delegation of delegatable tokens", () => {
      const parentToken = manager.grant({
        agentId: "agent-001",
        permissions: [{ category: "memory", actions: ["read", "write"] }],
        purpose: "Parent capability",
        delegatable: true,
      });

      const childToken = manager.delegate(parentToken.id, "agent-002");

      expect(childToken).not.toBeNull();
      expect(childToken!.agentId).toBe("agent-002");
      expect(childToken!.parentTokenId).toBe(parentToken.id);
      expect(childToken!.delegatable).toBe(false);
    });

    it("should reject delegation of non-delegatable tokens", () => {
      const parentToken = manager.grant({
        agentId: "agent-001",
        permissions: [{ category: "memory", actions: ["read"] }],
        purpose: "Non-delegatable",
        delegatable: false,
      });

      const childToken = manager.delegate(parentToken.id, "agent-002");
      expect(childToken).toBeNull();
    });

    it("should limit delegated permissions to parent scope", () => {
      const parentToken = manager.grant({
        agentId: "agent-001",
        permissions: [{ category: "memory", actions: ["read"] }],
        purpose: "Read only",
        delegatable: true,
      });

      // Try to delegate with more permissions
      const childToken = manager.delegate(
        parentToken.id,
        "agent-002",
        [{ category: "memory", actions: ["read", "write"] }]
      );

      expect(childToken).toBeNull();
    });
  });

  describe("Revocation", () => {
    it("should revoke tokens", () => {
      const token = manager.grant({
        agentId: "agent-001",
        permissions: [{ category: "memory", actions: ["read"] }],
        purpose: "Test",
      });

      expect(manager.check("agent-001", "memory", "read").allowed).toBe(true);

      manager.revoke(token.id);

      expect(manager.check("agent-001", "memory", "read").allowed).toBe(false);
    });

    it("should revoke all tokens for an agent", () => {
      manager.grant({
        agentId: "agent-001",
        permissions: [{ category: "memory", actions: ["read"] }],
        purpose: "Token 1",
      });
      manager.grant({
        agentId: "agent-001",
        permissions: [{ category: "tools", actions: ["execute"] }],
        purpose: "Token 2",
      });

      const revoked = manager.revokeAll("agent-001");

      expect(revoked).toBe(2);
      expect(manager.listTokens("agent-001").length).toBe(0);
    });
  });

  describe("Audit Log", () => {
    it("should log capability grants", () => {
      manager.grant({
        agentId: "agent-001",
        permissions: [{ category: "memory", actions: ["read"] }],
        purpose: "Test",
      });

      const log = manager.getAuditLog({ action: "grant" });
      expect(log.length).toBe(1);
      expect(log[0].agentId).toBe("agent-001");
    });

    it("should log permission checks", () => {
      manager.grant({
        agentId: "agent-001",
        permissions: [{ category: "memory", actions: ["read"] }],
        purpose: "Test",
      });

      manager.check("agent-001", "memory", "read");
      manager.check("agent-001", "memory", "write");

      const allowed = manager.getAuditLog({ action: "check_allowed" });
      const denied = manager.getAuditLog({ action: "check_denied" });

      expect(allowed.length).toBe(1);
      expect(denied.length).toBe(1);
    });

    it("should filter audit log by agent", () => {
      manager.grant({ agentId: "agent-001", permissions: [], purpose: "A" });
      manager.grant({ agentId: "agent-002", permissions: [], purpose: "B" });

      const log = manager.getAuditLog({ agentId: "agent-001" });
      expect(log.every((e) => e.agentId === "agent-001")).toBe(true);
    });
  });
});

// Permissions System tests
import { beforeEach, describe, expect, it } from "vitest";
import { CapabilityManager, PermissionError } from "./capabilities.js";

describe("CapabilityManager", () => {
  let manager: CapabilityManager;

  beforeEach(() => {
    manager = new CapabilityManager({ secret: "test-secret-key-1234-must-be-at-least-32-chars" });
  });

  describe("Grant", () => {
    it("should grant capabilities to agents", () => {
      const result = manager.grant({
        agentId: "agent-001",
        permissions: [{ category: "memory", actions: ["read", "write"] }],
        purpose: "Memory access for task",
        durationMs: 60000,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.id).toMatch(/^cap-/);
      expect(result.value.agentId).toBe("agent-001");
      expect(result.value.permissions.length).toBe(1);
      expect(result.value.signature).toBeDefined();
    });

    it("should set expiration time", () => {
      const result = manager.grant({
        agentId: "agent-001",
        permissions: [{ category: "tools", actions: ["execute"] }],
        purpose: "Tool use",
        durationMs: 5000,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const token = result.value;
      const expectedExpiry = token.issuedAt.getTime() + 5000;
      expect(token.expiresAt.getTime()).toBe(expectedExpiry);
    });

    it("should reject invalid request", () => {
      const result = manager.grant({
        agentId: "", // Invalid: empty
        permissions: [{ category: "memory", actions: ["read"] }],
        purpose: "Test",
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(PermissionError);
      expect(result.error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("Check", () => {
    it("should allow permitted actions", () => {
      const grantResult = manager.grant({
        agentId: "agent-001",
        permissions: [{ category: "memory", actions: ["read", "write"] }],
        purpose: "Test",
      });
      expect(grantResult.ok).toBe(true);

      const result = manager.check("agent-001", "memory", "read");
      expect(result.allowed).toBe(true);
      expect(result.matchedToken).toBeDefined();
    });

    it("should deny unpermitted actions", () => {
      const grantResult = manager.grant({
        agentId: "agent-001",
        permissions: [{ category: "memory", actions: ["read"] }],
        purpose: "Read only",
      });
      expect(grantResult.ok).toBe(true);

      const result = manager.check("agent-001", "memory", "write");
      expect(result.allowed).toBe(false);
    });

    it("should deny actions for different categories", () => {
      const grantResult = manager.grant({
        agentId: "agent-001",
        permissions: [{ category: "memory", actions: ["read", "write"] }],
        purpose: "Memory only",
      });
      expect(grantResult.ok).toBe(true);

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
      const grantResult = manager.grant({
        agentId: "agent-001",
        permissions: [{ category: "filesystem", actions: ["read"], resource: "/data/file.txt" }],
        purpose: "Specific file access",
      });
      expect(grantResult.ok).toBe(true);

      expect(manager.check("agent-001", "filesystem", "read", "/data/file.txt").allowed).toBe(true);
      expect(manager.check("agent-001", "filesystem", "read", "/other/file.txt").allowed).toBe(
        false,
      );
    });

    it("should match glob patterns", () => {
      const grantResult = manager.grant({
        agentId: "agent-001",
        permissions: [{ category: "filesystem", actions: ["read"], resource: "/data/*" }],
        purpose: "Data folder access",
      });
      expect(grantResult.ok).toBe(true);

      expect(manager.check("agent-001", "filesystem", "read", "/data/file.txt").allowed).toBe(true);
      expect(
        manager.check("agent-001", "filesystem", "read", "/data/nested/file.txt").allowed,
      ).toBe(false);
    });

    it("should allow without resource constraint when pattern not specified", () => {
      const grantResult = manager.grant({
        agentId: "agent-001",
        permissions: [{ category: "filesystem", actions: ["read"] }],
        purpose: "Full filesystem read access",
      });
      expect(grantResult.ok).toBe(true);

      expect(manager.check("agent-001", "filesystem", "read", "/any/path/file.txt").allowed).toBe(
        true,
      );
      expect(
        manager.check("agent-001", "filesystem", "read", "/data/nested/deep/file.txt").allowed,
      ).toBe(true);
    });
  });

  describe("Delegation", () => {
    it("should allow delegation of delegatable tokens", () => {
      const grantResult = manager.grant({
        agentId: "agent-001",
        permissions: [{ category: "memory", actions: ["read", "write"] }],
        purpose: "Parent capability",
        delegatable: true,
      });
      expect(grantResult.ok).toBe(true);
      if (!grantResult.ok) return;

      const childResult = manager.delegate(grantResult.value.id, "agent-002");

      expect(childResult.ok).toBe(true);
      if (!childResult.ok) return;
      expect(childResult.value.agentId).toBe("agent-002");
      expect(childResult.value.parentTokenId).toBe(grantResult.value.id);
      expect(childResult.value.delegatable).toBe(false);
    });

    it("should reject delegation of non-delegatable tokens", () => {
      const grantResult = manager.grant({
        agentId: "agent-001",
        permissions: [{ category: "memory", actions: ["read"] }],
        purpose: "Non-delegatable",
        delegatable: false,
      });
      expect(grantResult.ok).toBe(true);
      if (!grantResult.ok) return;

      const childResult = manager.delegate(grantResult.value.id, "agent-002");
      expect(childResult.ok).toBe(false);
      if (childResult.ok) return;
      expect(childResult.error.code).toBe("NOT_DELEGATABLE");
    });

    it("should limit delegated permissions to parent scope", () => {
      const grantResult = manager.grant({
        agentId: "agent-001",
        permissions: [{ category: "memory", actions: ["read"] }],
        purpose: "Read only",
        delegatable: true,
      });
      expect(grantResult.ok).toBe(true);
      if (!grantResult.ok) return;

      // Try to delegate with more permissions
      const childResult = manager.delegate(grantResult.value.id, "agent-002", [
        { category: "memory", actions: ["read", "write"] },
      ]);

      expect(childResult.ok).toBe(false);
      if (childResult.ok) return;
      expect(childResult.error.code).toBe("INSUFFICIENT_PERMISSIONS");
    });
  });

  describe("Revocation", () => {
    it("should revoke tokens", () => {
      const grantResult = manager.grant({
        agentId: "agent-001",
        permissions: [{ category: "memory", actions: ["read"] }],
        purpose: "Test",
      });
      expect(grantResult.ok).toBe(true);
      if (!grantResult.ok) return;

      expect(manager.check("agent-001", "memory", "read").allowed).toBe(true);

      const revokeResult = manager.revoke(grantResult.value.id);
      expect(revokeResult.ok).toBe(true);

      expect(manager.check("agent-001", "memory", "read").allowed).toBe(false);
    });

    it("should revoke all tokens for an agent", () => {
      const g1 = manager.grant({
        agentId: "agent-001",
        permissions: [{ category: "memory", actions: ["read"] }],
        purpose: "Token 1",
      });
      const g2 = manager.grant({
        agentId: "agent-001",
        permissions: [{ category: "tools", actions: ["execute"] }],
        purpose: "Token 2",
      });

      expect(g1.ok).toBe(true);
      expect(g2.ok).toBe(true);

      const revoked = manager.revokeAll("agent-001");

      expect(revoked).toBe(2);
      expect(manager.listTokens("agent-001").length).toBe(0);
    });

    it("should return error when revoking non-existent token", () => {
      const result = manager.revoke("non-existent-token");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("NOT_FOUND");
    });
  });

  describe("Audit Log", () => {
    it("should log capability grants", () => {
      const grantResult = manager.grant({
        agentId: "agent-001",
        permissions: [{ category: "memory", actions: ["read"] }],
        purpose: "Test",
      });
      expect(grantResult.ok).toBe(true);

      const log = manager.getAuditLog({ action: "grant" });
      expect(log.length).toBe(1);
      expect(log[0]?.agentId).toBe("agent-001");
    });

    it("should log permission checks", () => {
      const grantResult = manager.grant({
        agentId: "agent-001",
        permissions: [{ category: "memory", actions: ["read"] }],
        purpose: "Test",
      });
      expect(grantResult.ok).toBe(true);

      manager.check("agent-001", "memory", "read");
      manager.check("agent-001", "memory", "write");

      const allowed = manager.getAuditLog({ action: "check_allowed" });
      const denied = manager.getAuditLog({ action: "check_denied" });

      expect(allowed.length).toBe(1);
      expect(denied.length).toBe(1);
    });

    it("should filter audit log by agent", () => {
      const g1 = manager.grant({
        agentId: "agent-001",
        permissions: [{ category: "memory", actions: ["read"] }],
        purpose: "A",
      });
      const g2 = manager.grant({
        agentId: "agent-002",
        permissions: [{ category: "memory", actions: ["read"] }],
        purpose: "B",
      });

      expect(g1.ok).toBe(true);
      expect(g2.ok).toBe(true);

      const log = manager.getAuditLog({ agentId: "agent-001" });
      expect(log.every((e) => e.agentId === "agent-001")).toBe(true);
    });
  });

  describe("Token Operations", () => {
    it("should get token by ID", () => {
      const grantResult = manager.grant({
        agentId: "agent-001",
        permissions: [{ category: "memory", actions: ["read"] }],
        purpose: "Test",
      });
      expect(grantResult.ok).toBe(true);
      if (!grantResult.ok) return;

      const getResult = manager.getToken(grantResult.value.id);
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;
      expect(getResult.value.agentId).toBe("agent-001");
    });

    it("should return error for non-existent token", () => {
      const result = manager.getToken("non-existent");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("NOT_FOUND");
    });
  });
});

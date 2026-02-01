// Identity System tests
import { describe, it, expect, beforeEach } from "vitest";
import { IdentityManager } from "./identity-manager.js";
import { validateAgentCard, A2A_PROTOCOL_VERSION } from "./agent-card.js";

describe("IdentityManager", () => {
  let manager: IdentityManager;

  beforeEach(() => {
    manager = new IdentityManager({ baseUrl: "https://example.com" });
  });

  describe("Registration", () => {
    it("should register a new agent identity", () => {
      const result = manager.register({
        name: "Test Agent",
        description: "A test agent for unit testing",
      });

      expect(result.identity).toBeDefined();
      expect(result.identity.did).toMatch(/^did:agentos:/);
      expect(result.identity.shortId).toMatch(/^agent-/);
      expect(result.identity.active).toBe(true);
      expect(result.secretKey).toMatch(/^sk-/);
    });

    it("should create a valid Agent Card", () => {
      const result = manager.register({
        name: "My Agent",
        description: "Helpful assistant",
        skills: [
          {
            id: "chat",
            name: "Chat",
            description: "Have conversations",
          },
        ],
        tags: ["assistant", "chat"],
      });

      const card = result.identity.card;
      expect(validateAgentCard(card)).toBe(true);
      expect(card.protocolVersion).toBe(A2A_PROTOCOL_VERSION);
      expect(card.name).toBe("My Agent");
      expect(card.skills.length).toBe(1);
      expect(card.tags).toContain("assistant");
    });
  });

  describe("Retrieval", () => {
    it("should get identity by short ID", () => {
      const result = manager.register({ name: "Test", description: "Test" });

      const identity = manager.getById(result.identity.shortId);
      expect(identity).not.toBeNull();
      expect(identity!.did).toBe(result.identity.did);
    });

    it("should get identity by DID", () => {
      const result = manager.register({ name: "Test", description: "Test" });

      const identity = manager.getByDID(result.identity.did);
      expect(identity).not.toBeNull();
      expect(identity!.shortId).toBe(result.identity.shortId);
    });

    it("should return null for non-existent ID", () => {
      expect(manager.getById("non-existent")).toBeNull();
      expect(manager.getByDID("did:agentos:fake")).toBeNull();
    });
  });

  describe("Updates", () => {
    it("should update card with valid secret key", () => {
      const result = manager.register({ name: "Original", description: "Test" });

      const updated = manager.updateCard(result.identity.shortId, result.secretKey, {
        name: "Updated Name",
        description: "Updated description",
      });

      expect(updated).toBe(true);
      const card = manager.getAgentCard(result.identity.shortId);
      expect(card!.name).toBe("Updated Name");
    });

    it("should reject update with invalid secret key", () => {
      const result = manager.register({ name: "Test", description: "Test" });

      const updated = manager.updateCard(result.identity.shortId, "wrong-key", {
        name: "Hacked",
      });

      expect(updated).toBe(false);
      const card = manager.getAgentCard(result.identity.shortId);
      expect(card!.name).toBe("Test");
    });
  });

  describe("Skills", () => {
    it("should add skills to agent", () => {
      const result = manager.register({ name: "Test", description: "Test" });

      const added = manager.addSkill(result.identity.shortId, result.secretKey, {
        id: "code",
        name: "Code Generation",
        description: "Generate code",
      });

      expect(added).toBe(true);
      const card = manager.getAgentCard(result.identity.shortId);
      expect(card!.skills.length).toBe(1);
      expect(card!.skills[0].id).toBe("code");
    });

    it("should remove skills from agent", () => {
      const result = manager.register({
        name: "Test",
        description: "Test",
        skills: [{ id: "skill1", name: "Skill 1", description: "First skill" }],
      });

      const removed = manager.removeSkill(result.identity.shortId, result.secretKey, "skill1");

      expect(removed).toBe(true);
      const card = manager.getAgentCard(result.identity.shortId);
      expect(card!.skills.length).toBe(0);
    });
  });

  describe("Lifecycle", () => {
    it("should deactivate and reactivate agent", () => {
      const result = manager.register({ name: "Test", description: "Test" });

      // Deactivate
      manager.deactivate(result.identity.shortId, result.secretKey);
      expect(manager.getAgentCard(result.identity.shortId)).toBeNull();

      // Reactivate
      manager.reactivate(result.identity.shortId, result.secretKey);
      expect(manager.getAgentCard(result.identity.shortId)).not.toBeNull();
    });

    it("should delete agent permanently", () => {
      const result = manager.register({ name: "Test", description: "Test" });

      manager.delete(result.identity.shortId, result.secretKey);

      expect(manager.getById(result.identity.shortId)).toBeNull();
      expect(manager.getByDID(result.identity.did)).toBeNull();
    });
  });

  describe("Discovery", () => {
    it("should find agents by skill", () => {
      manager.register({
        name: "Coder",
        description: "Codes",
        skills: [{ id: "code", name: "Code", description: "Write code" }],
      });
      manager.register({
        name: "Writer",
        description: "Writes",
        skills: [{ id: "write", name: "Write", description: "Write text" }],
      });

      const coders = manager.findBySkill("code");
      expect(coders.length).toBe(1);
      expect(coders[0].card.name).toBe("Coder");
    });

    it("should find agents by tag", () => {
      manager.register({ name: "Agent 1", description: "Test", tags: ["helper", "chat"] });
      manager.register({ name: "Agent 2", description: "Test", tags: ["coder"] });

      const helpers = manager.findByTag("helper");
      expect(helpers.length).toBe(1);
      expect(helpers[0].card.name).toBe("Agent 1");
    });

    it("should list all active agents", () => {
      const r1 = manager.register({ name: "Active", description: "Test" });
      const r2 = manager.register({ name: "Inactive", description: "Test" });

      manager.deactivate(r2.identity.shortId, r2.secretKey);

      const active = manager.listActive();
      expect(active.length).toBe(1);
      expect(active[0].card.name).toBe("Active");
    });
  });
});

// Identity System tests
import { describe, it, expect, beforeEach } from "vitest";
import { IdentityManager, InMemoryIdentityStorage, IdentityError } from "./identity-manager.js";
import {
  validateAgentCard,
  A2A_PROTOCOL_VERSION,
  createAgentCard,
  parseAgentCard,
  serializeAgentCard,
  AgentCardError,
} from "./agent-card.js";

function getFirst<T>(items: T[]): T {
  const first = items[0];
  if (!first) {
    throw new Error("Expected at least one item");
  }
  return first;
}

describe("AgentCard", () => {
  describe("createAgentCard", () => {
    it("should create a valid agent card", () => {
      const result = createAgentCard("did:agentos:test-1", {
        name: "Test Agent",
        description: "A test agent",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe("did:agentos:test-1");
        expect(result.value.name).toBe("Test Agent");
        expect(result.value.protocolVersion).toBe(A2A_PROTOCOL_VERSION);
      }
    });

    it("should fail with invalid input", () => {
      const result = createAgentCard("did:agentos:test-1", {
        name: "", // Empty name is invalid
        description: "Test",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(AgentCardError);
        expect(result.error.code).toBe("VALIDATION_ERROR");
      }
    });
  });

  describe("validateAgentCard", () => {
    it("should validate a correct card", () => {
      const result = createAgentCard("did:agentos:test-1", {
        name: "Test",
        description: "Test",
      });

      if (result.ok) {
        const validationResult = validateAgentCard(result.value);
        expect(validationResult.ok).toBe(true);
      }
    });

    it("should reject invalid card", () => {
      const result = validateAgentCard({ invalid: "data" });
      expect(result.ok).toBe(false);
    });
  });

  describe("parseAgentCard", () => {
    it("should parse valid JSON", () => {
      const createResult = createAgentCard("did:agentos:test-1", {
        name: "Test",
        description: "Test",
      });

      if (createResult.ok) {
        const json = serializeAgentCard(createResult.value);
        const parseResult = parseAgentCard(json);

        expect(parseResult.ok).toBe(true);
        if (parseResult.ok) {
          expect(parseResult.value.id).toBe("did:agentos:test-1");
        }
      }
    });

    it("should fail on invalid JSON", () => {
      const result = parseAgentCard("not json");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("PARSE_ERROR");
      }
    });
  });
});

describe("IdentityManager", () => {
  let manager: IdentityManager;
  let storage: InMemoryIdentityStorage;

  beforeEach(() => {
    storage = new InMemoryIdentityStorage();
    manager = new IdentityManager({ baseUrl: "https://example.com" }, storage);
  });

  describe("Registration", () => {
    it("should register a new agent identity", async () => {
      const result = await manager.register({
        name: "Test Agent",
        description: "A test agent for unit testing",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.identity).toBeDefined();
        expect(result.value.identity.did).toMatch(/^did:agentos:/);
        expect(result.value.identity.shortId).toMatch(/^agent-/);
        expect(result.value.identity.active).toBe(true);
        expect(result.value.secretKey).toMatch(/^sk-/);
      }
    });

    it("should create a valid Agent Card", async () => {
      const result = await manager.register({
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

      expect(result.ok).toBe(true);
      if (result.ok) {
        const card = result.value.identity.card;
        const validationResult = validateAgentCard(card);
        expect(validationResult.ok).toBe(true);
        expect(card.protocolVersion).toBe(A2A_PROTOCOL_VERSION);
        expect(card.name).toBe("My Agent");
        expect(card.skills.length).toBe(1);
        expect(card.tags).toContain("assistant");
      }
    });

    it("should reject invalid registration input", async () => {
      const result = await manager.register({
        name: "", // Empty name is invalid
        description: "Test",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(IdentityError);
        expect(result.error.code).toBe("VALIDATION_ERROR");
      }
    });
  });

  describe("Retrieval", () => {
    it("should get identity by short ID", async () => {
      const regResult = await manager.register({ name: "Test", description: "Test" });
      expect(regResult.ok).toBe(true);
      if (!regResult.ok) return;

      const result = await manager.getById(regResult.value.identity.shortId);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.did).toBe(regResult.value.identity.did);
      }
    });

    it("should get identity by DID", async () => {
      const regResult = await manager.register({ name: "Test", description: "Test" });
      expect(regResult.ok).toBe(true);
      if (!regResult.ok) return;

      const result = await manager.getByDID(regResult.value.identity.did);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.shortId).toBe(regResult.value.identity.shortId);
      }
    });

    it("should return error for non-existent ID", async () => {
      const byIdResult = await manager.getById("non-existent");
      expect(byIdResult.ok).toBe(false);
      if (!byIdResult.ok) {
        expect(byIdResult.error.code).toBe("NOT_FOUND");
      }

      const byDIDResult = await manager.getByDID("did:agentos:fake");
      expect(byDIDResult.ok).toBe(false);
      if (!byDIDResult.ok) {
        expect(byDIDResult.error.code).toBe("NOT_FOUND");
      }
    });
  });

  describe("Updates", () => {
    it("should update card with valid secret key", async () => {
      const regResult = await manager.register({ name: "Original", description: "Test" });
      expect(regResult.ok).toBe(true);
      if (!regResult.ok) return;

      const updateResult = await manager.updateCard(
        regResult.value.identity.shortId,
        regResult.value.secretKey,
        {
          name: "Updated Name",
          description: "Updated description",
        }
      );

      expect(updateResult.ok).toBe(true);

      const cardResult = await manager.getAgentCard(regResult.value.identity.shortId);
      expect(cardResult.ok).toBe(true);
      if (cardResult.ok) {
        expect(cardResult.value.name).toBe("Updated Name");
      }
    });

    it("should reject update with invalid secret key", async () => {
      const regResult = await manager.register({ name: "Test", description: "Test" });
      expect(regResult.ok).toBe(true);
      if (!regResult.ok) return;

      const updateResult = await manager.updateCard(
        regResult.value.identity.shortId,
        "wrong-key",
        { name: "Hacked" }
      );

      expect(updateResult.ok).toBe(false);
      if (!updateResult.ok) {
        expect(updateResult.error.code).toBe("UNAUTHORIZED");
      }

      // Verify name wasn't changed
      const cardResult = await manager.getAgentCard(regResult.value.identity.shortId);
      expect(cardResult.ok).toBe(true);
      if (cardResult.ok) {
        expect(cardResult.value.name).toBe("Test");
      }
    });
  });

  describe("Skills", () => {
    it("should add skills to agent", async () => {
      const regResult = await manager.register({ name: "Test", description: "Test" });
      expect(regResult.ok).toBe(true);
      if (!regResult.ok) return;

      const addResult = await manager.addSkill(
        regResult.value.identity.shortId,
        regResult.value.secretKey,
        {
          id: "code",
          name: "Code Generation",
          description: "Generate code",
        }
      );

      expect(addResult.ok).toBe(true);

      const cardResult = await manager.getAgentCard(regResult.value.identity.shortId);
      expect(cardResult.ok).toBe(true);
      if (cardResult.ok) {
        expect(cardResult.value.skills.length).toBe(1);
        expect(getFirst(cardResult.value.skills).id).toBe("code");
      }
    });

    it("should remove skills from agent", async () => {
      const regResult = await manager.register({
        name: "Test",
        description: "Test",
        skills: [{ id: "skill1", name: "Skill 1", description: "First skill" }],
      });
      expect(regResult.ok).toBe(true);
      if (!regResult.ok) return;

      const removeResult = await manager.removeSkill(
        regResult.value.identity.shortId,
        regResult.value.secretKey,
        "skill1"
      );

      expect(removeResult.ok).toBe(true);

      const cardResult = await manager.getAgentCard(regResult.value.identity.shortId);
      expect(cardResult.ok).toBe(true);
      if (cardResult.ok) {
        expect(cardResult.value.skills.length).toBe(0);
      }
    });
  });

  describe("Lifecycle", () => {
    it("should deactivate and reactivate agent", async () => {
      const regResult = await manager.register({ name: "Test", description: "Test" });
      expect(regResult.ok).toBe(true);
      if (!regResult.ok) return;

      // Deactivate
      const deactivateResult = await manager.deactivate(
        regResult.value.identity.shortId,
        regResult.value.secretKey
      );
      expect(deactivateResult.ok).toBe(true);

      // Should not be able to get card for inactive agent
      const cardResult1 = await manager.getAgentCard(regResult.value.identity.shortId);
      expect(cardResult1.ok).toBe(false);

      // Reactivate
      const reactivateResult = await manager.reactivate(
        regResult.value.identity.shortId,
        regResult.value.secretKey
      );
      expect(reactivateResult.ok).toBe(true);

      // Should be able to get card again
      const cardResult2 = await manager.getAgentCard(regResult.value.identity.shortId);
      expect(cardResult2.ok).toBe(true);
    });

    it("should delete agent permanently", async () => {
      const regResult = await manager.register({ name: "Test", description: "Test" });
      expect(regResult.ok).toBe(true);
      if (!regResult.ok) return;

      const deleteResult = await manager.delete(
        regResult.value.identity.shortId,
        regResult.value.secretKey
      );
      expect(deleteResult.ok).toBe(true);

      const byIdResult = await manager.getById(regResult.value.identity.shortId);
      expect(byIdResult.ok).toBe(false);

      const byDIDResult = await manager.getByDID(regResult.value.identity.did);
      expect(byDIDResult.ok).toBe(false);
    });
  });

  describe("Discovery", () => {
    it("should find agents by skill", async () => {
      await manager.register({
        name: "Coder",
        description: "Codes",
        skills: [{ id: "code", name: "Code", description: "Write code" }],
      });
      await manager.register({
        name: "Writer",
        description: "Writes",
        skills: [{ id: "write", name: "Write", description: "Write text" }],
      });

      const coders = await manager.findBySkill("code");
      expect(coders.length).toBe(1);
      expect(getFirst(coders).card.name).toBe("Coder");
    });

    it("should find agents by tag", async () => {
      await manager.register({ name: "Agent 1", description: "Test", tags: ["helper", "chat"] });
      await manager.register({ name: "Agent 2", description: "Test", tags: ["coder"] });

      const helpers = await manager.findByTag("helper");
      expect(helpers.length).toBe(1);
      expect(getFirst(helpers).card.name).toBe("Agent 1");
    });

    it("should list all active agents", async () => {
      const r1 = await manager.register({ name: "Active", description: "Test" });
      const r2 = await manager.register({ name: "Inactive", description: "Test" });

      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      if (!r1.ok || !r2.ok) return;

      await manager.deactivate(r2.value.identity.shortId, r2.value.secretKey);

      const active = await manager.listActive();
      expect(active.length).toBe(1);
      expect(getFirst(active).card.name).toBe("Active");
    });
  });

  describe("Ownership Verification", () => {
    it("should verify ownership with correct key", async () => {
      const regResult = await manager.register({ name: "Test", description: "Test" });
      expect(regResult.ok).toBe(true);
      if (!regResult.ok) return;

      const isOwner = await manager.verifyOwnership(
        regResult.value.identity.shortId,
        regResult.value.secretKey
      );
      expect(isOwner).toBe(true);
    });

    it("should reject verification with wrong key", async () => {
      const regResult = await manager.register({ name: "Test", description: "Test" });
      expect(regResult.ok).toBe(true);
      if (!regResult.ok) return;

      const isOwner = await manager.verifyOwnership(
        regResult.value.identity.shortId,
        "wrong-key"
      );
      expect(isOwner).toBe(false);
    });
  });

  describe("DID Methods", () => {
    it("should generate did:agentos by default", async () => {
      const manager = new IdentityManager();
      const result = await manager.register({ name: "Test", description: "Test" });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.identity.did).toMatch(/^did:agentos:/);
      }
    });

    it("should generate did:key when configured", async () => {
      const manager = new IdentityManager({ didMethod: "key" });
      const result = await manager.register({ name: "Test", description: "Test" });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.identity.did).toMatch(/^did:key:z/);
      }
    });

    it("should generate did:web when configured", async () => {
      const manager = new IdentityManager({ didMethod: "web", domain: "example.com" });
      const result = await manager.register({ name: "Test", description: "Test" });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.identity.did).toMatch(/^did:web:example\.com:agents:/);
      }
    });
  });
});

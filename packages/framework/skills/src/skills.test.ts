// Skills System tests
import { describe, it, expect, beforeEach, vi } from "vitest";
import { SkillManager, createSkillManager } from "./manager.js";
import { SkillRegistry, createSkillRegistry } from "./registry.js";
import { SkillError } from "./types.js";
import { createToolRegistry } from "@agent-os/tools";
import type {
  SkillManifest,
  SkillModule,
  SkillEvent,
  SkillActivationContext,
} from "./types.js";
import { z } from "zod";

function getFirst<T>(items: T[]): T {
  const first = items[0];
  if (!first) {
    throw new Error("Expected at least one item");
  }
  return first;
}

describe("SkillManager", () => {
  let manager: SkillManager;

  beforeEach(() => {
    manager = createSkillManager({
      agentId: "test-agent",
      toolRegistry: createToolRegistry(),
    });
  });

  describe("Installation", () => {
    it("should install a skill", () => {
      const module: SkillModule = {
        manifest: {
          id: "test-skill",
          name: "Test Skill",
          description: "A test skill",
          version: "1.0.0",
        },
      };

      const result = manager.install(module);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("test-skill");
      }
      expect(manager.has("test-skill")).toBe(true);
    });

    it("should not install duplicate skills", () => {
      const module: SkillModule = {
        manifest: {
          id: "test-skill",
          name: "Test Skill",
          description: "A test skill",
          version: "1.0.0",
        },
      };

      manager.install(module);
      const result = manager.install(module);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(SkillError);
        expect(result.error.code).toBe("ALREADY_EXISTS");
      }
    });

    it("should reject invalid manifests", () => {
      const module: SkillModule = {
        manifest: {
          id: "",
          name: "",
          description: "",
          version: "",
        },
      };

      const result = manager.install(module);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(SkillError);
        expect(result.error.code).toBe("VALIDATION_ERROR");
      }
    });

    it("should emit event on installation", () => {
      const events: SkillEvent[] = [];
      manager.onEvent((e) => events.push(e));

      const result = manager.install({
        manifest: {
          id: "test-skill",
          name: "Test",
          description: "Test",
          version: "1.0.0",
        },
      });

      expect(result.ok).toBe(true);
      expect(events.length).toBe(1);
      expect(getFirst(events).type).toBe("skill_installed");
    });

    it("should activate immediately if requested", async () => {
      const module: SkillModule = {
        manifest: {
          id: "test-skill",
          name: "Test Skill",
          description: "A test skill",
          version: "1.0.0",
        },
      };

      manager.install(module, { activate: true });

      // Allow activation to complete
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(manager.isActive("test-skill")).toBe(true);
    });
  });

  describe("Uninstallation", () => {
    beforeEach(() => {
      manager.install({
        manifest: {
          id: "test-skill",
          name: "Test Skill",
          description: "A test skill",
          version: "1.0.0",
        },
      });
    });

    it("should uninstall a skill", async () => {
      const result = await manager.uninstall("test-skill");

      expect(result.ok).toBe(true);
      expect(manager.has("test-skill")).toBe(false);
    });

    it("should return error for non-existent skill", async () => {
      const result = await manager.uninstall("nonexistent");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(SkillError);
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });

    it("should emit event on uninstallation", async () => {
      const events: SkillEvent[] = [];
      manager.onEvent((e) => events.push(e));

      await manager.uninstall("test-skill");

      const uninstallEvent = events.find((e) => e.type === "skill_uninstalled");
      expect(uninstallEvent).toBeDefined();
    });
  });

  describe("Activation", () => {
    it("should activate a skill", async () => {
      manager.install({
        manifest: {
          id: "test-skill",
          name: "Test Skill",
          description: "A test skill",
          version: "1.0.0",
        },
      });

      const result = await manager.activate("test-skill");

      expect(result.ok).toBe(true);
      expect(manager.isActive("test-skill")).toBe(true);
    });

    it("should call activate handler", async () => {
      const activateFn = vi.fn();

      manager.install({
        manifest: {
          id: "test-skill",
          name: "Test Skill",
          description: "A test skill",
          version: "1.0.0",
        },
        activate: activateFn,
      });

      await manager.activate("test-skill");

      expect(activateFn).toHaveBeenCalled();
    });

    it("should provide activation context", async () => {
      let receivedContext: SkillActivationContext | null = null;

      manager.install({
        manifest: {
          id: "test-skill",
          name: "Test Skill",
          description: "A test skill",
          version: "1.0.0",
        },
        activate: (ctx) => {
          receivedContext = ctx;
        },
      });

      await manager.activate("test-skill");

      expect(receivedContext).not.toBeNull();
      expect(receivedContext!.agentId).toBe("test-agent");
      expect(typeof receivedContext!.registerTool).toBe("function");
      expect(typeof receivedContext!.log.info).toBe("function");
    });

    it("should return error for non-existent skill", async () => {
      const result = await manager.activate("nonexistent");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(SkillError);
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });

    it("should handle activation errors", async () => {
      manager.install({
        manifest: {
          id: "test-skill",
          name: "Test Skill",
          description: "A test skill",
          version: "1.0.0",
        },
        activate: () => {
          throw new Error("Activation failed");
        },
      });

      const result = await manager.activate("test-skill");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(SkillError);
        expect(result.error.code).toBe("ACTIVATION_ERROR");
      }

      const getResult = manager.get("test-skill");
      expect(getResult.ok).toBe(true);
      if (getResult.ok) {
        expect(getResult.value.state).toBe("error");
      }
    });
  });

  describe("Deactivation", () => {
    beforeEach(async () => {
      manager.install({
        manifest: {
          id: "test-skill",
          name: "Test Skill",
          description: "A test skill",
          version: "1.0.0",
        },
      });
      await manager.activate("test-skill");
    });

    it("should deactivate a skill", async () => {
      const result = await manager.deactivate("test-skill");

      expect(result.ok).toBe(true);
      expect(manager.isActive("test-skill")).toBe(false);
    });

    it("should call deactivate handler", async () => {
      const deactivateFn = vi.fn();

      await manager.uninstall("test-skill");
      manager.install({
        manifest: {
          id: "test-skill",
          name: "Test Skill",
          description: "A test skill",
          version: "1.0.0",
        },
        deactivate: deactivateFn,
      });
      await manager.activate("test-skill");

      await manager.deactivate("test-skill");

      expect(deactivateFn).toHaveBeenCalled();
    });
  });

  describe("Get Skill", () => {
    it("should get a skill instance", () => {
      manager.install({
        manifest: {
          id: "test-skill",
          name: "Test Skill",
          description: "A test skill",
          version: "1.0.0",
        },
      });

      const result = manager.get("test-skill");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.manifest.id).toBe("test-skill");
        expect(result.value.state).toBe("installed");
      }
    });

    it("should return error for non-existent skill", () => {
      const result = manager.get("nonexistent");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(SkillError);
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });
  });

  describe("Tool Registration", () => {
    it("should register tools via activation context", async () => {
      const toolRegistry = createToolRegistry();
      const mgr = createSkillManager({
        agentId: "test-agent",
        toolRegistry,
      });

      mgr.install({
        manifest: {
          id: "test-skill",
          name: "Test Skill",
          description: "A test skill",
          version: "1.0.0",
        },
        activate: (ctx) => {
          ctx.registerTool(
            {
              id: "my-tool",
              name: "My Tool",
              description: "A tool",
              inputSchema: z.object({ x: z.number() }),
            },
            async () => ({ success: true })
          );
        },
      });

      await mgr.activate("test-skill");

      // Tool should be namespaced
      expect(toolRegistry.has("test-skill:my-tool")).toBe(true);
    });

    it("should unregister tools on deactivation", async () => {
      const toolRegistry = createToolRegistry();
      const mgr = createSkillManager({
        agentId: "test-agent",
        toolRegistry,
      });

      mgr.install({
        manifest: {
          id: "test-skill",
          name: "Test Skill",
          description: "A test skill",
          version: "1.0.0",
        },
        activate: (ctx) => {
          ctx.registerTool(
            {
              id: "my-tool",
              name: "My Tool",
              description: "A tool",
              inputSchema: z.object({}),
            },
            async () => ({ success: true })
          );
        },
      });

      await mgr.activate("test-skill");
      expect(toolRegistry.has("test-skill:my-tool")).toBe(true);

      await mgr.deactivate("test-skill");
      expect(toolRegistry.has("test-skill:my-tool")).toBe(false);
    });
  });

  describe("Discovery", () => {
    beforeEach(() => {
      manager.install({
        manifest: {
          id: "math-skill",
          name: "Math Skill",
          description: "Mathematical operations",
          version: "1.0.0",
          categories: ["utility", "math"],
          tags: ["calculator", "numbers"],
        },
      });
      manager.install({
        manifest: {
          id: "text-skill",
          name: "Text Skill",
          description: "Text processing",
          version: "1.0.0",
          categories: ["utility", "text"],
          tags: ["string", "processing"],
        },
      });
    });

    it("should list all skills", () => {
      expect(manager.list().length).toBe(2);
    });

    it("should find by category", () => {
      const utility = manager.findByCategory("utility");
      expect(utility.length).toBe(2);

      const math = manager.findByCategory("math");
      expect(math.length).toBe(1);
    });

    it("should find by tag", () => {
      const calc = manager.findByTag("calculator");
      expect(calc.length).toBe(1);
      expect(getFirst(calc).manifest.id).toBe("math-skill");
    });

    it("should search by name", () => {
      const results = manager.search("math");
      expect(results.length).toBe(1);
    });

    it("should search by description", () => {
      const results = manager.search("processing");
      expect(results.length).toBe(1);
      expect(getFirst(results).manifest.id).toBe("text-skill");
    });
  });

  describe("Dependencies", () => {
    it("should reject skill with missing required dependency", () => {
      const module: SkillModule = {
        manifest: {
          id: "dependent-skill",
          name: "Dependent Skill",
          description: "Depends on another",
          version: "1.0.0",
          dependencies: [{ skillId: "base-skill", required: true }],
        },
      };

      const result = manager.install(module);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(SkillError);
        expect(result.error.code).toBe("DEPENDENCY_ERROR");
      }
    });

    it("should install skill when dependency is met", () => {
      // Install base skill first
      manager.install({
        manifest: {
          id: "base-skill",
          name: "Base Skill",
          description: "Base",
          version: "1.0.0",
        },
      });

      // Install dependent skill
      const module: SkillModule = {
        manifest: {
          id: "dependent-skill",
          name: "Dependent Skill",
          description: "Depends on base",
          version: "1.0.0",
          dependencies: [{ skillId: "base-skill", required: true }],
        },
      };

      const result = manager.install(module);

      expect(result.ok).toBe(true);
    });

    it("should reject skill with incompatible dependency version", () => {
      manager.install({
        manifest: {
          id: "base-skill",
          name: "Base Skill",
          description: "Base",
          version: "1.0.0",
        },
      });

      const module: SkillModule = {
        manifest: {
          id: "dependent-skill",
          name: "Dependent Skill",
          description: "Requires newer base",
          version: "1.0.0",
          dependencies: [{ skillId: "base-skill", required: true, versionRange: ">=2.0.0" }],
        },
      };

      const result = manager.install(module);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(SkillError);
        expect(result.error.code).toBe("DEPENDENCY_ERROR");
      }
    });
  });
});

describe("SkillRegistry", () => {
  let registry: SkillRegistry;

  beforeEach(() => {
    registry = createSkillRegistry();
  });

  describe("Registration", () => {
    it("should register a valid manifest", () => {
      const manifest: SkillManifest = {
        id: "test-skill",
        name: "Test Skill",
        description: "A test skill",
        version: "1.0.0",
      };

      const result = registry.register(manifest);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("test-skill");
      }
      expect(registry.has("test-skill")).toBe(true);
    });

    it("should reject invalid manifest", () => {
      const manifest = {
        id: "",
        name: "",
      } as SkillManifest;

      const result = registry.register(manifest);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(SkillError);
        expect(result.error.code).toBe("VALIDATION_ERROR");
      }
    });

    it("should unregister a skill", () => {
      registry.register({
        id: "test-skill",
        name: "Test",
        description: "Test",
        version: "1.0.0",
      });

      const result = registry.unregister("test-skill");

      expect(result.ok).toBe(true);
      expect(registry.has("test-skill")).toBe(false);
    });

    it("should return error for unregistering non-existent skill", () => {
      const result = registry.unregister("nonexistent");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(SkillError);
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });
  });

  describe("Get Skill", () => {
    it("should get a skill entry", () => {
      registry.register({
        id: "test-skill",
        name: "Test",
        description: "Test",
        version: "1.0.0",
      });

      const result = registry.get("test-skill");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.manifest.id).toBe("test-skill");
      }
    });

    it("should return error for non-existent skill", () => {
      const result = registry.get("nonexistent");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(SkillError);
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });
  });

  describe("Discovery", () => {
    beforeEach(() => {
      registry.register({
        id: "web-browse",
        name: "Web Browse",
        description: "Browse the web",
        version: "1.0.0",
        author: "Agent OS Team",
        categories: ["network", "utility"],
        tags: ["web", "browser", "http"],
        permissions: [{ id: "network:fetch", reason: "To fetch web pages" }],
      });
      registry.register({
        id: "file-system",
        name: "File System",
        description: "Access the file system",
        version: "1.0.0",
        author: "Agent OS Team",
        categories: ["storage", "utility"],
        tags: ["files", "disk"],
        permissions: [{ id: "file:read", reason: "To read files" }],
      });
      registry.register({
        id: "math-tools",
        name: "Math Tools",
        description: "Mathematical tools",
        version: "1.0.0",
        author: "Community",
        categories: ["utility"],
        tags: ["math", "calculator"],
      });
    });

    it("should list all entries", () => {
      expect(registry.list().length).toBe(3);
    });

    it("should find by category", () => {
      const utility = registry.findByCategory("utility");
      expect(utility.length).toBe(3);

      const network = registry.findByCategory("network");
      expect(network.length).toBe(1);
    });

    it("should find by tag", () => {
      const web = registry.findByTag("web");
      expect(web.length).toBe(1);
      expect(getFirst(web).manifest.id).toBe("web-browse");
    });

    it("should find by author", () => {
      const teamSkills = registry.findByAuthor("Agent OS Team");
      expect(teamSkills.length).toBe(2);
    });

    it("should find by permission", () => {
      const networkSkills = registry.findByPermission("network:fetch");
      expect(networkSkills.length).toBe(1);
      expect(getFirst(networkSkills).manifest.id).toBe("web-browse");
    });

    it("should search by name", () => {
      const results = registry.search("file");
      expect(results.length).toBe(1);
    });

    it("should search by tag", () => {
      const results = registry.search("calculator");
      expect(results.length).toBe(1);
      expect(getFirst(results).manifest.id).toBe("math-tools");
    });
  });

  describe("Statistics", () => {
    beforeEach(() => {
      registry.register({
        id: "skill-1",
        name: "Skill 1",
        description: "First skill",
        version: "1.0.0",
        author: "Author A",
        categories: ["cat1", "cat2"],
        tags: ["tag1", "tag2"],
      });
      registry.register({
        id: "skill-2",
        name: "Skill 2",
        description: "Second skill",
        version: "1.0.0",
        author: "Author B",
        categories: ["cat2", "cat3"],
        tags: ["tag2", "tag3"],
      });
    });

    it("should return registry stats", () => {
      const stats = registry.getStats();

      expect(stats.totalSkills).toBe(2);
      expect(stats.categories.length).toBe(3);
      expect(stats.tags.length).toBe(3);
      expect(stats.authors.length).toBe(2);
    });
  });

  describe("Import/Export", () => {
    beforeEach(() => {
      registry.register({
        id: "skill-1",
        name: "Skill 1",
        description: "First skill",
        version: "1.0.0",
      });
      registry.register({
        id: "skill-2",
        name: "Skill 2",
        description: "Second skill",
        version: "1.0.0",
      });
    });

    it("should export to JSON", () => {
      const json = registry.export();
      const data = JSON.parse(json) as Array<{ manifest: SkillManifest }>;

      expect(data.length).toBe(2);
      expect(getFirst(data).manifest.id).toBeDefined();
    });

    it("should import from JSON", () => {
      const json = registry.export();
      const newRegistry = createSkillRegistry();

      const result = newRegistry.import(json);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(2);
      }
      expect(newRegistry.list().length).toBe(2);
    });

    it("should return error for invalid JSON", () => {
      const result = registry.import("not valid json");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(SkillError);
        expect(result.error.code).toBe("PARSE_ERROR");
      }
    });
  });

  describe("Clear", () => {
    it("should clear all entries", () => {
      registry.register({
        id: "skill-1",
        name: "Skill 1",
        description: "First skill",
        version: "1.0.0",
      });

      registry.clear();

      expect(registry.list().length).toBe(0);
    });
  });
});

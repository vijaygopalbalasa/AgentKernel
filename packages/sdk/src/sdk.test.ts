// SDK tests — Agent manifest validation, signing, and definition creation

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  AgentManifestSchema,
  createAgentDefinition,
  defineAgent,
  signManifest,
  type AgentManifest,
  type AgentDefinition,
} from "./index.js";

// ─── MANIFEST VALIDATION ────────────────────────────────────

describe("AgentManifestSchema", () => {
  it("should validate a minimal manifest", () => {
    const manifest = {
      id: "test-agent",
      name: "Test Agent",
    };

    const result = AgentManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe("test-agent");
      expect(result.data.name).toBe("Test Agent");
      expect(result.data.version).toBe("0.1.0"); // default
      expect(result.data.permissions).toEqual([]); // default
      expect(result.data.requiredSkills).toEqual([]); // default
    }
  });

  it("should validate a complete manifest", () => {
    const manifest = {
      id: "complete-agent",
      name: "Complete Agent",
      version: "1.2.3",
      description: "A fully configured agent",
      author: "Test Author",
      preferredModel: "claude-3-5-sonnet-20241022",
      entryPoint: "./dist/index.js",
      requiredSkills: ["web-search", "file-system"],
      permissions: ["memory.read", "memory.write", "tools.execute"],
      permissionGrants: [
        {
          category: "filesystem",
          actions: ["read", "write"],
          resource: "/tmp/*",
          constraints: { maxSize: 1024 },
        },
      ],
      trustLevel: "semi-autonomous",
      a2aSkills: [
        {
          id: "research",
          name: "Research",
          description: "Research a topic",
          inputSchema: { type: "object", properties: { query: { type: "string" } } },
          outputSchema: { type: "object", properties: { result: { type: "string" } } },
        },
      ],
      limits: {
        maxTokensPerRequest: 4096,
        tokensPerMinute: 100000,
        requestsPerMinute: 60,
        toolCallsPerMinute: 30,
        costBudgetUSD: 10.0,
        maxMemoryMB: 512,
      },
      mcpServers: [
        {
          name: "filesystem",
          transport: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        },
      ],
      tools: [
        { id: "builtin:echo", enabled: true },
        { id: "builtin:http_fetch", enabled: false },
      ],
    };

    const result = AgentManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.version).toBe("1.2.3");
      expect(result.data.trustLevel).toBe("semi-autonomous");
      expect(result.data.limits?.maxTokensPerRequest).toBe(4096);
      expect(result.data.mcpServers?.[0]?.transport).toBe("stdio");
    }
  });

  it("should reject manifest without id", () => {
    const manifest = {
      name: "No ID Agent",
    };

    const result = AgentManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  it("should reject manifest without name", () => {
    const manifest = {
      id: "no-name",
    };

    const result = AgentManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  it("should reject empty id", () => {
    const manifest = {
      id: "",
      name: "Empty ID Agent",
    };

    const result = AgentManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  it("should reject invalid trustLevel", () => {
    const manifest = {
      id: "test",
      name: "Test",
      trustLevel: "invalid-level",
    };

    const result = AgentManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  it("should reject invalid MCP transport", () => {
    const manifest = {
      id: "test",
      name: "Test",
      mcpServers: [
        { name: "test", transport: "invalid-transport" },
      ],
    };

    const result = AgentManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  it("should accept all valid trust levels", () => {
    const levels = ["supervised", "semi-autonomous", "monitored-autonomous"] as const;

    for (const level of levels) {
      const manifest = {
        id: "test",
        name: "Test",
        trustLevel: level,
      };

      const result = AgentManifestSchema.safeParse(manifest);
      expect(result.success).toBe(true);
    }
  });

  it("should accept all valid MCP transports", () => {
    const transports = ["stdio", "sse", "streamable-http"] as const;

    for (const transport of transports) {
      const manifest = {
        id: "test",
        name: "Test",
        mcpServers: [{ name: "server", transport }],
      };

      const result = AgentManifestSchema.safeParse(manifest);
      expect(result.success).toBe(true);
    }
  });
});

// ─── AGENT DEFINITION ───────────────────────────────────────

describe("createAgentDefinition", () => {
  it("should create a valid agent definition", () => {
    const definition: AgentDefinition = {
      manifest: {
        id: "test-agent",
        name: "Test Agent",
        version: "1.0.0",
        permissions: ["memory.read"],
        requiredSkills: [],
      },
      handleTask: async (task) => {
        return { received: task };
      },
    };

    const result = createAgentDefinition(definition);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.manifest.id).toBe("test-agent");
    }
  });

  it("should fail for invalid manifest", () => {
    const definition = {
      manifest: {
        // missing id and name
        version: "1.0.0",
      },
      handleTask: async () => ({}),
    };

    const result = createAgentDefinition(definition as unknown as AgentDefinition);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Invalid agent manifest");
    }
  });

  it("should preserve initialize and terminate hooks", () => {
    const initialize = vi.fn();
    const terminate = vi.fn();

    const definition: AgentDefinition = {
      manifest: {
        id: "test",
        name: "Test",
        version: "1.0.0",
        permissions: [],
        requiredSkills: [],
      },
      initialize,
      handleTask: async () => ({}),
      terminate,
    };

    const result = createAgentDefinition(definition);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.initialize).toBe(initialize);
      expect(result.value.terminate).toBe(terminate);
    }
  });
});

describe("defineAgent", () => {
  it("should return definition for valid agent", () => {
    const definition = defineAgent({
      manifest: {
        id: "valid-agent",
        name: "Valid Agent",
        version: "1.0.0",
        permissions: [],
        requiredSkills: [],
      },
      handleTask: async (task) => ({ echo: task }),
    });

    expect(definition.manifest.id).toBe("valid-agent");
  });

  it("should throw for invalid manifest", () => {
    expect(() => {
      defineAgent({
        manifest: {
          id: "", // invalid - empty
          name: "Test",
          version: "1.0.0",
          permissions: [],
          requiredSkills: [],
        },
        handleTask: async () => ({}),
      });
    }).toThrow("Invalid agent manifest");
  });
});

// ─── MANIFEST SIGNING ───────────────────────────────────────

describe("signManifest", () => {
  const secret = "test-signing-secret-12345";

  it("should sign a manifest", () => {
    const manifest: AgentManifest = {
      id: "signed-agent",
      name: "Signed Agent",
      version: "1.0.0",
      permissions: ["memory.read"],
      requiredSkills: [],
    };

    const signed = signManifest(manifest, secret);

    expect(signed.signature).toBeDefined();
    expect(typeof signed.signature).toBe("string");
    expect(signed.signature!.length).toBe(64); // SHA-256 hex
    expect(signed.signedAt).toBeDefined();
  });

  it("should produce consistent signatures for same manifest", () => {
    const manifest: AgentManifest = {
      id: "consistent-agent",
      name: "Consistent Agent",
      version: "1.0.0",
      permissions: [],
      requiredSkills: [],
    };

    const signed1 = signManifest(manifest, secret);
    const signed2 = signManifest(manifest, secret);

    expect(signed1.signature).toBe(signed2.signature);
  });

  it("should produce different signatures for different secrets", () => {
    const manifest: AgentManifest = {
      id: "test-agent",
      name: "Test Agent",
      version: "1.0.0",
      permissions: [],
      requiredSkills: [],
    };

    const signed1 = signManifest(manifest, "secret-1");
    const signed2 = signManifest(manifest, "secret-2");

    expect(signed1.signature).not.toBe(signed2.signature);
  });

  it("should produce different signatures for different manifests", () => {
    const manifest1: AgentManifest = {
      id: "agent-1",
      name: "Agent 1",
      version: "1.0.0",
      permissions: [],
      requiredSkills: [],
    };

    const manifest2: AgentManifest = {
      id: "agent-2",
      name: "Agent 2",
      version: "1.0.0",
      permissions: [],
      requiredSkills: [],
    };

    const signed1 = signManifest(manifest1, secret);
    const signed2 = signManifest(manifest2, secret);

    expect(signed1.signature).not.toBe(signed2.signature);
  });

  it("should exclude existing signature from signing", () => {
    const manifest: AgentManifest = {
      id: "test-agent",
      name: "Test Agent",
      version: "1.0.0",
      permissions: [],
      requiredSkills: [],
      signature: "old-signature-to-be-replaced",
    };

    const signed = signManifest(manifest, secret);

    expect(signed.signature).not.toBe("old-signature-to-be-replaced");
    expect(signed.signature!.length).toBe(64);
  });

  it("should preserve signedAt if already present", () => {
    const existingTime = "2024-01-01T00:00:00.000Z";
    const manifest: AgentManifest = {
      id: "test-agent",
      name: "Test Agent",
      version: "1.0.0",
      permissions: [],
      requiredSkills: [],
      signedAt: existingTime,
    };

    const signed = signManifest(manifest, secret);

    expect(signed.signedAt).toBe(existingTime);
  });

  it("should handle complex manifest with nested objects", () => {
    const manifest: AgentManifest = {
      id: "complex-agent",
      name: "Complex Agent",
      version: "2.0.0",
      permissions: ["memory.read", "memory.write"],
      requiredSkills: ["skill-1", "skill-2"],
      permissionGrants: [
        {
          category: "filesystem",
          actions: ["read", "write"],
          resource: "/data/*",
          constraints: { maxSize: 1024, allowedExtensions: [".txt", ".json"] },
        },
      ],
      limits: {
        maxTokensPerRequest: 4096,
        tokensPerMinute: 100000,
      },
    };

    const signed = signManifest(manifest, secret);

    expect(signed.signature).toBeDefined();
    expect(signed.signature!.length).toBe(64);
  });
});

// ─── EDGE CASES ─────────────────────────────────────────────

describe("Edge Cases", () => {
  it("should handle manifest with all optional fields undefined", () => {
    const manifest = {
      id: "minimal",
      name: "Minimal",
    };

    const result = AgentManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.description).toBeUndefined();
      expect(result.data.author).toBeUndefined();
      expect(result.data.preferredModel).toBeUndefined();
      expect(result.data.trustLevel).toBeUndefined();
      expect(result.data.limits).toBeUndefined();
    }
  });

  it("should reject negative limits", () => {
    const manifest = {
      id: "test",
      name: "Test",
      limits: {
        maxTokensPerRequest: -1,
      },
    };

    const result = AgentManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  it("should reject empty permission grants array with invalid entries", () => {
    const manifest = {
      id: "test",
      name: "Test",
      permissionGrants: [
        {
          category: "", // invalid - empty
          actions: ["read"],
        },
      ],
    };

    const result = AgentManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  it("should reject permission grants with empty actions", () => {
    const manifest = {
      id: "test",
      name: "Test",
      permissionGrants: [
        {
          category: "filesystem",
          actions: [], // invalid - empty array
        },
      ],
    };

    const result = AgentManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  it("should handle agent task handler returning sync value", async () => {
    const definition = defineAgent({
      manifest: {
        id: "sync-agent",
        name: "Sync Agent",
        version: "1.0.0",
        permissions: [],
        requiredSkills: [],
      },
      handleTask: (task) => ({ sync: true, received: task }), // sync return
    });

    const result = await definition.handleTask({ test: "data" }, { agentId: "test-id" });
    expect(result).toEqual({ sync: true, received: { test: "data" } });
  });
});

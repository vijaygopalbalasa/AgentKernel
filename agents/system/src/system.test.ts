// System Agent Tests
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  SystemAgent,
  createSystemAgent,
  SystemManifestSchema,
  SystemError,
  DEFAULT_MANIFEST,
} from "./index.js";

describe("SystemAgent", () => {
  let agent: SystemAgent;

  beforeEach(() => {
    agent = createSystemAgent();
  });

  afterEach(async () => {
    if (agent.getStatus().state !== "terminated") {
      await agent.terminate();
    }
  });

  describe("Manifest Validation", () => {
    it("should use default manifest", () => {
      const status = agent.getStatus();
      expect(status.id).toBe("system");
      expect(status.name).toBe("System Agent");
    });

    it("should accept custom manifest", () => {
      const customAgent = createSystemAgent({
        id: "custom-system",
        name: "Custom System",
        version: "1.0.0",
        maxAgents: 50,
      });
      const status = customAgent.getStatus();
      expect(status.id).toBe("custom-system");
      expect(status.name).toBe("Custom System");
    });

    it("should validate manifest schema", () => {
      const valid = SystemManifestSchema.safeParse({
        id: "test",
        name: "Test System",
      });
      expect(valid.success).toBe(true);
    });

    it("should reject invalid manifest", () => {
      const invalid = SystemManifestSchema.safeParse({
        id: "",
        name: "Test",
      });
      expect(invalid.success).toBe(false);
    });

    it("should throw on invalid manifest in constructor", () => {
      expect(() => createSystemAgent({ id: "" })).toThrow(SystemError);
    });

    it("should reject too small check interval", () => {
      const invalid = SystemManifestSchema.safeParse({
        id: "test",
        name: "Test",
        checkInterval: 500, // Less than 1000
      });
      expect(invalid.success).toBe(false);
    });
  });

  describe("Lifecycle", () => {
    it("should start in idle state", () => {
      const status = agent.getStatus();
      expect(status.state).toBe("idle");
    });

    it("should initialize successfully", async () => {
      const result = await agent.initialize();
      expect(result.ok).toBe(true);
      expect(agent.getStatus().state).toBe("monitoring");
    });

    it("should reject double initialization", async () => {
      await agent.initialize();
      const result = await agent.initialize();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("ALREADY_RUNNING");
      }
    });

    it("should terminate successfully", async () => {
      await agent.initialize();
      const result = await agent.terminate();
      expect(result.ok).toBe(true);
      expect(agent.getStatus().state).toBe("terminated");
    });

    it("should track uptime after initialization", async () => {
      await agent.initialize();
      const status = agent.getStatus();
      expect(status.uptime).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Health Checks", () => {
    beforeEach(async () => {
      await agent.initialize();
    });

    it("should perform health check", async () => {
      const result = await agent.performHealthCheck();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.level).toBeDefined();
        expect(result.value.memory).toBeDefined();
        expect(result.value.agents).toBeDefined();
      }
    });

    it("should store last health report", async () => {
      await agent.performHealthCheck();
      const report = agent.getLastHealthReport();
      expect(report).toBeDefined();
      expect(report?.timestamp).toBeInstanceOf(Date);
    });

    it("should report memory usage", async () => {
      const result = await agent.performHealthCheck();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.memory.used).toBeGreaterThan(0);
        expect(result.value.memory.total).toBeGreaterThan(0);
        expect(result.value.memory.percentage).toBeGreaterThan(0);
      }
    });

    it("should report uptime in health check", async () => {
      const result = await agent.performHealthCheck();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.uptime).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe("Agent Resource Tracking", () => {
    beforeEach(async () => {
      await agent.initialize();
    });

    it("should register an agent", () => {
      const result = agent.registerAgent("test-agent-1");
      expect(result.ok).toBe(true);
      expect(agent.getStatus().agentCount).toBe(1);
    });

    it("should unregister an agent", () => {
      agent.registerAgent("test-agent-1");
      agent.unregisterAgent("test-agent-1");
      expect(agent.getStatus().agentCount).toBe(0);
    });

    it("should track agent resources", () => {
      agent.registerAgent("test-agent-1");
      const usage = agent.getAgentResources("test-agent-1");
      expect(usage).toBeDefined();
      expect(usage?.agentId).toBe("test-agent-1");
    });

    it("should update agent resources", () => {
      agent.registerAgent("test-agent-1");
      const result = agent.updateAgentResources("test-agent-1", {
        memoryMB: 100,
        cpuPercent: 25,
      });
      expect(result.ok).toBe(true);

      const usage = agent.getAgentResources("test-agent-1");
      expect(usage?.memoryMB).toBe(100);
      expect(usage?.cpuPercent).toBe(25);
    });

    it("should reject update for unregistered agent", () => {
      const result = agent.updateAgentResources("nonexistent", { memoryMB: 50 });
      expect(result.ok).toBe(false);
    });

    it("should get all agent resources", () => {
      agent.registerAgent("agent-1");
      agent.registerAgent("agent-2");
      const all = agent.getAllAgentResources();
      expect(all.length).toBe(2);
    });

    it("should enforce max agent limit", () => {
      const limitedAgent = createSystemAgent({ maxAgents: 2 });
      limitedAgent.registerAgent("agent-1");
      limitedAgent.registerAgent("agent-2");
      const result = limitedAgent.registerAgent("agent-3");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("RESOURCE_EXCEEDED");
      }
    });
  });

  describe("Provider Registration", () => {
    beforeEach(async () => {
      await agent.initialize();
    });

    it("should register a provider", () => {
      agent.registerProvider("anthropic");
      expect(agent.getStatus().providerCount).toBe(1);
    });

    it("should unregister a provider", () => {
      agent.registerProvider("anthropic");
      agent.unregisterProvider("anthropic");
      expect(agent.getStatus().providerCount).toBe(0);
    });

    it("should include providers in health report", async () => {
      agent.registerProvider("anthropic");
      agent.registerProvider("openai");

      const result = await agent.performHealthCheck();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.providers).toContain("anthropic");
        expect(result.value.providers).toContain("openai");
      }
    });
  });

  describe("Status", () => {
    it("should return complete status", async () => {
      await agent.initialize();
      const status = agent.getStatus();
      expect(status).toHaveProperty("id");
      expect(status).toHaveProperty("name");
      expect(status).toHaveProperty("state");
      expect(status).toHaveProperty("uptime");
      expect(status).toHaveProperty("healthLevel");
      expect(status).toHaveProperty("agentCount");
      expect(status).toHaveProperty("providerCount");
    });

    it("should report unknown health level before first check", () => {
      const status = agent.getStatus();
      expect(status.healthLevel).toBe("unknown");
    });
  });

  describe("Diagnostics", () => {
    beforeEach(async () => {
      await agent.initialize();
    });

    it("should return full diagnostics", () => {
      const diagnostics = agent.getDiagnostics();
      expect(diagnostics).toHaveProperty("manifest");
      expect(diagnostics).toHaveProperty("state");
      expect(diagnostics).toHaveProperty("uptime");
      expect(diagnostics).toHaveProperty("agents");
      expect(diagnostics).toHaveProperty("providers");
      expect(diagnostics).toHaveProperty("memory");
    });

    it("should include memory stats", () => {
      const diagnostics = agent.getDiagnostics();
      expect(diagnostics.memory.heapUsed).toBeGreaterThan(0);
      expect(diagnostics.memory.heapTotal).toBeGreaterThan(0);
      expect(diagnostics.memory.rss).toBeGreaterThan(0);
    });

    it("should include registered agents", () => {
      agent.registerAgent("test-agent");
      const diagnostics = agent.getDiagnostics();
      expect(diagnostics.agents.length).toBe(1);
    });
  });

  describe("SystemError", () => {
    it("should create error with code", () => {
      const error = new SystemError("Test error", "VALIDATION_ERROR");
      expect(error.message).toBe("Test error");
      expect(error.code).toBe("VALIDATION_ERROR");
      expect(error.name).toBe("SystemError");
    });

    it("should extend Error", () => {
      const error = new SystemError("Test", "RESOURCE_EXCEEDED");
      expect(error).toBeInstanceOf(Error);
    });
  });
});

describe("DEFAULT_MANIFEST", () => {
  it("should have required fields", () => {
    expect(DEFAULT_MANIFEST.id).toBe("system");
    expect(DEFAULT_MANIFEST.name).toBe("System Agent");
    expect(DEFAULT_MANIFEST.version).toBe("0.1.0");
  });

  it("should have resource limits", () => {
    expect(DEFAULT_MANIFEST.maxAgents).toBe(100);
    expect(DEFAULT_MANIFEST.maxMemoryMB).toBe(512);
  });

  it("should have check interval", () => {
    expect(DEFAULT_MANIFEST.checkInterval).toBe(30000);
  });
});

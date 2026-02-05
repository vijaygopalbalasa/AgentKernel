import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditLogger, MemoryAuditSink } from "../audit.js";
import { createHealthMonitor } from "../health.js";
import { AgentLifecycleManager, type AgentManifest } from "../lifecycle.js";
import { createMemoryPersistence } from "../persistence.js";
import { AgentStateMachine } from "../state-machine.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("AgentStateMachine", () => {
  it("should start in created state", () => {
    const machine = new AgentStateMachine();
    expect(machine.state).toBe("created");
  });

  it("should transition through valid states", () => {
    const machine = new AgentStateMachine();

    expect(machine.transition("INITIALIZE")).toBe(true);
    expect(machine.state).toBe("initializing");

    expect(machine.transition("READY")).toBe(true);
    expect(machine.state).toBe("ready");

    expect(machine.transition("START")).toBe(true);
    expect(machine.state).toBe("running");

    expect(machine.transition("COMPLETE")).toBe(true);
    expect(machine.state).toBe("ready");
  });

  it("should reject invalid transitions", () => {
    const machine = new AgentStateMachine();

    // Can't start directly from created
    expect(machine.transition("START")).toBe(false);
    expect(machine.state).toBe("created");
  });

  it("should track history", () => {
    const machine = new AgentStateMachine();
    machine.transition("INITIALIZE");
    machine.transition("READY");

    expect(machine.history.length).toBe(2);
    const firstTransition = machine.history[0];
    expect(firstTransition).toBeDefined();
    if (!firstTransition) return;
    expect(firstTransition.fromState).toBe("created");
    expect(firstTransition.toState).toBe("initializing");
  });
});

describe("AgentLifecycleManager", () => {
  const testManifest: AgentManifest = {
    name: "test-agent",
    version: "1.0.0",
    description: "A test agent",
  };

  describe("spawn", () => {
    it("should spawn agents", () => {
      const manager = new AgentLifecycleManager();
      const id = manager.spawn(testManifest);

      expect(id).toMatch(UUID_REGEX);
      expect(manager.agentCount).toBe(1);
      expect(manager.getState(id)).toBe("created");
    });

    it("should spawn with parent ID", () => {
      const manager = new AgentLifecycleManager();
      const parentId = manager.spawn(testManifest);
      const childId = manager.spawn(testManifest, parentId);

      const context = manager.getContext(childId);
      expect(context?.parentId).toBe(parentId);
    });

    it("should apply manifest limits", () => {
      const manager = new AgentLifecycleManager();
      const id = manager.spawn({
        ...testManifest,
        limits: { maxTokensPerRequest: 8192 },
      });

      const context = manager.getContext(id);
      expect(context?.limits.maxTokensPerRequest).toBe(8192);
    });

    it("should enforce agent limit", () => {
      const manager = new AgentLifecycleManager({ maxAgents: 2 });

      manager.spawn(testManifest);
      manager.spawn(testManifest);

      expect(() => manager.spawn(testManifest)).toThrow(/limit reached/);
    });

    it("should reject spawn during shutdown", async () => {
      const manager = new AgentLifecycleManager();
      await manager.shutdown();

      expect(() => manager.spawn(testManifest)).toThrow(/shutdown/);
    });
  });

  describe("initialize", () => {
    it("should initialize agents", async () => {
      const manager = new AgentLifecycleManager();
      const id = manager.spawn(testManifest);

      const result = await manager.initialize(id);

      expect(result).toBe(true);
      expect(manager.getState(id)).toBe("ready");
    });

    it("should throw for non-existent agent", async () => {
      const manager = new AgentLifecycleManager();

      await expect(manager.initialize("nonexistent")).rejects.toThrow(/not found/);
    });

    it("should block host entryPoint execution by default", async () => {
      const manager = new AgentLifecycleManager();
      const dir = mkdtempSync(join(tmpdir(), "agentkernel-entrypoint-"));
      const entryPoint = join(dir, "init.mjs");
      writeFileSync(entryPoint, "export default async () => {};\n", "utf-8");

      try {
        const id = manager.spawn({
          ...testManifest,
          entryPoint,
        });

        const result = await manager.initialize(id);
        expect(result).toBe(false);
        expect(manager.getState(id)).toBe("error");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("should allow host entryPoint execution when explicitly enabled", async () => {
      const manager = new AgentLifecycleManager({ allowHostEntryPointExecution: true });
      const dir = mkdtempSync(join(tmpdir(), "agentkernel-entrypoint-"));
      const entryPoint = join(dir, "init.mjs");
      writeFileSync(entryPoint, "export default async () => {};\n", "utf-8");

      try {
        const id = manager.spawn({
          ...testManifest,
          entryPoint,
        });

        const result = await manager.initialize(id);
        expect(result).toBe(true);
        expect(manager.getState(id)).toBe("ready");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("start", () => {
    it("should start an agent", async () => {
      const manager = new AgentLifecycleManager();
      const id = manager.spawn(testManifest);
      await manager.initialize(id);

      const result = manager.start(id);

      expect(result).toBe(true);
      expect(manager.getState(id)).toBe("running");
    });
  });

  describe("pause and resume", () => {
    it("should pause and resume agents", async () => {
      const manager = new AgentLifecycleManager();
      const id = manager.spawn(testManifest);
      await manager.initialize(id);

      manager.pause(id);
      expect(manager.getState(id)).toBe("paused");

      manager.resume(id);
      expect(manager.getState(id)).toBe("ready");
    });
  });

  describe("complete", () => {
    it("should mark task as complete", async () => {
      const manager = new AgentLifecycleManager();
      const id = manager.spawn(testManifest);
      await manager.initialize(id);
      manager.start(id);

      const result = manager.complete(id);

      expect(result).toBe(true);
      expect(manager.getState(id)).toBe("ready");
    });
  });

  describe("fail and recover", () => {
    it("should handle failure and recovery", async () => {
      const manager = new AgentLifecycleManager();
      const id = manager.spawn(testManifest);
      await manager.initialize(id);
      manager.start(id);

      manager.fail(id, "Test error");
      expect(manager.getState(id)).toBe("error");

      manager.recoverFromError(id);
      expect(manager.getState(id)).toBe("ready");
    });
  });

  describe("terminate", () => {
    it("should terminate agents", async () => {
      const manager = new AgentLifecycleManager();
      const id = manager.spawn(testManifest);

      const result = manager.terminate(id);

      expect(result).toBe(true);
      expect(manager.getState(id)).toBe("terminated");
    });

    it("should return false for non-existent agent", () => {
      const manager = new AgentLifecycleManager();
      expect(manager.terminate("nonexistent")).toBe(false);
    });
  });

  describe("events", () => {
    it("should track lifecycle events", async () => {
      const events: string[] = [];
      const manager = new AgentLifecycleManager();

      manager.onEvent((event) => {
        events.push(event.type);
      });

      const id = manager.spawn(testManifest);
      await manager.initialize(id);
      manager.start(id);
      manager.complete(id);
      manager.terminate(id);

      expect(events).toContain("spawn");
      expect(events).toContain("state_change");
      expect(events).toContain("terminate");
    });

    it("should return unsubscribe function", () => {
      const events: string[] = [];
      const manager = new AgentLifecycleManager();

      const unsubscribe = manager.onEvent((event) => {
        events.push(event.type);
      });

      manager.spawn(testManifest);
      expect(events).toContain("spawn");

      unsubscribe();

      manager.spawn(testManifest);
      expect(events.filter((e) => e === "spawn")).toHaveLength(1);
    });
  });

  describe("recordUsage", () => {
    it("should record usage and check limits", async () => {
      const events: string[] = [];
      const manager = new AgentLifecycleManager();

      manager.onEvent((event) => {
        events.push(event.type);
      });

      const id = manager.spawn({
        ...testManifest,
        limits: { tokensPerMinute: 1000 },
      });

      await manager.initialize(id);
      manager.start(id);

      // Record usage that exceeds limit
      manager.recordUsage(id, "claude-3-haiku-20240307", 600, 600);

      const context = manager.getContext(id);
      expect(context?.usage.inputTokens).toBe(600);
      expect(context?.usage.outputTokens).toBe(600);
      expect(events).toContain("resource_warning");
    });
  });

  describe("listAgents", () => {
    it("should list all agents", async () => {
      const manager = new AgentLifecycleManager();
      const id1 = manager.spawn({ ...testManifest, name: "agent-1" });
      const id2 = manager.spawn({ ...testManifest, name: "agent-2" });

      await manager.initialize(id1);

      const agents = manager.listAgents();
      expect(agents).toHaveLength(2);
      expect(agents.find((a) => a.id === id1)?.state).toBe("ready");
      expect(agents.find((a) => a.id === id2)?.state).toBe("created");
    });
  });

  describe("getAgentsByState", () => {
    it("should filter agents by state", async () => {
      const manager = new AgentLifecycleManager();
      const id1 = manager.spawn(testManifest);
      const id2 = manager.spawn(testManifest);

      await manager.initialize(id1);

      const readyAgents = manager.getAgentsByState("ready");
      const createdAgents = manager.getAgentsByState("created");

      expect(readyAgents).toContain(id1);
      expect(createdAgents).toContain(id2);
    });
  });

  describe("sandbox integration", () => {
    it("should create sandbox for spawned agents", () => {
      const manager = new AgentLifecycleManager();
      const id = manager.spawn(testManifest);

      const sandbox = manager.getSandbox(id);
      expect(sandbox).toBeDefined();
    });

    it("should grant requested capabilities", () => {
      const manager = new AgentLifecycleManager();
      const id = manager.spawn({
        ...testManifest,
        permissions: ["file:read", "network:http"],
      });

      expect(manager.hasCapability(id, "file:read")).toBe(true);
      expect(manager.hasCapability(id, "network:http")).toBe(true);
    });

    it("should check capabilities", () => {
      const manager = new AgentLifecycleManager();
      const id = manager.spawn(testManifest);

      expect(manager.checkCapability(id, "llm:chat")).toBe(true);
      expect(manager.checkCapability(id, "shell:execute")).toBe(false);
    });
  });

  describe("persistence integration", () => {
    it("should checkpoint agents when persistence is configured", async () => {
      const persistence = createMemoryPersistence();
      const manager = new AgentLifecycleManager({ persistence });

      const id = manager.spawn(testManifest);
      await manager.initialize(id);

      await manager.checkpoint(id);

      const hasCheckpoint = await persistence.hasCheckpoint(id);
      expect(hasCheckpoint).toBe(true);
    });

    it("should recover agents from checkpoint", async () => {
      const persistence = createMemoryPersistence();
      const manager1 = new AgentLifecycleManager({ persistence });

      const id1 = manager1.spawn(testManifest);
      await manager1.initialize(id1);
      manager1.start(id1);
      await manager1.checkpoint(id1);

      // Create new manager and recover
      const checkpoint = await persistence.recover(id1);
      expect(checkpoint).not.toBeNull();

      const manager2 = new AgentLifecycleManager({ persistence });
      const id2 = await manager2.recover(checkpoint!);

      expect(id2).toBe(id1);
      expect(manager2.getState(id2)).toBe("running");
    });
  });

  describe("audit integration", () => {
    it("should log lifecycle events", async () => {
      const memorySink = new MemoryAuditSink();
      const auditLogger = new AuditLogger({ sinks: [memorySink] });
      const manager = new AgentLifecycleManager({ auditLogger });

      const id = manager.spawn(testManifest);
      await manager.initialize(id);
      manager.terminate(id);

      const events = memorySink.getByCategory("lifecycle");
      expect(events.length).toBeGreaterThanOrEqual(2);
    });

    it("should log state transitions", async () => {
      const memorySink = new MemoryAuditSink();
      const auditLogger = new AuditLogger({ sinks: [memorySink] });
      const manager = new AgentLifecycleManager({ auditLogger });

      const id = manager.spawn(testManifest);
      await manager.initialize(id);

      const stateEvents = memorySink.getByCategory("state");
      expect(stateEvents.length).toBeGreaterThanOrEqual(2); // INITIALIZE, READY
    });
  });

  describe("health integration", () => {
    it("should provide health metrics", async () => {
      const manager = new AgentLifecycleManager();
      const id = manager.spawn(testManifest);
      await manager.initialize(id);

      const metrics = manager.getHealthMetrics(id);

      expect(metrics).not.toBeNull();
      expect(metrics?.agentId).toBe(id);
      expect(metrics?.state).toBe("ready");
      expect(metrics?.uptimeSeconds).toBeGreaterThanOrEqual(0);
    });

    it("should run health checks", async () => {
      const healthMonitor = createHealthMonitor();
      const manager = new AgentLifecycleManager({ healthMonitor });

      const id = manager.spawn(testManifest);
      await manager.initialize(id);

      const result = manager.checkHealth(id);

      expect(result).not.toBeNull();
      expect(result?.status).toBe("healthy");
    });

    it("should return null for non-existent agent", () => {
      const manager = new AgentLifecycleManager();
      expect(manager.getHealthMetrics("nonexistent")).toBeNull();
    });
  });

  describe("shutdown", () => {
    it("should terminate all agents", async () => {
      const manager = new AgentLifecycleManager({ shutdownTimeoutMs: 100 });
      manager.spawn(testManifest);
      manager.spawn(testManifest);

      await manager.shutdown();

      expect(manager.shuttingDown).toBe(true);
    });

    it("should checkpoint before shutdown", async () => {
      const persistence = createMemoryPersistence();
      const manager = new AgentLifecycleManager({
        persistence,
        shutdownTimeoutMs: 100,
      });

      const id = manager.spawn(testManifest);
      await manager.initialize(id);

      await manager.shutdown();

      const hasCheckpoint = await persistence.hasCheckpoint(id);
      expect(hasCheckpoint).toBe(true);
    });

    it("should be idempotent", async () => {
      const manager = new AgentLifecycleManager();

      await manager.shutdown();
      await manager.shutdown(); // Should not throw
    });
  });
});

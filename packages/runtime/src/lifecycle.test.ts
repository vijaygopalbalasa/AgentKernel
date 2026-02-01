// Agent Lifecycle Manager tests
import { describe, it, expect } from "vitest";
import { AgentLifecycleManager, type AgentManifest } from "./lifecycle.js";
import { AgentStateMachine } from "./state-machine.js";

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
    expect(machine.history[0].fromState).toBe("created");
    expect(machine.history[0].toState).toBe("initializing");
  });
});

describe("AgentLifecycleManager", () => {
  const testManifest: AgentManifest = {
    name: "test-agent",
    version: "1.0.0",
    description: "A test agent",
  };

  it("should spawn agents", () => {
    const manager = new AgentLifecycleManager();
    const id = manager.spawn(testManifest);

    expect(id).toMatch(/^agent-/);
    expect(manager.agentCount).toBe(1);
    expect(manager.getState(id)).toBe("created");
  });

  it("should initialize agents", async () => {
    const manager = new AgentLifecycleManager();
    const id = manager.spawn(testManifest);

    const result = await manager.initialize(id);

    expect(result).toBe(true);
    expect(manager.getState(id)).toBe("ready");
  });

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

  it("should enforce agent limits", () => {
    const manager = new AgentLifecycleManager({ maxAgents: 2 });

    manager.spawn(testManifest);
    manager.spawn(testManifest);

    expect(() => manager.spawn(testManifest)).toThrow(/limit reached/);
  });

  it("should record usage and check limits", async () => {
    const manager = new AgentLifecycleManager();
    const id = manager.spawn({
      ...testManifest,
      limits: { tokensPerMinute: 1000 },
    });

    await manager.initialize(id);
    manager.start(id);

    // Record usage
    manager.recordUsage(id, "claude-3-haiku-20240307", 500, 500);

    const context = manager.getContext(id);
    expect(context?.usage.inputTokens).toBe(500);
    expect(context?.usage.outputTokens).toBe(500);
  });
});

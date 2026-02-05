import { beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentEvent, type AgentState, AgentStateMachine } from "../state-machine.js";

describe("AgentStateMachine", () => {
  let machine: AgentStateMachine;

  beforeEach(() => {
    machine = new AgentStateMachine();
  });

  describe("initial state", () => {
    it("should start in 'created' state by default", () => {
      expect(machine.state).toBe("created");
    });

    it("should accept custom initial state", () => {
      const customMachine = new AgentStateMachine("ready");
      expect(customMachine.state).toBe("ready");
    });

    it("should have empty history initially", () => {
      expect(machine.history).toHaveLength(0);
    });
  });

  describe("canTransition", () => {
    it("should return true for valid transitions from created", () => {
      expect(machine.canTransition("INITIALIZE")).toBe(true);
      expect(machine.canTransition("TERMINATE")).toBe(true);
    });

    it("should return false for invalid transitions from created", () => {
      expect(machine.canTransition("START")).toBe(false);
      expect(machine.canTransition("PAUSE")).toBe(false);
      expect(machine.canTransition("COMPLETE")).toBe(false);
    });

    it("should validate transitions from initializing", () => {
      machine.transition("INITIALIZE");
      expect(machine.canTransition("READY")).toBe(true);
      expect(machine.canTransition("FAIL")).toBe(true);
      expect(machine.canTransition("TERMINATE")).toBe(true);
      expect(machine.canTransition("START")).toBe(false);
    });

    it("should validate transitions from ready", () => {
      machine.transition("INITIALIZE");
      machine.transition("READY");
      expect(machine.canTransition("START")).toBe(true);
      expect(machine.canTransition("PAUSE")).toBe(true);
      expect(machine.canTransition("TERMINATE")).toBe(true);
    });

    it("should validate transitions from running", () => {
      machine.transition("INITIALIZE");
      machine.transition("READY");
      machine.transition("START");
      expect(machine.canTransition("COMPLETE")).toBe(true);
      expect(machine.canTransition("PAUSE")).toBe(true);
      expect(machine.canTransition("FAIL")).toBe(true);
      expect(machine.canTransition("TERMINATE")).toBe(true);
    });
  });

  describe("getNextState", () => {
    it("should return correct next state for valid transition", () => {
      expect(machine.getNextState("INITIALIZE")).toBe("initializing");
    });

    it("should return null for invalid transition", () => {
      expect(machine.getNextState("START")).toBe(null);
    });
  });

  describe("transition", () => {
    it("should successfully transition through valid states", () => {
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
      expect(machine.transition("START")).toBe(false);
      expect(machine.state).toBe("created");
    });

    it("should record transitions in history", () => {
      machine.transition("INITIALIZE", "Test reason");
      machine.transition("READY");

      expect(machine.history).toHaveLength(2);
      const firstTransition = machine.history[0];
      expect(firstTransition).toBeDefined();
      if (!firstTransition) return;
      expect(firstTransition.fromState).toBe("created");
      expect(firstTransition.toState).toBe("initializing");
      expect(firstTransition.event).toBe("INITIALIZE");
      expect(firstTransition.reason).toBe("Test reason");
      expect(firstTransition.timestamp).toBeInstanceOf(Date);
    });

    it("should handle error state transitions", () => {
      machine.transition("INITIALIZE");
      machine.transition("FAIL", "Something went wrong");
      expect(machine.state).toBe("error");

      machine.transition("RECOVER");
      expect(machine.state).toBe("ready");
    });

    it("should handle pause and resume", () => {
      machine.transition("INITIALIZE");
      machine.transition("READY");
      machine.transition("PAUSE");
      expect(machine.state).toBe("paused");

      machine.transition("RESUME");
      expect(machine.state).toBe("ready");
    });

    it("should handle termination from any non-terminal state", () => {
      machine.transition("INITIALIZE");
      machine.transition("READY");
      machine.transition("START");
      machine.transition("TERMINATE", "Shutting down");
      expect(machine.state).toBe("terminated");
    });

    it("should not allow transitions from terminated state", () => {
      machine.transition("TERMINATE");
      expect(machine.transition("INITIALIZE")).toBe(false);
      expect(machine.state).toBe("terminated");
    });
  });

  describe("onTransition", () => {
    it("should call listener on transition", () => {
      const listener = vi.fn();
      machine.onTransition(listener);

      machine.transition("INITIALIZE");

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          fromState: "created",
          toState: "initializing",
          event: "INITIALIZE",
        }),
      );
    });

    it("should call multiple listeners", () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      machine.onTransition(listener1);
      machine.onTransition(listener2);

      machine.transition("INITIALIZE");

      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);
    });

    it("should return unsubscribe function", () => {
      const listener = vi.fn();
      const unsubscribe = machine.onTransition(listener);

      machine.transition("INITIALIZE");
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();

      machine.transition("READY");
      expect(listener).toHaveBeenCalledTimes(1); // Still 1
    });
  });

  describe("isTerminal", () => {
    it("should return false for non-terminal states", () => {
      expect(machine.isTerminal()).toBe(false);
      machine.transition("INITIALIZE");
      expect(machine.isTerminal()).toBe(false);
      machine.transition("READY");
      expect(machine.isTerminal()).toBe(false);
    });

    it("should return true for terminated state", () => {
      machine.transition("TERMINATE");
      expect(machine.isTerminal()).toBe(true);
    });
  });

  describe("isAvailable", () => {
    it("should return true only when ready", () => {
      expect(machine.isAvailable()).toBe(false);
      machine.transition("INITIALIZE");
      expect(machine.isAvailable()).toBe(false);
      machine.transition("READY");
      expect(machine.isAvailable()).toBe(true);
      machine.transition("START");
      expect(machine.isAvailable()).toBe(false);
    });
  });

  describe("isActive", () => {
    it("should return true for initializing and running states", () => {
      expect(machine.isActive()).toBe(false);
      machine.transition("INITIALIZE");
      expect(machine.isActive()).toBe(true);
      machine.transition("READY");
      expect(machine.isActive()).toBe(false);
      machine.transition("START");
      expect(machine.isActive()).toBe(true);
    });
  });

  describe("serialization", () => {
    it("should serialize to JSON", () => {
      machine.transition("INITIALIZE");
      machine.transition("READY");

      const json = machine.toJSON();
      expect(json.state).toBe("ready");
      expect(json.history).toHaveLength(2);
    });

    it("should restore from JSON", () => {
      machine.transition("INITIALIZE");
      machine.transition("READY");

      const json = machine.toJSON();
      const restored = AgentStateMachine.fromJSON(json);

      expect(restored.state).toBe("ready");
      expect(restored.history).toHaveLength(2);
      expect(restored.canTransition("START")).toBe(true);
    });
  });

  describe("full lifecycle", () => {
    it("should handle complete agent lifecycle", () => {
      // Created -> Initializing -> Ready
      expect(machine.transition("INITIALIZE")).toBe(true);
      expect(machine.transition("READY")).toBe(true);

      // Ready -> Running -> Ready (task complete)
      expect(machine.transition("START")).toBe(true);
      expect(machine.transition("COMPLETE")).toBe(true);

      // Ready -> Running -> Error -> Ready (recovery)
      expect(machine.transition("START")).toBe(true);
      expect(machine.transition("FAIL", "Task failed")).toBe(true);
      expect(machine.transition("RECOVER")).toBe(true);

      // Ready -> Paused -> Ready (pause/resume)
      expect(machine.transition("PAUSE")).toBe(true);
      expect(machine.transition("RESUME")).toBe(true);

      // Ready -> Terminated
      expect(machine.transition("TERMINATE", "Shutdown")).toBe(true);
      expect(machine.isTerminal()).toBe(true);
    });
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  PersistentStateMachine,
  createPersistentStateMachine,
} from "../persistent-state-machine.js";
import type { Database, Logger } from "@agentkernel/kernel";

// Mock logger
const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(() => mockLogger),
  level: "debug",
  silent: vi.fn(),
};

// Mock database factory
function createMockDatabase(
  queryOneResult: unknown = null,
  queryResult: unknown[] = []
): Database {
  return {
    query: vi.fn().mockResolvedValue(queryResult),
    queryOne: vi.fn().mockResolvedValue(queryOneResult),
    transaction: vi.fn().mockImplementation(async (fn) => {
      const mockSql = vi.fn().mockResolvedValue([]);
      return fn(mockSql);
    }),
    close: vi.fn().mockResolvedValue(undefined),
    runMigrations: vi.fn().mockResolvedValue({ ok: true, value: [] }),
    getStats: vi.fn().mockReturnValue({
      totalConnections: 1,
      activeConnections: 0,
      idleConnections: 1,
      waitingRequests: 0,
    }),
  } as unknown as Database;
}

describe("PersistentStateMachine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("without database (in-memory mode)", () => {
    it("should initialize with default state", async () => {
      const machine = new PersistentStateMachine({
        agentId: "test-agent-1",
        logger: mockLogger,
      });

      await machine.init();
      expect(machine.state).toBe("created");
    });

    it("should transition states correctly", async () => {
      const machine = await createPersistentStateMachine({
        agentId: "test-agent-2",
        logger: mockLogger,
      });

      expect(machine.state).toBe("created");
      expect(await machine.transition("INITIALIZE")).toBe(true);
      expect(machine.state).toBe("initializing");
      expect(await machine.transition("READY")).toBe(true);
      expect(machine.state).toBe("ready");
    });

    it("should reject invalid transitions", async () => {
      const machine = await createPersistentStateMachine({
        agentId: "test-agent-3",
        logger: mockLogger,
      });

      expect(machine.state).toBe("created");
      expect(await machine.transition("START")).toBe(false);
      expect(machine.state).toBe("created");
    });

    it("should track history in memory", async () => {
      const machine = await createPersistentStateMachine({
        agentId: "test-agent-4",
        logger: mockLogger,
      });

      await machine.transition("INITIALIZE", "starting up");
      await machine.transition("READY");

      expect(machine.history.length).toBe(2);
      expect(machine.history[0].fromState).toBe("created");
      expect(machine.history[0].toState).toBe("initializing");
      expect(machine.history[0].reason).toBe("starting up");
    });

    it("should return in-memory history from loadHistory", async () => {
      const machine = await createPersistentStateMachine({
        agentId: "test-agent-5",
        logger: mockLogger,
      });

      await machine.transition("INITIALIZE");
      await machine.transition("READY");

      const history = await machine.loadHistory();
      expect(history.length).toBe(2);
    });
  });

  describe("with database", () => {
    it("should load state from database on init", async () => {
      const db = createMockDatabase({ id: "test-agent", state: "ready" });

      const machine = await createPersistentStateMachine({
        agentId: "test-agent",
        database: db,
        logger: mockLogger,
      });

      expect(machine.state).toBe("ready");
      expect(db.queryOne).toHaveBeenCalledTimes(1);
    });

    it("should use default state if agent not in database", async () => {
      const db = createMockDatabase(null);

      const machine = await createPersistentStateMachine({
        agentId: "new-agent",
        database: db,
        defaultState: "created",
        logger: mockLogger,
      });

      expect(machine.state).toBe("created");
    });

    it("should persist transitions to database", async () => {
      const db = createMockDatabase({ id: "test-agent", state: "created" });

      const machine = await createPersistentStateMachine({
        agentId: "test-agent",
        database: db,
        logger: mockLogger,
      });

      await machine.transition("INITIALIZE", "test reason");

      expect(db.transaction).toHaveBeenCalledTimes(1);
    });

    it("should load history from database", async () => {
      // Mock returns data in DESC order (as the query does)
      const historyRows = [
        {
          id: "2",
          agent_id: "test-agent",
          from_state: "initializing",
          to_state: "ready",
          event: "READY",
          reason: "init complete",
          created_at: new Date("2024-01-02"),
        },
        {
          id: "1",
          agent_id: "test-agent",
          from_state: "created",
          to_state: "initializing",
          event: "INITIALIZE",
          reason: null,
          created_at: new Date("2024-01-01"),
        },
      ];

      const db = createMockDatabase(
        { id: "test-agent", state: "ready" },
        historyRows
      );

      const machine = await createPersistentStateMachine({
        agentId: "test-agent",
        database: db,
        logger: mockLogger,
      });

      const history = await machine.loadHistory();

      expect(db.query).toHaveBeenCalled();
      expect(history.length).toBe(2);
      expect(history[0].event).toBe("INITIALIZE");
      expect(history[1].event).toBe("READY");
      expect(history[1].reason).toBe("init complete");
    });

    it("should fall back gracefully on database error during init", async () => {
      const db = createMockDatabase();
      (db.queryOne as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Connection failed")
      );

      const machine = await createPersistentStateMachine({
        agentId: "test-agent",
        database: db,
        defaultState: "created",
        logger: mockLogger,
      });

      expect(machine.state).toBe("created");
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it("should fall back gracefully on database error during transition", async () => {
      const db = createMockDatabase({ id: "test-agent", state: "created" });
      (db.transaction as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Transaction failed")
      );

      const machine = await createPersistentStateMachine({
        agentId: "test-agent",
        database: db,
        logger: mockLogger,
      });

      // Should still succeed in-memory even if DB fails
      const result = await machine.transition("INITIALIZE");
      expect(result).toBe(true);
      expect(machine.state).toBe("initializing");
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  describe("helper methods", () => {
    it("canTransition returns correct values", async () => {
      const machine = await createPersistentStateMachine({
        agentId: "test",
        logger: mockLogger,
      });

      expect(machine.canTransition("INITIALIZE")).toBe(true);
      expect(machine.canTransition("START")).toBe(false);
    });

    it("getNextState returns correct values", async () => {
      const machine = await createPersistentStateMachine({
        agentId: "test",
        logger: mockLogger,
      });

      expect(machine.getNextState("INITIALIZE")).toBe("initializing");
      expect(machine.getNextState("START")).toBe(null);
    });

    it("isTerminal returns correct values", async () => {
      const machine = await createPersistentStateMachine({
        agentId: "test",
        logger: mockLogger,
      });

      expect(machine.isTerminal()).toBe(false);
      await machine.transition("TERMINATE");
      expect(machine.isTerminal()).toBe(true);
    });

    it("isAvailable returns correct values", async () => {
      const machine = await createPersistentStateMachine({
        agentId: "test",
        logger: mockLogger,
      });

      expect(machine.isAvailable()).toBe(false);
      await machine.transition("INITIALIZE");
      await machine.transition("READY");
      expect(machine.isAvailable()).toBe(true);
    });

    it("isActive returns correct values", async () => {
      const machine = await createPersistentStateMachine({
        agentId: "test",
        logger: mockLogger,
      });

      expect(machine.isActive()).toBe(false);
      await machine.transition("INITIALIZE");
      expect(machine.isActive()).toBe(true);
      await machine.transition("READY");
      await machine.transition("START");
      expect(machine.isActive()).toBe(true);
    });

    it("toJSON serializes correctly", async () => {
      const machine = await createPersistentStateMachine({
        agentId: "test",
        logger: mockLogger,
      });

      await machine.transition("INITIALIZE");

      const json = machine.toJSON();
      expect(json.state).toBe("initializing");
      expect(json.history.length).toBe(1);
    });

    it("onTransition registers listeners", async () => {
      const machine = await createPersistentStateMachine({
        agentId: "test",
        logger: mockLogger,
      });

      const transitions: unknown[] = [];
      const unsubscribe = machine.onTransition((t) => transitions.push(t));

      await machine.transition("INITIALIZE");
      await machine.transition("READY");

      expect(transitions.length).toBe(2);

      unsubscribe();
      await machine.transition("START");

      // Should not receive this one
      expect(transitions.length).toBe(2);
    });
  });
});

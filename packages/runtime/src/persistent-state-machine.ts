// PersistentStateMachine — PostgreSQL-backed state machine
// Persists agent state and transition history to the database

import type { Database, Logger, Sql } from "@agentkernel/kernel";
import { createLogger } from "@agentkernel/kernel";
import {
  type AgentEvent,
  type AgentState,
  AgentStateMachine,
  type StateTransition,
} from "./state-machine.js";

/** Configuration for PersistentStateMachine */
export interface PersistentStateMachineConfig {
  /** Agent ID (UUID) */
  agentId: string;
  /** Database instance (optional - falls back to in-memory if not provided) */
  database?: Database;
  /** Logger instance */
  logger?: Logger;
  /** Initial state if agent doesn't exist in database */
  defaultState?: AgentState;
}

/** Database row for agent state */
interface AgentStateRow {
  id: string;
  state: string;
}

/** Database row for state history */
interface StateHistoryRow {
  id: string;
  agent_id: string;
  from_state: string | null;
  to_state: string;
  event: string;
  reason: string | null;
  created_at: Date;
}

/**
 * PersistentStateMachine — State machine with PostgreSQL persistence.
 *
 * Wraps AgentStateMachine and adds:
 * - Load state from database on init
 * - Persist state changes to agents table
 * - Record transitions in agent_state_history table
 * - Fetch history from database
 *
 * Falls back to in-memory operation if database is unavailable.
 */
export class PersistentStateMachine {
  private machine: AgentStateMachine;
  private agentId: string;
  private db: Database | null;
  private log: Logger;
  private initialized = false;

  constructor(config: PersistentStateMachineConfig) {
    this.agentId = config.agentId;
    this.db = config.database ?? null;
    this.log = config.logger ?? createLogger({ name: "persistent-state-machine" });
    this.machine = new AgentStateMachine(config.defaultState ?? "created");
  }

  /**
   * Initialize the state machine by loading state from database.
   * Must be called before using the state machine.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    if (this.db) {
      try {
        const row = await this.db.queryOne<AgentStateRow>(
          (sql) => sql`SELECT id, state FROM agents WHERE id = ${this.agentId}`,
        );

        if (row) {
          // Restore state from database
          const dbState = row.state as AgentState;
          this.machine = new AgentStateMachine(dbState);
          this.log.debug("Loaded state from database", {
            agentId: this.agentId,
            state: dbState,
          });
        } else {
          this.log.debug("Agent not found in database, using default state", {
            agentId: this.agentId,
            state: this.machine.state,
          });
        }
      } catch (error) {
        this.log.warn("Failed to load state from database, using in-memory", {
          agentId: this.agentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.initialized = true;
  }

  /** Current state */
  get state(): AgentState {
    return this.machine.state;
  }

  /** In-memory transition history (local to this instance) */
  get history(): ReadonlyArray<StateTransition> {
    return this.machine.history;
  }

  /** Check if a transition is valid from current state */
  canTransition(event: AgentEvent): boolean {
    return this.machine.canTransition(event);
  }

  /** Get the target state for an event (or null if invalid) */
  getNextState(event: AgentEvent): AgentState | null {
    return this.machine.getNextState(event);
  }

  /**
   * Attempt to transition to a new state.
   * Persists the change to the database if available.
   * Returns true if successful, false if invalid transition.
   */
  async transition(event: AgentEvent, reason?: string): Promise<boolean> {
    if (!this.initialized) {
      await this.init();
    }

    const fromState = this.machine.state;
    const success = this.machine.transition(event, reason);

    if (!success) {
      return false;
    }

    const toState = this.machine.state;

    // Persist to database
    if (this.db) {
      try {
        await this.db.transaction(async (sql: Sql) => {
          // Update agent state
          await sql`
            UPDATE agents
            SET state = ${toState}, updated_at = NOW()
            WHERE id = ${this.agentId}
          `;

          // Insert into history (trigger may also do this, but we ensure it)
          await sql`
            INSERT INTO agent_state_history (agent_id, from_state, to_state, event, reason)
            VALUES (${this.agentId}, ${fromState}, ${toState}, ${event}, ${reason ?? null})
          `;
        });

        this.log.debug("Persisted state transition", {
          agentId: this.agentId,
          fromState,
          toState,
          event,
        });
      } catch (error) {
        // Log but don't fail - in-memory state is already updated
        this.log.warn("Failed to persist state transition", {
          agentId: this.agentId,
          fromState,
          toState,
          event,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return true;
  }

  /** Register a listener for state transitions */
  onTransition(listener: (transition: StateTransition) => void): () => void {
    return this.machine.onTransition(listener);
  }

  /** Check if agent is in a terminal state */
  isTerminal(): boolean {
    return this.machine.isTerminal();
  }

  /** Check if agent can accept new tasks */
  isAvailable(): boolean {
    return this.machine.isAvailable();
  }

  /** Check if agent is actively processing */
  isActive(): boolean {
    return this.machine.isActive();
  }

  /**
   * Load transition history from the database.
   * Returns empty array if database is unavailable.
   */
  async loadHistory(options?: {
    limit?: number;
    since?: Date;
  }): Promise<StateTransition[]> {
    if (!this.db) {
      return [...this.machine.history];
    }

    try {
      const limit = options?.limit ?? 100;
      const since = options?.since ?? new Date(0);

      const rows = await this.db.query<StateHistoryRow>(
        (sql) =>
          sql`
          SELECT id, agent_id, from_state, to_state, event, reason, created_at
          FROM agent_state_history
          WHERE agent_id = ${this.agentId}
            AND created_at >= ${since}
          ORDER BY created_at DESC
          LIMIT ${limit}
        `,
      );

      return rows
        .map((row) => ({
          fromState: (row.from_state ?? "created") as AgentState,
          toState: row.to_state as AgentState,
          event: row.event as AgentEvent,
          timestamp: row.created_at,
          reason: row.reason ?? undefined,
        }))
        .reverse();
    } catch (error) {
      this.log.warn("Failed to load history from database", {
        agentId: this.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [...this.machine.history];
    }
  }

  /** Serialize state for checkpointing */
  toJSON(): { state: AgentState; history: StateTransition[] } {
    return this.machine.toJSON();
  }

  /**
   * Create a PersistentStateMachine and initialize it.
   * Convenience factory method.
   */
  static async create(config: PersistentStateMachineConfig): Promise<PersistentStateMachine> {
    const machine = new PersistentStateMachine(config);
    await machine.init();
    return machine;
  }
}

/**
 * Create and initialize a persistent state machine.
 */
export async function createPersistentStateMachine(
  config: PersistentStateMachineConfig,
): Promise<PersistentStateMachine> {
  return PersistentStateMachine.create(config);
}

// Agent State Machine — defines valid states and transitions
// Based on 2026 AgenticOps best practices

/** Valid agent states (like Android app lifecycle) */
export type AgentState =
  | "created" // Agent manifest loaded, not yet initialized
  | "initializing" // Loading resources, connecting to services
  | "ready" // Initialized, waiting for tasks
  | "running" // Actively processing a task
  | "paused" // Suspended (can resume)
  | "error" // Recoverable error state
  | "terminated"; // Final state, cannot recover

/** Events that trigger state transitions */
export type AgentEvent =
  | "INITIALIZE" // Start initialization
  | "READY" // Initialization complete
  | "START" // Begin processing
  | "PAUSE" // Suspend execution
  | "RESUME" // Resume from pause
  | "COMPLETE" // Task completed successfully
  | "FAIL" // Error occurred
  | "RECOVER" // Attempt recovery from error
  | "TERMINATE"; // Shutdown agent

/** State transition record for audit trail */
export interface StateTransition {
  fromState: AgentState;
  toState: AgentState;
  event: AgentEvent;
  timestamp: Date;
  reason?: string;
}

/** Valid state transitions map */
const TRANSITIONS: Record<AgentState, Partial<Record<AgentEvent, AgentState>>> = {
  created: {
    INITIALIZE: "initializing",
    TERMINATE: "terminated",
  },
  initializing: {
    READY: "ready",
    FAIL: "error",
    TERMINATE: "terminated",
  },
  ready: {
    START: "running",
    PAUSE: "paused",
    TERMINATE: "terminated",
  },
  running: {
    COMPLETE: "ready",
    PAUSE: "paused",
    FAIL: "error",
    TERMINATE: "terminated",
  },
  paused: {
    RESUME: "ready",
    TERMINATE: "terminated",
  },
  error: {
    RECOVER: "ready",
    TERMINATE: "terminated",
  },
  terminated: {
    // No transitions from terminated — final state
  },
};

/**
 * Agent state machine with transition validation and history tracking.
 * Implements checkpointing pattern for observability.
 */
export class AgentStateMachine {
  private _state: AgentState = "created";
  private _history: StateTransition[] = [];
  private _listeners: Array<(transition: StateTransition) => void> = [];

  constructor(initialState: AgentState = "created") {
    this._state = initialState;
  }

  /** Current state */
  get state(): AgentState {
    return this._state;
  }

  /** Full transition history for audit trail */
  get history(): ReadonlyArray<StateTransition> {
    return this._history;
  }

  /** Check if a transition is valid from current state */
  canTransition(event: AgentEvent): boolean {
    const validTransitions = TRANSITIONS[this._state];
    return event in validTransitions;
  }

  /** Get the target state for an event (or null if invalid) */
  getNextState(event: AgentEvent): AgentState | null {
    const validTransitions = TRANSITIONS[this._state];
    return validTransitions[event] ?? null;
  }

  /**
   * Attempt to transition to a new state.
   * Returns true if successful, false if invalid transition.
   */
  transition(event: AgentEvent, reason?: string): boolean {
    const nextState = this.getNextState(event);

    if (!nextState) {
      return false;
    }

    const transition: StateTransition = {
      fromState: this._state,
      toState: nextState,
      event,
      timestamp: new Date(),
      reason,
    };

    this._state = nextState;
    this._history.push(transition);

    // Notify listeners (for logging, metrics, etc.)
    for (const listener of this._listeners) {
      listener(transition);
    }

    return true;
  }

  /** Register a listener for state transitions */
  onTransition(listener: (transition: StateTransition) => void): () => void {
    this._listeners.push(listener);
    return () => {
      const index = this._listeners.indexOf(listener);
      if (index > -1) {
        this._listeners.splice(index, 1);
      }
    };
  }

  /** Check if agent is in a terminal state */
  isTerminal(): boolean {
    return this._state === "terminated";
  }

  /** Check if agent can accept new tasks */
  isAvailable(): boolean {
    return this._state === "ready";
  }

  /** Check if agent is actively processing */
  isActive(): boolean {
    return this._state === "running" || this._state === "initializing";
  }

  /** Serialize state for persistence/checkpointing */
  toJSON(): { state: AgentState; history: StateTransition[] } {
    return {
      state: this._state,
      history: this._history,
    };
  }

  /** Restore from serialized state */
  static fromJSON(data: { state: AgentState; history: StateTransition[] }): AgentStateMachine {
    const machine = new AgentStateMachine(data.state);
    machine._history = data.history;
    return machine;
  }
}

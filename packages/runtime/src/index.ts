// @agent-os/runtime — Agent Runtime (Layer 3)
// Handles agent lifecycle, state management, and resource tracking

console.log("✅ @agent-os/runtime loaded");

// State Machine
export {
  AgentStateMachine,
  type AgentState,
  type AgentEvent,
  type StateTransition,
} from "./state-machine.js";

// Agent Context
export {
  type AgentId,
  type AgentContext,
  type AgentMetadata,
  type ResourceLimits,
  type ResourceUsage,
  type LimitCheckResult,
  DEFAULT_LIMITS,
  createInitialUsage,
  checkLimits,
  estimateCost,
} from "./agent-context.js";

// Lifecycle Manager
export {
  AgentLifecycleManager,
  type AgentManifest,
  type LifecycleEvent,
  type LifecycleManagerOptions,
} from "./lifecycle.js";

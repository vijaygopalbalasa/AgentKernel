// @agentkernel/runtime — Agent Runtime (Layer 3)
// Handles agent lifecycle, state management, sandboxing, persistence, and health monitoring

// State Machine
export {
  AgentStateMachine,
  type AgentState,
  type AgentEvent,
  type StateTransition,
} from "./state-machine.js";

// Persistent State Machine (PostgreSQL-backed)
export {
  PersistentStateMachine,
  createPersistentStateMachine,
  type PersistentStateMachineConfig,
} from "./persistent-state-machine.js";

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
  type AgentInitializer,
  type AgentInitializerContext,
  type LifecycleEvent,
  type LifecycleManagerOptions,
} from "./lifecycle.js";

// Sandbox (Capability-based Permissions)
export {
  AgentSandbox,
  SandboxRegistry,
  type Capability,
  type CapabilityGrant,
  type CapabilityConstraints,
  type PermissionCheckResult,
  type PermissionAuditEntry,
  type SandboxConfig,
  ALL_CAPABILITIES,
  DEFAULT_CAPABILITIES,
  DANGEROUS_CAPABILITIES,
  DEFAULT_SANDBOX_CONFIG,
} from "./sandbox.js";

// Persistence (State Checkpointing)
export {
  PersistenceManager,
  FilePersistenceStorage,
  MemoryPersistenceStorage,
  type PersistenceStorage,
  type AgentCheckpoint,
  type FilePersistenceConfig,
  type PersistenceManagerConfig,
  CHECKPOINT_VERSION,
  createFilePersistence,
  createMemoryPersistence,
} from "./persistence.js";

// Audit Logging
export {
  AuditLogger,
  ConsoleAuditSink,
  MemoryAuditSink,
  FileAuditSink,
  DatabaseAuditSink,
  type AuditSink,
  type AuditEvent,
  type AuditSeverity,
  type AuditCategory,
  type AuditLoggerConfig,
  type LifecycleAuditData,
  type StateAuditData,
  type PermissionAuditData,
  type ResourceAuditData,
  type SecurityAuditData,
  type ToolAuditData,
  type CommunicationAuditData,
  type DatabaseAuditRecord,
  type DatabaseAuditWriter,
  type CreateAuditLoggerOptions,
  createAuditLogger,
} from "./audit.js";

// Health Monitoring
export {
  HealthMonitor,
  type HealthCheckResult,
  type HealthStatus,
  type HealthCheck,
  type HealthMetrics,
  type HealthThresholds,
  type HealthMonitorConfig,
  type HealthEvent,
  type HealthEventListener,
  type AnomalyDetection,
  DEFAULT_HEALTH_THRESHOLDS,
  DEFAULT_HEALTH_MONITOR_CONFIG,
  createHealthMonitor,
} from "./health.js";

// Agent State Store
export {
  InMemoryAgentStateStore,
  RedisAgentStateStore,
  type AgentStateStore,
  type AgentStateEntry,
  type RedisHashClient,
} from "./agent-state-store.js";

// Job Runner
export {
  JobRunner,
  type JobRunnerConfig,
  type JobRunnerJobConfig,
  type JobLockProvider,
  type JobLockRelease,
} from "./job-runner.js";

// Adapter (Universal Agent Framework Bridge)
export {
  AdapterRegistry,
  defaultAdapterRegistry,
  type AgentAdapter,
  type AdapterConfig,
  type AdapterMessage,
  type AdapterResponse,
  type AdapterState,
  type AdapterFactory,
} from "./adapter.js";

// Worker Sandbox (Real Process Isolation)
export {
  WorkerSandbox,
  SandboxPool,
  type SandboxResourceLimits,
  type SandboxResult,
  DEFAULT_SANDBOX_LIMITS,
} from "./worker-sandbox.js";

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
  getSandboxHardeningIssues,
  assertSandboxHardening,
} from "./sandbox.js";

// Production Hardening
export { isProductionHardeningEnabled } from "./hardening.js";

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

// Policy Engine (Allow / Block / Approve Rules)
export {
  PolicyEngine,
  createPolicyEngine,
  createPermissivePolicyEngine,
  createStrictPolicyEngine,
  matchPattern,
  matchAnyPattern,
  DEFAULT_BLOCKED_FILE_PATHS,
  DEFAULT_BLOCKED_NETWORK_HOSTS,
  DEFAULT_BLOCKED_SHELL_COMMANDS,
  DEFAULT_BLOCKED_SECRET_PATTERNS,
  PolicySetSchema,
  getPolicyHardeningIssues,
  assertPolicyHardening,
  type PolicyDecision,
  type PolicyRule,
  type FilePolicyRule,
  type NetworkPolicyRule,
  type ShellPolicyRule,
  type SecretPolicyRule,
  type AnyPolicyRule,
  type PolicyEvaluation,
  type PolicySet,
  type FileEvalRequest,
  type NetworkEvalRequest,
  type ShellEvalRequest,
  type SecretEvalRequest,
  type PolicyEvalRequest,
  type PolicyAuditEntry,
} from "./policy-engine.js";

// Database Audit Writer (PostgreSQL Integration)
export {
  createDatabaseAuditWriter,
  createDatabaseAuditWriterWithResult,
  createAuditLoggerWithDatabase,
  queryAuditLogs,
  getAuditStats,
  type DatabaseAuditWriterOptions,
  type AuditLoggerWithDatabaseOptions,
  type AuditWriteResult,
  type AuditQueryOptions,
  type AuditLogRecord,
  type AuditStats,
} from "./db-audit-writer.js";

// Policy Configuration (YAML/JSON loading, env var expansion, merging)
export {
  loadPolicySetFromFile,
  loadPolicySetFromFiles,
  expandEnvVars,
  expandEnvVarsInObject,
  mergePolicySets,
  validatePolicySet,
  createFileRule,
  createNetworkRule,
  createShellRule,
  createSecretRule,
  PolicyConfigError,
  type PolicyConfigOptions,
  type PolicyValidationIssue,
} from "./policy-config.js";

// Process Sandbox (Real OS-level isolation)
export {
  ProcessSandbox,
  ProcessSandboxRegistry,
  type ProcessSandboxConfig,
  type SandboxExecutionResult,
  type SandboxState,
} from "./process-sandbox.js";

// State Persistence (PostgreSQL-backed)
export {
  PostgresStatePersistence,
  PostgresCapabilityStore,
  PostgresRateLimitStore,
  createPersistenceStores,
  type StatePersistence,
  type CapabilityStore,
  type RateLimitStore,
  type PersistedAgentState,
  type CapabilityToken,
  type RateLimitBucket,
} from "./state-persistence.js";

// Per-Agent Rate Limiter
export {
  AgentRateLimiter,
  TokenBucket,
  createAgentRateLimiter,
  DEFAULT_RATE_LIMIT_CONFIG,
  type RateLimitConfig,
  type RateLimitResult,
  type TokenBucketState,
  type BucketType,
} from "./rate-limiter.js";

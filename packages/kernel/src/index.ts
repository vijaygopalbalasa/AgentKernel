// @agent-os/kernel — Compute Kernel (Layer 1)
// The foundation layer providing: configuration, logging, database,
// vector storage, event bus, health checks, and graceful shutdown

// Configuration
export {
  ConfigManager,
  ConfigSchema,
  DatabaseConfigSchema,
  QdrantConfigSchema,
  RedisConfigSchema,
  GatewayConfigSchema,
  LoggingConfigSchema,
  ProviderConfigSchema,
  RuntimeConfigSchema,
  getConfig,
  loadConfig,
  createConfigManager,
  type Config,
  type DatabaseConfig,
  type QdrantConfig,
  type RedisConfig,
  type GatewayConfig,
  type LoggingConfig,
  type ProviderConfig,
  type RuntimeConfig,
} from "./config.js";

// Logging
export {
  initLogger,
  createLogger,
  getLogger,
  flushLogs,
  shutdownLogger,
  isLevelEnabled,
  LOG_LEVELS,
  type Logger,
  type LogContext,
  type CreateLoggerOptions,
  type LogLevel,
} from "./logger.js";

// Database
export {
  createDatabase,
  checkDatabaseHealth,
  waitForDatabase,
  type Database,
  type Sql,
  type PoolStats,
  type MigrationResult,
  type MigrationError,
} from "./database.js";

// Vector Store
export {
  createVectorStore,
  checkVectorStoreHealth,
  waitForVectorStore,
  type VectorStore,
  type VectorPoint,
  type SearchResult,
  type SearchFilter,
  type CollectionInfo,
  type Embedding,
} from "./vector-store.js";

// Event Bus
export {
  createEventBus,
  checkEventBusHealth,
  waitForEventBus,
  type EventBus,
  type EventMessage,
  type EventHandler,
  type Subscription,
  type EventBusStats,
} from "./event-bus.js";

// Health Checks
export {
  createHealthManager,
  createDatabaseHealthChecker,
  createVectorStoreHealthChecker,
  createEventBusHealthChecker,
  createSimpleHealthChecker,
  type HealthManager,
  type HealthChecker,
  type ComponentHealth,
  type SystemHealth,
  type HealthCheckOptions,
} from "./health.js";

// Graceful Shutdown
export {
  createShutdownManager,
  getShutdownManager,
  onShutdown,
  shutdown,
  createDrainHandler,
  SHUTDOWN_PRIORITIES,
  type ShutdownManager,
  type ShutdownHandler,
  type ShutdownOptions,
} from "./shutdown.js";

// Circuit Breaker
export {
  CircuitBreaker,
  CircuitOpenError,
  CircuitBreakerConfigSchema,
  getCircuitBreaker,
  getAllCircuitMetrics,
  resetAllCircuits,
  destroyAllCircuits,
  withCircuitBreaker,
  type CircuitState,
  type CircuitBreakerConfig,
  type CircuitBreakerMetrics,
} from "./circuit-breaker.js";

// Retry
export {
  retry,
  retryAsync,
  withRetry,
  calculateDelay,
  isConnectionError,
  isRateLimitError,
  isServerError,
  isNonRetryableError,
  isRetryableError,
  RetryConfigSchema,
  dbRetryConfig,
  redisRetryConfig,
  llmRetryConfig,
  connectionRetryConfig,
  type RetryConfig,
  type RetryContext,
  type RetryableErrorFilter,
} from "./retry.js";

// Timeout
export {
  TimeoutError,
  TimeoutConfigSchema,
  defaultTimeouts,
  configureTimeouts,
  getTimeouts,
  withTimeout,
  createTimeoutController,
  withDbTimeout,
  withLlmTimeout,
  withMcpTimeout,
  withA2aTimeout,
  withAgentTaskTimeout,
  withHttpTimeout,
  Deadline,
  type TimeoutConfig,
} from "./timeout.js";

// Degradation
export {
  DegradationManager,
  DegradationConfigSchema,
  getDegradationManager,
  resetDegradationManager,
  withFallback,
  withCachedFallback,
  type DegradationLevel,
  type DegradationState,
  type ServiceStatus,
  type DegradationConfig,
} from "./degradation.js";

// Dead Letter Queue
export {
  DeadLetterQueue,
  InMemoryDlqStorage,
  DeadLetterSchema,
  DlqConfigSchema,
  getDeadLetterQueue,
  resetDeadLetterQueue,
  type DeadLetter,
  type DlqStatus,
  type DlqConfig,
  type DlqStorage,
} from "./dead-letter-queue.js";

// Security
export {
  // Input Validation
  validateInput,
  ValidationSchemas,
  sanitizeString,
  sanitizeObject,
  // Secrets Management
  isSecretKey,
  resolveSecret,
  maskSecret,
  redactSecrets,
  SecretReferenceSchema,
  // Vault Providers
  EnvVaultProvider,
  registerVaultProvider,
  unregisterVaultProvider,
  getVaultProvider,
  getDefaultVaultProvider,
  clearVaultProviders,
  // Rate Limiting
  RateLimiter,
  RateLimitConfigSchema,
  getRateLimiter,
  destroyAllRateLimiters,
  // Audit Logging
  AuditLogger,
  InMemoryAuditStorage,
  AuditEntrySchema,
  getAuditLogger,
  resetAuditLogger,
  // Security Headers
  SecurityHeaders,
  CorsConfigSchema,
  getCorsHeaders,
  // Request Validation
  validateRequestHeaders,
  validateContentType,
  validateRequestSize,
  type SecretReference,
  type VaultProvider,
  type RateLimitConfig,
  type AuditAction,
  type AuditEntry,
  type AuditStorage,
  type CorsConfig,
} from "./security.js";

// Metrics
export {
  Counter,
  Gauge,
  Histogram,
  MetricsRegistry,
  MetricsConfigSchema,
  getMetricsRegistry,
  resetMetricsRegistry,
  createStandardMetrics,
  collectProcessMetrics,
  type MetricType,
  type MetricLabels,
  type MetricValue,
  type MetricDefinition,
  type MetricsConfig,
} from "./metrics.js";

// Tracing
export {
  Span,
  Tracer,
  TracingConfigSchema,
  getTracer,
  resetTracer,
  parseTraceParent,
  generateTraceParent,
  extractTraceContext,
  injectTraceContext,
  TRACE_PARENT_HEADER,
  TRACE_STATE_HEADER,
  type SpanContext,
  type SpanData,
  type SpanEvent,
  type TracingConfig,
} from "./tracing.js";

// Scheduler
export {
  Scheduler,
  JobConfigSchema,
  getScheduler,
  resetScheduler,
  createScheduler,
  type JobConfig,
  type JobHandler,
  type Job,
  type JobStatus,
  type JobExecutionResult,
  type JobEventListener,
  type SchedulerConfig,
} from "./scheduler.js";

// Version
export const VERSION = "0.1.0";

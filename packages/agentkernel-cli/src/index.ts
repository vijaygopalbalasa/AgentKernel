// OpenClaw Security Wrapper — intercepts all tool calls and enforces policies
// Sits between OpenClaw Gateway and actual tool execution

export {
  OpenClawSecurityProxy,
  createOpenClawProxy,
  type OpenClawProxyConfig,
  type OpenClawProxyStats,
} from "./proxy.js";

export {
  ToolInterceptor,
  createToolInterceptor,
  type ToolCall,
  type ToolResult,
  type InterceptorConfig,
} from "./interceptor.js";

export {
  OpenClawAuditLogger,
  createOpenClawAuditLogger,
  type OpenClawAuditEvent,
  type OpenClawAuditSink,
  ConsoleOpenClawAuditSink,
  MemoryOpenClawAuditSink,
  FileOpenClawAuditSink,
} from "./audit.js";

export {
  DEFAULT_OPENCLAW_POLICY,
  getDefaultOpenClawPolicy,
  mergeWithDefaultPolicy,
  MALICIOUS_EXFIL_DOMAINS,
  SENSITIVE_FILE_PATTERNS,
  DANGEROUS_SHELL_PATTERNS,
  CLOUD_METADATA_HOSTS,
  APPROVAL_REQUIRED_COMMANDS,
} from "./default-policy.js";

export { loadOpenClawProxyConfigFromEnv } from "./config.js";

export {
  resolveTarget,
  resolveTypedTarget,
  loadSimplifiedPolicy,
  saveSimplifiedPolicy,
  simplifiedToRuntimeFormat,
  addAllowRule,
  addBlockRule,
  removeRules,
  summarizePolicy,
  testPolicy,
  generatePolicyFromTemplate,
  type PolicyTemplate,
  type ResolvedTarget,
  type SimplifiedPolicyYaml,
  type PolicySummary,
  type TestResult,
  type InitOptions,
} from "./policy-manager.js";

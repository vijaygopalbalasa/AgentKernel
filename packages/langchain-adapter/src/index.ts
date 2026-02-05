// @agentkernel/langchain-adapter — LangChain integration for AgentKernel
// Intercepts tool calls with PolicyEngine for secure agent execution

// Interceptor (core functionality)
export {
  LangChainToolInterceptor,
  PolicyBlockedError,
  createToolInterceptor,
  createStrictToolInterceptor,
  type LangChainInterceptorConfig,
  type SecurityEvent,
  type PolicyCategory,
  type WrappedToolResult,
} from "./interceptor.js";

// Wrappers (high-level API)
export {
  secureTools,
  secureTool,
  createToolSecurityWrapper,
  createAllowlistPolicy,
  createBlocklistPolicy,
  type SecureAgentConfig,
  type SecuredToolsResult,
} from "./wrapper.js";

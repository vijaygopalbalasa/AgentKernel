// High-level wrappers for LangChain agents and executors
// Provides easy integration with AgentKernel security policies

import type { PolicySet } from "@agentkernel/runtime";
import type { StructuredTool } from "@langchain/core/tools";
import {
  type LangChainInterceptorConfig,
  type LangChainToolInterceptor,
  type SecurityEvent,
  createToolInterceptor,
} from "./interceptor.js";

// ─── TYPES ────────────────────────────────────────────────────────────

/** Configuration for securing an agent or tool set */
export interface SecureAgentConfig {
  /** Policy set for security enforcement */
  policySet?: Partial<PolicySet>;
  /** Agent ID for audit logging */
  agentId?: string;
  /** Callback for approval requests */
  onApprovalRequest?: (tool: string, args: Record<string, unknown>) => Promise<boolean>;
  /** Callback for security events */
  onSecurityEvent?: (event: SecurityEvent) => void;
  /** Enable verbose logging of all security decisions */
  verbose?: boolean;
}

/** Result of securing tools */
export interface SecuredToolsResult<T extends StructuredTool> {
  /** The secured tools */
  tools: T[];
  /** The interceptor used for policy enforcement */
  interceptor: LangChainToolInterceptor;
  /** Get security event history (if verbose mode is enabled) */
  getSecurityEvents?: () => SecurityEvent[];
}

// ─── TOOL WRAPPER FUNCTIONS ───────────────────────────────────────────

/**
 * Secure a set of LangChain tools with AgentKernel policy enforcement.
 *
 * @param tools - Array of LangChain StructuredTools to secure
 * @param config - Security configuration
 * @returns Secured tools and interceptor
 *
 * @example
 * ```typescript
 * import { secureTools } from "@agentkernel/langchain-adapter";
 * import { loadPolicySetFromFile } from "@agentkernel/runtime";
 *
 * const policy = loadPolicySetFromFile("./policy.yaml");
 * const { tools: securedTools } = secureTools(myTools, {
 *   policySet: policy,
 *   agentId: "my-agent",
 *   onSecurityEvent: (event) => {
 *     if (event.type === "blocked") {
 *       console.warn(`Blocked: ${event.tool}`);
 *     }
 *   },
 * });
 *
 * // Use securedTools with LangChain
 * const agent = createReactAgent({ llm, tools: securedTools });
 * ```
 */
export function secureTools<T extends StructuredTool>(
  tools: T[],
  config: SecureAgentConfig = {},
): SecuredToolsResult<T> {
  const securityEvents: SecurityEvent[] = [];

  const interceptorConfig: LangChainInterceptorConfig = {
    policySet: config.policySet,
    agentId: config.agentId,
    onApprovalRequest: config.onApprovalRequest,
    onSecurityEvent: (event) => {
      if (config.verbose) {
        securityEvents.push(event);
        logSecurityEvent(event);
      }
      config.onSecurityEvent?.(event);
    },
  };

  const interceptor = createToolInterceptor(interceptorConfig);
  const securedTools = interceptor.wrapTools(tools);

  return {
    tools: securedTools,
    interceptor,
    getSecurityEvents: config.verbose ? () => [...securityEvents] : undefined,
  };
}

/**
 * Secure a single LangChain tool with AgentKernel policy enforcement.
 *
 * @param tool - The LangChain StructuredTool to secure
 * @param config - Security configuration
 * @returns The secured tool
 *
 * @example
 * ```typescript
 * const securedReadFile = secureTool(readFileTool, {
 *   policySet: policy,
 *   agentId: "file-reader",
 * });
 * ```
 */
export function secureTool<T extends StructuredTool>(tool: T, config: SecureAgentConfig = {}): T {
  const { tools } = secureTools([tool], config);
  return tools[0]!;
}

/**
 * Create a tool security wrapper function that can be applied to tools later.
 *
 * @param config - Security configuration
 * @returns A function that secures tools
 *
 * @example
 * ```typescript
 * const makeSecure = createToolSecurityWrapper({
 *   policySet: policy,
 *   agentId: "my-agent",
 * });
 *
 * const securedTool1 = makeSecure(tool1);
 * const securedTool2 = makeSecure(tool2);
 * ```
 */
export function createToolSecurityWrapper(
  config: SecureAgentConfig = {},
): <T extends StructuredTool>(tool: T) => T {
  const { interceptor } = secureTools([], config);
  return <T extends StructuredTool>(tool: T) => interceptor.wrapTool(tool);
}

// ─── HELPER FUNCTIONS ─────────────────────────────────────────────────

/** Log a security event to console with color coding */
function logSecurityEvent(event: SecurityEvent): void {
  const timestamp = event.timestamp.toISOString();
  const tool = event.tool;
  const type = event.type;
  const reason = event.reason ?? "";

  switch (type) {
    case "allowed":
      console.log(`[${timestamp}] ✅ ALLOWED: ${tool} - ${reason}`);
      break;
    case "blocked":
      console.log(`[${timestamp}] ❌ BLOCKED: ${tool} - ${reason}`);
      break;
    case "approval_required":
      console.log(`[${timestamp}] ⚠️ APPROVED: ${tool} - ${reason}`);
      break;
    case "approval_denied":
      console.log(`[${timestamp}] 🚫 DENIED: ${tool} - ${reason}`);
      break;
  }
}

// ─── POLICY HELPER FUNCTIONS ──────────────────────────────────────────

/**
 * Create a simple policy that allows specific tools.
 *
 * @param allowedTools - List of tool names to allow
 * @returns A policy set that allows only the specified tools
 *
 * @example
 * ```typescript
 * const policy = createAllowlistPolicy(["read_file", "web_search"]);
 * const { tools } = secureTools(myTools, { policySet: policy });
 * ```
 */
export function createAllowlistPolicy(allowedTools: string[]): Partial<PolicySet> {
  // Create shell rules to block/allow specific tools
  const allowRules = allowedTools.map((tool, index) => ({
    id: `allow-${tool}-${index}`,
    type: "shell" as const,
    decision: "allow" as const,
    priority: 100,
    enabled: true,
    commandPatterns: [tool, `*${tool}*`],
  }));

  return {
    name: "allowlist-policy",
    defaultDecision: "block",
    shellRules: allowRules,
  };
}

/**
 * Create a simple policy that blocks specific tools.
 *
 * @param blockedTools - List of tool names to block
 * @returns A policy set that blocks the specified tools
 *
 * @example
 * ```typescript
 * const policy = createBlocklistPolicy(["delete_file", "shell"]);
 * const { tools } = secureTools(myTools, { policySet: policy });
 * ```
 */
export function createBlocklistPolicy(blockedTools: string[]): Partial<PolicySet> {
  const blockRules = blockedTools.map((tool, index) => ({
    id: `block-${tool}-${index}`,
    type: "shell" as const,
    decision: "block" as const,
    priority: 100,
    enabled: true,
    commandPatterns: [tool, `*${tool}*`],
  }));

  return {
    name: "blocklist-policy",
    defaultDecision: "allow",
    shellRules: blockRules,
  };
}

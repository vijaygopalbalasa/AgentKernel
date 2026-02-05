// LangChain Tool Interceptor — Apply PolicyEngine to LangChain tool calls
// Wraps StructuredTool to enforce allow/block/approve policies

import {
  type AgentId,
  type FileEvalRequest,
  type NetworkEvalRequest,
  type PolicyDecision,
  type PolicyEngine,
  type PolicyEvalRequest,
  type PolicyEvaluation,
  type PolicySet,
  type SecretEvalRequest,
  type ShellEvalRequest,
  createPolicyEngine,
  createStrictPolicyEngine,
} from "@agentkernel/runtime";
import type { StructuredTool } from "@langchain/core/tools";

// ─── TYPES ────────────────────────────────────────────────────────────

/** Configuration for the LangChain tool interceptor */
export interface LangChainInterceptorConfig {
  /** Policy set for security enforcement */
  policySet?: Partial<PolicySet>;
  /** Agent ID for audit logging */
  agentId?: string;
  /** Pre-configured policy engine (takes precedence over policySet) */
  policyEngine?: PolicyEngine;
  /** Callback for approval requests */
  onApprovalRequest?: (tool: string, args: Record<string, unknown>) => Promise<boolean>;
  /** Callback for security events */
  onSecurityEvent?: (event: SecurityEvent) => void;
  /** Tool name to policy category mapping overrides */
  toolCategoryOverrides?: Record<string, PolicyCategory>;
}

/** Security event emitted during tool interception */
export interface SecurityEvent {
  type: "allowed" | "blocked" | "approval_required" | "approval_denied";
  tool: string;
  args: Record<string, unknown>;
  decision: PolicyDecision;
  reason?: string;
  timestamp: Date;
}

/** Policy categories that tools can be mapped to */
export type PolicyCategory = "file" | "network" | "shell" | "secret" | "generic";

/** Result of wrapping a tool */
export interface WrappedToolResult<T extends StructuredTool> {
  tool: T;
  originalTool: T;
}

// ─── TOOL CATEGORY MAPPING ─────────────────────────────────────────────

/** Default mapping of tool names to policy categories */
const DEFAULT_TOOL_CATEGORY_MAP: Record<string, PolicyCategory> = {
  // File operations
  read_file: "file",
  write_file: "file",
  list_directory: "file",
  delete_file: "file",
  move_file: "file",
  copy_file: "file",
  create_directory: "file",
  file_reader: "file",
  file_writer: "file",
  fs_read: "file",
  fs_write: "file",

  // Network operations
  http_request: "network",
  fetch: "network",
  api_call: "network",
  web_request: "network",
  browser: "network",
  web_browser: "network",
  request: "network",

  // Shell operations
  shell: "shell",
  bash: "shell",
  terminal: "shell",
  run_command: "shell",
  execute: "shell",
  exec: "shell",
  subprocess: "shell",

  // Secret operations
  get_secret: "secret",
  set_secret: "secret",
  env_var: "secret",
  credential: "secret",
  api_key: "secret",
};

/** Determine policy category for a tool */
function getToolCategory(
  toolName: string,
  overrides?: Record<string, PolicyCategory>,
): PolicyCategory {
  const normalizedName = toolName.toLowerCase().replace(/[-_\s]/g, "_");

  // Check overrides first
  if (overrides?.[normalizedName]) {
    return overrides[normalizedName];
  }

  // Check default mappings
  for (const [pattern, category] of Object.entries(DEFAULT_TOOL_CATEGORY_MAP)) {
    if (normalizedName.includes(pattern) || pattern.includes(normalizedName)) {
      return category;
    }
  }

  return "generic";
}

// ─── INTERCEPTOR ──────────────────────────────────────────────────────

/**
 * LangChain Tool Interceptor
 *
 * Wraps LangChain tools to enforce security policies before execution.
 *
 * @example
 * ```typescript
 * const interceptor = new LangChainToolInterceptor({
 *   policySet: myPolicySet,
 *   agentId: "my-agent",
 *   onSecurityEvent: (event) => console.log(event),
 * });
 *
 * const securedTool = interceptor.wrapTool(myTool);
 * const securedTools = interceptor.wrapTools([tool1, tool2, tool3]);
 * ```
 */
export class LangChainToolInterceptor {
  private readonly policyEngine: PolicyEngine;
  private readonly agentId: AgentId;
  private readonly onApprovalRequest?: (
    tool: string,
    args: Record<string, unknown>,
  ) => Promise<boolean>;
  private readonly onSecurityEvent?: (event: SecurityEvent) => void;
  private readonly toolCategoryOverrides?: Record<string, PolicyCategory>;

  constructor(config: LangChainInterceptorConfig = {}) {
    this.policyEngine =
      config.policyEngine ??
      (config.policySet
        ? createPolicyEngine(config.policySet)
        : createPolicyEngine({ defaultDecision: "allow" }));
    this.agentId = (config.agentId ?? "langchain-agent") as AgentId;
    this.onApprovalRequest = config.onApprovalRequest;
    this.onSecurityEvent = config.onSecurityEvent;
    this.toolCategoryOverrides = config.toolCategoryOverrides;
  }

  /**
   * Wrap a single LangChain tool with policy enforcement.
   *
   * @param tool - The LangChain StructuredTool to wrap
   * @returns A new tool with security policies applied
   */
  wrapTool<T extends StructuredTool>(tool: T): T {
    const interceptor = this;
    // Use type assertion to access _call - this is necessary for tool interception
    // We need to bypass TypeScript's protected member check with unknown cast
    const toolAny = tool as unknown as {
      _call: (args: unknown, runManager?: unknown) => Promise<string>;
    };
    const originalCall = toolAny._call.bind(tool);

    // Create a wrapped version that intercepts calls
    const wrappedCall = async function (
      this: T,
      args: Record<string, unknown>,
      runManager?: unknown,
    ): Promise<string> {
      const toolName = tool.name;
      const toolArgs = args as Record<string, unknown>;

      // Evaluate policy
      const evaluation = await interceptor.evaluatePolicy(toolName, toolArgs);

      // Handle decision
      if (evaluation.decision === "block") {
        const event: SecurityEvent = {
          type: "blocked",
          tool: toolName,
          args: toolArgs,
          decision: "block",
          reason: evaluation.reason,
          timestamp: new Date(),
        };
        interceptor.onSecurityEvent?.(event);
        throw new PolicyBlockedError(
          `Tool '${toolName}' blocked by security policy: ${evaluation.reason ?? "Access denied"}`,
        );
      }

      if (evaluation.decision === "approve") {
        // Request approval
        if (!interceptor.onApprovalRequest) {
          const event: SecurityEvent = {
            type: "approval_denied",
            tool: toolName,
            args: toolArgs,
            decision: "approve",
            reason: "No approval handler configured",
            timestamp: new Date(),
          };
          interceptor.onSecurityEvent?.(event);
          throw new PolicyBlockedError(
            `Tool '${toolName}' requires approval but no approval handler is configured`,
          );
        }

        const approved = await interceptor.onApprovalRequest(toolName, toolArgs);
        if (!approved) {
          const event: SecurityEvent = {
            type: "approval_denied",
            tool: toolName,
            args: toolArgs,
            decision: "approve",
            reason: "Approval denied by user",
            timestamp: new Date(),
          };
          interceptor.onSecurityEvent?.(event);
          throw new PolicyBlockedError(`Tool '${toolName}' execution denied: approval not granted`);
        }

        const event: SecurityEvent = {
          type: "approval_required",
          tool: toolName,
          args: toolArgs,
          decision: "approve",
          reason: "Approved by user",
          timestamp: new Date(),
        };
        interceptor.onSecurityEvent?.(event);
      } else {
        // Allowed
        const event: SecurityEvent = {
          type: "allowed",
          tool: toolName,
          args: toolArgs,
          decision: "allow",
          reason: evaluation.reason,
          timestamp: new Date(),
        };
        interceptor.onSecurityEvent?.(event);
      }

      // Execute original tool
      return originalCall(args, runManager as never);
    };

    // Replace the _call method using type assertion
    // We need to bypass TypeScript's protected member check with unknown cast
    (tool as unknown as { _call: typeof wrappedCall })._call = wrappedCall;

    return tool;
  }

  /**
   * Wrap multiple LangChain tools with policy enforcement.
   *
   * @param tools - Array of LangChain StructuredTools to wrap
   * @returns Array of wrapped tools with security policies applied
   */
  wrapTools<T extends StructuredTool>(tools: T[]): T[] {
    return tools.map((tool) => this.wrapTool(tool));
  }

  /**
   * Evaluate policy for a tool call.
   *
   * @param toolName - Name of the tool
   * @param args - Tool arguments
   * @returns Policy evaluation result
   */
  private async evaluatePolicy(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<PolicyEvaluation> {
    const category = getToolCategory(toolName, this.toolCategoryOverrides);

    // Build request based on category
    let request: PolicyEvalRequest;

    switch (category) {
      case "file": {
        const path = this.extractPath(args);
        const operation = this.extractFileOperation(toolName);
        request = {
          type: "file",
          path: path ?? "*",
          operation,
          agentId: this.agentId,
        } satisfies FileEvalRequest;
        break;
      }

      case "network": {
        const url = this.extractUrl(args);
        if (url) {
          try {
            const parsed = new URL(url);
            request = {
              type: "network",
              host: parsed.hostname,
              port: parsed.port ? Number.parseInt(parsed.port, 10) : undefined,
              protocol: parsed.protocol.replace(":", "") as "http" | "https",
              agentId: this.agentId,
            } satisfies NetworkEvalRequest;
          } catch {
            // Invalid URL - use wildcard host
            request = {
              type: "network",
              host: "*",
              agentId: this.agentId,
            } satisfies NetworkEvalRequest;
          }
        } else {
          request = {
            type: "network",
            host: "*",
            agentId: this.agentId,
          } satisfies NetworkEvalRequest;
        }
        break;
      }

      case "shell": {
        const command = this.extractCommand(args);
        request = {
          type: "shell",
          command: command ?? "",
          args: [],
          agentId: this.agentId,
        } satisfies ShellEvalRequest;
        break;
      }

      case "secret": {
        const name = this.extractSecretName(args);
        request = {
          type: "secret",
          name: name ?? "*",
          agentId: this.agentId,
        } satisfies SecretEvalRequest;
        break;
      }

      default:
        // Generic tools - evaluate as shell command with tool name
        request = {
          type: "shell",
          command: toolName,
          args: [],
          agentId: this.agentId,
        } satisfies ShellEvalRequest;
    }

    return this.policyEngine.evaluate(request);
  }

  /** Extract file path from args */
  private extractPath(args: Record<string, unknown>): string | undefined {
    return (
      (args.path as string) ??
      (args.file_path as string) ??
      (args.filePath as string) ??
      (args.file as string) ??
      (args.filename as string)
    );
  }

  /** Extract URL from args */
  private extractUrl(args: Record<string, unknown>): string | undefined {
    return (
      (args.url as string) ??
      (args.uri as string) ??
      (args.endpoint as string) ??
      (args.target as string)
    );
  }

  /** Extract command from args */
  private extractCommand(args: Record<string, unknown>): string | undefined {
    return (
      (args.command as string) ??
      (args.cmd as string) ??
      (args.script as string) ??
      (args.shell_command as string)
    );
  }

  /** Extract secret name from args */
  private extractSecretName(args: Record<string, unknown>): string | undefined {
    return (
      (args.name as string) ??
      (args.key as string) ??
      (args.secret_name as string) ??
      (args.variable as string)
    );
  }

  /** Determine file operation from tool name */
  private extractFileOperation(toolName: string): "read" | "write" | "delete" | "list" {
    const name = toolName.toLowerCase();
    if (name.includes("read") || name.includes("get") || name.includes("load")) {
      return "read";
    }
    if (name.includes("write") || name.includes("save") || name.includes("create")) {
      return "write";
    }
    if (name.includes("delete") || name.includes("remove")) {
      return "delete";
    }
    if (name.includes("list") || name.includes("dir")) {
      return "list";
    }
    return "read"; // Default to read
  }
}

// ─── ERROR CLASSES ─────────────────────────────────────────────────────

/**
 * Error thrown when a tool call is blocked by policy.
 */
export class PolicyBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyBlockedError";
  }
}

// ─── FACTORY FUNCTIONS ─────────────────────────────────────────────────

/**
 * Create a tool interceptor with the given configuration.
 *
 * @param config - Interceptor configuration
 * @returns A configured LangChainToolInterceptor
 */
export function createToolInterceptor(
  config: LangChainInterceptorConfig = {},
): LangChainToolInterceptor {
  return new LangChainToolInterceptor(config);
}

/**
 * Create a strict tool interceptor that blocks by default.
 *
 * @param config - Optional configuration overrides
 * @returns A strict LangChainToolInterceptor
 */
export function createStrictToolInterceptor(
  config: Omit<LangChainInterceptorConfig, "policyEngine"> = {},
): LangChainToolInterceptor {
  return new LangChainToolInterceptor({
    ...config,
    policyEngine: createStrictPolicyEngine(),
  });
}

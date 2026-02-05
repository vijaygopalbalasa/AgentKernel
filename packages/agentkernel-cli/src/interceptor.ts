// Tool Interceptor — intercepts OpenClaw tool calls and enforces policies

import {
  type PolicyEngine,
  type PolicyEvaluation,
  type PolicySet,
  createPolicyEngine,
} from "@agentkernel/runtime";
import { z } from "zod";

// ─── TOOL CALL SCHEMAS ─────────────────────────────────────────

/** OpenClaw tool call structure */
export const ToolCallSchema = z.object({
  /** Tool name (e.g., "bash", "read", "write", "browser") */
  tool: z.string().min(1),
  /** Tool arguments */
  args: z.record(z.unknown()).optional(),
  /** Session ID */
  sessionId: z.string().optional(),
  /** Timestamp */
  timestamp: z.date().optional(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

/** Tool execution result */
export const ToolResultSchema = z.object({
  /** Whether execution was allowed */
  allowed: z.boolean(),
  /** Result if allowed and executed */
  result: z.unknown().optional(),
  /** Error message if blocked or failed */
  error: z.string().optional(),
  /** Policy evaluation details */
  evaluation: z
    .object({
      decision: z.enum(["allow", "block", "approve"]),
      reason: z.string(),
      matchedRule: z.unknown().optional(),
    })
    .optional(),
  /** Execution time in ms */
  executionTimeMs: z.number().optional(),
});
export type ToolResult = z.infer<typeof ToolResultSchema>;

/** Interceptor configuration */
export interface InterceptorConfig {
  /** Policy set to use */
  policySet?: Partial<PolicySet>;
  /** Agent ID for audit logging */
  agentId: string;
  /** Whether to log all tool calls */
  logAllCalls?: boolean;
  /** Callback for approval requests */
  onApprovalRequest?: (call: ToolCall, evaluation: PolicyEvaluation) => Promise<boolean>;
  /** Callback for blocked calls */
  onBlocked?: (call: ToolCall, evaluation: PolicyEvaluation) => void;
  /** Callback for allowed calls */
  onAllowed?: (call: ToolCall, evaluation: PolicyEvaluation) => void;
}

// ─── TOOL MAPPINGS ─────────────────────────────────────────────

/** Map OpenClaw tools to policy categories */
const TOOL_CATEGORY_MAP: Record<string, "file" | "network" | "shell" | "secret"> = {
  // File operations
  read: "file",
  write: "file",
  edit: "file",
  glob: "file",
  grep: "file",
  ls: "file",

  // Shell operations
  bash: "shell",
  process: "shell",
  terminal: "shell",

  // Network operations
  browser: "network",
  fetch: "network",
  curl: "network",
  http: "network",
  websocket: "network",

  // Secret operations
  env: "secret",
  secrets: "secret",
  credentials: "secret",
};

/** Extract file path from tool args */
function extractFilePath(tool: string, args: Record<string, unknown>): string | undefined {
  // Common path argument names
  const pathKeys = [
    "path",
    "file",
    "filepath",
    "file_path",
    "filename",
    "target",
    "source",
    "dest",
  ];

  for (const key of pathKeys) {
    if (typeof args[key] === "string") {
      return args[key] as string;
    }
  }

  // For read/write/edit tools, first positional arg is often the path
  if (["read", "write", "edit"].includes(tool) && typeof args[0] === "string") {
    return args[0] as string;
  }

  return undefined;
}

/** Extract host from network tool args */
function extractHost(tool: string, args: Record<string, unknown>): string | undefined {
  const urlKeys = ["url", "host", "hostname", "endpoint", "uri"];

  for (const key of urlKeys) {
    if (typeof args[key] === "string") {
      try {
        const url = new URL(args[key] as string);
        return url.hostname;
      } catch {
        return args[key] as string;
      }
    }
  }

  return undefined;
}

/** Extract command from shell tool args */
function extractCommand(
  tool: string,
  args: Record<string, unknown>,
): { command: string; shellArgs?: string[] } | undefined {
  const commandKeys = ["command", "cmd", "script", "exec"];

  for (const key of commandKeys) {
    if (typeof args[key] === "string") {
      const parts = (args[key] as string).split(" ");
      return {
        command: parts[0] ?? "",
        shellArgs: parts.slice(1),
      };
    }
  }

  // For bash tool, the command might be in args directly
  if (tool === "bash" && typeof args.command === "string") {
    const parts = args.command.split(" ");
    return {
      command: parts[0] ?? "",
      shellArgs: parts.slice(1),
    };
  }

  return undefined;
}

/** Extract secret name from tool args */
function extractSecretName(tool: string, args: Record<string, unknown>): string | undefined {
  const nameKeys = ["name", "key", "secret", "variable", "env_var"];

  for (const key of nameKeys) {
    if (typeof args[key] === "string") {
      return args[key] as string;
    }
  }

  return undefined;
}

// ─── TOOL INTERCEPTOR ──────────────────────────────────────────

/**
 * Tool Interceptor — evaluates OpenClaw tool calls against security policies.
 *
 * Features:
 * - Intercepts all OpenClaw tool calls (bash, read, write, browser, etc.)
 * - Routes to appropriate policy category
 * - Supports approval workflow for sensitive operations
 * - Full audit logging
 */
export class ToolInterceptor {
  private readonly policyEngine: PolicyEngine;
  private readonly config: InterceptorConfig;
  private callCount = 0;
  private blockedCount = 0;
  private allowedCount = 0;
  private approvalCount = 0;

  constructor(config: InterceptorConfig) {
    this.config = config;
    this.policyEngine = createPolicyEngine(config.policySet);
  }

  /**
   * Intercept a tool call and evaluate against policies.
   */
  async intercept(call: ToolCall): Promise<ToolResult> {
    this.callCount++;
    const startTime = Date.now();

    // Determine policy category
    const category = TOOL_CATEGORY_MAP[call.tool] ?? "shell"; // Default to shell (most restrictive)
    const args = call.args ?? {};

    let evaluation: PolicyEvaluation;

    switch (category) {
      case "file": {
        const path = extractFilePath(call.tool, args);
        if (!path) {
          // No path found - use default policy
          evaluation = {
            decision: "block",
            reason: `Cannot determine file path for tool "${call.tool}"`,
            timestamp: new Date(),
          };
        } else {
          const operation = this.mapToolToFileOperation(call.tool);
          evaluation = this.policyEngine.evaluate({
            type: "file",
            path,
            operation,
            agentId: this.config.agentId,
          });
        }
        break;
      }

      case "network": {
        const host = extractHost(call.tool, args);
        if (!host) {
          evaluation = {
            decision: "block",
            reason: `Cannot determine host for tool "${call.tool}"`,
            timestamp: new Date(),
          };
        } else {
          evaluation = this.policyEngine.evaluate({
            type: "network",
            host,
            agentId: this.config.agentId,
          });
        }
        break;
      }

      case "shell": {
        const cmdInfo = extractCommand(call.tool, args);
        if (!cmdInfo) {
          evaluation = {
            decision: "block",
            reason: `Cannot determine command for tool "${call.tool}"`,
            timestamp: new Date(),
          };
        } else {
          evaluation = this.policyEngine.evaluate({
            type: "shell",
            command: cmdInfo.command,
            args: cmdInfo.shellArgs,
            agentId: this.config.agentId,
          });
        }
        break;
      }

      case "secret": {
        const name = extractSecretName(call.tool, args);
        if (!name) {
          evaluation = {
            decision: "block",
            reason: `Cannot determine secret name for tool "${call.tool}"`,
            timestamp: new Date(),
          };
        } else {
          evaluation = this.policyEngine.evaluate({
            type: "secret",
            name,
            agentId: this.config.agentId,
          });
        }
        break;
      }

      default:
        evaluation = {
          decision: "block",
          reason: `Unknown tool category for "${call.tool}"`,
          timestamp: new Date(),
        };
    }

    // Handle decision
    const executionTimeMs = Date.now() - startTime;

    switch (evaluation.decision) {
      case "allow":
        this.allowedCount++;
        this.config.onAllowed?.(call, evaluation);
        return {
          allowed: true,
          evaluation: {
            decision: evaluation.decision,
            reason: evaluation.reason,
            matchedRule: evaluation.matchedRule,
          },
          executionTimeMs,
        };

      case "block":
        this.blockedCount++;
        this.config.onBlocked?.(call, evaluation);
        return {
          allowed: false,
          error: `Blocked by security policy: ${evaluation.reason}`,
          evaluation: {
            decision: evaluation.decision,
            reason: evaluation.reason,
            matchedRule: evaluation.matchedRule,
          },
          executionTimeMs,
        };

      case "approve":
        this.approvalCount++;
        // Request approval if callback provided
        if (this.config.onApprovalRequest) {
          const approved = await this.config.onApprovalRequest(call, evaluation);
          if (approved) {
            this.allowedCount++;
            return {
              allowed: true,
              evaluation: {
                decision: "allow",
                reason: `Approved by user: ${evaluation.reason}`,
                matchedRule: evaluation.matchedRule,
              },
              executionTimeMs: Date.now() - startTime,
            };
          }
        }
        // Not approved or no callback
        this.blockedCount++;
        return {
          allowed: false,
          error: `Requires approval: ${evaluation.reason}`,
          evaluation: {
            decision: evaluation.decision,
            reason: evaluation.reason,
            matchedRule: evaluation.matchedRule,
          },
          executionTimeMs,
        };
    }
  }

  /**
   * Get interceptor statistics.
   */
  getStats(): {
    totalCalls: number;
    allowedCalls: number;
    blockedCalls: number;
    approvalRequests: number;
  } {
    return {
      totalCalls: this.callCount,
      allowedCalls: this.allowedCount,
      blockedCalls: this.blockedCount,
      approvalRequests: this.approvalCount,
    };
  }

  /**
   * Get policy audit log.
   */
  getAuditLog() {
    return this.policyEngine.getAuditLog();
  }

  /**
   * Reset statistics.
   */
  resetStats(): void {
    this.callCount = 0;
    this.blockedCount = 0;
    this.allowedCount = 0;
    this.approvalCount = 0;
  }

  private mapToolToFileOperation(tool: string): "read" | "write" | "delete" | "list" {
    switch (tool) {
      case "read":
      case "grep":
        return "read";
      case "write":
      case "edit":
        return "write";
      case "rm":
      case "delete":
        return "delete";
      case "ls":
      case "glob":
        return "list";
      default:
        return "read";
    }
  }
}

/**
 * Create a tool interceptor with the given configuration.
 */
export function createToolInterceptor(config: InterceptorConfig): ToolInterceptor {
  return new ToolInterceptor(config);
}

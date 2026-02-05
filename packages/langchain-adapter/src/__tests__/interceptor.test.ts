import type { PolicySet } from "@agentkernel/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  type LangChainInterceptorConfig,
  LangChainToolInterceptor,
  PolicyBlockedError,
  type SecurityEvent,
  createStrictToolInterceptor,
  createToolInterceptor,
} from "../interceptor.js";

// Mock StructuredTool for testing
class MockStructuredTool {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  _call: (args: Record<string, unknown>) => Promise<string>;

  constructor(
    name: string,
    description: string,
    schema: z.ZodObject<z.ZodRawShape>,
    call: (args: Record<string, unknown>) => Promise<string>,
  ) {
    this.name = name;
    this.description = description;
    this.schema = schema;
    this._call = call;
  }
}

function createMockTool(name: string, returnValue = "success"): MockStructuredTool {
  return new MockStructuredTool(
    name,
    `A mock ${name} tool`,
    z.object({ input: z.string().optional() }),
    vi.fn().mockResolvedValue(returnValue),
  );
}

describe("LangChainToolInterceptor", () => {
  describe("constructor", () => {
    it("should create interceptor with default settings", () => {
      const interceptor = new LangChainToolInterceptor();
      expect(interceptor).toBeDefined();
    });

    it("should create interceptor with custom policy set", () => {
      const policySet: Partial<PolicySet> = {
        name: "test-policy",
        defaultDecision: "block",
      };
      const interceptor = new LangChainToolInterceptor({ policySet });
      expect(interceptor).toBeDefined();
    });

    it("should create interceptor with custom agent ID", () => {
      const interceptor = new LangChainToolInterceptor({ agentId: "test-agent" });
      expect(interceptor).toBeDefined();
    });

    it("should accept approval request callback", () => {
      const onApprovalRequest = vi.fn().mockResolvedValue(true);
      const interceptor = new LangChainToolInterceptor({ onApprovalRequest });
      expect(interceptor).toBeDefined();
    });

    it("should accept security event callback", () => {
      const onSecurityEvent = vi.fn();
      const interceptor = new LangChainToolInterceptor({ onSecurityEvent });
      expect(interceptor).toBeDefined();
    });
  });

  describe("wrapTool", () => {
    it("should wrap a single tool", () => {
      const interceptor = new LangChainToolInterceptor();
      const tool = createMockTool("test_tool");
      const wrapped = interceptor.wrapTool(tool);

      expect(wrapped).toBeDefined();
      expect(wrapped.name).toBe("test_tool");
    });

    it("should allow generic tools by default", async () => {
      const securityEvents: SecurityEvent[] = [];
      const interceptor = new LangChainToolInterceptor({
        onSecurityEvent: (event) => securityEvents.push(event),
      });

      const tool = createMockTool("generic_tool");
      const wrapped = interceptor.wrapTool(tool);

      await wrapped._call({ input: "test" });

      expect(securityEvents).toHaveLength(1);
      expect(securityEvents[0].type).toBe("allowed");
    });

    it("should call original tool when allowed", async () => {
      const interceptor = new LangChainToolInterceptor({
        policySet: { defaultDecision: "allow" },
      });

      const tool = createMockTool("allowed_tool", "result");
      const originalCall = tool._call;
      const wrapped = interceptor.wrapTool(tool);

      const result = await wrapped._call({ input: "test" });

      expect(result).toBe("result");
    });
  });

  describe("wrapTools", () => {
    it("should wrap multiple tools", () => {
      const interceptor = new LangChainToolInterceptor();
      const tools = [createMockTool("tool1"), createMockTool("tool2"), createMockTool("tool3")];

      const wrapped = interceptor.wrapTools(tools);

      expect(wrapped).toHaveLength(3);
      expect(wrapped[0].name).toBe("tool1");
      expect(wrapped[1].name).toBe("tool2");
      expect(wrapped[2].name).toBe("tool3");
    });

    it("should apply policies to all wrapped tools", async () => {
      const securityEvents: SecurityEvent[] = [];
      const interceptor = new LangChainToolInterceptor({
        policySet: { defaultDecision: "allow" },
        onSecurityEvent: (event) => securityEvents.push(event),
      });

      const tools = [createMockTool("tool1"), createMockTool("tool2")];
      const wrapped = interceptor.wrapTools(tools);

      await wrapped[0]._call({});
      await wrapped[1]._call({});

      expect(securityEvents).toHaveLength(2);
    });
  });

  describe("policy enforcement", () => {
    it("should block tool when policy denies access", async () => {
      const policySet: Partial<PolicySet> = {
        defaultDecision: "block",
      };
      const interceptor = new LangChainToolInterceptor({ policySet });

      const tool = createMockTool("read_file");
      const wrapped = interceptor.wrapTool(tool);

      await expect(wrapped._call({ path: "/etc/passwd" })).rejects.toThrow(PolicyBlockedError);
    });

    it("should emit blocked event when tool is blocked", async () => {
      const securityEvents: SecurityEvent[] = [];
      const policySet: Partial<PolicySet> = {
        defaultDecision: "block",
      };
      const interceptor = new LangChainToolInterceptor({
        policySet,
        onSecurityEvent: (event) => securityEvents.push(event),
      });

      const tool = createMockTool("read_file");
      const wrapped = interceptor.wrapTool(tool);

      try {
        await wrapped._call({ path: "/secret" });
      } catch {
        // Expected
      }

      expect(securityEvents).toHaveLength(1);
      expect(securityEvents[0].type).toBe("blocked");
      expect(securityEvents[0].tool).toBe("read_file");
    });

    it("should allow file read when policy allows", async () => {
      const policySet: Partial<PolicySet> = {
        defaultDecision: "block",
        fileRules: [
          {
            id: "allow-workspace",
            type: "file",
            decision: "allow",
            priority: 100,
            enabled: true,
            pathPatterns: ["/workspace/**"],
            operations: ["read"],
          },
        ],
      };
      const interceptor = new LangChainToolInterceptor({ policySet });

      const tool = createMockTool("read_file", "file content");
      const wrapped = interceptor.wrapTool(tool);

      const result = await wrapped._call({ path: "/workspace/test.txt" });
      expect(result).toBe("file content");
    });

    it("should block dangerous shell commands", async () => {
      const policySet: Partial<PolicySet> = {
        defaultDecision: "allow",
        shellRules: [
          {
            id: "block-rm",
            type: "shell",
            decision: "block",
            priority: 100,
            enabled: true,
            commandPatterns: ["rm *", "rm -rf*"],
          },
        ],
      };
      const interceptor = new LangChainToolInterceptor({ policySet });

      const tool = createMockTool("shell");
      const wrapped = interceptor.wrapTool(tool);

      await expect(wrapped._call({ command: "rm -rf /" })).rejects.toThrow(PolicyBlockedError);
    });
  });

  describe("approval workflow", () => {
    it("should request approval when policy requires it", async () => {
      const onApprovalRequest = vi.fn().mockResolvedValue(true);
      const policySet: Partial<PolicySet> = {
        defaultDecision: "approve",
      };
      const interceptor = new LangChainToolInterceptor({
        policySet,
        onApprovalRequest,
      });

      const tool = createMockTool("sensitive_tool", "approved result");
      const wrapped = interceptor.wrapTool(tool);

      const result = await wrapped._call({});

      expect(onApprovalRequest).toHaveBeenCalledWith("sensitive_tool", {});
      expect(result).toBe("approved result");
    });

    it("should block when approval is denied", async () => {
      const onApprovalRequest = vi.fn().mockResolvedValue(false);
      const policySet: Partial<PolicySet> = {
        defaultDecision: "approve",
      };
      const interceptor = new LangChainToolInterceptor({
        policySet,
        onApprovalRequest,
      });

      const tool = createMockTool("sensitive_tool");
      const wrapped = interceptor.wrapTool(tool);

      await expect(wrapped._call({})).rejects.toThrow(PolicyBlockedError);
    });

    it("should block when no approval handler is configured", async () => {
      const policySet: Partial<PolicySet> = {
        defaultDecision: "approve",
      };
      const interceptor = new LangChainToolInterceptor({ policySet });

      const tool = createMockTool("sensitive_tool");
      const wrapped = interceptor.wrapTool(tool);

      await expect(wrapped._call({})).rejects.toThrow("requires approval but no approval handler");
    });

    it("should emit approval_required event when approved", async () => {
      const securityEvents: SecurityEvent[] = [];
      const onApprovalRequest = vi.fn().mockResolvedValue(true);
      const policySet: Partial<PolicySet> = {
        defaultDecision: "approve",
      };
      const interceptor = new LangChainToolInterceptor({
        policySet,
        onApprovalRequest,
        onSecurityEvent: (event) => securityEvents.push(event),
      });

      const tool = createMockTool("sensitive_tool");
      const wrapped = interceptor.wrapTool(tool);

      await wrapped._call({});

      expect(securityEvents).toHaveLength(1);
      expect(securityEvents[0].type).toBe("approval_required");
    });

    it("should emit approval_denied event when denied", async () => {
      const securityEvents: SecurityEvent[] = [];
      const onApprovalRequest = vi.fn().mockResolvedValue(false);
      const policySet: Partial<PolicySet> = {
        defaultDecision: "approve",
      };
      const interceptor = new LangChainToolInterceptor({
        policySet,
        onApprovalRequest,
        onSecurityEvent: (event) => securityEvents.push(event),
      });

      const tool = createMockTool("sensitive_tool");
      const wrapped = interceptor.wrapTool(tool);

      try {
        await wrapped._call({});
      } catch {
        // Expected
      }

      expect(securityEvents).toHaveLength(1);
      expect(securityEvents[0].type).toBe("approval_denied");
    });
  });

  describe("tool category mapping", () => {
    it("should categorize file tools correctly", async () => {
      const securityEvents: SecurityEvent[] = [];
      const policySet: Partial<PolicySet> = {
        defaultDecision: "block",
        fileRules: [
          {
            id: "allow-all",
            type: "file",
            decision: "allow",
            priority: 100,
            enabled: true,
            pathPatterns: ["**"],
            operations: ["read", "write", "delete", "list"],
          },
        ],
      };
      const interceptor = new LangChainToolInterceptor({
        policySet,
        onSecurityEvent: (event) => securityEvents.push(event),
      });

      const fileTools = [
        createMockTool("read_file"),
        createMockTool("write_file"),
        createMockTool("file_reader"),
      ];
      const wrapped = interceptor.wrapTools(fileTools);

      for (const tool of wrapped) {
        await tool._call({ path: "/test" });
      }

      expect(securityEvents.every((e) => e.type === "allowed")).toBe(true);
    });

    it("should categorize network tools correctly", async () => {
      const securityEvents: SecurityEvent[] = [];
      const policySet: Partial<PolicySet> = {
        defaultDecision: "block",
        networkRules: [
          {
            id: "allow-all",
            type: "network",
            decision: "allow",
            priority: 100,
            enabled: true,
            hostPatterns: ["**"],
          },
        ],
      };
      const interceptor = new LangChainToolInterceptor({
        policySet,
        onSecurityEvent: (event) => securityEvents.push(event),
      });

      const tool = createMockTool("http_request");
      const wrapped = interceptor.wrapTool(tool);

      await wrapped._call({ url: "https://example.com/api" });

      expect(securityEvents[0].type).toBe("allowed");
    });

    it("should use tool category overrides", async () => {
      const securityEvents: SecurityEvent[] = [];
      const policySet: Partial<PolicySet> = {
        defaultDecision: "block",
        fileRules: [
          {
            id: "allow-files",
            type: "file",
            decision: "allow",
            priority: 100,
            enabled: true,
            pathPatterns: ["**"],
            operations: ["read"],
          },
        ],
      };
      const interceptor = new LangChainToolInterceptor({
        policySet,
        toolCategoryOverrides: {
          custom_tool: "file",
        },
        onSecurityEvent: (event) => securityEvents.push(event),
      });

      const tool = createMockTool("custom_tool");
      const wrapped = interceptor.wrapTool(tool);

      await wrapped._call({ path: "/test" });

      expect(securityEvents[0].type).toBe("allowed");
    });
  });
});

describe("createToolInterceptor", () => {
  it("should create an interceptor", () => {
    const interceptor = createToolInterceptor();
    expect(interceptor).toBeInstanceOf(LangChainToolInterceptor);
  });

  it("should accept configuration", () => {
    const config: LangChainInterceptorConfig = {
      agentId: "test",
      policySet: { defaultDecision: "allow" },
    };
    const interceptor = createToolInterceptor(config);
    expect(interceptor).toBeInstanceOf(LangChainToolInterceptor);
  });
});

describe("createStrictToolInterceptor", () => {
  it("should create a strict interceptor", () => {
    const interceptor = createStrictToolInterceptor();
    expect(interceptor).toBeInstanceOf(LangChainToolInterceptor);
  });

  it("should block by default", async () => {
    const interceptor = createStrictToolInterceptor();
    const tool = createMockTool("any_tool");
    const wrapped = interceptor.wrapTool(tool);

    await expect(wrapped._call({})).rejects.toThrow(PolicyBlockedError);
  });
});

describe("PolicyBlockedError", () => {
  it("should have correct name", () => {
    const error = new PolicyBlockedError("test message");
    expect(error.name).toBe("PolicyBlockedError");
  });

  it("should have correct message", () => {
    const error = new PolicyBlockedError("Tool blocked");
    expect(error.message).toBe("Tool blocked");
  });

  it("should be instanceof Error", () => {
    const error = new PolicyBlockedError("test");
    expect(error).toBeInstanceOf(Error);
  });
});

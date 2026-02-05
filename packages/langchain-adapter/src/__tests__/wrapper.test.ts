import type { PolicySet } from "@agentkernel/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { PolicyBlockedError, type SecurityEvent } from "../interceptor.js";
import {
  type SecureAgentConfig,
  type SecuredToolsResult,
  createAllowlistPolicy,
  createBlocklistPolicy,
  createToolSecurityWrapper,
  secureTool,
  secureTools,
} from "../wrapper.js";

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

describe("secureTools", () => {
  it("should secure an array of tools", () => {
    const tools = [createMockTool("tool1"), createMockTool("tool2")];

    const result = secureTools(tools);

    expect(result.tools).toHaveLength(2);
    expect(result.interceptor).toBeDefined();
  });

  it("should return empty array for empty input", () => {
    const result = secureTools([]);

    expect(result.tools).toHaveLength(0);
    expect(result.interceptor).toBeDefined();
  });

  it("should apply policy set to tools", async () => {
    const tools = [createMockTool("test_tool", "result")];
    const config: SecureAgentConfig = {
      policySet: { defaultDecision: "allow" },
    };

    const result = secureTools(tools, config);

    // Tool should work
    const output = await result.tools[0]._call({ input: "test" });
    expect(output).toBe("result");
  });

  it("should use custom agent ID", () => {
    const tools = [createMockTool("test_tool")];
    const config: SecureAgentConfig = {
      agentId: "custom-agent",
    };

    const result = secureTools(tools, config);

    expect(result.interceptor).toBeDefined();
  });

  it("should call onSecurityEvent callback", async () => {
    const securityEvents: SecurityEvent[] = [];
    const tools = [createMockTool("test_tool")];
    const config: SecureAgentConfig = {
      policySet: { defaultDecision: "allow" },
      onSecurityEvent: (event) => securityEvents.push(event),
    };

    const result = secureTools(tools, config);
    await result.tools[0]._call({});

    expect(securityEvents).toHaveLength(1);
    expect(securityEvents[0].type).toBe("allowed");
  });

  it("should enable verbose mode with getSecurityEvents", async () => {
    const tools = [createMockTool("test_tool")];
    const config: SecureAgentConfig = {
      policySet: { defaultDecision: "allow" },
      verbose: true,
    };

    const result = secureTools(tools, config);
    await result.tools[0]._call({});

    expect(result.getSecurityEvents).toBeDefined();
    const events = result.getSecurityEvents?.();
    expect(events).toHaveLength(1);
  });

  it("should not have getSecurityEvents when verbose is false", () => {
    const tools = [createMockTool("test_tool")];
    const config: SecureAgentConfig = {
      verbose: false,
    };

    const result = secureTools(tools, config);

    expect(result.getSecurityEvents).toBeUndefined();
  });

  it("should call onApprovalRequest when policy requires approval", async () => {
    const onApprovalRequest = vi.fn().mockResolvedValue(true);
    const tools = [createMockTool("test_tool")];
    const config: SecureAgentConfig = {
      policySet: { defaultDecision: "approve" },
      onApprovalRequest,
    };

    const result = secureTools(tools, config);
    await result.tools[0]._call({});

    expect(onApprovalRequest).toHaveBeenCalledWith("test_tool", {});
  });
});

describe("secureTool", () => {
  it("should secure a single tool", () => {
    const tool = createMockTool("single_tool");
    const securedTool = secureTool(tool);

    expect(securedTool).toBeDefined();
    expect(securedTool.name).toBe("single_tool");
  });

  it("should apply config to single tool", async () => {
    const events: SecurityEvent[] = [];
    const tool = createMockTool("single_tool", "result");
    const securedTool = secureTool(tool, {
      policySet: { defaultDecision: "allow" },
      onSecurityEvent: (e) => events.push(e),
    });

    const result = await securedTool._call({});

    expect(result).toBe("result");
    expect(events).toHaveLength(1);
  });
});

describe("createToolSecurityWrapper", () => {
  it("should create a reusable wrapper function", () => {
    const makeSecure = createToolSecurityWrapper({
      policySet: { defaultDecision: "allow" },
    });

    const tool1 = createMockTool("tool1");
    const tool2 = createMockTool("tool2");

    const secured1 = makeSecure(tool1);
    const secured2 = makeSecure(tool2);

    expect(secured1.name).toBe("tool1");
    expect(secured2.name).toBe("tool2");
  });

  it("should apply same config to all wrapped tools", async () => {
    const events: SecurityEvent[] = [];
    const makeSecure = createToolSecurityWrapper({
      policySet: { defaultDecision: "allow" },
      onSecurityEvent: (e) => events.push(e),
    });

    const tool1 = createMockTool("tool1");
    const tool2 = createMockTool("tool2");

    const secured1 = makeSecure(tool1);
    const secured2 = makeSecure(tool2);

    await secured1._call({});
    await secured2._call({});

    expect(events).toHaveLength(2);
  });
});

describe("createAllowlistPolicy", () => {
  it("should create policy allowing specified tools", () => {
    const policy = createAllowlistPolicy(["read_file", "web_search"]);

    expect(policy.name).toBe("allowlist-policy");
    expect(policy.defaultDecision).toBe("block");
    expect(policy.shellRules).toBeDefined();
    expect(policy.shellRules).toHaveLength(2);
  });

  it("should create allow rules for each tool", () => {
    const policy = createAllowlistPolicy(["tool1", "tool2", "tool3"]);

    expect(policy.shellRules).toHaveLength(3);
    expect(policy.shellRules?.[0].decision).toBe("allow");
    expect(policy.shellRules?.[0].commandPatterns).toContain("tool1");
  });

  it("should handle empty allowlist", () => {
    const policy = createAllowlistPolicy([]);

    expect(policy.shellRules).toHaveLength(0);
    expect(policy.defaultDecision).toBe("block");
  });

  it("should block non-allowlisted tools", async () => {
    const policy = createAllowlistPolicy(["special_permitted_tool"]);
    const tool = createMockTool("random_blocked_action");
    const { tools } = secureTools([tool], { policySet: policy });

    await expect(tools[0]._call({})).rejects.toThrow(PolicyBlockedError);
  });
});

describe("createBlocklistPolicy", () => {
  it("should create policy blocking specified tools", () => {
    const policy = createBlocklistPolicy(["delete_file", "shell"]);

    expect(policy.name).toBe("blocklist-policy");
    expect(policy.defaultDecision).toBe("allow");
    expect(policy.shellRules).toBeDefined();
    expect(policy.shellRules).toHaveLength(2);
  });

  it("should create block rules for each tool", () => {
    const policy = createBlocklistPolicy(["danger1", "danger2"]);

    expect(policy.shellRules).toHaveLength(2);
    expect(policy.shellRules?.[0].decision).toBe("block");
    expect(policy.shellRules?.[0].commandPatterns).toContain("danger1");
  });

  it("should handle empty blocklist", () => {
    const policy = createBlocklistPolicy([]);

    expect(policy.shellRules).toHaveLength(0);
    expect(policy.defaultDecision).toBe("allow");
  });

  it("should allow non-blocklisted tools", async () => {
    const policy = createBlocklistPolicy(["blocked_tool"]);
    const tool = createMockTool("allowed_tool", "success");
    const { tools } = secureTools([tool], { policySet: policy });

    const result = await tools[0]._call({});
    expect(result).toBe("success");
  });
});

describe("integration scenarios", () => {
  it("should work with combined verbose and event callback", async () => {
    const externalEvents: SecurityEvent[] = [];
    const tools = [createMockTool("test1"), createMockTool("test2")];

    const { tools: secured, getSecurityEvents } = secureTools(tools, {
      policySet: { defaultDecision: "allow" },
      verbose: true,
      onSecurityEvent: (e) => externalEvents.push(e),
    });

    await secured[0]._call({});
    await secured[1]._call({});

    // Both external and internal tracking should work
    expect(externalEvents).toHaveLength(2);
    expect(getSecurityEvents?.()).toHaveLength(2);
  });

  it("should preserve tool metadata after wrapping", () => {
    const tool = createMockTool("my_tool");
    tool.description = "My custom description";

    const secured = secureTool(tool);

    expect(secured.name).toBe("my_tool");
    expect(secured.description).toBe("My custom description");
  });

  it("should handle multiple sequential calls", async () => {
    const events: SecurityEvent[] = [];
    const tool = createMockTool("counter_tool");
    let callCount = 0;
    tool._call = vi.fn().mockImplementation(async () => {
      callCount++;
      return `call ${callCount}`;
    });

    const secured = secureTool(tool, {
      policySet: { defaultDecision: "allow" },
      onSecurityEvent: (e) => events.push(e),
    });

    const results = await Promise.all([secured._call({}), secured._call({}), secured._call({})]);

    expect(events).toHaveLength(3);
    expect(results).toHaveLength(3);
  });
});

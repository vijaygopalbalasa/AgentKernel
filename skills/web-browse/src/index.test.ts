import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { webBrowseSkill } from "./index.js";
import type { ToolHandler, ToolContext, ToolResult } from "@agentkernel/tools";
import type { SkillActivationContext, SkillLogger } from "@agentkernel/skills";

// ─── TEST HELPERS ────────────────────────────────────────────

const registeredTools = new Map<string, { handler: ToolHandler<Record<string, unknown>> }>();

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: "test-agent",
    requestId: "test-req",
    allowAllDomains: true,
    ...overrides,
  };
}

const mockLog: SkillLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeActivationContext(): SkillActivationContext {
  return {
    agentId: "test-agent",
    log: mockLog,
    registerTool: (def, handler) => {
      registeredTools.set(def.id, { handler: handler as ToolHandler<Record<string, unknown>> });
    },
    unregisterTool: (id) => {
      registeredTools.delete(id);
    },
    getConfig: () => undefined,
    setData: async () => {},
    getData: async () => undefined,
  };
}

async function invokeTool(toolId: string, args: Record<string, unknown>, ctx?: Partial<ToolContext>): Promise<ToolResult> {
  const tool = registeredTools.get(toolId);
  if (!tool) throw new Error(`Tool not registered: ${toolId}`);
  return tool.handler(args, makeContext(ctx));
}

// ─── TESTS ───────────────────────────────────────────────────

describe("web-browse skill", () => {
  beforeEach(() => {
    registeredTools.clear();
    webBrowseSkill.activate!(makeActivationContext());
  });

  afterEach(() => {
    webBrowseSkill.deactivate!(makeActivationContext());
  });

  it("registers 3 tools on activate", () => {
    expect(registeredTools.size).toBe(3);
    expect(registeredTools.has("fetch")).toBe(true);
    expect(registeredTools.has("extract")).toBe(true);
    expect(registeredTools.has("links")).toBe(true);
  });

  it("unregisters all tools on deactivate", () => {
    webBrowseSkill.deactivate!(makeActivationContext());
    expect(registeredTools.size).toBe(0);
  });

  it("has correct manifest", () => {
    expect(webBrowseSkill.manifest.id).toBe("web-browse");
    expect(webBrowseSkill.manifest.permissions?.length).toBe(1);
    expect(webBrowseSkill.manifest.permissions?.[0]?.id).toBe("network:http");
    expect(webBrowseSkill.manifest.tools?.length).toBe(3);
  });

  describe("fetch", () => {
    it("returns error for unreachable URLs", async () => {
      const result = await invokeTool("fetch", {
        url: "http://localhost:1/nonexistent",
        timeoutMs: 1000,
      }, { allowAllDomains: true });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Fetch failed");
    });

    it("returns error for invalid URLs", async () => {
      const result = await invokeTool("fetch", {
        url: "not-a-url",
        timeoutMs: 1000,
      }, { allowAllDomains: true });

      // Zod validation or fetch error
      expect(result.success).toBe(false);
    });
  });

  describe("domain validation", () => {
    it("blocks domains not in allowlist", async () => {
      const result = await invokeTool("fetch", {
        url: "http://evil.com/steal",
        timeoutMs: 1000,
      }, { allowAllDomains: false, allowedDomains: ["example.com"] });

      expect(result.success).toBe(false);
      expect(result.error).toContain("not in the allowed domains list");
    });

    it("allows domains in the allowlist", async () => {
      const result = await invokeTool("fetch", {
        url: "http://localhost:1/test",
        timeoutMs: 500,
      }, { allowAllDomains: false, allowedDomains: ["localhost"] });

      // Will fail to connect but NOT due to domain validation
      expect(result.error).not.toContain("not in the allowed domains list");
    });

    it("supports wildcard domain patterns", async () => {
      const result = await invokeTool("fetch", {
        url: "http://api.example.com/data",
        timeoutMs: 500,
      }, { allowAllDomains: false, allowedDomains: ["*.example.com"] });

      // Will fail to connect but NOT due to domain validation
      expect(result.error).not.toContain("not in the allowed domains list");
    });

    it("blocks all domains when no allowlist configured", async () => {
      const result = await invokeTool("fetch", {
        url: "http://example.com/",
        timeoutMs: 1000,
      }, { allowAllDomains: false, allowedDomains: [] });

      expect(result.success).toBe(false);
      expect(result.error).toContain("no allowed domains configured");
    });
  });

  describe("extract", () => {
    it("returns error for unreachable URLs", async () => {
      const result = await invokeTool("extract", {
        url: "http://localhost:1/nonexistent",
        timeoutMs: 1000,
      }, { allowAllDomains: true });

      expect(result.success).toBe(false);
      expect(result.error).toContain("failed");
    });
  });

  describe("links", () => {
    it("returns error for unreachable URLs", async () => {
      const result = await invokeTool("links", {
        url: "http://localhost:1/nonexistent",
        timeoutMs: 1000,
      }, { allowAllDomains: true });

      expect(result.success).toBe(false);
    });
  });
});

describe("web-browse HTML utilities", async () => {
  const { createServer } = await import("node:http");

  let server: ReturnType<typeof createServer>;
  let port: number;

  beforeEach(async () => {
    registeredTools.clear();
    webBrowseSkill.activate!(makeActivationContext());

    await new Promise<void>((resolve) => {
      server = createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!DOCTYPE html>
<html>
<head>
  <title>Test Page</title>
  <meta name="description" content="A test page for web-browse skill">
</head>
<body>
  <script>var x = 1;</script>
  <style>.hidden { display: none; }</style>
  <h1>Hello World</h1>
  <p>This is a &amp; test with &lt;entities&gt; and &#169; symbol.</p>
  <a href="/about">About Us</a>
  <a href="https://example.com/page">External Link</a>
  <div>
    <a href="/relative">Relative</a>
  </div>
</body>
</html>`);
      });

      server.listen(0, () => {
        const addr = server.address();
        port = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  afterEach(async () => {
    webBrowseSkill.deactivate!(makeActivationContext());
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("extracts readable text from HTML", async () => {
    const result = await invokeTool("extract", {
      url: `http://localhost:${port}/`,
      timeoutMs: 5000,
    }, { allowAllDomains: true });

    expect(result.success).toBe(true);
    const content = result.content as Record<string, unknown>;
    expect(content.title).toBe("Test Page");
    expect(content.description).toBe("A test page for web-browse skill");

    const text = content.text as string;
    expect(text).toContain("Hello World");
    expect(text).toContain("This is a & test");
    expect(text).toContain("© symbol");
    // Script and style content should be stripped
    expect(text).not.toContain("var x = 1");
    expect(text).not.toContain(".hidden");
  });

  it("extracts links with resolved URLs", async () => {
    const result = await invokeTool("extract", {
      url: `http://localhost:${port}/`,
      includeLinks: true,
      timeoutMs: 5000,
    }, { allowAllDomains: true });

    expect(result.success).toBe(true);
    const content = result.content as Record<string, unknown>;
    const links = content.links as Array<{ text: string; href: string }>;

    expect(links.length).toBe(3);
    expect(links.some((l) => l.text === "About Us" && l.href.includes("/about"))).toBe(true);
    expect(links.some((l) => l.href === "https://example.com/page")).toBe(true);
  });

  it("links tool returns link list", async () => {
    const result = await invokeTool("links", {
      url: `http://localhost:${port}/`,
      timeoutMs: 5000,
    }, { allowAllDomains: true });

    expect(result.success).toBe(true);
    const content = result.content as { title: string; links: Array<{ text: string; href: string }>; count: number };
    expect(content.title).toBe("Test Page");
    expect(content.count).toBe(3);
  });

  it("fetch returns raw response", async () => {
    const result = await invokeTool("fetch", {
      url: `http://localhost:${port}/`,
      timeoutMs: 5000,
    }, { allowAllDomains: true });

    expect(result.success).toBe(true);
    const content = result.content as { status: number; body: string; contentType: string };
    expect(content.status).toBe(200);
    expect(content.body).toContain("<title>Test Page</title>");
    expect(content.contentType).toContain("text/html");
  });

  it("respects maxLength for text extraction", async () => {
    const result = await invokeTool("extract", {
      url: `http://localhost:${port}/`,
      maxLength: 20,
      timeoutMs: 5000,
    }, { allowAllDomains: true });

    expect(result.success).toBe(true);
    const content = result.content as Record<string, unknown>;
    const text = content.text as string;
    expect(text).toContain("[... truncated]");
  });
});

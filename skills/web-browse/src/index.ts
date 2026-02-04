// @agentkernel/skill-web-browse — Web browsing skill
// Fetch URLs, extract readable text, and discover links
// Uses native fetch() with timeout, proxy support, and output limits

import { z } from "zod";
import type { SkillModule, SkillActivationContext } from "@agentkernel/skills";
import type { ToolHandler, ToolContext, ToolDefinition } from "@agentkernel/tools";

// ─── HTML UTILITIES ──────────────────────────────────────────

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
  "&copy;": "©",
  "&reg;": "®",
  "&trade;": "™",
};

function decodeEntities(text: string): string {
  let result = text.replace(/&[a-zA-Z0-9#]+;/g, (entity) => {
    if (HTML_ENTITIES[entity]) return HTML_ENTITIES[entity];
    // Numeric entities: &#123; or &#x1a;
    if (entity.startsWith("&#x")) {
      const code = Number.parseInt(entity.slice(3, -1), 16);
      return Number.isNaN(code) ? entity : String.fromCodePoint(code);
    }
    if (entity.startsWith("&#")) {
      const code = Number.parseInt(entity.slice(2, -1), 10);
      return Number.isNaN(code) ? entity : String.fromCodePoint(code);
    }
    return entity;
  });
  return result;
}

function htmlToText(html: string): string {
  let text = html;

  // Remove script and style blocks entirely
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");

  // Add newlines for block elements
  text = text.replace(/<\/?(?:div|p|br|h[1-6]|ul|ol|li|table|tr|td|th|blockquote|pre|hr|section|article|header|footer|nav|main|aside|figure|figcaption)[^>]*>/gi, "\n");

  // Strip all remaining HTML tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode HTML entities
  text = decodeEntities(text);

  // Collapse multiple whitespace/newlines
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n[ \t]+/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();

  return text;
}

function extractLinks(html: string, baseUrl: string): Array<{ text: string; href: string }> {
  const links: Array<{ text: string; href: string }> = [];
  const linkRegex = /<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1]!;
    const rawText = match[2]!;
    const text = htmlToText(rawText).trim();

    if (!text || !href) continue;

    // Resolve relative URLs
    let resolvedHref: string;
    try {
      resolvedHref = new URL(href, baseUrl).href;
    } catch {
      resolvedHref = href;
    }

    links.push({ text, href: resolvedHref });
  }

  return links;
}

function extractTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match ? decodeEntities(match[1]!).trim() : "";
}

function extractMetaDescription(html: string): string {
  const match = /<meta\s[^>]*name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']*)["']/i.exec(html)
    ?? /<meta\s[^>]*content\s*=\s*["']([^"']*)["'][^>]*name\s*=\s*["']description["']/i.exec(html);
  return match ? decodeEntities(match[1]!).trim() : "";
}

// ─── DOMAIN VALIDATION ──────────────────────────────────────

function validateDomain(url: string, context: ToolContext): string | null {
  if (context.allowAllDomains) return null;

  if (!context.allowedDomains || context.allowedDomains.length === 0) {
    return `Domain blocked: no allowed domains configured.`;
  }

  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return `Invalid URL: ${url}`;
  }

  const isAllowed = context.allowedDomains.some((pattern) => {
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(2);
      return hostname === suffix || hostname.endsWith(`.${suffix}`);
    }
    return hostname === pattern;
  });

  if (!isAllowed) {
    return `Domain '${hostname}' is not in the allowed domains list.`;
  }

  return null;
}

// ─── FETCH TOOL ──────────────────────────────────────────────

const fetchSchema = z.object({
  url: z.string().url().describe("URL to fetch"),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]).optional(),
  headers: z.record(z.string()).optional(),
  body: z.union([z.string(), z.record(z.unknown())]).optional(),
  timeoutMs: z.number().int().min(100).max(60000).optional().describe("Timeout in ms (default 10000)"),
  maxBytes: z.number().int().min(1).max(5 * 1024 * 1024).optional().describe("Max response bytes (default 1MB)"),
});

const fetchHandler: ToolHandler<z.infer<typeof fetchSchema>> = async (args, context) => {
  const domainError = validateDomain(args.url, context);
  if (domainError) {
    return { success: false, error: domainError };
  }

  const controller = new AbortController();
  const timeoutMs = args.timeoutMs ?? 10000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  if (context.signal) {
    context.signal.addEventListener("abort", () => controller.abort());
  }

  try {
    const body = args.body && typeof args.body === "object"
      ? JSON.stringify(args.body)
      : args.body;

    const response = await fetch(args.url, {
      method: args.method ?? "GET",
      headers: args.headers,
      body,
      signal: controller.signal,
      redirect: "error", // Block redirects to prevent SSRF bypass
    });

    const text = await response.text();
    const maxBytes = args.maxBytes ?? 1024 * 1024;
    if (Buffer.byteLength(text, "utf-8") > maxBytes) {
      return {
        success: false,
        error: `Response exceeded limit (${maxBytes} bytes)`,
      };
    }

    return {
      success: response.ok,
      content: {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: text,
        contentType: response.headers.get("content-type") ?? undefined,
      },
      error: response.ok ? undefined : `HTTP ${response.status} ${response.statusText}`,
    };
  } catch (err) {
    return {
      success: false,
      error: `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timeout);
  }
};

// ─── EXTRACT TEXT TOOL ───────────────────────────────────────

const extractSchema = z.object({
  url: z.string().url().describe("URL to fetch and extract text from"),
  maxLength: z.number().int().min(100).max(200000).optional().describe("Max text length (default 50000)"),
  includeLinks: z.boolean().optional().describe("Include extracted links"),
  timeoutMs: z.number().int().min(100).max(60000).optional().describe("Timeout in ms (default 10000)"),
});

const extractHandler: ToolHandler<z.infer<typeof extractSchema>> = async (args, context) => {
  const domainError = validateDomain(args.url, context);
  if (domainError) {
    return { success: false, error: domainError };
  }

  const controller = new AbortController();
  const timeoutMs = args.timeoutMs ?? 10000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  if (context.signal) {
    context.signal.addEventListener("abort", () => controller.abort());
  }

  try {
    const response = await fetch(args.url, {
      method: "GET",
      headers: {
        "Accept": "text/html,application/xhtml+xml,text/plain",
        "User-Agent": "AgentKernel/0.1 (web-browse skill)",
      },
      signal: controller.signal,
      redirect: "error", // Block redirects to prevent SSRF bypass
    });

    if (!response.ok) {
      return {
        success: false,
        error: `HTTP ${response.status} ${response.statusText}`,
      };
    }

    const html = await response.text();
    const maxLength = args.maxLength ?? 50000;

    const title = extractTitle(html);
    const description = extractMetaDescription(html);
    let text = htmlToText(html);

    if (text.length > maxLength) {
      text = text.slice(0, maxLength) + "\n\n[... truncated]";
    }

    const result: Record<string, unknown> = {
      url: args.url,
      title,
      description: description || undefined,
      text,
      textLength: text.length,
    };

    if (args.includeLinks) {
      result.links = extractLinks(html, args.url);
    }

    return { success: true, content: result };
  } catch (err) {
    return {
      success: false,
      error: `Extract failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timeout);
  }
};

// ─── LINKS TOOL ──────────────────────────────────────────────

const linksSchema = z.object({
  url: z.string().url().describe("URL to extract links from"),
  timeoutMs: z.number().int().min(100).max(60000).optional().describe("Timeout in ms (default 10000)"),
});

const linksHandler: ToolHandler<z.infer<typeof linksSchema>> = async (args, context) => {
  const domainError = validateDomain(args.url, context);
  if (domainError) {
    return { success: false, error: domainError };
  }

  const controller = new AbortController();
  const timeoutMs = args.timeoutMs ?? 10000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  if (context.signal) {
    context.signal.addEventListener("abort", () => controller.abort());
  }

  try {
    const response = await fetch(args.url, {
      method: "GET",
      headers: {
        "Accept": "text/html,application/xhtml+xml",
        "User-Agent": "AgentKernel/0.1 (web-browse skill)",
      },
      signal: controller.signal,
      redirect: "error", // Block redirects to prevent SSRF bypass
    });

    if (!response.ok) {
      return {
        success: false,
        error: `HTTP ${response.status} ${response.statusText}`,
      };
    }

    const html = await response.text();
    const links = extractLinks(html, args.url);
    const title = extractTitle(html);

    return {
      success: true,
      content: { url: args.url, title, links, count: links.length },
    };
  } catch (err) {
    return {
      success: false,
      error: `Links extraction failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timeout);
  }
};

// ─── TOOL DEFINITIONS ────────────────────────────────────────

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler<Record<string, unknown>> }> = [
  {
    definition: {
      id: "fetch",
      name: "HTTP Fetch",
      description: "Fetch a URL and return the raw response (status, headers, body).",
      inputSchema: fetchSchema,
      category: "network",
      tags: ["http", "fetch", "web"],
      requiredPermissions: ["network:http"],
    },
    handler: fetchHandler as ToolHandler<Record<string, unknown>>,
  },
  {
    definition: {
      id: "extract",
      name: "Extract Text",
      description: "Fetch a web page and extract readable text content (strips HTML, scripts, styles).",
      inputSchema: extractSchema,
      category: "network",
      tags: ["http", "web", "text", "extract"],
      requiredPermissions: ["network:http"],
    },
    handler: extractHandler as ToolHandler<Record<string, unknown>>,
  },
  {
    definition: {
      id: "links",
      name: "Extract Links",
      description: "Fetch a web page and extract all hyperlinks with their text.",
      inputSchema: linksSchema,
      category: "network",
      tags: ["http", "web", "links"],
      requiredPermissions: ["network:http"],
    },
    handler: linksHandler as ToolHandler<Record<string, unknown>>,
  },
];

// ─── SKILL MODULE ────────────────────────────────────────────

export const webBrowseSkill: SkillModule = {
  manifest: {
    id: "web-browse",
    name: "Web Browse",
    description:
      "Fetch web pages, extract readable text, and discover links. " +
      "Uses native fetch() with timeout and size limits. No external browser required.",
    version: "0.1.0",
    author: "AgentKernel",
    license: "MIT",
    categories: ["network"],
    tags: ["web", "http", "fetch", "browse", "extract"],
    permissions: [
      { id: "network:http", reason: "Fetch URLs over HTTP(S)", required: true },
    ],
    tools: tools.map((t) => t.definition),
  },

  activate(context: SkillActivationContext): void {
    context.log.info("Activating web-browse skill");

    for (const { definition, handler } of tools) {
      context.registerTool(definition, handler);
      context.log.debug(`Registered tool: ${definition.id}`);
    }
  },

  deactivate(context: SkillActivationContext): void {
    context.log.info("Deactivating web-browse skill");

    for (const { definition } of tools) {
      context.unregisterTool(definition.id);
    }
  },
};

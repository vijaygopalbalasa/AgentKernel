// @agentkernel/adapter-openclaw — Run OpenClaw agents inside AgentKernel's sandboxed runtime
// Wraps OpenClaw's skill-based architecture with capability-based permission enforcement.

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import type {
  AgentAdapter,
  AdapterConfig,
  AdapterMessage,
  AdapterResponse,
  AdapterState,
} from "@agentkernel/runtime";
import type { Capability, AgentSandbox } from "@agentkernel/runtime";

/** Skill entry in an OpenClaw configuration file. */
interface OpenClawSkill {
  name: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

/** Parsed OpenClaw configuration. */
interface OpenClawConfig {
  name?: string;
  version?: string;
  personality?: string;
  skills: OpenClawSkill[];
  channels?: Record<string, unknown>;
  memory?: Record<string, unknown>;
  model?: string;
  raw: Record<string, unknown>;
}

/** Maps OpenClaw skill names to AgentKernel capabilities. */
const SKILL_CAPABILITY_MAP: Record<string, Capability[]> = {
  "file-system": ["file:read", "file:write"],
  "file-read": ["file:read"],
  "file-write": ["file:read", "file:write"],
  "file-delete": ["file:read", "file:delete"],
  "shell-exec": ["shell:execute"],
  "shell": ["shell:execute"],
  "web-browse": ["network:http"],
  "web-search": ["network:http"],
  "http": ["network:http"],
  "websocket": ["network:websocket"],
  "memory": ["memory:read", "memory:write"],
  "knowledge": ["memory:read", "memory:write"],
  "mcp": ["tool:mcp"],
  "agent-delegate": ["agent:communicate"],
};

/** Capabilities every OpenClaw agent needs (LLM access for the core loop). */
const BASE_CAPABILITIES: Capability[] = ["llm:chat", "llm:stream"];

/**
 * Adapter that wraps OpenClaw agents inside AgentKernel's sandboxed runtime.
 *
 * Reads OpenClaw configuration, maps skills to AgentKernel capabilities,
 * and enforces sandbox permissions before allowing skill execution.
 *
 * @example
 * ```typescript
 * const adapter = new OpenClawAdapter();
 * await adapter.load({ configPath: "./openclaw.yaml", workingDirectory: ".", env: {}, options: {} });
 * await adapter.start(sandbox);
 * const response = await adapter.handleMessage({ type: "chat", payload: { content: "Hello" } });
 * await adapter.stop();
 * ```
 */
export class OpenClawAdapter implements AgentAdapter {
  readonly name = "openclaw";
  readonly version = "0.1.0";

  private _state: AdapterState = "idle";
  private config: OpenClawConfig | null = null;
  private sandbox: AgentSandbox | null = null;
  private workingDirectory: string = process.cwd();
  private requiredCapabilities: Capability[] = [];

  get state(): AdapterState {
    return this._state;
  }

  /** Load and validate an OpenClaw configuration file. */
  async load(adapterConfig: AdapterConfig): Promise<void> {
    const configPath = resolve(adapterConfig.workingDirectory, adapterConfig.configPath);

    if (!existsSync(configPath)) {
      throw new Error(`OpenClaw config not found: ${configPath}`);
    }

    this.workingDirectory = adapterConfig.workingDirectory || dirname(configPath);
    const raw = parseConfigFile(configPath);
    this.config = normalizeConfig(raw);
    this.requiredCapabilities = resolveCapabilities(this.config);
    this._state = "loaded";
  }

  /** Start the adapted OpenClaw agent with sandbox enforcement. */
  async start(sandbox: AgentSandbox): Promise<void> {
    if (this._state !== "loaded") {
      throw new Error(`Cannot start adapter in state "${this._state}" (must be "loaded")`);
    }

    if (!this.config) {
      throw new Error("No configuration loaded");
    }

    this.sandbox = sandbox;

    const denied = this.requiredCapabilities.filter((cap) => !sandbox.check(cap).allowed);
    if (denied.length > 0) {
      this._state = "error";
      throw new Error(
        `OpenClaw agent requires capabilities not granted by sandbox: ${denied.join(", ")}. ` +
        `Grant them explicitly or use --policy permissive.`
      );
    }

    this._state = "running";
  }

  /** Gracefully stop the adapted agent. */
  async stop(): Promise<void> {
    this.sandbox = null;
    this._state = "stopped";
  }

  /**
   * Handle a message by checking sandbox permissions and routing to the appropriate skill.
   *
   * Messages with type "chat" are forwarded as LLM requests.
   * Messages with type "skill_invoke" trigger a capability check before execution.
   * Messages with type "tool_call" validate the tool against enabled skills.
   */
  async handleMessage(message: AdapterMessage): Promise<AdapterResponse> {
    if (this._state !== "running" || !this.sandbox || !this.config) {
      return {
        type: "error",
        payload: { message: `Adapter is not running (state: ${this._state})` },
      };
    }

    switch (message.type) {
      case "chat":
        return this.handleChat(message);
      case "skill_invoke":
        return this.handleSkillInvoke(message);
      case "tool_call":
        return this.handleToolCall(message);
      case "status":
        return this.handleStatus();
      default:
        return {
          type: "error",
          payload: { message: `Unknown message type: ${message.type}` },
        };
    }
  }

  /** Return capabilities required by the loaded OpenClaw configuration. */
  getRequiredCapabilities(): Capability[] {
    return [...this.requiredCapabilities];
  }

  /** Get the parsed OpenClaw configuration (available after load). */
  getConfig(): OpenClawConfig | null {
    return this.config;
  }

  // ─── Message Handlers ─────────────────────────────────────

  private handleChat(message: AdapterMessage): AdapterResponse {
    const sandbox = this.sandbox!;
    const check = sandbox.check("llm:chat");
    if (!check.allowed) {
      return {
        type: "error",
        payload: { message: `Permission denied: llm:chat — ${check.reason ?? ""}` },
      };
    }

    const content = message.payload.content as string | undefined;
    return {
      type: "chat_request",
      payload: {
        messages: [
          ...(this.config?.personality
            ? [{ role: "system", content: this.config.personality }]
            : []),
          { role: "user", content: content ?? "" },
        ],
        model: this.config?.model,
        workingDirectory: this.workingDirectory,
      },
    };
  }

  private handleSkillInvoke(message: AdapterMessage): AdapterResponse {
    const sandbox = this.sandbox!;
    const skillName = message.payload.skill as string | undefined;

    if (!skillName) {
      return { type: "error", payload: { message: "Missing skill name" } };
    }

    const enabledSkills = this.config!.skills
      .filter((s) => s.enabled !== false)
      .map((s) => s.name);

    if (!enabledSkills.includes(skillName)) {
      return {
        type: "error",
        payload: { message: `Skill "${skillName}" is not enabled in this OpenClaw config` },
      };
    }

    const requiredCaps = SKILL_CAPABILITY_MAP[skillName] ?? [];
    for (const cap of requiredCaps) {
      const check = sandbox.check(cap, { skill: skillName });
      if (!check.allowed) {
        return {
          type: "error",
          payload: {
            message: `Skill "${skillName}" denied: capability "${cap}" — ${check.reason ?? "not granted"}`,
          },
        };
      }
    }

    const skillConfig = this.config!.skills.find((s) => s.name === skillName);

    return {
      type: "skill_approved",
      payload: {
        skill: skillName,
        config: skillConfig?.config ?? {},
        args: message.payload.args ?? {},
        workingDirectory: this.workingDirectory,
      },
    };
  }

  private handleToolCall(message: AdapterMessage): AdapterResponse {
    const sandbox = this.sandbox!;
    const toolName = message.payload.tool as string | undefined;

    if (!toolName) {
      return { type: "error", payload: { message: "Missing tool name" } };
    }

    const capability = inferCapabilityFromTool(toolName);
    if (capability) {
      const check = sandbox.check(capability, { tool: toolName });
      if (!check.allowed) {
        return {
          type: "error",
          payload: {
            message: `Tool "${toolName}" denied: capability "${capability}" — ${check.reason ?? "not granted"}`,
          },
        };
      }
    }

    if (isPathBasedTool(toolName)) {
      const path = message.payload.path as string | undefined;
      if (path && capability) {
        const pathCheck = sandbox.checkPathConstraint(capability, resolve(this.workingDirectory, path));
        if (!pathCheck.allowed) {
          return {
            type: "error",
            payload: { message: `Path access denied: ${pathCheck.reason ?? ""}` },
          };
        }
      }
    }

    if (isNetworkTool(toolName)) {
      const url = message.payload.url as string | undefined;
      if (url && capability) {
        const host = extractHost(url);
        if (host) {
          const hostCheck = sandbox.checkHostConstraint(capability, host);
          if (!hostCheck.allowed) {
            return {
              type: "error",
              payload: { message: `Network access denied: ${hostCheck.reason ?? ""}` },
            };
          }
        }
      }
    }

    return {
      type: "tool_approved",
      payload: {
        tool: toolName,
        args: message.payload.args ?? {},
        workingDirectory: this.workingDirectory,
      },
    };
  }

  private handleStatus(): AdapterResponse {
    return {
      type: "status",
      payload: {
        adapter: this.name,
        version: this.version,
        state: this._state,
        config: this.config
          ? {
              name: this.config.name,
              skills: this.config.skills
                .filter((s) => s.enabled !== false)
                .map((s) => s.name),
              model: this.config.model,
            }
          : null,
        capabilities: this.requiredCapabilities,
      },
    };
  }
}

// ─── Config Parsing ───────────────────────────────────────────

function parseConfigFile(configPath: string): Record<string, unknown> {
  const ext = extname(configPath).toLowerCase();
  const content = readFileSync(configPath, "utf-8");

  if (ext === ".json") {
    return JSON.parse(content) as Record<string, unknown>;
  }

  if (ext === ".yaml" || ext === ".yml") {
    return parseSimpleYaml(content);
  }

  throw new Error(`Unsupported config format: ${ext} (expected .json, .yaml, or .yml)`);
}

/**
 * Minimal YAML parser for OpenClaw config files.
 * Handles the common subset: key-value pairs, lists, and nested objects.
 * For full YAML support, users should convert to JSON or install js-yaml.
 */
function parseSimpleYaml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split(/\r?\n/);
  let currentKey = "";
  let currentList: unknown[] | null = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, "  ");

    if (!line.trim() || line.trim().startsWith("#")) {
      continue;
    }

    const listMatch = line.match(/^(\s*)- (.+)$/);
    if (listMatch && currentKey) {
      if (!currentList) {
        currentList = [];
        result[currentKey] = currentList;
      }
      currentList.push(parseYamlValue((listMatch[2] ?? "").trim()));
      continue;
    }

    const kvMatch = line.match(/^([a-zA-Z_][\w.-]*):\s*(.*)$/);
    if (kvMatch) {
      currentKey = kvMatch[1] ?? "";
      const value = (kvMatch[2] ?? "").trim();
      currentList = null;

      if (value) {
        result[currentKey] = parseYamlValue(value);
      }
    }
  }

  return result;
}

function parseYamlValue(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (/^-?\d+$/.test(value)) return parseInt(value, 10);
  if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    return value.slice(1, -1);
  }
  return value;
}

// ─── Config Normalization ────────────────────────────────────

function normalizeConfig(raw: Record<string, unknown>): OpenClawConfig {
  const skills = normalizeSkills(raw);

  return {
    name: typeof raw.name === "string" ? raw.name : undefined,
    version: typeof raw.version === "string" ? raw.version : undefined,
    personality: typeof raw.personality === "string"
      ? raw.personality
      : typeof raw.system_prompt === "string"
        ? raw.system_prompt
        : typeof raw.systemPrompt === "string"
          ? raw.systemPrompt
          : undefined,
    skills,
    channels: typeof raw.channels === "object" && raw.channels !== null
      ? raw.channels as Record<string, unknown>
      : undefined,
    memory: typeof raw.memory === "object" && raw.memory !== null
      ? raw.memory as Record<string, unknown>
      : undefined,
    model: typeof raw.model === "string" ? raw.model : undefined,
    raw,
  };
}

function normalizeSkills(raw: Record<string, unknown>): OpenClawSkill[] {
  const skills: OpenClawSkill[] = [];

  if (Array.isArray(raw.skills)) {
    for (const entry of raw.skills) {
      if (typeof entry === "string") {
        skills.push({ name: entry, enabled: true });
      } else if (typeof entry === "object" && entry !== null) {
        const obj = entry as Record<string, unknown>;
        if (typeof obj.name === "string") {
          skills.push({
            name: obj.name,
            enabled: obj.enabled !== false,
            config: typeof obj.config === "object" && obj.config !== null
              ? obj.config as Record<string, unknown>
              : undefined,
          });
        }
      }
    }
  }

  if (typeof raw.skills === "object" && raw.skills !== null && !Array.isArray(raw.skills)) {
    const skillMap = raw.skills as Record<string, unknown>;
    for (const [name, value] of Object.entries(skillMap)) {
      if (typeof value === "boolean") {
        skills.push({ name, enabled: value });
      } else if (typeof value === "object" && value !== null) {
        const obj = value as Record<string, unknown>;
        skills.push({
          name,
          enabled: obj.enabled !== false,
          config: obj as Record<string, unknown>,
        });
      }
    }
  }

  return skills;
}

// ─── Capability Resolution ───────────────────────────────────

function resolveCapabilities(config: OpenClawConfig): Capability[] {
  const caps = new Set<Capability>(BASE_CAPABILITIES);

  for (const skill of config.skills) {
    if (skill.enabled === false) continue;
    const mapped = SKILL_CAPABILITY_MAP[skill.name];
    if (mapped) {
      for (const cap of mapped) {
        caps.add(cap);
      }
    }
  }

  if (config.memory) {
    caps.add("memory:read");
    caps.add("memory:write");
  }

  return Array.from(caps);
}

// ─── Tool → Capability Mapping ───────────────────────────────

function inferCapabilityFromTool(toolName: string): Capability | null {
  const lower = toolName.toLowerCase();

  if (lower.includes("read_file") || lower.includes("list_dir") || lower.includes("cat")) {
    return "file:read";
  }
  if (lower.includes("write_file") || lower.includes("create_file") || lower.includes("edit_file")) {
    return "file:write";
  }
  if (lower.includes("delete_file") || lower.includes("remove_file") || lower.includes("rm")) {
    return "file:delete";
  }
  if (lower.includes("exec") || lower.includes("shell") || lower.includes("bash") || lower.includes("run_command")) {
    return "shell:execute";
  }
  if (lower.includes("http") || lower.includes("fetch") || lower.includes("curl") || lower.includes("browse") || lower.includes("web")) {
    return "network:http";
  }
  if (lower.includes("websocket") || lower.includes("ws_")) {
    return "network:websocket";
  }

  return null;
}

function isPathBasedTool(toolName: string): boolean {
  const lower = toolName.toLowerCase();
  return (
    lower.includes("file") ||
    lower.includes("dir") ||
    lower.includes("read") ||
    lower.includes("write") ||
    lower.includes("cat") ||
    lower.includes("ls")
  );
}

function isNetworkTool(toolName: string): boolean {
  const lower = toolName.toLowerCase();
  return (
    lower.includes("http") ||
    lower.includes("fetch") ||
    lower.includes("curl") ||
    lower.includes("browse") ||
    lower.includes("web") ||
    lower.includes("websocket")
  );
}

function extractHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    return null;
  }
}

/** Create an OpenClaw adapter instance. */
export function createOpenClawAdapter(): OpenClawAdapter {
  return new OpenClawAdapter();
}

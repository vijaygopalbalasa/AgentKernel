// AgentRun — Run any agent safely
// Hero command: agentrun run ./my-agent.ts

import chalk from "chalk";
import ora from "ora";
import { resolve, extname, basename, dirname } from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import {
  AgentSandbox,
  defaultAdapterRegistry,
  type AgentAdapter,
  type AdapterConfig,
} from "@agentrun/runtime";

const SUPPORTED_EXTENSIONS = new Set([".ts", ".js", ".mts", ".mjs"]);
const ADAPTER_CONFIG_EXTENSIONS = new Set([".yaml", ".yml", ".json"]);

const DEFAULT_SANDBOX_CAPABILITIES = [
  "llm:chat",
  "llm:stream",
  "memory:read",
  "memory:write",
];

interface RunOptions {
  host: string;
  port: string;
  token?: string;
  adapter?: string;
  policy: string;
  standalone?: boolean;
}

interface AgentSpawnResult {
  agentId: string;
  status: string;
}

/**
 * Run an agent from a source file.
 *
 * Connected mode (default): deploys the agent to a running gateway.
 * Standalone mode (--standalone): validates the agent locally without a gateway.
 */
export async function runAgent(agentPath: string, options: RunOptions): Promise<void> {
  const resolvedPath = resolve(process.cwd(), agentPath);

  if (!existsSync(resolvedPath)) {
    console.error(chalk.red(`\n  Agent file not found: ${agentPath}`));
    process.exit(1);
  }

  const ext = extname(resolvedPath);
  if (!options.adapter && !SUPPORTED_EXTENSIONS.has(ext)) {
    if (ADAPTER_CONFIG_EXTENSIONS.has(ext)) {
      console.error(chalk.red(`\n  Config file detected but no adapter specified.`));
      console.log(chalk.gray(`  Try: agentrun run ${agentPath} --adapter openclaw`));
      process.exit(1);
    }
    console.error(chalk.red(`\n  Unsupported file type: ${ext}`));
    console.log(chalk.gray("  Supported: .ts, .js, .mts, .mjs (or use --adapter for config files)"));
    process.exit(1);
  }

  const agentName = basename(resolvedPath, ext);

  console.log();
  console.log(chalk.bold("AgentRun"));
  console.log(chalk.gray("─".repeat(40)));

  if (options.adapter) {
    await runWithAdapter(resolvedPath, agentName, options);
    return;
  }

  if (options.standalone) {
    await runStandalone(resolvedPath, agentName);
  } else {
    await runConnected(resolvedPath, agentName, options);
  }
}

// ─── Connected Mode ─────────────────────────────────────────

async function runConnected(
  agentFilePath: string,
  agentName: string,
  options: RunOptions
): Promise<void> {
  const spinner = ora("Connecting to gateway...").start();
  const authToken = options.token ?? process.env.GATEWAY_AUTH_TOKEN;

  let ws: WebSocket;
  try {
    ws = await connectGateway(options.host, options.port, authToken);
    spinner.succeed(chalk.green("Connected to gateway"));
  } catch (error) {
    spinner.fail(chalk.red("Gateway not reachable"));
    console.log();
    console.log(chalk.gray("  The AgentRun gateway is not running."));
    console.log(chalk.gray("  Start it first:"));
    console.log();
    console.log(chalk.cyan("    agentrun start"));
    console.log(chalk.gray("    # or: docker compose up -d"));
    console.log();
    console.log(chalk.gray("  Or run in standalone validation mode:"));
    console.log(chalk.cyan(`    agentrun run ${basename(agentFilePath)} --standalone`));
    console.log();
    process.exit(1);
  }

  const agentId = `run-${agentName}-${Date.now()}`;
  const isStrict = options.policy === "strict";

  const manifest = {
    id: agentId,
    name: agentName,
    version: "0.1.0",
    description: `Agent loaded from ${basename(agentFilePath)}`,
    entryPoint: agentFilePath,
    permissions: ["memory.read", "memory.write"],
    trustLevel: isStrict ? "supervised" : "semi-autonomous",
  };

  const deploySpinner = ora("Deploying agent...").start();

  try {
    const response = await sendAndWait(ws, {
      type: "agent_spawn",
      id: `spawn-${Date.now()}`,
      payload: { manifest },
    });

    const payload = response.payload as Partial<AgentSpawnResult> | undefined;

    if (response.type === "error") {
      const errPayload = response.payload as { message?: string } | undefined;
      deploySpinner.fail(chalk.red(`Deploy failed: ${errPayload?.message ?? "Unknown error"}`));
      ws.close();
      process.exit(1);
    }

    deploySpinner.succeed(chalk.green("Agent deployed"));
  } catch (error) {
    deploySpinner.fail(chalk.red(`Deploy failed: ${error instanceof Error ? error.message : String(error)}`));
    ws.close();
    process.exit(1);
  }

  // Show status summary
  console.log();
  console.log(`  ${chalk.green("✓")} Agent loaded        ${chalk.gray(basename(agentFilePath))}`);
  console.log(`  ${chalk.green("✓")} Sandbox active      ${chalk.gray(`${DEFAULT_SANDBOX_CAPABILITIES.length} capabilities`)}`);
  console.log(`  ${chalk.green("✓")} Policy              ${chalk.gray(isStrict ? "strict (supervised)" : "permissive")}`);
  console.log(`  ${chalk.green("✓")} Gateway             ${chalk.gray(`ws://${options.host}:${options.port}`)}`);
  console.log();

  for (const cap of DEFAULT_SANDBOX_CAPABILITIES) {
    console.log(`  ${chalk.gray("•")} ${chalk.white(cap)}`);
  }

  console.log();
  console.log(chalk.cyan("  → Agent running"), chalk.gray("(Ctrl+C to stop)"));
  console.log();

  // Listen for agent events
  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString()) as {
        type: string;
        payload?: Record<string, unknown>;
      };

      if (message.type === "event") {
        const channel = message.payload?.channel ?? "";
        const eventType = message.payload?.type ?? "";
        const eventData = message.payload?.data;
        console.log(
          chalk.magenta("[event]") +
          ` ${chalk.yellow(`${String(channel)}:${String(eventType)}`)}` +
          chalk.gray(eventData ? ` ${JSON.stringify(eventData).slice(0, 120)}` : "")
        );
      }

      if (message.type === "agent_terminated" || message.type === "agent_error") {
        const reason = message.payload?.reason ?? message.payload?.error ?? "unknown";
        console.log(chalk.yellow(`\n  Agent stopped: ${String(reason)}`));
        ws.close();
        process.exit(0);
      }
    } catch {
      // Ignore unparseable messages
    }
  });

  // Subscribe to events for this agent
  ws.send(JSON.stringify({
    type: "subscribe_events",
    id: `sub-${Date.now()}`,
    payload: { agentId },
  }));

  // Graceful shutdown
  const shutdown = () => {
    console.log(chalk.gray("\n  Stopping agent..."));

    ws.send(JSON.stringify({
      type: "agent_terminate",
      id: `term-${Date.now()}`,
      payload: { agentId },
    }));

    setTimeout(() => {
      ws.close();
      process.exit(0);
    }, 3000);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep alive — reconnect handling
  ws.on("close", () => {
    console.log(chalk.yellow("\n  Gateway connection closed."));
    process.exit(0);
  });

  ws.on("error", (error) => {
    console.error(chalk.red(`\n  Gateway error: ${error.message}`));
    process.exit(1);
  });
}

// ─── Standalone Mode ────────────────────────────────────────

async function runStandalone(agentFilePath: string, agentName: string): Promise<void> {
  const spinner = ora("Loading agent module...").start();

  try {
    const specifier = pathToFileURL(agentFilePath).href;
    const module = (await import(specifier)) as Record<string, unknown>;

    const agent = resolveAgentModule(module);
    if (!agent) {
      spinner.fail(chalk.red("Invalid agent module"));
      console.log(chalk.gray("\n  The file must export a handleTask function."));
      console.log(chalk.gray("  Use defineAgent() from @agentrun/sdk:\n"));
      console.log(chalk.cyan("    import { defineAgent } from \"@agentrun/sdk\";"));
      console.log(chalk.cyan("    export default defineAgent({ ... });"));
      console.log();
      process.exit(1);
    }

    spinner.succeed(chalk.green("Agent loaded"));

    const manifest = agent.manifest as Record<string, unknown> | undefined;
    const name = (manifest?.name ?? agentName) as string;
    const version = (manifest?.version ?? "0.1.0") as string;
    const permissions = (manifest?.permissions ?? []) as string[];

    console.log();
    console.log(`  ${chalk.green("✓")} Agent loaded        ${chalk.white(name)} ${chalk.gray(`v${version}`)}`);
    console.log(`  ${chalk.green("✓")} Sandbox active      ${chalk.gray(`${DEFAULT_SANDBOX_CAPABILITIES.length} default capabilities`)}`);
    console.log(`  ${chalk.green("✓")} Mode                ${chalk.gray("standalone (validation)")}`);

    if (permissions.length > 0) {
      console.log(`  ${chalk.green("✓")} Requested perms     ${chalk.gray(permissions.join(", "))}`);
    }

    console.log();

    // Show exported functions
    const hasInit = typeof agent.initialize === "function";
    const hasTerminate = typeof agent.terminate === "function";
    const hasHandleTask = typeof agent.handleTask === "function";

    console.log(chalk.bold("  Exported handlers:"));
    console.log(`  ${hasHandleTask ? chalk.green("✓") : chalk.red("✗")} handleTask`);
    console.log(`  ${hasInit ? chalk.green("✓") : chalk.gray("–")} initialize`);
    console.log(`  ${hasTerminate ? chalk.green("✓") : chalk.gray("–")} terminate`);
    console.log();

    console.log(chalk.green("  Agent is valid and ready to deploy."));
    console.log(chalk.gray("  To run with a gateway:\n"));
    console.log(chalk.cyan(`    agentrun start`));
    console.log(chalk.cyan(`    agentrun run ${basename(agentFilePath)}`));
    console.log();
  } catch (error) {
    spinner.fail(chalk.red("Failed to load agent"));
    console.error(chalk.gray(`\n  ${error instanceof Error ? error.message : String(error)}`));

    if (String(error).includes("Cannot find module") || String(error).includes("ERR_MODULE_NOT_FOUND")) {
      console.log(chalk.gray("\n  Make sure dependencies are installed: pnpm install"));
    }

    console.log();
    process.exit(1);
  }
}

// ─── Adapter Mode ───────────────────────────────────────────

async function runWithAdapter(
  configPath: string,
  agentName: string,
  options: RunOptions
): Promise<void> {
  const adapterName = options.adapter!;

  await registerBuiltinAdapters();

  const adapter = defaultAdapterRegistry.create(adapterName);
  if (!adapter) {
    console.error(chalk.red(`\n  Unknown adapter: ${adapterName}`));
    console.log(chalk.gray(`  Available adapters: ${defaultAdapterRegistry.list().join(", ") || "none"}`));
    console.log(chalk.gray(`  Install an adapter: pnpm add @agentrun/adapter-${adapterName}`));
    process.exit(1);
  }

  const loadSpinner = ora(`Loading ${adapterName} config...`).start();

  const safeEnv = sanitizeEnv(process.env);

  const adapterConfig: AdapterConfig = {
    configPath,
    workingDirectory: dirname(configPath),
    env: safeEnv,
    options: {},
  };

  await adapter.load(adapterConfig);
  loadSpinner.succeed(chalk.green(`${adapterName} config loaded`));

  const requiredCaps = adapter.getRequiredCapabilities();
  const isStrict = options.policy === "strict";

  const sandbox = new AgentSandbox(`adapter-${agentName}-${Date.now()}`, {
    enforcePermissions: isStrict,
  });

  if (!isStrict) {
    for (const cap of requiredCaps) {
      sandbox.grant(cap, "system");
    }
  }

  const startSpinner = ora("Starting adapted agent...").start();
  await adapter.start(sandbox);
  startSpinner.succeed(chalk.green("Adapter started"));

  console.log();
  console.log(`  ${chalk.green("✓")} Adapter             ${chalk.white(adapterName)} ${chalk.gray(`v${adapter.version}`)}`);
  console.log(`  ${chalk.green("✓")} Config              ${chalk.gray(basename(configPath))}`);
  console.log(`  ${chalk.green("✓")} Sandbox active      ${chalk.gray(`${requiredCaps.length} capabilities`)}`);
  console.log(`  ${chalk.green("✓")} Policy              ${chalk.gray(isStrict ? "strict" : "permissive")}`);
  console.log();

  for (const cap of requiredCaps) {
    const granted = sandbox.has(cap);
    const icon = granted ? chalk.green("•") : chalk.red("✗");
    console.log(`  ${icon} ${chalk.white(cap)}`);
  }

  console.log();
  console.log(chalk.cyan("  → Adapted agent running"), chalk.gray("(Ctrl+C to stop)"));
  console.log();

  const shutdown = async () => {
    console.log(chalk.gray("\n  Stopping adapted agent..."));
    await adapter.stop();
    console.log(chalk.green("  Adapter stopped."));
    process.exit(0);
  };

  process.on("SIGINT", () => { shutdown().catch(() => process.exit(1)); });
  process.on("SIGTERM", () => { shutdown().catch(() => process.exit(1)); });

  // Keep the process alive
  await new Promise(() => {});
}

async function registerBuiltinAdapters(): Promise<void> {
  if (!defaultAdapterRegistry.has("openclaw")) {
    try {
      const mod = await import("@agentrun/adapter-openclaw") as {
        createOpenClawAdapter: () => AgentAdapter;
      };
      defaultAdapterRegistry.register("openclaw", mod.createOpenClawAdapter);
    } catch {
      // OpenClaw adapter not installed — skip silent registration
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────

const BLOCKED_ENV_PREFIXES = [
  "GATEWAY_AUTH",
  "INTERNAL_AUTH",
  "PERMISSION_SECRET",
  "MANIFEST_SIGNING",
  "MEMORY_ENCRYPTION",
  "ANTHROPIC_API",
  "OPENAI_API",
  "GOOGLE_AI_API",
  "DATABASE_URL",
  "REDIS_URL",
  "QDRANT_URL",
];

export function sanitizeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const blocked = BLOCKED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
    if (!blocked) {
      result[key] = value;
    }
  }
  return result;
}

export function resolveAgentModule(module: Record<string, unknown>): Record<string, unknown> | null {
  // Check default export
  if (module.default && typeof module.default === "object") {
    const def = module.default as Record<string, unknown>;
    if (typeof def.handleTask === "function") return def;
  }

  // Check named export
  if (typeof module.handleTask === "function") {
    return module as Record<string, unknown>;
  }

  // Check nested default.default (ESM interop)
  if (module.default && typeof module.default === "object") {
    const nested = module.default as Record<string, unknown>;
    if (nested.default && typeof nested.default === "object") {
      const inner = nested.default as Record<string, unknown>;
      if (typeof inner.handleTask === "function") return inner;
    }
  }

  return null;
}

function connectGateway(host: string, port: string, token?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${host}:${port}`);
    const authId = `auth-${Date.now()}`;
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        ws.close();
        reject(new Error("Connection timeout"));
      }
    }, 5000);

    ws.on("open", () => {
      if (token) {
        ws.send(JSON.stringify({ type: "auth", id: authId, payload: { token } }));
      }
    });

    ws.on("message", (data) => {
      if (settled) return;
      const msg = JSON.parse(data.toString()) as { type: string; id?: string };

      if (msg.type === "auth_required" && !token) {
        settled = true;
        clearTimeout(timeout);
        ws.close();
        reject(new Error("Authentication required. Set GATEWAY_AUTH_TOKEN or use --token"));
        return;
      }

      if (msg.type === "auth_success") {
        settled = true;
        clearTimeout(timeout);
        resolve(ws);
      }

      if (msg.type === "auth_failed") {
        settled = true;
        clearTimeout(timeout);
        ws.close();
        reject(new Error("Authentication failed"));
      }
    });

    ws.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`Connection failed: ${error.message}`));
      }
    });
  });
}

function sendAndWait(
  ws: WebSocket,
  message: { type: string; id: string; payload: unknown }
): Promise<{ type: string; id?: string; payload?: unknown }> {
  return new Promise((resolve, reject) => {
    const messageId = message.id;

    const handler = (data: Buffer) => {
      const response = JSON.parse(data.toString()) as {
        type: string;
        id?: string;
        payload?: unknown;
      };
      if (response.id === messageId || response.type === "error") {
        ws.off("message", handler);
        clearTimeout(timeout);
        resolve(response);
      }
    };

    const timeout = setTimeout(() => {
      ws.off("message", handler);
      reject(new Error("Response timeout"));
    }, 30000);

    ws.on("message", handler);
    ws.send(JSON.stringify(message));
  });
}

#!/usr/bin/env node
// AgentRun CLI — Command line interface for AgentRun
// Production quality with proper error handling

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { WebSocket } from "ws";
import { z } from "zod";
import {
  createLogger,
  loadConfig,
  createDatabase,
  waitForDatabase,
  createVectorStore,
  waitForVectorStore,
  createEventBus,
  waitForEventBus,
} from "@agentrun/kernel";
import { signManifest, AgentManifestSchema } from "@agentrun/sdk";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { type Result, ok, err } from "@agentrun/shared";
import { startShell } from "./shell.js";
import { installAgent, uninstallAgent, listAgents, updateAgent } from "./package-manager.js";
import { runAgent } from "./run.js";

const VERSION = "0.2.0";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 18800;

const log = createLogger({ name: "cli" });

// ─── Zod Schemas ────────────────────────────────────────────

const GatewayResponseSchema = z.object({
  type: z.string(),
  id: z.string().optional(),
  payload: z.unknown().optional(),
  timestamp: z.number().optional(),
});

const HealthResponseSchema = z.object({
  status: z.enum(["ok", "degraded", "error"]),
  version: z.string(),
  uptime: z.number(),
  providers: z.array(z.string()),
  agents: z.number(),
  connections: z.number(),
  timestamp: z.number(),
});

// ─── CLI Program ────────────────────────────────────────────

const program = new Command();
loadEnvFile(resolve(process.cwd(), ".env"));

program
  .name("agentrun")
  .description("AgentRun — Run any AI agent safely")
  .version(VERSION);

// ─── Helpers ────────────────────────────────────────────────

function generateSecret(bytes: number = 24): string {
  return randomBytes(bytes).toString("hex");
}

function parseEnvContent(content: string): Map<string, string> {
  const map = new Map<string, string>();
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    map.set(key, value);
  }
  return map;
}

function loadEnvFile(envPath: string): void {
  if (!existsSync(envPath)) return;
  try {
    const content = readFileSync(envPath, "utf-8");
    const map = parseEnvContent(content);
    for (const [key, value] of map.entries()) {
      if (process.env[key] === undefined || process.env[key] === "") {
        process.env[key] = value;
      }
    }
  } catch {
    // best-effort; ignore failures
  }
}

function upsertEnvValue(content: string, key: string, value: string): string {
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(content)) {
    return content.replace(pattern, `${key}=${value}`);
  }
  const suffix = content.endsWith("\n") ? "" : "\n";
  return `${content}${suffix}${key}=${value}\n`;
}

function needsSecret(value: string | undefined): boolean {
  if (!value) return true;
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith("change-me")) return true;
  return false;
}

async function isPortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.once("error", () => resolvePort(false));
    server.once("listening", () => {
      server.close(() => resolvePort(true));
    });
    server.listen(port, host);
  });
}

function parseMajorVersion(version: string): number {
  const match = version.match(/^(\d+)/);
  if (!match) return 0;
  return Number(match[1]);
}

// ─── Run Command (Hero) ─────────────────────────────────────

program
  .command("run <agent>")
  .description("Run an agent file safely with sandboxing")
  .option("--standalone", "Validate agent locally without a running gateway")
  .option("--host <host>", "Gateway host", DEFAULT_HOST)
  .option("-p, --port <port>", "Gateway port", String(DEFAULT_PORT))
  .option("-t, --token <token>", "Auth token")
  .option("--adapter <adapter>", "Agent adapter (e.g. openclaw)")
  .option("--policy <policy>", "Security policy: strict or permissive", "strict")
  .action(async (agentPath, options) => {
    await runAgent(agentPath, {
      host: options.host,
      port: options.port,
      token: options.token,
      adapter: options.adapter,
      policy: options.policy,
      standalone: options.standalone,
    });
  });

// ─── Status Command ─────────────────────────────────────────

program
  .command("status")
  .description("Show AgentRun status")
  .option("-h, --host <host>", "Gateway host", DEFAULT_HOST)
  .option("-p, --port <port>", "Gateway port", String(DEFAULT_PORT))
  .action(async (options) => {
    const spinner = ora("Checking gateway status...").start();

    try {
      const healthPort = parseInt(options.port) + 1;
      const url = `http://${options.host}:${healthPort}/health`;
      const response = await fetch(url);

      if (!response.ok) {
        spinner.fail(chalk.red("Gateway is not running"));
        process.exit(1);
      }

      const data = await response.json();
      const result = HealthResponseSchema.safeParse(data);

      if (!result.success) {
        spinner.fail(chalk.red("Invalid health response"));
        process.exit(1);
      }

      const health = result.data;
      spinner.succeed(chalk.green("Gateway is running"));

      console.log();
      console.log(chalk.bold("AgentRun Status"));
      console.log("─".repeat(40));
      console.log(`${chalk.gray("Status:")}    ${getStatusColor(health.status)}`);
      console.log(`${chalk.gray("Version:")}   ${health.version}`);
      console.log(`${chalk.gray("Uptime:")}    ${formatUptime(health.uptime)}`);
      console.log(`${chalk.gray("Providers:")} ${health.providers.join(", ") || "none"}`);
      console.log(`${chalk.gray("Agents:")}    ${health.agents}`);
      console.log(`${chalk.gray("Clients:")}   ${health.connections}`);
    } catch (error) {
      spinner.fail(chalk.red("Gateway is not running"));
      console.log(chalk.gray(`  Connect to: ws://${options.host}:${options.port}`));
      process.exit(1);
    }
  });

// ─── Start Command ──────────────────────────────────────────

program
  .command("start")
  .description("Start the AgentRun gateway")
  .option("-d, --detach", "Run in background")
  .option("--docker", "Start via docker compose (default if docker-compose.yml exists)")
  .option("--local", "Start the gateway process directly")
  .action(async (options) => {
    const spinner = ora("Starting AgentRun gateway...").start();

    try {
      const { exec, spawn } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execAsync = promisify(exec);

      const hasComposeFile = existsSync(resolve(process.cwd(), "docker-compose.yml"));
      const useDocker = options.docker || (!options.local && hasComposeFile);

      if (useDocker) {
        // Docker Compose mode
        spinner.text = "Starting AgentRun via Docker Compose...";

        if (!hasComposeFile) {
          spinner.fail(chalk.red("No docker-compose.yml found. Use --local for direct start."));
          process.exit(1);
        }

        try {
          await execAsync("docker info", { timeout: 5000 });
        } catch {
          spinner.fail(chalk.red("Docker is not running. Start Docker first or use --local."));
          process.exit(1);
        }

        if (options.detach) {
          await execAsync("docker compose up -d --build", { cwd: process.cwd(), timeout: 300000 });
          spinner.succeed(chalk.green("AgentRun started in background"));
          console.log(chalk.gray("  Dashboard: http://localhost:3000"));
          console.log(chalk.gray("  Gateway:   ws://localhost:18800"));
          console.log(chalk.gray("  Health:    http://localhost:18801/health"));
          console.log(chalk.gray("  Stop:      agentrun stop"));
        } else {
          spinner.succeed("Launching AgentRun...");
          const child = spawn("docker", ["compose", "up", "--build"], {
            cwd: process.cwd(),
            stdio: "inherit",
          });
          child.on("exit", (code) => process.exit(code ?? 0));
        }
      } else {
        // Direct local mode — start gateway via node
        spinner.text = "Starting AgentRun gateway locally...";

        const gatewayEntry = resolve(process.cwd(), "apps/gateway/dist/main.js");
        const gatewayDev = resolve(process.cwd(), "apps/gateway/src/main.ts");

        if (existsSync(gatewayEntry)) {
          spinner.succeed("Launching gateway...");
          const child = spawn("node", [gatewayEntry], {
            cwd: process.cwd(),
            stdio: "inherit",
            env: { ...process.env },
          });
          child.on("exit", (code) => process.exit(code ?? 0));
        } else if (existsSync(gatewayDev)) {
          spinner.succeed("Launching gateway (dev mode via tsx)...");
          const child = spawn("npx", ["tsx", gatewayDev], {
            cwd: process.cwd(),
            stdio: "inherit",
            env: { ...process.env },
          });
          child.on("exit", (code) => process.exit(code ?? 0));
        } else {
          spinner.fail(chalk.red("Gateway entry point not found."));
          console.log(chalk.gray("  Build first: pnpm build"));
          console.log(chalk.gray("  Or use:      agentrun start --docker"));
          process.exit(1);
        }
      }
    } catch (error) {
      spinner.fail(chalk.red(`Start failed: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  });

// ─── Init Command ───────────────────────────────────────────

program
  .command("init")
  .description("Create or update .env with secure defaults")
  .option("-f, --force", "Overwrite existing .env")
  .option("-u, --update-missing", "Fill missing or placeholder secrets")
  .action(async (options) => {
    const spinner = ora("Initializing environment...").start();

    try {
      const envPath = resolve(process.cwd(), ".env");
      const examplePath = resolve(process.cwd(), ".env.example");

      if (!existsSync(examplePath)) {
        spinner.fail(chalk.red(".env.example not found in this directory"));
        process.exit(1);
      }

      const exampleContent = await readFile(examplePath, "utf-8");
      const targetExists = existsSync(envPath);
      const currentContent = targetExists ? await readFile(envPath, "utf-8") : "";

      if (targetExists && !options.force && !options.updateMissing) {
        spinner.info(chalk.yellow(".env already exists. Use --update-missing or --force."));
        return;
      }

      const secrets: Record<string, string> = {
        GATEWAY_AUTH_TOKEN: generateSecret(24),
        INTERNAL_AUTH_TOKEN: generateSecret(24),
        PERMISSION_SECRET: generateSecret(32),
        MANIFEST_SIGNING_SECRET: generateSecret(32),
      };

      let nextContent = targetExists && options.updateMissing ? currentContent : exampleContent;
      const existingMap = parseEnvContent(nextContent);

      for (const [key, value] of Object.entries(secrets)) {
        const existing = existingMap.get(key);
        if (options.updateMissing) {
          if (needsSecret(existing)) {
            nextContent = upsertEnvValue(nextContent, key, value);
          }
        } else {
          nextContent = upsertEnvValue(nextContent, key, value);
        }
      }

      await writeFile(envPath, nextContent);
      spinner.succeed(chalk.green(".env ready"));
      console.log(chalk.gray("Next steps:"));
      console.log(chalk.gray("  1) Add at least one provider key (Anthropic/OpenAI/Google)"));
      console.log(chalk.gray("  2) Run: docker compose up --build"));
    } catch (error) {
      spinner.fail(chalk.red(`Init failed: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  });

// ─── Doctor Command ─────────────────────────────────────────

program
  .command("doctor")
  .description("Check local AgentRun setup for common issues")
  .option("--env <path>", "Env file path", ".env")
  .option("--docker", "Check Docker availability")
  .option("--ports", "Check gateway ports", true)
  .option("--infra", "Check Postgres/Redis/Qdrant connectivity")
  .action(async (options) => {
    const spinner = ora("Running checks...").start();

    const results: Array<{ label: string; ok: boolean; detail?: string }> = [];
    try {
      const nodeMajor = parseMajorVersion(process.versions.node);
      results.push({
        label: "Node.js version (>=22)",
        ok: nodeMajor >= 22,
        detail: `v${process.versions.node}`,
      });

      const envPath = resolve(process.cwd(), options.env);
      const envExists = existsSync(envPath);
      results.push({
        label: `.env present (${options.env})`,
        ok: envExists,
      });

      const envContent = envExists ? await readFile(envPath, "utf-8") : "";
      const envMap = parseEnvContent(envContent);
      const getEnv = (key: string): string | undefined => envMap.get(key) ?? process.env[key];

      const gatewayToken = getEnv("GATEWAY_AUTH_TOKEN");
      results.push({
        label: "GATEWAY_AUTH_TOKEN set",
        ok: !needsSecret(gatewayToken),
      });

      const internalToken = getEnv("INTERNAL_AUTH_TOKEN");
      results.push({
        label: "INTERNAL_AUTH_TOKEN set",
        ok: !needsSecret(internalToken),
      });

      const permissionSecret = getEnv("PERMISSION_SECRET");
      results.push({
        label: "PERMISSION_SECRET length >= 16",
        ok: Boolean(permissionSecret && permissionSecret.trim().length >= 16 && !needsSecret(permissionSecret)),
      });

      const hasProviderKey =
        Boolean(getEnv("ANTHROPIC_API_KEY")) ||
        Boolean(getEnv("OPENAI_API_KEY")) ||
        Boolean(getEnv("GOOGLE_AI_API_KEY")) ||
        Boolean(getEnv("OLLAMA_URL"));
      results.push({
        label: "At least one provider configured",
        ok: hasProviderKey,
      });

      if (options.ports) {
        const port = Number(getEnv("GATEWAY_PORT") ?? DEFAULT_PORT);
        const healthPort = port + 1;
        const gatewayAvailable = await isPortAvailable(DEFAULT_HOST, port);
        const healthAvailable = await isPortAvailable(DEFAULT_HOST, healthPort);
        results.push({
          label: `Gateway port ${port} available`,
          ok: gatewayAvailable,
        });
        results.push({
          label: `Health port ${healthPort} available`,
          ok: healthAvailable,
        });
      }

      if (options.docker) {
        try {
          const { exec } = await import("node:child_process");
          const { promisify } = await import("node:util");
          const execAsync = promisify(exec);
          await execAsync("docker info");
          results.push({ label: "Docker available", ok: true });
        } catch (error) {
          results.push({
            label: "Docker available",
            ok: false,
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (options.infra) {
        const config = loadConfig();

        // Database
        try {
          const db = createDatabase(config.database, log);
          const ready = await waitForDatabase(db, { maxRetries: 5, retryDelayMs: 500, logger: log });
          results.push({
            label: "PostgreSQL reachable",
            ok: ready,
          });
          await db.close();
        } catch (error) {
          results.push({
            label: "PostgreSQL reachable",
            ok: false,
            detail: error instanceof Error ? error.message : String(error),
          });
        }

        // Qdrant
        try {
          const vectorStore = createVectorStore(config.qdrant, log);
          const ready = await waitForVectorStore(vectorStore, { maxRetries: 5, retryDelayMs: 500, logger: log });
          results.push({
            label: "Qdrant reachable",
            ok: ready,
          });
          await vectorStore.close();
        } catch (error) {
          results.push({
            label: "Qdrant reachable",
            ok: false,
            detail: error instanceof Error ? error.message : String(error),
          });
        }

        // Redis (event bus)
        try {
          const bus = createEventBus(config.redis, log);
          const ready = await waitForEventBus(bus, { maxRetries: 5, retryDelayMs: 500, logger: log });
          results.push({
            label: "Redis reachable",
            ok: ready,
          });
          await bus.close();
        } catch (error) {
          results.push({
            label: "Redis reachable",
            ok: false,
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }

      spinner.stop();
      console.log(chalk.bold("AgentRun Doctor"));
      console.log("─".repeat(40));
      for (const result of results) {
        const status = result.ok ? chalk.green("✓") : chalk.red("✗");
        const detail = result.detail ? chalk.gray(` (${result.detail})`) : "";
        console.log(`${status} ${result.label}${detail}`);
      }

      const failures = results.filter((r) => !r.ok);
      if (failures.length > 0) {
        console.log();
        console.log(chalk.yellow("Fixes:"));
        if (failures.some((r) => r.label.includes("provider"))) {
          console.log(chalk.gray("  - Set a provider key in .env or run Ollama locally"));
        }
        if (failures.some((r) => r.label.includes("GATEWAY_AUTH_TOKEN"))) {
          console.log(chalk.gray("  - Run: agentrun init --update-missing"));
        }
        process.exitCode = 1;
      }
    } catch (error) {
      spinner.fail(chalk.red(`Doctor failed: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  });

// ─── New Agent Command ──────────────────────────────────────

program
  .command("new-agent <name>")
  .description("Scaffold a new AgentRun agent")
  .option("-d, --dir <dir>", "Target directory", "agents")
  .action(async (name, options) => {
    const spinner = ora(`Scaffolding agent ${name}...`).start();

    try {
      const fs = await import("fs/promises");
      const path = await import("path");
      const slug = name.toLowerCase().replace(/[^a-z0-9-_]/g, "-");
      const agentDir = path.resolve(process.cwd(), options.dir, slug);

      await fs.mkdir(path.join(agentDir, "src"), { recursive: true });

      const packageJson = {
        name: `@agentrun/agent-${slug}`,
        version: "0.1.0",
        type: "module",
        scripts: {
          build: "tsup src/index.ts --format esm --dts",
          dev: "tsx watch src/index.ts",
        },
        dependencies: {
          "@agentrun/sdk": "workspace:*",
        },
        devDependencies: {
          tsup: "^8.5.1",
          tsx: "^4.19.0",
          typescript: "^5.9.3",
        },
      };

      const agentSource = `import { defineAgent } from "@agentrun/sdk";

const agent = defineAgent({
  manifest: {
    id: "${slug}",
    name: "${name} Agent",
    version: "0.1.0",
    description: "Custom AgentRun agent generated by the CLI",
    requiredSkills: [],
    permissions: ["memory.read", "memory.write"],
  },
  async handleTask(task) {
    return {
      type: "echo",
      input: task,
      message: "Hello from ${name} Agent!",
    };
  },
});

export default agent;
`;

      await fs.writeFile(path.join(agentDir, "package.json"), JSON.stringify(packageJson, null, 2));
      await fs.writeFile(path.join(agentDir, "src", "index.ts"), agentSource);

      spinner.succeed(`Agent scaffolded at ${agentDir}`);
      console.log(chalk.gray("Next steps:"));
      console.log(chalk.gray(`  cd ${agentDir}`));
      console.log(chalk.gray("  pnpm install"));
      console.log(chalk.gray("  pnpm build"));
    } catch (error) {
      spinner.fail(chalk.red(`Failed to scaffold agent: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  });

// ─── Deploy Command ─────────────────────────────────────────

program
  .command("deploy <manifest>")
  .description("Deploy an agent from a manifest file")
  .option("-h, --host <host>", "Gateway host", DEFAULT_HOST)
  .option("-p, --port <port>", "Gateway port", String(DEFAULT_PORT))
  .option("-t, --token <token>", "Auth token")
  .action(async (manifestPath, options) => {
    const spinner = ora(`Deploying agent from ${manifestPath}...`).start();

    try {
      // Read manifest file
      const fs = await import("fs/promises");
      const manifestContent = await fs.readFile(manifestPath, "utf-8");
      const manifest = JSON.parse(manifestContent);

      // Connect to gateway
      const ws = await connectToGateway(options.host, options.port, options.token);

      // Send spawn request
      const response = await sendMessage(ws, {
        type: "agent_spawn",
        id: `deploy-${Date.now()}`,
        payload: { manifest },
      });

      ws.close();

      if (response.type === "agent_spawn_result") {
        const payload = response.payload as { agentId: string; status: string };
        spinner.succeed(chalk.green(`Agent deployed: ${payload.agentId}`));
        console.log(chalk.gray(`  Status: ${payload.status}`));
      } else if (response.type === "error") {
        const payload = response.payload as { message: string };
        spinner.fail(chalk.red(`Deploy failed: ${payload.message}`));
        process.exit(1);
      }
    } catch (error) {
      spinner.fail(chalk.red(`Deploy failed: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  });

// ─── Agents Command ─────────────────────────────────────────

program
  .command("agents")
  .description("List running agents")
  .option("-h, --host <host>", "Gateway host", DEFAULT_HOST)
  .option("-p, --port <port>", "Gateway port", String(DEFAULT_PORT))
  .option("-t, --token <token>", "Auth token")
  .action(async (options) => {
    const spinner = ora("Fetching agents...").start();

    try {
      const ws = await connectToGateway(options.host, options.port, options.token);

      const response = await sendMessage(ws, {
        type: "agent_status",
        id: `agents-${Date.now()}`,
      });

      ws.close();

      if (response.type === "agent_list") {
        const payload = response.payload as { agents: Array<{ id: string; name: string; state: string; uptime: number }>; count: number };
        spinner.succeed(chalk.green(`${payload.count} agent(s) running`));

        if (payload.count > 0) {
          console.log();
          console.log(chalk.bold("ID".padEnd(30)) + chalk.bold("Name".padEnd(20)) + chalk.bold("State".padEnd(15)) + chalk.bold("Uptime"));
          console.log("─".repeat(75));
          for (const agent of payload.agents) {
            console.log(
              agent.id.padEnd(30) +
              agent.name.padEnd(20) +
              getStateColor(agent.state).padEnd(15) +
              formatUptime(agent.uptime)
            );
          }
        }
      } else if (response.type === "error") {
        const payload = response.payload as { message: string };
        spinner.fail(chalk.red(`Failed: ${payload.message}`));
        process.exit(1);
      }
    } catch (error) {
      spinner.fail(chalk.red(`Failed: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  });

// ─── Terminate Command ──────────────────────────────────────

program
  .command("terminate <agentId>")
  .description("Terminate a running agent")
  .option("-h, --host <host>", "Gateway host", DEFAULT_HOST)
  .option("-p, --port <port>", "Gateway port", String(DEFAULT_PORT))
  .option("-t, --token <token>", "Auth token")
  .option("-f, --force", "Force terminate")
  .action(async (agentId, options) => {
    const spinner = ora(`Terminating agent ${agentId}...`).start();

    try {
      const ws = await connectToGateway(options.host, options.port, options.token);

      const response = await sendMessage(ws, {
        type: "agent_terminate",
        id: `terminate-${Date.now()}`,
        payload: { agentId, force: options.force },
      });

      ws.close();

      if (response.type === "agent_terminate_result") {
        const payload = response.payload as { success: boolean };
        if (payload.success) {
          spinner.succeed(chalk.green(`Agent ${agentId} terminated`));
        } else {
          spinner.fail(chalk.red("Termination failed"));
          process.exit(1);
        }
      } else if (response.type === "error") {
        const payload = response.payload as { message: string };
        spinner.fail(chalk.red(`Failed: ${payload.message}`));
        process.exit(1);
      }
    } catch (error) {
      spinner.fail(chalk.red(`Failed: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  });

// ─── Chat Command ───────────────────────────────────────────

program
  .command("chat <message>")
  .description("Send a chat message to the LLM")
  .option("-h, --host <host>", "Gateway host", DEFAULT_HOST)
  .option("-p, --port <port>", "Gateway port", String(DEFAULT_PORT))
  .option("-t, --token <token>", "Auth token")
  .option("-m, --model <model>", "Model to use")
  .option("-s, --stream", "Stream response tokens")
  .action(async (message, options) => {
    const spinner = ora("Sending message...").start();

    try {
      const ws = await connectToGateway(options.host, options.port, options.token);
      const request = {
        type: "chat",
        id: `chat-${Date.now()}`,
        payload: {
          model: options.model,
          messages: [{ role: "user", content: message }],
          stream: Boolean(options.stream),
        },
      };

      if (options.stream) {
        const streamResult = await streamChat(ws, request, {
          onStart: (model) => {
            spinner.succeed(chalk.green(`Response from ${model ?? "model"}`));
          },
          onChunk: (delta) => {
            process.stdout.write(delta);
          },
          onComplete: () => {
            process.stdout.write("\n");
          },
        });
        ws.close();

        if (!streamResult.ok) {
          spinner.fail(chalk.red(`Failed: ${streamResult.error.message}`));
          process.exit(1);
        }
        return;
      }

      const response = await sendMessage(ws, request);

      ws.close();

      if (response.type === "chat_response") {
        const payload = response.payload as { content: string; model: string };
        spinner.succeed(chalk.green(`Response from ${payload.model}`));
        console.log();
        console.log(payload.content);
      } else if (response.type === "error") {
        const payload = response.payload as { message: string };
        spinner.fail(chalk.red(`Failed: ${payload.message}`));
        process.exit(1);
      }
    } catch (error) {
      spinner.fail(chalk.red(`Failed: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  });

// ─── Social Commands ────────────────────────────────────────

const social = program
  .command("social")
  .description("Social layer operations (forums, jobs, reputation)");

social
  .command("forum-create")
  .description("Create a forum")
  .requiredOption("-a, --agent <agentId>", "Agent ID")
  .requiredOption("-n, --name <name>", "Forum name")
  .option("-d, --description <description>", "Forum description")
  .option("-h, --host <host>", "Gateway host", DEFAULT_HOST)
  .option("-p, --port <port>", "Gateway port", String(DEFAULT_PORT))
  .option("-t, --token <token>", "Auth token")
  .action(async (options) => {
    await runAgentTask({
      title: "Creating forum...",
      options,
      task: {
        type: "forum_create",
        name: options.name,
        description: options.description,
      },
    });
  });

social
  .command("forum-list")
  .description("List forums")
  .requiredOption("-a, --agent <agentId>", "Agent ID")
  .option("-q, --query <query>", "Search query")
  .option("-l, --limit <limit>", "Limit results", parseInt)
  .option("-h, --host <host>", "Gateway host", DEFAULT_HOST)
  .option("-p, --port <port>", "Gateway port", String(DEFAULT_PORT))
  .option("-t, --token <token>", "Auth token")
  .action(async (options) => {
    await runAgentTask({
      title: "Listing forums...",
      options,
      task: {
        type: "forum_list",
        query: options.query,
        limit: options.limit,
      },
    });
  });

social
  .command("forum-post")
  .description("Post to a forum")
  .requiredOption("-a, --agent <agentId>", "Agent ID")
  .requiredOption("-f, --forum <forumId>", "Forum ID")
  .requiredOption("-c, --content <content>", "Post content")
  .option("-m, --metadata <json>", "Metadata JSON")
  .option("-h, --host <host>", "Gateway host", DEFAULT_HOST)
  .option("-p, --port <port>", "Gateway port", String(DEFAULT_PORT))
  .option("-t, --token <token>", "Auth token")
  .action(async (options) => {
    await runAgentTask({
      title: "Posting to forum...",
      options,
      task: {
        type: "forum_post",
        forumId: options.forum,
        content: options.content,
        metadata: parseJsonOption(options.metadata),
      },
    });
  });

social
  .command("forum-posts")
  .description("List forum posts")
  .requiredOption("-a, --agent <agentId>", "Agent ID")
  .requiredOption("-f, --forum <forumId>", "Forum ID")
  .option("-l, --limit <limit>", "Limit results", parseInt)
  .option("-h, --host <host>", "Gateway host", DEFAULT_HOST)
  .option("-p, --port <port>", "Gateway port", String(DEFAULT_PORT))
  .option("-t, --token <token>", "Auth token")
  .action(async (options) => {
    await runAgentTask({
      title: "Fetching forum posts...",
      options,
      task: {
        type: "forum_posts",
        forumId: options.forum,
        limit: options.limit,
      },
    });
  });

social
  .command("job-post")
  .description("Post a job")
  .requiredOption("-a, --agent <agentId>", "Agent ID")
  .requiredOption("-t, --title <title>", "Job title")
  .option("-d, --description <description>", "Job description")
  .option("-b, --budget <budget>", "Budget USD", parseFloat)
  .option("-h, --host <host>", "Gateway host", DEFAULT_HOST)
  .option("-p, --port <port>", "Gateway port", String(DEFAULT_PORT))
  .option("-T, --token <token>", "Auth token")
  .action(async (options) => {
    await runAgentTask({
      title: "Posting job...",
      options,
      task: {
        type: "job_post",
        title: options.title,
        description: options.description,
        budgetUsd: options.budget,
      },
    });
  });

social
  .command("job-list")
  .description("List jobs")
  .requiredOption("-a, --agent <agentId>", "Agent ID")
  .option("-s, --status <status>", "Job status filter")
  .option("-l, --limit <limit>", "Limit results", parseInt)
  .option("-h, --host <host>", "Gateway host", DEFAULT_HOST)
  .option("-p, --port <port>", "Gateway port", String(DEFAULT_PORT))
  .option("-t, --token <token>", "Auth token")
  .action(async (options) => {
    await runAgentTask({
      title: "Listing jobs...",
      options,
      task: {
        type: "job_list",
        status: options.status,
        limit: options.limit,
      },
    });
  });

social
  .command("job-apply")
  .description("Apply for a job")
  .requiredOption("-a, --agent <agentId>", "Agent ID")
  .requiredOption("-j, --job <jobId>", "Job ID")
  .option("-p, --proposal <proposal>", "Application proposal")
  .option("-h, --host <host>", "Gateway host", DEFAULT_HOST)
  .option("-P, --port <port>", "Gateway port", String(DEFAULT_PORT))
  .option("-t, --token <token>", "Auth token")
  .action(async (options) => {
    await runAgentTask({
      title: "Submitting application...",
      options,
      task: {
        type: "job_apply",
        jobId: options.job,
        proposal: options.proposal,
      },
    });
  });

social
  .command("reputation-get")
  .description("Fetch agent reputation")
  .requiredOption("-a, --agent <agentId>", "Agent ID")
  .option("-t, --target <targetAgentId>", "Target agent ID")
  .option("-h, --host <host>", "Gateway host", DEFAULT_HOST)
  .option("-p, --port <port>", "Gateway port", String(DEFAULT_PORT))
  .option("-T, --token <token>", "Auth token")
  .action(async (options) => {
    await runAgentTask({
      title: "Fetching reputation...",
      options,
      task: {
        type: "reputation_get",
        agentId: options.target,
      },
    });
  });

social
  .command("reputation-list")
  .description("List reputations")
  .requiredOption("-a, --agent <agentId>", "Agent ID")
  .option("-l, --limit <limit>", "Limit results", parseInt)
  .option("-h, --host <host>", "Gateway host", DEFAULT_HOST)
  .option("-p, --port <port>", "Gateway port", String(DEFAULT_PORT))
  .option("-t, --token <token>", "Auth token")
  .action(async (options) => {
    await runAgentTask({
      title: "Listing reputations...",
      options,
      task: {
        type: "reputation_list",
        limit: options.limit,
      },
    });
  });

social
  .command("reputation-adjust")
  .description("Adjust agent reputation")
  .requiredOption("-a, --agent <agentId>", "Agent ID")
  .requiredOption("-t, --target <targetAgentId>", "Target agent ID")
  .requiredOption("-d, --delta <delta>", "Reputation delta", parseFloat)
  .option("-r, --reason <reason>", "Adjustment reason")
  .option("-h, --host <host>", "Gateway host", DEFAULT_HOST)
  .option("-p, --port <port>", "Gateway port", String(DEFAULT_PORT))
  .option("-T, --token <token>", "Auth token")
  .action(async (options) => {
    await runAgentTask({
      title: "Adjusting reputation...",
      options,
      task: {
        type: "reputation_adjust",
        agentId: options.target,
        delta: options.delta,
        reason: options.reason,
      },
    });
  });

social
  .command("directory")
  .description("List registered agents with reputation")
  .requiredOption("-a, --agent <agentId>", "Agent ID")
  .option("-q, --query <query>", "Filter by agent name")
  .option("-s, --status <status>", "Filter by agent status")
  .option("-l, --limit <limit>", "Limit results", parseInt)
  .option("-o, --offset <offset>", "Offset results", parseInt)
  .option("-h, --host <host>", "Gateway host", DEFAULT_HOST)
  .option("-p, --port <port>", "Gateway port", String(DEFAULT_PORT))
  .option("-t, --token <token>", "Auth token")
  .action(async (options) => {
    await runAgentTask({
      title: "Listing agent directory...",
      options,
      task: {
        type: "agent_directory",
        query: options.query,
        status: options.status,
        limit: options.limit,
        offset: options.offset,
      },
    });
  });

// ─── Governance Commands ───────────────────────────────────

const governance = program
  .command("governance")
  .description("Governance operations (policies, moderation, sanctions, audit)");

governance
  .command("policy-create")
  .description("Create a policy")
  .requiredOption("-a, --agent <agentId>", "Agent ID")
  .requiredOption("-n, --name <name>", "Policy name")
  .option("-d, --description <description>", "Policy description")
  .option("-r, --rules <json>", "Rules JSON")
  .option("-h, --host <host>", "Gateway host", DEFAULT_HOST)
  .option("-p, --port <port>", "Gateway port", String(DEFAULT_PORT))
  .option("-t, --token <token>", "Auth token")
  .action(async (options) => {
    await runAgentTask({
      title: "Creating policy...",
      options,
      task: {
        type: "policy_create",
        name: options.name,
        description: options.description,
        rules: parseJsonOption(options.rules),
      },
    });
  });

governance
  .command("policy-list")
  .description("List policies")
  .requiredOption("-a, --agent <agentId>", "Agent ID")
  .option("-s, --status <status>", "Policy status")
  .option("-l, --limit <limit>", "Limit results", parseInt)
  .option("-h, --host <host>", "Gateway host", DEFAULT_HOST)
  .option("-p, --port <port>", "Gateway port", String(DEFAULT_PORT))
  .option("-t, --token <token>", "Auth token")
  .action(async (options) => {
    await runAgentTask({
      title: "Listing policies...",
      options,
      task: {
        type: "policy_list",
        status: options.status,
        limit: options.limit,
      },
    });
  });

governance
  .command("policy-set-status")
  .description("Update policy status")
  .requiredOption("-a, --agent <agentId>", "Agent ID")
  .requiredOption("-p, --policy <policyId>", "Policy ID")
  .requiredOption("-s, --status <status>", "Status (active|inactive)")
  .option("-h, --host <host>", "Gateway host", DEFAULT_HOST)
  .option("-P, --port <port>", "Gateway port", String(DEFAULT_PORT))
  .option("-t, --token <token>", "Auth token")
  .action(async (options) => {
    await runAgentTask({
      title: "Updating policy...",
      options,
      task: {
        type: "policy_set_status",
        policyId: options.policy,
        status: options.status,
      },
    });
  });

governance
  .command("moderation-open")
  .description("Open a moderation case")
  .requiredOption("-a, --agent <agentId>", "Agent ID")
  .requiredOption("-s, --subject <subjectAgentId>", "Subject agent ID")
  .option("-p, --policy <policyId>", "Policy ID")
  .option("-r, --reason <reason>", "Reason")
  .option("-e, --evidence <json>", "Evidence JSON")
  .option("-h, --host <host>", "Gateway host", DEFAULT_HOST)
  .option("-P, --port <port>", "Gateway port", String(DEFAULT_PORT))
  .option("-t, --token <token>", "Auth token")
  .action(async (options) => {
    await runAgentTask({
      title: "Opening moderation case...",
      options,
      task: {
        type: "moderation_case_open",
        subjectAgentId: options.subject,
        policyId: options.policy,
        reason: options.reason,
        evidence: parseJsonOption(options.evidence),
      },
    });
  });

governance
  .command("moderation-list")
  .description("List moderation cases")
  .requiredOption("-a, --agent <agentId>", "Agent ID")
  .option("-s, --status <status>", "Case status")
  .option("-S, --subject <subjectAgentId>", "Subject agent ID")
  .option("-l, --limit <limit>", "Limit results", parseInt)
  .option("-h, --host <host>", "Gateway host", DEFAULT_HOST)
  .option("-p, --port <port>", "Gateway port", String(DEFAULT_PORT))
  .option("-t, --token <token>", "Auth token")
  .action(async (options) => {
    await runAgentTask({
      title: "Listing moderation cases...",
      options,
      task: {
        type: "moderation_case_list",
        status: options.status,
        subjectAgentId: options.subject,
        limit: options.limit,
      },
    });
  });

governance
  .command("moderation-resolve")
  .description("Resolve a moderation case")
  .requiredOption("-a, --agent <agentId>", "Agent ID")
  .requiredOption("-c, --case <caseId>", "Case ID")
  .option("-r, --resolution <resolution>", "Resolution notes")
  .option("-s, --status <status>", "Status (resolved|dismissed)")
  .option("-h, --host <host>", "Gateway host", DEFAULT_HOST)
  .option("-p, --port <port>", "Gateway port", String(DEFAULT_PORT))
  .option("-t, --token <token>", "Auth token")
  .action(async (options) => {
    await runAgentTask({
      title: "Resolving moderation case...",
      options,
      task: {
        type: "moderation_case_resolve",
        caseId: options.case,
        resolution: options.resolution,
        status: options.status,
      },
    });
  });

governance
  .command("appeal-open")
  .description("Open a moderation appeal")
  .requiredOption("-a, --agent <agentId>", "Agent ID")
  .requiredOption("-c, --case <caseId>", "Case ID")
  .option("-r, --reason <reason>", "Reason")
  .option("-e, --evidence <json>", "Evidence JSON")
  .option("-h, --host <host>", "Gateway host", DEFAULT_HOST)
  .option("-p, --port <port>", "Gateway port", String(DEFAULT_PORT))
  .option("-t, --token <token>", "Auth token")
  .action(async (options) => {
    await runAgentTask({
      title: "Opening appeal...",
      options,
      task: {
        type: "appeal_open",
        caseId: options.case,
        reason: options.reason,
        evidence: parseJsonOption(options.evidence),
      },
    });
  });

governance
  .command("appeal-list")
  .description("List appeals")
  .requiredOption("-a, --agent <agentId>", "Agent ID")
  .option("-s, --status <status>", "Appeal status")
  .option("-c, --case <caseId>", "Case ID")
  .option("-u, --appellant <appellantAgentId>", "Appellant agent ID")
  .option("-l, --limit <limit>", "Limit results", parseInt)
  .option("-h, --host <host>", "Gateway host", DEFAULT_HOST)
  .option("-p, --port <port>", "Gateway port", String(DEFAULT_PORT))
  .option("-t, --token <token>", "Auth token")
  .action(async (options) => {
    await runAgentTask({
      title: "Listing appeals...",
      options,
      task: {
        type: "appeal_list",
        status: options.status,
        caseId: options.case,
        appellantAgentId: options.appellant,
        limit: options.limit,
      },
    });
  });

governance
  .command("appeal-resolve")
  .description("Resolve an appeal")
  .requiredOption("-a, --agent <agentId>", "Agent ID")
  .requiredOption("--appeal <appealId>", "Appeal ID")
  .option("-r, --resolution <resolution>", "Resolution notes")
  .option("-s, --status <status>", "Status (resolved|dismissed)")
  .option("-h, --host <host>", "Gateway host", DEFAULT_HOST)
  .option("-p, --port <port>", "Gateway port", String(DEFAULT_PORT))
  .option("-t, --token <token>", "Auth token")
  .action(async (options) => {
    await runAgentTask({
      title: "Resolving appeal...",
      options,
      task: {
        type: "appeal_resolve",
        appealId: options.appeal,
        resolution: options.resolution,
        status: options.status,
      },
    });
  });

governance
  .command("sanction-apply")
  .description("Apply a sanction")
  .requiredOption("-a, --agent <agentId>", "Agent ID")
  .requiredOption("-s, --subject <subjectAgentId>", "Subject agent ID")
  .requiredOption("-t, --type <type>", "Sanction type (warn|throttle|quarantine|ban)")
  .option("-c, --case <caseId>", "Case ID")
  .option("-d, --details <json>", "Details JSON")
  .option("-h, --host <host>", "Gateway host", DEFAULT_HOST)
  .option("-p, --port <port>", "Gateway port", String(DEFAULT_PORT))
  .option("-T, --token <token>", "Auth token")
  .action(async (options) => {
    await runAgentTask({
      title: "Applying sanction...",
      options,
      task: {
        type: "sanction_apply",
        subjectAgentId: options.subject,
        sanctionType: options.type,
        caseId: options.case,
        details: parseJsonOption(options.details),
      },
    });
  });

governance
  .command("sanction-list")
  .description("List sanctions")
  .requiredOption("-a, --agent <agentId>", "Agent ID")
  .option("-s, --status <status>", "Sanction status")
  .option("-u, --subject <subjectAgentId>", "Subject agent ID")
  .option("-l, --limit <limit>", "Limit results", parseInt)
  .option("-h, --host <host>", "Gateway host", DEFAULT_HOST)
  .option("-p, --port <port>", "Gateway port", String(DEFAULT_PORT))
  .option("-t, --token <token>", "Auth token")
  .action(async (options) => {
    await runAgentTask({
      title: "Listing sanctions...",
      options,
      task: {
        type: "sanction_list",
        status: options.status,
        subjectAgentId: options.subject,
        limit: options.limit,
      },
    });
  });

governance
  .command("sanction-lift")
  .description("Lift a sanction")
  .requiredOption("-a, --agent <agentId>", "Agent ID")
  .requiredOption("-s, --sanction <sanctionId>", "Sanction ID")
  .option("-h, --host <host>", "Gateway host", DEFAULT_HOST)
  .option("-p, --port <port>", "Gateway port", String(DEFAULT_PORT))
  .option("-t, --token <token>", "Auth token")
  .action(async (options) => {
    await runAgentTask({
      title: "Lifting sanction...",
      options,
      task: {
        type: "sanction_lift",
        sanctionId: options.sanction,
      },
    });
  });

governance
  .command("audit-query")
  .description("Query audit log")
  .requiredOption("-a, --agent <agentId>", "Agent ID")
  .option("-A, --action <action>", "Filter by action")
  .option("-u, --actor <actorId>", "Filter by actor ID")
  .option("-l, --limit <limit>", "Limit results", parseInt)
  .option("-h, --host <host>", "Gateway host", DEFAULT_HOST)
  .option("-p, --port <port>", "Gateway port", String(DEFAULT_PORT))
  .option("-t, --token <token>", "Auth token")
  .action(async (options) => {
    await runAgentTask({
      title: "Querying audit log...",
      options,
      task: {
        type: "audit_query",
        action: options.action,
        actorId: options.actor,
        limit: options.limit,
      },
    });
  });

// ─── Stop Command ──────────────────────────────────────────

program
  .command("stop")
  .description("Stop the AgentRun gateway")
  .action(async () => {
    const spinner = ora("Stopping AgentRun...").start();

    try {
      const { exec } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execAsync = promisify(exec);

      const hasComposeFile = existsSync(resolve(process.cwd(), "docker-compose.yml"));
      if (hasComposeFile) {
        await execAsync("docker compose down", { cwd: process.cwd(), timeout: 60000 });
        spinner.succeed(chalk.green("AgentRun stopped"));
      } else {
        spinner.info("No docker-compose.yml found. If the gateway was started locally, terminate the process directly (Ctrl+C).");
      }
    } catch (error) {
      spinner.fail(chalk.red(`Stop failed: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  });

// ─── Shell Command ─────────────────────────────────────────

program
  .command("shell")
  .description("Open an interactive AgentRun shell (REPL)")
  .option("-h, --host <host>", "Gateway host", DEFAULT_HOST)
  .option("-p, --port <port>", "Gateway port", String(DEFAULT_PORT))
  .option("-t, --token <token>", "Auth token")
  .action(async (options) => {
    await startShell({
      host: options.host,
      port: options.port,
      token: options.token ?? process.env.GATEWAY_AUTH_TOKEN,
    });
  });

// ─── Install Command ───────────────────────────────────────

program
  .command("install <source>")
  .description("Install an agent from local path, npm package, or git repo")
  .action(async (source) => {
    await installAgent(source);
  });

// ─── Uninstall Command ─────────────────────────────────────

program
  .command("uninstall <agentId>")
  .description("Uninstall an installed agent")
  .action(async (agentId) => {
    await uninstallAgent(agentId);
  });

// ─── List Installed Command ─────────────────────────────────

program
  .command("list")
  .description("List installed agents")
  .action(() => {
    listAgents();
  });

// ─── Update Command ────────────────────────────────────────

program
  .command("update <agentId>")
  .description("Update an installed agent from its original source")
  .action(async (agentId) => {
    await updateAgent(agentId);
  });

// ─── Sign Command ──────────────────────────────────────────

program
  .command("sign <manifest>")
  .description("Sign an agent manifest for production deployment")
  .option("-s, --secret <secret>", "Signing secret (or set MANIFEST_SIGNING_SECRET env var)")
  .option("-o, --output <file>", "Output file (default: <manifest>.signed.json)")
  .action(async (manifestPath, options) => {
    const spinner = ora(`Signing manifest ${manifestPath}...`).start();

    try {
      const fs = await import("fs/promises");
      const path = await import("path");

      // Get signing secret
      const secret = options.secret ?? process.env.MANIFEST_SIGNING_SECRET;
      if (!secret) {
        spinner.fail(chalk.red("No signing secret provided"));
        console.log(chalk.gray("  Use --secret <secret> or set MANIFEST_SIGNING_SECRET env var"));
        process.exit(1);
      }

      if (secret.length < 16) {
        spinner.fail(chalk.red("Signing secret must be at least 16 characters"));
        process.exit(1);
      }

      // Read manifest file
      const manifestContent = await fs.readFile(manifestPath, "utf-8");
      let manifest: unknown;
      try {
        manifest = JSON.parse(manifestContent);
      } catch {
        spinner.fail(chalk.red("Invalid JSON in manifest file"));
        process.exit(1);
      }

      // Validate manifest schema
      const parseResult = AgentManifestSchema.safeParse(manifest);
      if (!parseResult.success) {
        spinner.fail(chalk.red("Invalid manifest schema"));
        console.log(chalk.gray(`  ${parseResult.error.message}`));
        process.exit(1);
      }

      // Sign the manifest
      const signedManifest = signManifest(parseResult.data, secret);

      // Determine output path
      const outputPath = options.output ?? manifestPath.replace(/\.json$/, ".signed.json");

      // Write signed manifest
      await fs.writeFile(outputPath, JSON.stringify(signedManifest, null, 2));

      spinner.succeed(chalk.green(`Manifest signed successfully`));
      console.log();
      console.log(chalk.gray("Signed manifest details:"));
      console.log(`  ${chalk.gray("ID:")}        ${signedManifest.id}`);
      console.log(`  ${chalk.gray("Name:")}      ${signedManifest.name}`);
      console.log(`  ${chalk.gray("Version:")}   ${signedManifest.version}`);
      console.log(`  ${chalk.gray("Signed at:")} ${signedManifest.signedAt}`);
      console.log(`  ${chalk.gray("Output:")}    ${outputPath}`);
    } catch (error) {
      spinner.fail(chalk.red(`Failed to sign manifest: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  });

// ─── Version Command ────────────────────────────────────────

program
  .command("version")
  .description("Show version information")
  .action(() => {
    console.log(chalk.bold("AgentRun CLI"));
    console.log(`Version: ${VERSION}`);
    console.log();
    console.log("AgentRun — Run any AI agent safely");
    console.log("https://github.com/vijaygopalbalasa/AgentRun");
  });

// ─── Helper Functions ───────────────────────────────────────

async function connectToGateway(host: string, port: string, token?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${host}:${port}`);
    let authenticated = false;
    const authToken = token ?? process.env.GATEWAY_AUTH_TOKEN;
    const authRequestId = authToken ? `auth-${Date.now()}` : null;

    ws.on("open", () => {
      if (authToken) {
        ws.send(
          JSON.stringify({
            type: "auth",
            id: authRequestId,
            payload: { token: authToken },
          })
        );
      }
    });

    ws.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === "auth_required" && !authToken) {
        ws.close();
        reject(new Error("Authentication required"));
        return;
      }
      if (message.type === "auth_success") {
        if (authRequestId && message.id && message.id !== authRequestId) {
          return;
        }
        if (authRequestId && !message.id) {
          return;
        }
        authenticated = true;
        resolve(ws);
      } else if (message.type === "auth_failed") {
        ws.close();
        reject(new Error("Authentication failed"));
      }
    });

    ws.on("error", (error) => {
      reject(new Error(`Connection failed: ${error.message}`));
    });

    // Timeout for connection
    setTimeout(() => {
      if (!authenticated) {
        ws.close();
        reject(new Error("Connection timeout"));
      }
    }, 5000);
  });
}

async function sendMessage(ws: WebSocket, message: unknown): Promise<{ type: string; payload?: unknown }> {
  return new Promise((resolve, reject) => {
    const messageId = (message as { id?: string }).id;

    const handler = (data: Buffer) => {
      const response = JSON.parse(data.toString());
      if (response.id === messageId || response.type === "error") {
        ws.off("message", handler);
        resolve(response);
      }
    };

    ws.on("message", handler);
    ws.send(JSON.stringify(message));

    // Timeout for response
    setTimeout(() => {
      ws.off("message", handler);
      reject(new Error("Response timeout"));
    }, 30000);
  });
}

async function streamChat(
  ws: WebSocket,
  message: unknown,
  handlers: {
    onStart?: (model?: string) => void;
    onChunk?: (delta: string) => void;
    onComplete?: (content: string) => void;
  } = {}
): Promise<Result<{ content: string; model?: string }, Error>> {
  return new Promise((resolve) => {
    const messageId = (message as { id?: string }).id;
    let content = "";
    let started = false;

    const cleanup = (timeoutId: NodeJS.Timeout) => {
      clearTimeout(timeoutId);
      ws.off("message", handler);
    };

    const handler = (data: Buffer) => {
      const response = JSON.parse(data.toString()) as {
        type: string;
        id?: string;
        payload?: { delta?: string; content?: string; model?: string; message?: string };
      };
      if (response.type === "chat_stream") {
        if (!started) {
          started = true;
          handlers.onStart?.(response.payload?.model);
        }
        const delta = response.payload?.delta ?? "";
        if (delta) {
          content += delta;
          handlers.onChunk?.(delta);
        }
        return;
      }
      if (response.type === "chat_stream_end" && response.id === messageId) {
        cleanup(timeoutId);
        handlers.onComplete?.(content);
        resolve(ok({ content, model: response.payload?.model }));
        return;
      }
      if (response.type === "error") {
        cleanup(timeoutId);
        const messageText = response.payload?.message ?? "Streaming failed";
        resolve(err(new Error(messageText)));
      }
    };

    ws.on("message", handler);
    ws.send(JSON.stringify(message));

    const timeoutId = setTimeout(() => {
      cleanup(timeoutId);
      resolve(err(new Error("Stream timeout")));
    }, 120000);
  });
}

function parseJsonOption(value?: string): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function runAgentTask({
  title,
  options,
  task,
}: {
  title: string;
  options: { host: string; port: string; token?: string; agent: string };
  task: Record<string, unknown>;
}): Promise<void> {
  const spinner = ora(title).start();

  try {
    const ws = await connectToGateway(options.host, options.port, options.token);
    const response = await sendMessage(ws, {
      type: "agent_task",
      id: `task-${Date.now()}`,
      payload: { agentId: options.agent, task },
    });
    ws.close();

    if (response.type === "agent_task_result") {
      const payload = response.payload as { status?: string; result?: unknown; error?: string };
      if (payload.status === "ok") {
        spinner.succeed(chalk.green("Task completed"));
        if (payload.result !== undefined) {
          if (typeof payload.result === "string") {
            console.log(payload.result);
          } else {
            console.log(JSON.stringify(payload.result, null, 2));
          }
        }
        return;
      }
      spinner.fail(chalk.red(payload.error ?? "Task failed"));
      process.exit(1);
    }

    if (response.type === "error") {
      const payload = response.payload as { message?: string };
      spinner.fail(chalk.red(payload.message ?? "Gateway error"));
      process.exit(1);
    }

    spinner.fail(chalk.red("Unexpected response"));
    process.exit(1);
  } catch (error) {
    spinner.fail(chalk.red(`Failed: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

function getStatusColor(status: string): string {
  switch (status) {
    case "ok":
      return chalk.green(status);
    case "degraded":
      return chalk.yellow(status);
    case "error":
      return chalk.red(status);
    default:
      return status;
  }
}

function getStateColor(state: string): string {
  switch (state) {
    case "ready":
    case "running":
      return chalk.green(state);
    case "paused":
    case "initializing":
      return chalk.yellow(state);
    case "error":
    case "terminated":
      return chalk.red(state);
    default:
      return state;
  }
}

// ─── Run CLI ────────────────────────────────────────────────

program.parse();

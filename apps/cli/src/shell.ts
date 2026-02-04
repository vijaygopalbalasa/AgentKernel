// AgentRun Shell — Interactive REPL for managing the OS
// Like bash/zsh for Linux or adb shell for Android.

import chalk from "chalk";
import { WebSocket } from "ws";
import { createInterface, type Interface } from "node:readline";

interface ShellOptions {
  host: string;
  port: string;
  token?: string;
}

interface ShellState {
  ws: WebSocket | null;
  rl: Interface | null;
  authenticated: boolean;
  streaming: boolean;
  eventStream: boolean;
  pendingRequests: Map<string, { resolve: (value: unknown) => void; reject: (err: Error) => void }>;
}

const PROMPT = chalk.cyan("agentrun") + chalk.gray("> ");

const HELP_TEXT = `
${chalk.bold("AgentRun Shell — OS Management Commands")}

${chalk.yellow("Agent Management")}
  /agents                    List running agents
  /agent <id> status         Agent details
  /agent <id> restart        Restart an agent
  /agent <id> terminate      Stop an agent

${chalk.yellow("Memory")}
  /memory search <query>     Search across agent memory
  /memory stats              Memory usage statistics

${chalk.yellow("Tools & Providers")}
  /tools                     List available tools
  /providers                 List LLM providers and models

${chalk.yellow("Monitoring")}
  /health                    Gateway health check
  /events                    Toggle live event streaming

${chalk.yellow("Agent Interaction")}
  /chat <message>            Send a chat to the LLM
  /chat @<agent> <message>   Send a task to a specific agent

${chalk.yellow("Agent Installation")}
  /deploy <manifest>         Deploy agent from manifest path

${chalk.yellow("Shell")}
  /help                      Show this help
  /quit                      Exit shell
`;

function generateId(): string {
  return `shell-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Start the AgentRun interactive shell.
 */
export async function startShell(options: ShellOptions): Promise<void> {
  const state: ShellState = {
    ws: null,
    rl: null,
    authenticated: false,
    streaming: false,
    eventStream: false,
    pendingRequests: new Map(),
  };

  console.log(chalk.bold("\nAgentRun Shell"));
  console.log(chalk.gray("Type /help for commands, /quit to exit\n"));

  // Connect to gateway
  try {
    state.ws = await connect(options, state);
    console.log(chalk.green("Connected to gateway") + chalk.gray(` (${options.host}:${options.port})\n`));
  } catch (error) {
    console.error(chalk.red(`Failed to connect: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }

  // Set up readline
  state.rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: PROMPT,
    terminal: true,
  });

  state.rl.prompt();

  state.rl.on("line", (line) => {
    const input = line.trim();
    if (!input) {
      state.rl?.prompt();
      return;
    }

    void handleInput(input, state, options).then(() => {
      if (!state.streaming) {
        state.rl?.prompt();
      }
    });
  });

  state.rl.on("close", () => {
    console.log(chalk.gray("\nGoodbye."));
    state.ws?.close();
    process.exit(0);
  });
}

async function connect(options: ShellOptions, state: ShellState): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${options.host}:${options.port}`);
    const authToken = options.token ?? process.env.GATEWAY_AUTH_TOKEN;
    const authId = `auth-${Date.now()}`;

    ws.on("open", () => {
      if (authToken) {
        ws.send(JSON.stringify({ type: "auth", id: authId, payload: { token: authToken } }));
      }
    });

    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as {
        type: string;
        id?: string;
        payload?: Record<string, unknown>;
      };

      // Auth handling
      if (msg.type === "auth_required" && !authToken) {
        ws.close();
        reject(new Error("Auth required. Set GATEWAY_AUTH_TOKEN or use --token"));
        return;
      }
      if (msg.type === "auth_success") {
        state.authenticated = true;
        resolve(ws);
        return;
      }
      if (msg.type === "auth_failed") {
        ws.close();
        reject(new Error("Auth failed"));
        return;
      }

      // Streaming chat
      if (msg.type === "chat_stream") {
        const delta = (msg.payload?.delta ?? "") as string;
        if (delta) process.stdout.write(delta);
        return;
      }
      if (msg.type === "chat_stream_end") {
        process.stdout.write("\n");
        state.streaming = false;
        state.rl?.prompt();
        return;
      }

      // Event streaming
      if (msg.type === "event" && state.eventStream) {
        const channel = msg.payload?.channel ?? "unknown";
        const eventType = msg.payload?.type ?? "unknown";
        console.log(chalk.magenta(`[event] `) + chalk.yellow(`${String(channel)}:${String(eventType)}`) +
          chalk.gray(` ${JSON.stringify(msg.payload?.data ?? {}).slice(0, 100)}`));
        state.rl?.prompt();
        return;
      }

      // Pending request responses
      if (msg.id && state.pendingRequests.has(msg.id)) {
        const pending = state.pendingRequests.get(msg.id);
        state.pendingRequests.delete(msg.id);
        pending?.resolve(msg);
        return;
      }
    });

    ws.on("error", (error) => {
      reject(new Error(`WebSocket error: ${error.message}`));
    });

    ws.on("close", () => {
      if (state.authenticated) {
        console.log(chalk.red("\nConnection lost. Exiting."));
        process.exit(1);
      }
    });

    setTimeout(() => {
      if (!state.authenticated) {
        ws.close();
        reject(new Error("Connection timeout"));
      }
    }, 10000);
  });
}

async function sendRequest(
  state: ShellState,
  message: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    throw new Error("Not connected to gateway");
  }

  const id = (message.id as string) ?? generateId();
  const msg = { ...message, id };

  return new Promise((resolve, reject) => {
    state.pendingRequests.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject,
    });
    state.ws?.send(JSON.stringify(msg));

    setTimeout(() => {
      if (state.pendingRequests.has(id)) {
        state.pendingRequests.delete(id);
        reject(new Error("Request timeout"));
      }
    }, 30000);
  });
}

async function handleInput(input: string, state: ShellState, options: ShellOptions): Promise<void> {
  // Slash commands
  if (input.startsWith("/")) {
    const parts = input.slice(1).split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);

    switch (cmd) {
      case "quit":
      case "exit":
      case "q":
        console.log(chalk.gray("Goodbye."));
        state.ws?.close();
        process.exit(0);
        break;

      case "help":
        console.log(HELP_TEXT);
        break;

      case "health":
        await cmdHealth(options);
        break;

      case "agents":
        await cmdAgents(state, options);
        break;

      case "agent":
        await cmdAgent(state, args);
        break;

      case "tools":
        await cmdTools(state);
        break;

      case "providers":
        await cmdProviders(options);
        break;

      case "memory":
        await cmdMemory(state, args);
        break;

      case "events":
        state.eventStream = !state.eventStream;
        if (state.eventStream) {
          console.log(chalk.magenta("Event streaming ON") + chalk.gray(" — /events again to stop"));
          state.ws?.send(JSON.stringify({ type: "subscribe_events", id: generateId(), payload: {} }));
        } else {
          console.log(chalk.gray("Event streaming OFF"));
          state.ws?.send(JSON.stringify({ type: "unsubscribe_events", id: generateId(), payload: {} }));
        }
        break;

      case "chat":
        await cmdChat(state, args.join(" "));
        break;

      case "deploy":
        await cmdDeploy(state, args[0]);
        break;

      default:
        console.log(chalk.red(`Unknown command: /${cmd}`) + chalk.gray(" — type /help"));
        break;
    }
    return;
  }

  // Bare text → treat as chat
  await cmdChat(state, input);
}

async function cmdHealth(options: ShellOptions): Promise<void> {
  try {
    const healthPort = Number(options.port) + 1;
    const response = await fetch(`http://${options.host}:${healthPort}/health`);
    const data = await response.json() as Record<string, unknown>;
    const status = data.status as string;
    const color = status === "ok" ? chalk.green : status === "degraded" ? chalk.yellow : chalk.red;
    console.log(`  Status:      ${color(status)}`);
    console.log(`  Version:     ${chalk.white(String(data.version ?? "unknown"))}`);
    console.log(`  Uptime:      ${chalk.white(formatUptime(Number(data.uptime ?? 0)))}`);
    console.log(`  Agents:      ${chalk.white(String(data.agents ?? 0))}`);
    console.log(`  Connections: ${chalk.white(String(data.connections ?? 0))}`);
    console.log(`  Providers:   ${chalk.white(String(Array.isArray(data.providers) ? data.providers.join(", ") : "none"))}`);
  } catch (error) {
    console.log(chalk.red(`Health check failed: ${error instanceof Error ? error.message : String(error)}`));
  }
}

async function cmdAgents(state: ShellState, options: ShellOptions): Promise<void> {
  try {
    const response = await sendRequest(state, {
      type: "agent_list",
      payload: {},
    }) as { payload?: { agents?: Array<Record<string, unknown>> } };

    const agents = response.payload?.agents ?? [];
    if (agents.length === 0) {
      console.log(chalk.gray("  No agents running"));
      return;
    }

    console.log(chalk.bold(`  ${agents.length} agent(s) running:\n`));
    for (const agent of agents) {
      const stateStr = String(agent.state ?? "unknown");
      const stateColor = stateStr === "ready" || stateStr === "running" ? chalk.green : chalk.yellow;
      console.log(
        `  ${chalk.cyan(String(agent.id ?? "?").padEnd(16))} ` +
        `${stateColor(stateStr.padEnd(12))} ` +
        chalk.gray(String(agent.name ?? ""))
      );
    }
  } catch (error) {
    console.log(chalk.red(`Failed: ${error instanceof Error ? error.message : String(error)}`));
  }
}

async function cmdAgent(state: ShellState, args: string[]): Promise<void> {
  if (args.length < 2) {
    console.log(chalk.gray("Usage: /agent <id> <status|restart|terminate>"));
    return;
  }
  const [agentId, action] = args;

  if (action === "status") {
    try {
      const response = await sendRequest(state, {
        type: "agent_status",
        payload: { agentId },
      }) as { payload?: Record<string, unknown> };
      console.log(JSON.stringify(response.payload, null, 2));
    } catch (error) {
      console.log(chalk.red(`Failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  } else if (action === "terminate") {
    try {
      await sendRequest(state, {
        type: "agent_terminate",
        payload: { agentId },
      });
      console.log(chalk.green(`Agent ${agentId} terminated`));
    } catch (error) {
      console.log(chalk.red(`Failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  } else if (action === "restart") {
    try {
      await sendRequest(state, { type: "agent_terminate", payload: { agentId } });
      console.log(chalk.yellow(`Agent ${agentId} terminated, restarting...`));
      // Re-deploy would need manifest — simplified for now
      console.log(chalk.gray("Use /deploy <manifest> to redeploy the agent"));
    } catch (error) {
      console.log(chalk.red(`Failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  } else {
    console.log(chalk.gray("Actions: status, restart, terminate"));
  }
}

async function cmdTools(state: ShellState): Promise<void> {
  try {
    const response = await sendRequest(state, {
      type: "agent_task",
      payload: { agentId: "__system__", task: { type: "list_tools" }, internal: true },
    }) as { payload?: { result?: { tools?: Array<Record<string, unknown>> } } };

    const tools = response.payload?.result?.tools ?? [];
    if (tools.length === 0) {
      console.log(chalk.gray("  No tools available"));
      return;
    }

    console.log(chalk.bold(`  ${tools.length} tool(s):\n`));
    for (const tool of tools) {
      console.log(`  ${chalk.cyan(String(tool.id ?? "?").padEnd(28))} ${chalk.gray(String(tool.description ?? ""))}`);
    }
  } catch (error) {
    console.log(chalk.red(`Failed: ${error instanceof Error ? error.message : String(error)}`));
  }
}

async function cmdProviders(options: ShellOptions): Promise<void> {
  try {
    const healthPort = Number(options.port) + 1;
    const response = await fetch(`http://${options.host}:${healthPort}/health`);
    const data = await response.json() as { providers?: string[] };
    const providers = data.providers ?? [];
    if (providers.length === 0) {
      console.log(chalk.gray("  No providers configured"));
      return;
    }
    console.log(chalk.bold(`  ${providers.length} provider(s):\n`));
    for (const p of providers) {
      console.log(`  ${chalk.cyan(p)}`);
    }
  } catch (error) {
    console.log(chalk.red(`Failed: ${error instanceof Error ? error.message : String(error)}`));
  }
}

async function cmdMemory(state: ShellState, args: string[]): Promise<void> {
  if (args.length === 0) {
    console.log(chalk.gray("Usage: /memory search <query>  or  /memory stats"));
    return;
  }

  const subCmd = args[0];
  if (subCmd === "search" && args.length > 1) {
    const query = args.slice(1).join(" ");
    try {
      const response = await sendRequest(state, {
        type: "agent_task",
        payload: {
          agentId: "__system__",
          task: { type: "search_memory", query, types: ["semantic", "episodic"], limit: 10 },
          internal: true,
        },
      }) as { payload?: { result?: { memories?: Array<Record<string, unknown>>; total?: number } } };

      const memories = response.payload?.result?.memories ?? [];
      if (memories.length === 0) {
        console.log(chalk.gray("  No memories found"));
        return;
      }

      console.log(chalk.bold(`  ${memories.length} result(s):\n`));
      for (const m of memories) {
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m);
        console.log(`  ${chalk.yellow(String(m.type ?? "?").padEnd(10))} ${chalk.white(content.slice(0, 100))}`);
      }
    } catch (error) {
      console.log(chalk.red(`Failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  } else if (subCmd === "stats") {
    console.log(chalk.gray("  Memory stats not yet implemented"));
  } else {
    console.log(chalk.gray("Usage: /memory search <query>  or  /memory stats"));
  }
}

async function cmdChat(state: ShellState, input: string): Promise<void> {
  if (!input.trim()) return;

  // Check for @agent mention
  const mentionMatch = input.match(/^@(\S+)\s+(.+)/);
  if (mentionMatch) {
    const agentId = mentionMatch[1];
    const taskContent = mentionMatch[2];
    console.log(chalk.gray(`  → routing to @${agentId}`));

    try {
      const response = await sendRequest(state, {
        type: "agent_task",
        payload: {
          agentId,
          task: { type: "chat", question: taskContent, content: taskContent },
        },
      }) as { payload?: { result?: unknown; status?: string; error?: string } };

      if (response.payload?.status === "error") {
        console.log(chalk.red(`  Error: ${response.payload.error ?? "Task failed"}`));
      } else {
        const result = response.payload?.result;
        if (typeof result === "string") {
          console.log(result);
        } else if (result && typeof result === "object") {
          const r = result as Record<string, unknown>;
          console.log(String(r.content ?? r.answer ?? r.message ?? JSON.stringify(result, null, 2)));
        }
      }
    } catch (error) {
      console.log(chalk.red(`Failed: ${error instanceof Error ? error.message : String(error)}`));
    }
    return;
  }

  // Direct LLM chat with streaming
  state.streaming = true;
  const messageId = generateId();

  state.ws?.send(JSON.stringify({
    type: "chat",
    id: messageId,
    payload: {
      messages: [{ role: "user", content: input }],
      stream: true,
    },
  }));
}

async function cmdDeploy(state: ShellState, manifestPath: string | undefined): Promise<void> {
  if (!manifestPath) {
    console.log(chalk.gray("Usage: /deploy <path-to-manifest.json>"));
    return;
  }

  try {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const resolved = path.resolve(process.cwd(), manifestPath);
    const content = await fs.readFile(resolved, "utf-8");
    const manifest = JSON.parse(content) as Record<string, unknown>;

    const response = await sendRequest(state, {
      type: "agent_spawn",
      payload: { manifest },
    }) as { payload?: { agentId?: string; status?: string } };

    if (response.payload?.status === "ready") {
      console.log(chalk.green(`Agent ${response.payload.agentId ?? manifest.id} deployed`));
    } else {
      console.log(chalk.red("Deploy failed"));
      console.log(JSON.stringify(response.payload, null, 2));
    }
  } catch (error) {
    console.log(chalk.red(`Failed: ${error instanceof Error ? error.message : String(error)}`));
  }
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

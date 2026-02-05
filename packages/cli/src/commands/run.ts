// Run Command — Start the AgentKernel security proxy
// Usage: agentkernel run [-c config.yaml] [--audit-db] [--port 3456]

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { CAC } from "cac";
import pc from "picocolors";

import {
  type Database,
  type DatabaseConfig,
  type Logger,
  createDatabase,
  createLogger,
  onShutdown,
} from "@agentkernel/kernel";
import {
  type AuditLogger,
  createAuditLoggerWithDatabase,
  loadPolicySetFromFile,
} from "@agentkernel/runtime";
import {
  type OpenClawAuditEvent,
  type OpenClawProxyConfig,
  type OpenClawSecurityProxy,
  createOpenClawProxy,
} from "@agentkernel/agent-kernel";

/** Parse a PostgreSQL connection string into DatabaseConfig */
function parseDatabaseUrl(url: string): DatabaseConfig {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 5432,
    database: parsed.pathname.replace(/^\//, "") || "agentkernel",
    user: decodeURIComponent(parsed.username || "agentkernel"),
    password: decodeURIComponent(parsed.password || ""),
    ssl:
      parsed.searchParams.get("sslmode") === "require" || parsed.searchParams.get("ssl") === "true",
    maxConnections: 10,
    idleTimeout: 30000,
  };
}

export interface RunOptions {
  config?: string;
  auditDb?: boolean;
  port?: number;
  gateway?: string;
  agentId?: string;
  verbose?: boolean;
}

interface RunContext {
  logger: Logger;
  database: Database | null;
  auditLogger: AuditLogger | null;
  proxy: OpenClawSecurityProxy | null;
}

export async function runProxy(options: RunOptions): Promise<RunContext> {
  const logger = createLogger({
    name: "agentkernel",
    level: options.verbose ? "debug" : "info",
    pretty: true,
  });

  const context: RunContext = {
    logger,
    database: null,
    auditLogger: null,
    proxy: null,
  };

  try {
    logger.info("Starting AgentKernel security proxy...");

    // Setup database if audit-db is enabled
    if (options.auditDb) {
      const dbUrl = process.env.DATABASE_URL;
      if (!dbUrl) {
        throw new Error("DATABASE_URL environment variable is required when --audit-db is enabled");
      }
      logger.info("Connecting to PostgreSQL for audit logging...");
      const dbConfig = parseDatabaseUrl(dbUrl);
      context.database = createDatabase(dbConfig, logger);
      await context.database.connectionReady;
      logger.info("Database connected");

      context.auditLogger = createAuditLoggerWithDatabase({
        database: context.database,
        includeConsole: options.verbose,
      });
    }

    // Build proxy configuration
    const proxyConfig = buildProxyConfig(options, logger, context.auditLogger);

    // Create and start proxy (createOpenClawProxy already starts it)
    logger.info(`Starting proxy on port ${proxyConfig.listenPort ?? 18788}...`);
    context.proxy = await createOpenClawProxy(proxyConfig);

    logger.info(pc.green(`AgentKernel proxy running on port ${proxyConfig.listenPort ?? 18788}`));
    logger.info(pc.dim(`Gateway: ${proxyConfig.gatewayUrl ?? "ws://127.0.0.1:18789"}`));

    if (options.auditDb) {
      logger.info(pc.dim("Audit logging: PostgreSQL"));
    }

    // Setup graceful shutdown
    onShutdown("agentkernel-proxy", async () => {
      logger.info("Shutting down...");

      if (context.proxy) {
        await context.proxy.stop();
        logger.debug("Proxy stopped");
      }

      if (context.auditLogger) {
        await context.auditLogger.close();
        logger.debug("Audit logger closed");
      }

      if (context.database) {
        await context.database.close();
        logger.debug("Database closed");
      }

      logger.info("Shutdown complete");
    });

    return context;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to start proxy: ${message}`);
    throw error;
  }
}

function buildProxyConfig(
  options: RunOptions,
  logger: Logger,
  auditLogger: AuditLogger | null,
): OpenClawProxyConfig {
  const gatewayUrl = options.gateway ?? process.env.OPENCLAW_GATEWAY_URL ?? "ws://127.0.0.1:18789";

  // SECURITY: SSRF validation is ON by default
  // Only skip with explicit AGENTKERNEL_SKIP_SSRF_VALIDATION=true for local dev
  const isLocalhost = gatewayUrl.includes("127.0.0.1") || gatewayUrl.includes("localhost");
  const explicitSkip = process.env.AGENTKERNEL_SKIP_SSRF_VALIDATION === "true";

  // SSRF validation is always ON unless explicitly disabled for localhost only
  const skipSsrfValidation = isLocalhost && explicitSkip;

  if (!skipSsrfValidation && isLocalhost) {
    logger.info(
      pc.dim(
        "[SECURITY] SSRF validation enabled. Set AGENTKERNEL_SKIP_SSRF_VALIDATION=true to disable for local dev.",
      ),
    );
  }

  const config: OpenClawProxyConfig = {
    listenPort: options.port ?? 18788,
    gatewayUrl,
    agentId: options.agentId ?? process.env.OPENCLAW_AGENT_ID ?? "agentkernel-proxy",
    skipSsrfValidation,
  };

  // Add audit logger as a sink if available
  if (auditLogger) {
    config.auditSinks = [
      {
        write: (event: OpenClawAuditEvent) => {
          auditLogger.tool(config.agentId ?? "proxy", {
            toolName: event.toolName ?? "unknown",
            action: "invoke",
            inputSummary: event.details ? JSON.stringify(event.details).slice(0, 100) : "",
          });
        },
      },
    ];
  }

  // Load policy from config file if provided
  if (options.config) {
    const configPath = resolve(process.cwd(), options.config);

    if (!existsSync(configPath)) {
      throw new Error(`Config file not found: ${configPath}`);
    }

    logger.info(`Loading policy from ${options.config}...`);
    config.policySet = loadPolicySetFromFile(configPath);
    logger.info(
      pc.dim(
        `Policy loaded: ${config.policySet?.name ?? "unnamed"} (${
          config.policySet?.defaultDecision ?? "block"
        } by default)`,
      ),
    );
  }

  return config;
}

export function registerRunCommand(cli: CAC): void {
  cli
    .command("run", "Start the security proxy")
    .option("-c, --config <path>", "Path to policy config file (YAML/JSON)")
    .option("--audit-db", "Enable PostgreSQL audit logging (requires DATABASE_URL)")
    .option("-p, --port <port>", "Proxy listen port", { default: 18788 })
    .option("-g, --gateway <url>", "OpenClaw gateway URL")
    .option("-a, --agent-id <id>", "Agent ID for the proxy")
    .example("  agentkernel run")
    .example("  agentkernel run -c policies/production.yaml")
    .example("  agentkernel run --audit-db --port 8080")
    .example("  agentkernel run -c config.yaml --audit-db -v")
    .action(async (options: RunOptions) => {
      try {
        await runProxy(options);
        // Keep process running
        await new Promise(() => {});
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(pc.red("Error:"), message);
        process.exit(1);
      }
    });
}

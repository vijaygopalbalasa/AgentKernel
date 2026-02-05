// Status Command — Check health of AgentKernel services
// Usage: agentkernel status [--json] [--database-url]

import type { CAC } from "cac";
import pc from "picocolors";

import { type Database, type DatabaseConfig, createDatabase } from "@agentkernel/kernel";

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

export interface StatusOptions {
  json?: boolean;
  databaseUrl?: string;
  verbose?: boolean;
}

export interface ServiceStatus {
  service: string;
  status: "healthy" | "unhealthy" | "unknown";
  message?: string;
  latencyMs?: number;
  details?: Record<string, unknown>;
}

export interface StatusResult {
  timestamp: string;
  services: ServiceStatus[];
  overall: "healthy" | "degraded" | "unhealthy";
}

export async function checkStatus(options: StatusOptions): Promise<StatusResult> {
  const services: ServiceStatus[] = [];
  const timestamp = new Date().toISOString();

  // Check PostgreSQL if DATABASE_URL is available
  const dbUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (dbUrl) {
    const dbStatus = await checkDatabase(dbUrl);
    services.push(dbStatus);
  }

  // Determine overall status
  const unhealthy = services.filter((s) => s.status === "unhealthy").length;
  const unknown = services.filter((s) => s.status === "unknown").length;

  let overall: StatusResult["overall"] = "healthy";
  if (unhealthy > 0) {
    overall = "unhealthy";
  } else if (unknown > 0) {
    overall = "degraded";
  }

  return {
    timestamp,
    services,
    overall,
  };
}

async function checkDatabase(connectionString: string): Promise<ServiceStatus> {
  let db: Database | null = null;

  try {
    const start = Date.now();
    const config = parseDatabaseUrl(connectionString);
    db = createDatabase(config);
    await db.connectionReady;

    const isConnected = await db.isConnected();
    const latencyMs = Date.now() - start;

    if (isConnected) {
      const stats = db.getStats();
      return {
        service: "postgresql",
        status: "healthy",
        message: "Connected",
        latencyMs,
        details: {
          total: stats.total,
          idle: stats.idle,
          active: stats.active,
          pending: stats.pending,
        },
      };
    }

    return {
      service: "postgresql",
      status: "unhealthy",
      message: "Connection test failed",
      latencyMs,
    };
  } catch (error) {
    return {
      service: "postgresql",
      status: "unhealthy",
      message: error instanceof Error ? error.message : "Unknown error",
    };
  } finally {
    if (db) {
      await db.close();
    }
  }
}

function formatStatus(result: StatusResult): string {
  const lines: string[] = [];

  // Header
  const overallColor =
    result.overall === "healthy" ? pc.green : result.overall === "degraded" ? pc.yellow : pc.red;

  lines.push(`AgentKernel Status: ${overallColor(result.overall.toUpperCase())}`);
  lines.push(pc.dim(`Checked at: ${result.timestamp}`));
  lines.push("");

  // Services
  if (result.services.length === 0) {
    lines.push(pc.dim("No services configured to check"));
    lines.push(pc.dim("Set DATABASE_URL to check PostgreSQL connection"));
  } else {
    lines.push("Services:");
    for (const service of result.services) {
      const statusIcon =
        service.status === "healthy"
          ? pc.green("✓")
          : service.status === "unhealthy"
            ? pc.red("✗")
            : pc.yellow("?");

      let line = `  ${statusIcon} ${service.service}`;

      if (service.message) {
        line += pc.dim(` - ${service.message}`);
      }

      if (service.latencyMs !== undefined) {
        line += pc.dim(` (${service.latencyMs}ms)`);
      }

      lines.push(line);

      if (service.details) {
        for (const [key, value] of Object.entries(service.details)) {
          lines.push(pc.dim(`      ${key}: ${value}`));
        }
      }
    }
  }

  return lines.join("\n");
}

export function registerStatusCommand(cli: CAC): void {
  cli
    .command("status", "Check health of AgentKernel services")
    .option("--json", "Output in JSON format")
    .option("--database-url <url>", "PostgreSQL connection string (overrides DATABASE_URL)")
    .example("  agentkernel status")
    .example("  agentkernel status --json")
    .example("  agentkernel status --database-url postgres://localhost/mydb")
    .action(async (options: StatusOptions) => {
      try {
        const result = await checkStatus(options);

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(formatStatus(result));
        }

        // Exit with non-zero if unhealthy
        if (result.overall === "unhealthy") {
          process.exit(1);
        }
      } catch (error) {
        if (options.json) {
          console.log(
            JSON.stringify({
              error: error instanceof Error ? error.message : "Unknown error",
            }),
          );
        } else {
          console.error(pc.red("Error:"), error instanceof Error ? error.message : error);
        }
        process.exit(1);
      }
    });
}

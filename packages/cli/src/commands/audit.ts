// Audit Command — Query and display audit logs
// Usage: agentkernel audit [--limit 100] [--action tool.invoke] [--since 2024-01-01]

import type { CAC } from "cac";
import pc from "picocolors";

import { type Database, type DatabaseConfig, createDatabase } from "@agentkernel/kernel";
import {
  type AuditLogRecord,
  type AuditQueryOptions,
  type AuditStats,
  getAuditStats,
  queryAuditLogs,
} from "@agentkernel/runtime";

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

export interface AuditOptions {
  limit?: number;
  offset?: number;
  action?: string;
  outcome?: string;
  resourceType?: string;
  agentId?: string;
  since?: string;
  until?: string;
  stats?: boolean;
  json?: boolean;
  databaseUrl?: string;
  verbose?: boolean;
}

export async function queryAudit(
  options: AuditOptions,
): Promise<{ logs?: AuditLogRecord[]; stats?: AuditStats }> {
  const dbUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error("DATABASE_URL is required. Set it in your environment or use --database-url");
  }

  let db: Database | null = null;
  try {
    const config = parseDatabaseUrl(dbUrl);
    db = createDatabase(config);
    await db.connectionReady;

    if (options.stats) {
      const stats = await getAuditStats(db, {
        since: options.since ? new Date(options.since) : undefined,
        until: options.until ? new Date(options.until) : undefined,
        agentId: options.agentId,
      });
      return { stats };
    }

    const queryOptions: AuditQueryOptions = {
      limit: options.limit ?? 100,
      offset: options.offset,
      action: options.action,
      outcome: options.outcome,
      resourceType: options.resourceType,
      agentId: options.agentId,
      since: options.since ? new Date(options.since) : undefined,
      until: options.until ? new Date(options.until) : undefined,
    };

    const logs = await queryAuditLogs(db, queryOptions);
    return { logs };
  } finally {
    if (db) {
      await db.close();
    }
  }
}

function formatLogs(logs: AuditLogRecord[]): string {
  if (logs.length === 0) {
    return pc.dim("No audit logs found matching the criteria");
  }

  const lines: string[] = [];
  lines.push(`Found ${logs.length} audit log entries:\n`);

  for (const log of logs) {
    const timestamp = new Date(log.created_at).toLocaleString();
    const outcomeColor =
      log.outcome === "success"
        ? pc.green
        : log.outcome === "blocked"
          ? pc.red
          : log.outcome === "denied"
            ? pc.yellow
            : pc.dim;

    lines.push(`${pc.dim(timestamp)} ${pc.cyan(log.action)} ${outcomeColor(log.outcome)}`);

    if (log.resource_type || log.resource_id) {
      lines.push(
        pc.dim(
          `  Resource: ${log.resource_type ?? ""}${log.resource_id ? `:${log.resource_id}` : ""}`,
        ),
      );
    }

    if (log.actor_id) {
      lines.push(pc.dim(`  Agent: ${log.actor_id}`));
    }

    if (log.details && Object.keys(log.details).length > 0) {
      const detailsStr = JSON.stringify(log.details);
      const truncated = detailsStr.length > 100 ? `${detailsStr.slice(0, 100)}...` : detailsStr;
      lines.push(pc.dim(`  Details: ${truncated}`));
    }

    lines.push("");
  }

  return lines.join("\n");
}

function formatStats(stats: AuditStats): string {
  const lines: string[] = [];

  lines.push("Audit Log Statistics\n");
  lines.push(`Total entries: ${pc.bold(String(stats.total))}\n`);

  lines.push("By Outcome:");
  for (const [outcome, count] of Object.entries(stats.byOutcome)) {
    const color =
      outcome === "success"
        ? pc.green
        : outcome === "blocked"
          ? pc.red
          : outcome === "denied"
            ? pc.yellow
            : pc.dim;
    lines.push(`  ${color(outcome)}: ${count}`);
  }

  lines.push("\nBy Action:");
  const sortedActions = Object.entries(stats.byAction)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  for (const [action, count] of sortedActions) {
    lines.push(`  ${pc.cyan(action)}: ${count}`);
  }

  lines.push("\nBy Resource Type:");
  for (const [type, count] of Object.entries(stats.byResourceType)) {
    lines.push(`  ${type || "(none)"}: ${count}`);
  }

  return lines.join("\n");
}

export function registerAuditCommand(cli: CAC): void {
  cli
    .command("audit", "Query audit logs from the database")
    .option("-l, --limit <number>", "Maximum number of entries to return", { default: 100 })
    .option("-o, --offset <number>", "Skip first N entries")
    .option("-a, --action <action>", "Filter by action (e.g., tool.invoke, permission.check)")
    .option("--outcome <outcome>", "Filter by outcome (success, blocked, denied, error)")
    .option("-r, --resource-type <type>", "Filter by resource type (tool, permission, etc.)")
    .option("--agent-id <id>", "Filter by agent ID")
    .option("-s, --since <date>", "Filter entries since date (ISO format)")
    .option("-u, --until <date>", "Filter entries until date (ISO format)")
    .option("--stats", "Show statistics instead of log entries")
    .option("--json", "Output in JSON format")
    .option("--database-url <url>", "PostgreSQL connection string (overrides DATABASE_URL)")
    .example("  agentkernel audit")
    .example("  agentkernel audit --limit 50 --action tool.invoke")
    .example("  agentkernel audit --outcome blocked --since 2024-01-01")
    .example("  agentkernel audit --stats")
    .example("  agentkernel audit --stats --agent-id my-agent --json")
    .action(async (options: AuditOptions) => {
      try {
        const result = await queryAudit(options);

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        if (result.stats) {
          console.log(formatStats(result.stats));
        } else if (result.logs) {
          console.log(formatLogs(result.logs));
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

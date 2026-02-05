// AgentKernel CLI — Command-line interface for managing security proxies
// Usage: agentkernel run|status|audit

import { cac } from "cac";
import pc from "picocolors";
import { registerAuditCommand } from "./commands/audit.js";
import { registerRunCommand } from "./commands/run.js";
import { registerStatusCommand } from "./commands/status.js";

// Read version from package.json at build time
const VERSION = "0.1.0";

export const cli = cac("agentkernel");

// Global options
cli.option("--verbose, -v", "Enable verbose output");

// Register commands
registerRunCommand(cli);
registerStatusCommand(cli);
registerAuditCommand(cli);

// Default help
cli.help();
cli.version(VERSION);

// Custom error handling
cli.on("command:*", () => {
  console.error(pc.red("Unknown command: %s"), cli.args.join(" "));
  console.log(`Run ${pc.cyan("agentkernel --help")} to see available commands.`);
  process.exit(1);
});

// Export for programmatic use
export { registerRunCommand, registerStatusCommand, registerAuditCommand };

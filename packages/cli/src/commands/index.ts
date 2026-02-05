// Commands barrel export

export { registerRunCommand, runProxy, type RunOptions } from "./run.js";
export {
  registerStatusCommand,
  checkStatus,
  type StatusOptions,
  type StatusResult,
  type ServiceStatus,
} from "./status.js";
export { registerAuditCommand, queryAudit, type AuditOptions } from "./audit.js";

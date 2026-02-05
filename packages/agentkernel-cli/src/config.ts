// OpenClaw proxy configuration helpers

import type { PolicySet } from "@agentkernel/runtime";
import * as runtime from "@agentkernel/runtime";
import { z } from "zod";
import type { OpenClawProxyConfig } from "./proxy.js";

// Re-export for backwards compatibility
export const loadPolicySetFromFile = runtime.loadPolicySetFromFile;

const EnvConfigSchema = z.object({
  AGENTKERNEL_HOST: z.string().optional(),
  AGENTKERNEL_PORT: z.string().optional(),
  AGENTKERNEL_GATEWAY_URL: z.string().optional(),
  AGENTKERNEL_AGENT_ID: z.string().optional(),
  AGENTKERNEL_MAX_MESSAGES_PER_SECOND: z.string().optional(),
  AGENTKERNEL_MAX_MESSAGE_SIZE_BYTES: z.string().optional(),
  AGENTKERNEL_MESSAGE_TIMEOUT_MS: z.string().optional(),
  AGENTKERNEL_POLICY_FILE: z.string().optional(),
  AGENTKERNEL_SKIP_SSRF_VALIDATION: z.string().optional(),
  AGENTKERNEL_ALLOWED_GATEWAY_HOSTS: z.string().optional(),
  OPENCLAW_PROXY_PORT: z.string().optional(),
  OPENCLAW_GATEWAY_URL: z.string().optional(),
  OPENCLAW_AGENT_ID: z.string().optional(),
  OPENCLAW_PROXY_MAX_MESSAGES_PER_SECOND: z.string().optional(),
  OPENCLAW_PROXY_MAX_MESSAGE_SIZE_BYTES: z.string().optional(),
  OPENCLAW_PROXY_MESSAGE_TIMEOUT_MS: z.string().optional(),
  OPENCLAW_POLICY_FILE: z.string().optional(),
  OPENCLAW_SKIP_SSRF_VALIDATION: z.string().optional(),
  OPENCLAW_ALLOWED_GATEWAY_HOSTS: z.string().optional(),
});

function parseEnvNumber(value?: string): number | undefined {
  if (value === undefined) return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function parseEnvBoolean(value?: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value.toLowerCase() === "true") return true;
  if (value.toLowerCase() === "false") return false;
  return undefined;
}

function parseCsv(value?: string): string[] | undefined {
  if (!value) return undefined;
  const hosts = value
    .split(",")
    .map((host) => host.trim())
    .filter((host) => host.length > 0);
  return hosts.length > 0 ? hosts : undefined;
}

/**
 * Load OpenClaw proxy configuration from environment variables.
 */
export function loadOpenClawProxyConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Partial<OpenClawProxyConfig> {
  const raw = EnvConfigSchema.parse(env);
  const config: Partial<OpenClawProxyConfig> = {};

  const listenHost = raw.AGENTKERNEL_HOST;
  if (listenHost) config.listenHost = listenHost;

  const listenPort = parseEnvNumber(raw.AGENTKERNEL_PORT ?? raw.OPENCLAW_PROXY_PORT);
  if (listenPort) config.listenPort = listenPort;

  const gatewayUrl = raw.AGENTKERNEL_GATEWAY_URL ?? raw.OPENCLAW_GATEWAY_URL;
  if (gatewayUrl) config.gatewayUrl = gatewayUrl;

  const agentId = raw.AGENTKERNEL_AGENT_ID ?? raw.OPENCLAW_AGENT_ID;
  if (agentId) config.agentId = agentId;

  const maxMessagesPerSecond = parseEnvNumber(
    raw.AGENTKERNEL_MAX_MESSAGES_PER_SECOND ?? raw.OPENCLAW_PROXY_MAX_MESSAGES_PER_SECOND,
  );
  if (maxMessagesPerSecond) config.maxMessagesPerSecond = maxMessagesPerSecond;

  const maxMessageSizeBytes = parseEnvNumber(
    raw.AGENTKERNEL_MAX_MESSAGE_SIZE_BYTES ?? raw.OPENCLAW_PROXY_MAX_MESSAGE_SIZE_BYTES,
  );
  if (maxMessageSizeBytes) config.maxMessageSizeBytes = maxMessageSizeBytes;

  const messageTimeoutMs = parseEnvNumber(
    raw.AGENTKERNEL_MESSAGE_TIMEOUT_MS ?? raw.OPENCLAW_PROXY_MESSAGE_TIMEOUT_MS,
  );
  if (messageTimeoutMs) config.messageTimeoutMs = messageTimeoutMs;

  const policyFile = raw.AGENTKERNEL_POLICY_FILE ?? raw.OPENCLAW_POLICY_FILE;
  if (policyFile) {
    config.policySet = runtime.loadPolicySetFromFile(policyFile);
  }

  const skipSsrfValidation = parseEnvBoolean(
    raw.AGENTKERNEL_SKIP_SSRF_VALIDATION ?? raw.OPENCLAW_SKIP_SSRF_VALIDATION,
  );
  if (skipSsrfValidation !== undefined) {
    config.skipSsrfValidation = skipSsrfValidation;
  }

  const allowedGatewayHosts = parseCsv(
    raw.AGENTKERNEL_ALLOWED_GATEWAY_HOSTS ?? raw.OPENCLAW_ALLOWED_GATEWAY_HOSTS,
  );
  if (allowedGatewayHosts) {
    config.allowedGatewayHosts = allowedGatewayHosts;
  }

  return config;
}

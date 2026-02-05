// OpenClaw proxy configuration helpers

import { z } from "zod";
import { loadPolicySetFromFile, type PolicySet } from "@agentkernel/runtime";
import type { OpenClawProxyConfig } from "./proxy.js";

// Re-export for backwards compatibility
export { loadPolicySetFromFile };

const EnvConfigSchema = z.object({
  OPENCLAW_PROXY_PORT: z.string().optional(),
  OPENCLAW_GATEWAY_URL: z.string().optional(),
  OPENCLAW_AGENT_ID: z.string().optional(),
  OPENCLAW_PROXY_MAX_MESSAGES_PER_SECOND: z.string().optional(),
  OPENCLAW_PROXY_MAX_MESSAGE_SIZE_BYTES: z.string().optional(),
  OPENCLAW_PROXY_MESSAGE_TIMEOUT_MS: z.string().optional(),
  OPENCLAW_POLICY_FILE: z.string().optional(),
});

function parseEnvNumber(value?: string): number | undefined {
  if (value === undefined) return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

/**
 * Load OpenClaw proxy configuration from environment variables.
 */
export function loadOpenClawProxyConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): Partial<OpenClawProxyConfig> {
  const raw = EnvConfigSchema.parse(env);
  const config: Partial<OpenClawProxyConfig> = {};

  const listenPort = parseEnvNumber(raw.OPENCLAW_PROXY_PORT);
  if (listenPort) config.listenPort = listenPort;

  if (raw.OPENCLAW_GATEWAY_URL) config.gatewayUrl = raw.OPENCLAW_GATEWAY_URL;
  if (raw.OPENCLAW_AGENT_ID) config.agentId = raw.OPENCLAW_AGENT_ID;

  const maxMessagesPerSecond = parseEnvNumber(raw.OPENCLAW_PROXY_MAX_MESSAGES_PER_SECOND);
  if (maxMessagesPerSecond) config.maxMessagesPerSecond = maxMessagesPerSecond;

  const maxMessageSizeBytes = parseEnvNumber(raw.OPENCLAW_PROXY_MAX_MESSAGE_SIZE_BYTES);
  if (maxMessageSizeBytes) config.maxMessageSizeBytes = maxMessageSizeBytes;

  const messageTimeoutMs = parseEnvNumber(raw.OPENCLAW_PROXY_MESSAGE_TIMEOUT_MS);
  if (messageTimeoutMs) config.messageTimeoutMs = messageTimeoutMs;

  if (raw.OPENCLAW_POLICY_FILE) {
    config.policySet = loadPolicySetFromFile(raw.OPENCLAW_POLICY_FILE);
  }

  return config;
}

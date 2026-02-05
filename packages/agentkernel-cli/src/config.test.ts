import { describe, expect, it } from "vitest";
import { loadOpenClawProxyConfigFromEnv } from "./config.js";

describe("loadOpenClawProxyConfigFromEnv", () => {
  it("parses AGENTKERNEL_* variables", () => {
    const config = loadOpenClawProxyConfigFromEnv({
      AGENTKERNEL_PORT: "19999",
      AGENTKERNEL_GATEWAY_URL: "wss://gateway.example.com",
      AGENTKERNEL_AGENT_ID: "agent-1",
      AGENTKERNEL_MAX_MESSAGES_PER_SECOND: "200",
      AGENTKERNEL_MAX_MESSAGE_SIZE_BYTES: "4096",
      AGENTKERNEL_MESSAGE_TIMEOUT_MS: "15000",
      AGENTKERNEL_SKIP_SSRF_VALIDATION: "true",
      AGENTKERNEL_ALLOWED_GATEWAY_HOSTS: "gateway.example.com,api.example.com",
    });

    expect(config.listenPort).toBe(19999);
    expect(config.gatewayUrl).toBe("wss://gateway.example.com");
    expect(config.agentId).toBe("agent-1");
    expect(config.maxMessagesPerSecond).toBe(200);
    expect(config.maxMessageSizeBytes).toBe(4096);
    expect(config.messageTimeoutMs).toBe(15000);
    expect(config.skipSsrfValidation).toBe(true);
    expect(config.allowedGatewayHosts).toEqual(["gateway.example.com", "api.example.com"]);
  });

  it("supports OPENCLAW_* legacy aliases", () => {
    const config = loadOpenClawProxyConfigFromEnv({
      OPENCLAW_PROXY_PORT: "18888",
      OPENCLAW_GATEWAY_URL: "ws://legacy.example.com",
      OPENCLAW_AGENT_ID: "legacy-agent",
      OPENCLAW_PROXY_MAX_MESSAGES_PER_SECOND: "80",
      OPENCLAW_PROXY_MAX_MESSAGE_SIZE_BYTES: "1024",
      OPENCLAW_PROXY_MESSAGE_TIMEOUT_MS: "1000",
      OPENCLAW_SKIP_SSRF_VALIDATION: "false",
      OPENCLAW_ALLOWED_GATEWAY_HOSTS: "legacy.example.com",
    });

    expect(config.listenPort).toBe(18888);
    expect(config.gatewayUrl).toBe("ws://legacy.example.com");
    expect(config.agentId).toBe("legacy-agent");
    expect(config.maxMessagesPerSecond).toBe(80);
    expect(config.maxMessageSizeBytes).toBe(1024);
    expect(config.messageTimeoutMs).toBe(1000);
    expect(config.skipSsrfValidation).toBe(false);
    expect(config.allowedGatewayHosts).toEqual(["legacy.example.com"]);
  });

  it("prefers AGENTKERNEL_* over OPENCLAW_* when both are set", () => {
    const config = loadOpenClawProxyConfigFromEnv({
      AGENTKERNEL_PORT: "17777",
      OPENCLAW_PROXY_PORT: "16666",
      AGENTKERNEL_GATEWAY_URL: "ws://primary.example.com",
      OPENCLAW_GATEWAY_URL: "ws://secondary.example.com",
    });

    expect(config.listenPort).toBe(17777);
    expect(config.gatewayUrl).toBe("ws://primary.example.com");
  });
});

import { describe, expect, it } from "vitest";
import { OpenClawSecurityProxy } from "./proxy.js";

describe("OpenClawSecurityProxy URL validation", () => {
  it("allows default localhost gateway configuration", () => {
    expect(() => new OpenClawSecurityProxy()).not.toThrow();
  });

  it("blocks non-websocket gateway protocols", () => {
    expect(() => new OpenClawSecurityProxy({ gatewayUrl: "http://example.com" })).toThrow(
      /Only ws:\/\/ and wss:\/\//i,
    );
  });

  it("blocks private network gateway URLs by default", () => {
    expect(() => new OpenClawSecurityProxy({ gatewayUrl: "ws://10.0.0.15:18789" })).toThrow(
      /blocked internal ip/i,
    );
  });

  it("allows localhost URLs without requiring skipSsrfValidation", () => {
    expect(() => new OpenClawSecurityProxy({ gatewayUrl: "ws://127.0.0.1:18789" })).not.toThrow();
  });

  it("allows explicit allowlisted hosts", () => {
    expect(
      () =>
        new OpenClawSecurityProxy({
          gatewayUrl: "ws://metadata.google.internal:18789",
          allowedGatewayHosts: ["metadata.google.internal"],
        }),
    ).not.toThrow();
  });
});

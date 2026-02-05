import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isProductionHardeningEnabled } from "./hardening.js";
import { createPermissivePolicyEngine } from "./policy-engine.js";
import { AgentSandbox } from "./sandbox.js";
import { WorkerSandbox } from "./worker-sandbox.js";

describe("Runtime production hardening", () => {
  const originalHardening = process.env.ENFORCE_PRODUCTION_HARDENING;

  beforeEach(() => {
    Reflect.deleteProperty(process.env, "ENFORCE_PRODUCTION_HARDENING");
  });

  afterEach(() => {
    if (originalHardening === undefined) {
      Reflect.deleteProperty(process.env, "ENFORCE_PRODUCTION_HARDENING");
    } else {
      process.env.ENFORCE_PRODUCTION_HARDENING = originalHardening;
    }
  });

  it("should detect hardening flag", () => {
    process.env.ENFORCE_PRODUCTION_HARDENING = "true";
    expect(isProductionHardeningEnabled()).toBe(true);
    process.env.ENFORCE_PRODUCTION_HARDENING = "false";
    expect(isProductionHardeningEnabled()).toBe(false);
  });

  it("should block insecure sandbox settings when hardening is enabled", () => {
    process.env.ENFORCE_PRODUCTION_HARDENING = "true";
    expect(() => new AgentSandbox("agent-1", { enforcePermissions: false })).toThrow(
      /Production hardening/,
    );
  });

  it("should allow default sandbox settings when hardening is enabled", () => {
    process.env.ENFORCE_PRODUCTION_HARDENING = "true";
    expect(() => new AgentSandbox("agent-1")).not.toThrow();
  });

  it("should block permissive policy engines when hardening is enabled", () => {
    process.env.ENFORCE_PRODUCTION_HARDENING = "true";
    expect(() => createPermissivePolicyEngine()).toThrow(/Production hardening/);
  });

  it("should block WorkerSandbox when hardening is enabled", async () => {
    process.env.ENFORCE_PRODUCTION_HARDENING = "true";
    Reflect.deleteProperty(process.env, "ALLOW_UNSAFE_WORKER_SANDBOX");
    const sandbox = new WorkerSandbox();
    await expect(sandbox.start()).rejects.toThrow(/WorkerSandbox is not a hardened/);
  });

  it("should allow opting in to WorkerSandbox when hardening is enabled", () => {
    process.env.ENFORCE_PRODUCTION_HARDENING = "true";
    process.env.ALLOW_UNSAFE_WORKER_SANDBOX = "true";
    const sandbox = new WorkerSandbox();
    expect(sandbox).toBeDefined();
  });
});

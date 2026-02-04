import { describe, it, expect, beforeEach } from "vitest";
import {
  AdapterRegistry,
  defaultAdapterRegistry,
  type AgentAdapter,
  type AdapterConfig,
  type AdapterMessage,
  type AdapterResponse,
  type AdapterState,
} from "../adapter.js";
import { AgentSandbox, type Capability } from "../sandbox.js";

// ─── Mock Adapter ───────────────────────────────────────────

class MockAdapter implements AgentAdapter {
  readonly name = "mock";
  readonly version = "1.0.0";
  private _state: AdapterState = "idle";
  private sandbox: AgentSandbox | null = null;
  private loadedConfig: AdapterConfig | null = null;

  get state(): AdapterState {
    return this._state;
  }

  async load(config: AdapterConfig): Promise<void> {
    if (this._state !== "idle") {
      throw new Error(`Cannot load adapter in state "${this._state}" (must be "idle")`);
    }
    this.loadedConfig = config;
    this._state = "loaded";
  }

  async start(sandbox: AgentSandbox): Promise<void> {
    if (this._state !== "loaded") {
      throw new Error(`Cannot start adapter in state "${this._state}" (must be "loaded")`);
    }
    this.sandbox = sandbox;
    this._state = "running";
  }

  async stop(): Promise<void> {
    if (this._state !== "running") {
      throw new Error(`Cannot stop adapter in state "${this._state}" (must be "running")`);
    }
    this.sandbox = null;
    this._state = "stopped";
  }

  async handleMessage(message: AdapterMessage): Promise<AdapterResponse> {
    if (this._state !== "running") {
      return { type: "error", payload: { message: `Adapter is not running (state: ${this._state})` } };
    }
    return { type: "echo", payload: message.payload };
  }

  getRequiredCapabilities(): Capability[] {
    return ["llm:chat", "memory:read"];
  }

  getLoadedConfig(): AdapterConfig | null {
    return this.loadedConfig;
  }
}

// ─── Failing Adapter (for error path testing) ───────────────

class FailingAdapter implements AgentAdapter {
  readonly name = "failing";
  readonly version = "0.0.1";
  private _state: AdapterState = "idle";

  get state(): AdapterState {
    return this._state;
  }

  async load(): Promise<void> {
    this._state = "error";
    throw new Error("Configuration is invalid");
  }

  async start(): Promise<void> {
    throw new Error("Cannot start");
  }

  async stop(): Promise<void> {
    this._state = "stopped";
  }

  async handleMessage(): Promise<AdapterResponse> {
    return { type: "error", payload: { message: "Adapter failed" } };
  }

  getRequiredCapabilities(): Capability[] {
    return [];
  }
}

// ─── AdapterRegistry ────────────────────────────────────────

describe("AdapterRegistry", () => {
  let registry: AdapterRegistry;

  beforeEach(() => {
    registry = new AdapterRegistry();
  });

  it("should register and create an adapter", () => {
    registry.register("mock", () => new MockAdapter());
    const adapter = registry.create("mock");
    expect(adapter).toBeInstanceOf(MockAdapter);
    expect(adapter?.name).toBe("mock");
    expect(adapter?.version).toBe("1.0.0");
  });

  it("should return undefined for unregistered adapter", () => {
    expect(registry.create("nonexistent")).toBeUndefined();
  });

  it("should check if adapter is registered", () => {
    registry.register("mock", () => new MockAdapter());
    expect(registry.has("mock")).toBe(true);
    expect(registry.has("nonexistent")).toBe(false);
  });

  it("should list registered adapter names", () => {
    registry.register("mock", () => new MockAdapter());
    registry.register("failing", () => new FailingAdapter());
    const names = registry.list();
    expect(names).toContain("mock");
    expect(names).toContain("failing");
    expect(names).toHaveLength(2);
  });

  it("should unregister an adapter", () => {
    registry.register("mock", () => new MockAdapter());
    expect(registry.has("mock")).toBe(true);

    const removed = registry.unregister("mock");
    expect(removed).toBe(true);
    expect(registry.has("mock")).toBe(false);
    expect(registry.create("mock")).toBeUndefined();
  });

  it("should return false when unregistering non-existent adapter", () => {
    expect(registry.unregister("nonexistent")).toBe(false);
  });

  it("should create independent instances per call", () => {
    registry.register("mock", () => new MockAdapter());
    const a = registry.create("mock");
    const b = registry.create("mock");
    expect(a).not.toBe(b);
    expect(a?.state).toBe("idle");
    expect(b?.state).toBe("idle");
  });

  it("should override a registered adapter", () => {
    registry.register("mock", () => new MockAdapter());
    registry.register("mock", () => new FailingAdapter());
    const adapter = registry.create("mock");
    expect(adapter).toBeInstanceOf(FailingAdapter);
  });

  it("should start with an empty list", () => {
    expect(registry.list()).toHaveLength(0);
  });
});

describe("defaultAdapterRegistry", () => {
  it("should be an instance of AdapterRegistry", () => {
    expect(defaultAdapterRegistry).toBeInstanceOf(AdapterRegistry);
  });

  it("should support register and create", () => {
    const name = `test-default-${Date.now()}`;
    defaultAdapterRegistry.register(name, () => new MockAdapter());
    const adapter = defaultAdapterRegistry.create(name);
    expect(adapter).toBeInstanceOf(MockAdapter);
    defaultAdapterRegistry.unregister(name);
  });
});

// ─── Adapter Lifecycle ──────────────────────────────────────

describe("AgentAdapter lifecycle", () => {
  const testConfig: AdapterConfig = {
    configPath: "/tmp/test-config.yaml",
    workingDirectory: "/tmp",
    env: { NODE_ENV: "test" },
    options: {},
  };

  it("should start in idle state", () => {
    const adapter = new MockAdapter();
    expect(adapter.state).toBe("idle");
  });

  it("should transition idle → loaded on load()", async () => {
    const adapter = new MockAdapter();
    await adapter.load(testConfig);
    expect(adapter.state).toBe("loaded");
  });

  it("should transition loaded → running on start()", async () => {
    const adapter = new MockAdapter();
    const sandbox = new AgentSandbox("test-agent");
    await adapter.load(testConfig);
    await adapter.start(sandbox);
    expect(adapter.state).toBe("running");
  });

  it("should transition running → stopped on stop()", async () => {
    const adapter = new MockAdapter();
    const sandbox = new AgentSandbox("test-agent");
    await adapter.load(testConfig);
    await adapter.start(sandbox);
    await adapter.stop();
    expect(adapter.state).toBe("stopped");
  });

  it("should complete full lifecycle: idle → loaded → running → stopped", async () => {
    const adapter = new MockAdapter();
    const sandbox = new AgentSandbox("test-agent");

    expect(adapter.state).toBe("idle");
    await adapter.load(testConfig);
    expect(adapter.state).toBe("loaded");
    await adapter.start(sandbox);
    expect(adapter.state).toBe("running");
    await adapter.stop();
    expect(adapter.state).toBe("stopped");
  });

  it("should reject load() when not in idle state", async () => {
    const adapter = new MockAdapter();
    await adapter.load(testConfig);
    await expect(adapter.load(testConfig)).rejects.toThrow("idle");
  });

  it("should reject start() when not in loaded state", async () => {
    const adapter = new MockAdapter();
    const sandbox = new AgentSandbox("test-agent");
    await expect(adapter.start(sandbox)).rejects.toThrow("loaded");
  });

  it("should reject stop() when not in running state", async () => {
    const adapter = new MockAdapter();
    await expect(adapter.stop()).rejects.toThrow("running");
  });

  it("should reject start() after stop()", async () => {
    const adapter = new MockAdapter();
    const sandbox = new AgentSandbox("test-agent");
    await adapter.load(testConfig);
    await adapter.start(sandbox);
    await adapter.stop();
    await expect(adapter.start(sandbox)).rejects.toThrow("loaded");
  });
});

// ─── Adapter Message Handling ───────────────────────────────

describe("AgentAdapter message handling", () => {
  const testConfig: AdapterConfig = {
    configPath: "/tmp/test-config.yaml",
    workingDirectory: "/tmp",
    env: {},
    options: {},
  };

  it("should handle messages when running", async () => {
    const adapter = new MockAdapter();
    const sandbox = new AgentSandbox("test-agent");
    await adapter.load(testConfig);
    await adapter.start(sandbox);

    const response = await adapter.handleMessage({
      type: "chat",
      payload: { content: "Hello" },
    });
    expect(response.type).toBe("echo");
    expect(response.payload.content).toBe("Hello");
  });

  it("should return error when not running", async () => {
    const adapter = new MockAdapter();
    const response = await adapter.handleMessage({
      type: "chat",
      payload: { content: "Hello" },
    });
    expect(response.type).toBe("error");
  });

  it("should return error after stop()", async () => {
    const adapter = new MockAdapter();
    const sandbox = new AgentSandbox("test-agent");
    await adapter.load(testConfig);
    await adapter.start(sandbox);
    await adapter.stop();

    const response = await adapter.handleMessage({
      type: "chat",
      payload: { content: "Hello" },
    });
    expect(response.type).toBe("error");
  });
});

// ─── Adapter Capabilities ───────────────────────────────────

describe("AgentAdapter capabilities", () => {
  it("should report required capabilities", () => {
    const adapter = new MockAdapter();
    const caps = adapter.getRequiredCapabilities();
    expect(caps).toContain("llm:chat");
    expect(caps).toContain("memory:read");
  });

  it("should return stable capabilities across calls", () => {
    const adapter = new MockAdapter();
    const a = adapter.getRequiredCapabilities();
    const b = adapter.getRequiredCapabilities();
    expect(a).toEqual(b);
  });
});

// ─── Adapter Error Handling ─────────────────────────────────

describe("AgentAdapter error handling", () => {
  it("should transition to error state on load failure", async () => {
    const adapter = new FailingAdapter();
    await expect(adapter.load({
      configPath: "/nonexistent",
      workingDirectory: "/tmp",
      env: {},
      options: {},
    })).rejects.toThrow("Configuration is invalid");
    expect(adapter.state).toBe("error");
  });
});

// ─── Adapter Config Propagation ─────────────────────────────

describe("AgentAdapter config propagation", () => {
  it("should receive the full AdapterConfig on load", async () => {
    const adapter = new MockAdapter();
    const config: AdapterConfig = {
      configPath: "/path/to/config.yaml",
      workingDirectory: "/path/to",
      env: { CUSTOM: "value" },
      options: { debug: true },
    };

    await adapter.load(config);
    expect(adapter.getLoadedConfig()).toBe(config);
  });
});

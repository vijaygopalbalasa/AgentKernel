// Adapter — universal interface for running external agent frameworks inside AgentRun
// Allows OpenClaw, CrewAI, LangGraph, and custom agents to run sandboxed.

import type { Capability } from "./sandbox.js";
import type { AgentSandbox } from "./sandbox.js";

/** Configuration passed to an adapter when loading an external agent. */
export interface AdapterConfig {
  /** Path to the agent's configuration file (YAML, JSON, or JS/TS). */
  configPath: string;
  /** Working directory for the adapted agent. Defaults to the config file's directory. */
  workingDirectory: string;
  /** Environment variables to inject into the adapted agent. */
  env: Record<string, string>;
  /** Adapter-specific options. */
  options: Record<string, unknown>;
}

/** Inbound message forwarded to an adapted agent. */
export interface AdapterMessage {
  /** Message type (e.g. "task", "chat", "event"). */
  type: string;
  /** Message payload. */
  payload: Record<string, unknown>;
}

/** Response from an adapted agent. */
export interface AdapterResponse {
  /** Response type (e.g. "result", "error", "stream_chunk"). */
  type: string;
  /** Response payload. */
  payload: Record<string, unknown>;
}

/** Lifecycle state of an adapter instance. */
export type AdapterState = "idle" | "loaded" | "running" | "stopped" | "error";

/**
 * Universal adapter interface for external agent frameworks.
 *
 * Implement this interface to run any agent framework inside AgentRun's
 * sandboxed runtime. The adapter translates between the external framework's
 * API and AgentRun's capability-based permission model.
 *
 * @example
 * ```typescript
 * const adapter: AgentAdapter = new OpenClawAdapter();
 * await adapter.load({ configPath: "./openclaw.yaml", ... });
 * await adapter.start(sandbox);
 * const response = await adapter.handleMessage({ type: "chat", payload: { content: "Hello" } });
 * await adapter.stop();
 * ```
 */
export interface AgentAdapter {
  /** Human-readable adapter name (e.g. "openclaw", "crewai"). */
  readonly name: string;
  /** Semver version of this adapter. */
  readonly version: string;
  /** Current lifecycle state. */
  readonly state: AdapterState;

  /**
   * Load and validate the external agent's configuration.
   * Called once before start(). Should parse the config file, validate it,
   * and determine required capabilities.
   */
  load(config: AdapterConfig): Promise<void>;

  /**
   * Start the adapted agent with sandbox enforcement.
   * All capability checks are routed through the provided sandbox.
   */
  start(sandbox: AgentSandbox): Promise<void>;

  /**
   * Gracefully stop the adapted agent and clean up resources.
   */
  stop(): Promise<void>;

  /**
   * Forward a message to the adapted agent and return its response.
   * The adapter must check sandbox capabilities before allowing tool calls.
   */
  handleMessage(message: AdapterMessage): Promise<AdapterResponse>;

  /**
   * Return the capabilities this adapter requires based on the loaded config.
   * Called after load() to determine what sandbox permissions to request.
   */
  getRequiredCapabilities(): Capability[];
}

/**
 * Factory function that creates a new adapter instance.
 * Registered with AdapterRegistry for dynamic adapter loading.
 */
export type AdapterFactory = () => AgentAdapter;

/**
 * Registry for agent adapters.
 *
 * Adapters are registered by name and can be retrieved to wrap external
 * agent frameworks in AgentRun's sandboxed runtime.
 *
 * @example
 * ```typescript
 * const registry = new AdapterRegistry();
 * registry.register("openclaw", () => new OpenClawAdapter());
 * const adapter = registry.create("openclaw");
 * ```
 */
export class AdapterRegistry {
  private readonly factories: Map<string, AdapterFactory> = new Map();

  /** Register an adapter factory by name. */
  register(name: string, factory: AdapterFactory): void {
    this.factories.set(name, factory);
  }

  /** Create a new adapter instance by name. Returns undefined if not registered. */
  create(name: string): AgentAdapter | undefined {
    const factory = this.factories.get(name);
    if (!factory) return undefined;
    return factory();
  }

  /** Check if an adapter is registered. */
  has(name: string): boolean {
    return this.factories.has(name);
  }

  /** List all registered adapter names. */
  list(): string[] {
    return Array.from(this.factories.keys());
  }

  /** Remove a registered adapter. */
  unregister(name: string): boolean {
    return this.factories.delete(name);
  }
}

/** Global default adapter registry. */
export const defaultAdapterRegistry = new AdapterRegistry();

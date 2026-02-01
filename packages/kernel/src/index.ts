// @agent-os/kernel — Compute Kernel (Layer 1)
// Manages: process management, storage, network, security, logging

export { createLogger } from "./logger.js";
export { createConfig, type KernelConfig } from "./config.js";
export type { Logger } from "@agent-os/shared";

console.log("✅ @agent-os/kernel loaded");

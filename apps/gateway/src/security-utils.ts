// Security utilities for AgentRun Gateway
// Path and domain allowlist checking, manifest verification

import { createHmac } from "crypto";
import { resolve, sep } from "path";

/** Agent manifest for signing */
export interface AgentManifest {
  id: string;
  name: string;
  version?: string;
  signature?: string;
  [key: string]: unknown;
}

/**
 * Parse comma-separated allowed paths from environment.
 */
export function parseAllowedPaths(value?: string): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Parse comma-separated allowed domains from environment.
 * Supports wildcard patterns like *.example.com
 */
export function parseAllowedDomains(value?: string): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/**
 * Parse comma-separated allowed commands from environment.
 * Supports wildcard suffixes like "/usr/bin/*" or "git*".
 */
export function parseAllowedCommands(value?: string): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Parse boolean value from environment string.
 */
export function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) return true;
  if (["false", "0", "no", "n"].includes(normalized)) return false;
  return fallback;
}

/**
 * Normalize a file path to absolute form.
 */
export function normalizePath(inputPath: string): string {
  try {
    return resolve(inputPath);
  } catch {
    return inputPath;
  }
}

/**
 * Check if a path is within an allowed directory.
 */
export function isPathWithin(pathValue: string, allowed: string): boolean {
  const normalizedPath = normalizePath(pathValue);
  const normalizedAllowed = normalizePath(allowed);
  return (
    normalizedPath === normalizedAllowed ||
    normalizedPath.startsWith(normalizedAllowed + sep)
  );
}

/**
 * Check if a path is allowed based on the allowlist.
 * @param pathValue - The path to check
 * @param allowedPaths - List of allowed path prefixes
 * @param allowAll - If true, bypass all restrictions
 */
export function isPathAllowed(pathValue: string, allowedPaths: string[], allowAll: boolean): boolean {
  if (allowAll) return true;
  if (allowedPaths.length === 0) return false;
  return allowedPaths.some((allowed) => isPathWithin(pathValue, allowed));
}

/**
 * Check if a domain/host is allowed based on the allowlist.
 * Supports wildcard patterns like *.example.com
 * @param host - The hostname to check
 * @param allowedDomains - List of allowed domains (supports wildcards)
 * @param allowAll - If true, bypass all restrictions
 */
export function isDomainAllowed(host: string, allowedDomains: string[], allowAll: boolean): boolean {
  if (allowAll) return true;
  if (allowedDomains.length === 0) return false;
  const normalizedHost = host.toLowerCase();

  return allowedDomains.some((entry) => {
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(2);
      return normalizedHost === suffix || normalizedHost.endsWith(`.${suffix}`);
    }
    return normalizedHost === entry;
  });
}

/**
 * Check if a shell command is allowed.
 * Supports exact matches or wildcard prefixes ending with "*".
 */
export function isCommandAllowed(command: string, allowedCommands: string[], allowAll: boolean): boolean {
  if (allowAll) return true;
  if (allowedCommands.length === 0) return false;
  const normalized = command.trim();
  return allowedCommands.some((entry) => {
    if (entry.endsWith("*")) {
      const prefix = entry.slice(0, -1);
      return normalized.startsWith(prefix);
    }
    return normalized === entry;
  });
}

/**
 * Stable JSON stringification for deterministic hashing.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(",")}}`;
}

/**
 * Sign an agent manifest using HMAC-SHA256.
 */
export function signManifestPayload(manifest: AgentManifest, secret: string): string {
  const { signature: _signature, ...payload } = manifest;
  return createHmac("sha256", secret).update(stableStringify(payload)).digest("hex");
}

/**
 * Verify an agent manifest signature.
 */
export function verifyManifestSignature(
  manifest: AgentManifest,
  secret: string
): { ok: boolean; message?: string } {
  if (!manifest.signature) {
    return { ok: false, message: "Manifest signature missing" };
  }
  const expected = signManifestPayload(manifest, secret);
  if (expected !== manifest.signature) {
    return { ok: false, message: "Manifest signature mismatch" };
  }
  return { ok: true };
}

/**
 * Extract hostname from a URL.
 */
export function extractHostname(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    return null;
  }
}

/**
 * Validate that required production security settings are configured.
 */
export function validateProductionSecurity(config: {
  allowedPaths: string[];
  allowedDomains: string[];
  allowAllPaths: boolean;
  allowAllDomains: boolean;
  isProduction: boolean;
}): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!config.isProduction) {
    return { valid: true, errors: [] };
  }

  // In production, must have explicit allowlists OR explicit allow-all
  if (config.allowedPaths.length === 0 && !config.allowAllPaths) {
    errors.push("ALLOWED_PATHS must be set in production (or set ALLOW_ALL_PATHS=true)");
  }

  if (config.allowedDomains.length === 0 && !config.allowAllDomains) {
    errors.push("ALLOWED_DOMAINS must be set in production (or set ALLOW_ALL_DOMAINS=true)");
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Escape ILIKE special characters in user input to prevent pattern injection.
 * Prevents `%` and `_` wildcards from being used in ILIKE queries.
 */
export function escapeILikePattern(input: string): string {
  return input.replace(/[%_\\]/g, "\\$&");
}

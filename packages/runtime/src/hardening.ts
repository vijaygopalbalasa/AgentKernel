// Production hardening helpers for runtime security enforcement

const TRUTHY = new Set(["1", "true", "yes", "on"]);

export function isProductionHardeningEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.ENFORCE_PRODUCTION_HARDENING;
  if (!value) return false;
  return TRUTHY.has(value.trim().toLowerCase());
}

export const DEFAULT_GATEWAY_HOST =
  typeof window !== "undefined" ? window.location.hostname : "127.0.0.1";

export const DEFAULT_GATEWAY_PORT = 18800;
export const DEFAULT_HTTP_PORT = 18801;

export function getWsUrl(host?: string, port?: number): string {
  const h = host || DEFAULT_GATEWAY_HOST;
  const p = port || DEFAULT_GATEWAY_PORT;
  return `ws://${h}:${p}`;
}

export function getHealthUrl(host?: string, port?: number): string {
  const h = host || DEFAULT_GATEWAY_HOST;
  const p = port || DEFAULT_HTTP_PORT;
  return `http://${h}:${p}/health`;
}

export function getMetricsUrl(host?: string, port?: number): string {
  const h = host || DEFAULT_GATEWAY_HOST;
  const p = port || DEFAULT_HTTP_PORT;
  return `http://${h}:${p}/metrics`;
}

export const MAX_EVENTS = 100;
export const REQUEST_TIMEOUT_MS = 10_000;
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;

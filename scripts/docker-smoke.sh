#!/usr/bin/env bash
set -euo pipefail

start_time=$(date +%s)
compose_args=(-f docker-compose.yml -f docker-compose.dev.yml)

cleanup() {
  if [[ "${SMOKE_CLEANUP:-}" == "true" || "${CI:-}" == "true" ]]; then
    docker compose "${compose_args[@]}" down --remove-orphans >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT

echo "Starting AgentOS via docker compose..."
if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon not accessible. Ensure Docker Desktop is running and the current user has access." >&2
  exit 1
fi
docker compose "${compose_args[@]}" up -d --build

health_url="http://localhost:18801/live"

echo "Waiting for gateway health..."
for i in {1..60}; do
  if curl -sf "$health_url" >/dev/null; then
    break
  fi
  sleep 5
  if [ "$i" -eq 60 ]; then
    echo "Gateway did not become healthy in time." >&2
    exit 1
  fi
done

end_time=$(date +%s)
elapsed=$((end_time - start_time))

echo "Gateway healthy in ${elapsed}s"

if [ "$elapsed" -gt 300 ]; then
  echo "Warning: startup exceeded 5 minutes." >&2
  exit 2
fi

echo "Startup within 5 minutes."

#!/usr/bin/env bash
set -euo pipefail

# Restore a Qdrant snapshot to a collection
# Usage: ./restore-qdrant.sh <snapshot_file>

QDRANT_HOST=${QDRANT_HOST:-localhost}
QDRANT_PORT=${QDRANT_PORT:-6333}
QDRANT_COLLECTION=${QDRANT_COLLECTION:-agent_os_memory}

if [ $# -lt 1 ]; then
  echo "Usage: $0 <snapshot_file>" >&2
  echo "  Restores a Qdrant snapshot to collection '${QDRANT_COLLECTION}'" >&2
  echo "  Set QDRANT_HOST, QDRANT_PORT, QDRANT_COLLECTION env vars as needed" >&2
  exit 1
fi

SNAPSHOT_FILE="$1"

if [ ! -f "$SNAPSHOT_FILE" ]; then
  echo "Snapshot file not found: $SNAPSHOT_FILE" >&2
  exit 1
fi

echo "Restoring snapshot to collection '${QDRANT_COLLECTION}' on ${QDRANT_HOST}:${QDRANT_PORT}..."

# Upload snapshot file and trigger restore
response=$(curl -s -w "\n%{http_code}" -X POST \
  "http://${QDRANT_HOST}:${QDRANT_PORT}/collections/${QDRANT_COLLECTION}/snapshots/upload" \
  -H "Content-Type: multipart/form-data" \
  -F "snapshot=@${SNAPSHOT_FILE}")

http_code=$(echo "$response" | tail -1)
body=$(echo "$response" | head -n -1)

if [ "$http_code" -ge 200 ] && [ "$http_code" -lt 300 ]; then
  echo "Qdrant snapshot restored successfully"
  echo "Response: $body"
else
  echo "Failed to restore snapshot (HTTP $http_code): $body" >&2
  exit 1
fi

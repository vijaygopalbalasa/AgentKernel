#!/usr/bin/env bash
set -euo pipefail

QDRANT_HOST=${QDRANT_HOST:-localhost}
QDRANT_PORT=${QDRANT_PORT:-6333}
QDRANT_COLLECTION=${QDRANT_COLLECTION:-agent_os_memory}
BACKUP_DIR=${BACKUP_DIR:-./backups}

mkdir -p "$BACKUP_DIR"

snapshot=$(curl -s -X POST "http://${QDRANT_HOST}:${QDRANT_PORT}/collections/${QDRANT_COLLECTION}/snapshots")

snapshot_name=$(echo "$snapshot" | sed -n 's/.*"name":"\([^"]*\)".*/\1/p')
if [ -z "$snapshot_name" ]; then
  echo "Failed to create snapshot: $snapshot" >&2
  exit 1
fi

curl -s -o "$BACKUP_DIR/${snapshot_name}.snapshot" \
  "http://${QDRANT_HOST}:${QDRANT_PORT}/collections/${QDRANT_COLLECTION}/snapshots/${snapshot_name}"

echo "Qdrant snapshot saved to $BACKUP_DIR/${snapshot_name}.snapshot"

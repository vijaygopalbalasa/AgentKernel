#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR=${BACKUP_DIR:-./backups}
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
FILENAME=${FILENAME:-agentos_postgres_${TIMESTAMP}.dump}

mkdir -p "$BACKUP_DIR"

export PGHOST=${PGHOST:-localhost}
export PGPORT=${PGPORT:-5432}
export PGUSER=${PGUSER:-agentuser}
export PGPASSWORD=${PGPASSWORD:-agentpass}
export PGDATABASE=${PGDATABASE:-agentdb}

pg_dump -Fc -f "$BACKUP_DIR/$FILENAME" "$PGDATABASE"

echo "Postgres backup written to $BACKUP_DIR/$FILENAME"

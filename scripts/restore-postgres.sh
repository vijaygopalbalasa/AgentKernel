#!/usr/bin/env bash
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 /path/to/backup.dump" >&2
  exit 1
fi

BACKUP_FILE=$1

export PGHOST=${PGHOST:-localhost}
export PGPORT=${PGPORT:-5432}
export PGUSER=${PGUSER:-agentuser}
export PGPASSWORD=${PGPASSWORD:-agentpass}
export PGDATABASE=${PGDATABASE:-agentdb}

pg_restore --clean --if-exists --dbname "$PGDATABASE" "$BACKUP_FILE"

echo "Postgres restore completed from $BACKUP_FILE"

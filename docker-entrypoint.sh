#!/bin/sh
set -eu

MIGRATE="node /app/packages/db/dist/migrate.js"
SEED="node /app/packages/db/dist/seed.js"

case "${1:-web}" in
  web)
    echo "[entrypoint] applying the migrations"
    $MIGRATE
    echo "[entrypoint] RBAC seed (idempotent)"
    $SEED
    echo "[entrypoint] starting the Next.js panel on ${HOSTNAME:-0.0.0.0}:${PORT:-3000}"
    exec node /app/web/apps/web/server.js
    ;;
  worker)
    echo "[entrypoint] starting the BullMQ worker"
    exec node /app/apps/worker/dist/main.js
    ;;
  migrate)
    exec $MIGRATE
    ;;
  seed)
    exec $SEED
    ;;
  backup)
    # Disaster recovery: `docker compose run --rm worker backup restore-panel …`
    shift
    exec node /app/apps/worker/dist/cli/backup.js "$@"
    ;;
  *)
    exec "$@"
    ;;
esac

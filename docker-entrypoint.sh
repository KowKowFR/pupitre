#!/bin/sh
set -eu

MIGRATE="node /app/packages/db/dist/migrate.js"
SEED="node /app/packages/db/dist/seed.js"

case "${1:-web}" in
  web)
    echo "[entrypoint] application des migrations"
    $MIGRATE
    echo "[entrypoint] seed RBAC (idempotent)"
    $SEED
    echo "[entrypoint] démarrage du panel Next.js sur ${HOSTNAME:-0.0.0.0}:${PORT:-3000}"
    exec node /app/web/apps/web/server.js
    ;;
  worker)
    echo "[entrypoint] démarrage du worker BullMQ"
    exec node /app/apps/worker/dist/main.js
    ;;
  migrate)
    exec $MIGRATE
    ;;
  seed)
    exec $SEED
    ;;
  backup)
    # Reprise après sinistre : `docker compose run --rm worker backup restore-panel …`
    shift
    exec node /app/apps/worker/dist/cli/backup.js "$@"
    ;;
  *)
    exec "$@"
    ;;
esac

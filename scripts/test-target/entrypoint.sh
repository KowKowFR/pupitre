#!/bin/sh
# Starts the target's Docker daemon, then sshd.
set -eu

SOCKET=/var/run/docker.sock

echo "[test-target] starting the Docker daemon"
dockerd-entrypoint.sh dockerd >/var/log/dockerd.log 2>&1 &

for _ in $(seq 1 60); do
  [ -S "$SOCKET" ] && docker info >/dev/null 2>&1 && break
  sleep 1
done

if ! docker info >/dev/null 2>&1; then
  echo "[test-target] the Docker daemon did not start:"
  tail -20 /var/log/dockerd.log || true
  exit 1
fi
echo "[test-target] daemon ready — $(docker info --format '{{.ServerVersion}}')"

# The deployment account must be able to talk to the daemon without sudo, as on a
# correctly provisioned machine where it belongs to the `docker` group.
GID=$(stat -c '%g' "$SOCKET")
GROUP=$(getent group "$GID" | cut -d: -f1 || true)
if [ -z "$GROUP" ]; then
  GROUP=dockerhost
  addgroup -g "$GID" "$GROUP" 2>/dev/null || true
fi
addgroup tp "$GROUP" 2>/dev/null || true
echo "[test-target] tp added to the $GROUP group (gid $GID)"

echo "[test-target] starting sshd"
exec /usr/sbin/sshd -D -e

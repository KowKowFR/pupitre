#!/bin/sh
# Démarre le daemon Docker de la cible, puis sshd.
set -eu

SOCKET=/var/run/docker.sock

echo "[test-target] démarrage du daemon Docker"
dockerd-entrypoint.sh dockerd >/var/log/dockerd.log 2>&1 &

for _ in $(seq 1 60); do
  [ -S "$SOCKET" ] && docker info >/dev/null 2>&1 && break
  sleep 1
done

if ! docker info >/dev/null 2>&1; then
  echo "[test-target] le daemon Docker n'a pas démarré :"
  tail -20 /var/log/dockerd.log || true
  exit 1
fi
echo "[test-target] daemon prêt — $(docker info --format '{{.ServerVersion}}')"

# Le compte de déploiement doit pouvoir parler au daemon sans sudo, comme sur
# une machine correctement provisionnée où il appartient au groupe `docker`.
GID=$(stat -c '%g' "$SOCKET")
GROUP=$(getent group "$GID" | cut -d: -f1 || true)
if [ -z "$GROUP" ]; then
  GROUP=dockerhost
  addgroup -g "$GID" "$GROUP" 2>/dev/null || true
fi
addgroup tp "$GROUP" 2>/dev/null || true
echo "[test-target] tp ajouté au groupe $GROUP (gid $GID)"

echo "[test-target] démarrage de sshd"
exec /usr/sbin/sshd -D -e

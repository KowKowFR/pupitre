#!/bin/sh
# Démarre le serveur K3s, attend qu'il soit réellement utilisable, puis sshd.
#
# Même forme que l'entrypoint de la cible Docker : on ne rend la main à sshd
# qu'une fois le runtime prêt. Sinon le preflight se connecte, trouve `kubectl`,
# et rapporte « cluster non joignable » pour une raison de calendrier plutôt
# que de configuration.
set -eu

KUBECONFIG_PATH=/etc/rancher/k3s/k3s.yaml

# ── Cgroups : libérer la racine avant de lancer quoi que ce soit ────────────
#
# En cgroup v2, un cgroup qui contient des processus ne peut pas déléguer ses
# contrôleurs à ses enfants (« no internal process constraint »). La racine du
# conteneur contient sshd et ce script : `runc` échoue alors à créer le cgroup
# de chaque pod, sur « cannot enter cgroupv2 /sys/fs/cgroup/k8s.io with domain
# controllers ». Le symptôme se voit côté Kubernetes — des pods bloqués en
# `ContainerCreating` — et n'a rien à voir avec Kubernetes.
#
# La manœuvre est celle de kind : déplacer les processus existants dans un
# sous-groupe `/init`, puis activer les contrôleurs sur la racine devenue vide.
if [ -w /sys/fs/cgroup/cgroup.procs ]; then
  mkdir -p /sys/fs/cgroup/init
  while read -r pid; do
    echo "$pid" > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || true
  done < /sys/fs/cgroup/cgroup.procs

  # `+cpu +memory …` sur `subtree_control` : sans cela les enfants n'héritent
  # d'aucun contrôleur et kubelet refuse de démarrer pour une autre raison.
  if [ -r /sys/fs/cgroup/cgroup.controllers ]; then
    sed 's/\([a-z]*\)/+\1/g' /sys/fs/cgroup/cgroup.controllers \
      > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || true
  fi
  echo "[k3s-target] cgroups délégués — type de racine : $(cat /sys/fs/cgroup/cgroup.type 2>/dev/null || echo inconnu)"
fi

echo "[k3s-target] démarrage du serveur K3s"

# `--write-kubeconfig-mode 644` n'est pas cosmétique : le driver lit le
# kubeconfig **sans sudo** (`[ -r /etc/rancher/k3s/k3s.yaml ]`). En 0600 root,
# le cluster serait joignable pour root et invisible pour le compte de
# déploiement — panne incompréhensible côté panel.
#
# Traefik reste EN PLACE, contrairement au réflexe habituel en conteneur : le
# rendu K3s publie en ClusterIP et expose par un Ingress. Sans contrôleur
# d'ingress, une application déployée n'aurait aucune URL, et le test de parité
# ne prouverait rien.
#
# `metrics-server` est retiré : il ne sert à rien ici et consomme de la mémoire.
# `cgroups-per-qos=false` et `enforce-node-allocatable=` : kubelet renonce à
# créer la hiérarchie `/kubepods`. Dans un conteneur, la racine cgroup v2 est en
# état « domain threaded » et refuse un sous-groupe de type domaine — kubelet
# échoue alors au démarrage sur « cannot enter cgroupv2 /sys/fs/cgroup/kubepods
# with domain controllers ». On peut réarranger les cgroups à la main comme le
# fait kind, ou simplement ne pas les demander.
#
# Ce qu'on y perd : les limites de ressources ne sont plus appliquées par
# classe de qualité de service. Sans importance ici — cette cible sert à
# vérifier qu'une AppSpec se déploie sur K3s, pas à mesurer l'ordonnancement.
k3s server \
  --write-kubeconfig-mode 644 \
  --disable metrics-server \
  --disable-cloud-controller \
  --kubelet-arg=cgroups-per-qos=false \
  --kubelet-arg=enforce-node-allocatable= \
  > /var/log/k3s.log 2>&1 &

# Le nœud doit être `Ready` ET l'espace de noms par défaut utilisable. Les deux
# arrivent à quelques secondes d'écart, et n'attendre que le premier laisse
# passer des `kubectl apply` qui échouent sur un cluster à moitié levé.
ready=0
for _ in $(seq 1 120); do
  if [ -r "$KUBECONFIG_PATH" ] \
     && KUBECONFIG="$KUBECONFIG_PATH" kubectl get --raw='/readyz' >/dev/null 2>&1 \
     && KUBECONFIG="$KUBECONFIG_PATH" kubectl get nodes 2>/dev/null | grep -qw Ready; then
    ready=1
    break
  fi
  sleep 2
done

if [ "$ready" -ne 1 ]; then
  echo "[k3s-target] le cluster n'est pas prêt après 240 s :"
  tail -30 /var/log/k3s.log || true
  exit 1
fi

echo "[k3s-target] cluster prêt — $(KUBECONFIG=$KUBECONFIG_PATH kubectl version -o json 2>/dev/null | sed -n 's/.*"gitVersion": *"\([^"]*\)".*/\1/p' | head -1)"

# Le contrôleur d'ingress arrive après le nœud. On l'attend sans en faire une
# condition bloquante : un cluster sans Traefik reste testable pour tout ce qui
# ne passe pas par une URL, et l'échec doit se lire dans le déploiement, pas
# ici sous forme d'un conteneur qui refuse de démarrer.
if KUBECONFIG="$KUBECONFIG_PATH" kubectl -n kube-system rollout status \
     deploy/traefik --timeout=120s >/dev/null 2>&1; then
  echo "[k3s-target] contrôleur d'ingress Traefik prêt"
else
  echo "[k3s-target] AVERTISSEMENT : Traefik n'est pas prêt — les Ingress ne répondront pas"
fi

# Le compte de déploiement doit trouver le cluster sans rien exporter : le
# driver ne positionne `KUBECONFIG` que s'il est vide, et lit ce chemin.
echo "export KUBECONFIG=$KUBECONFIG_PATH" > /etc/profile.d/k3s.sh
chmod 644 /etc/profile.d/k3s.sh

echo "[k3s-target] démarrage de sshd"
exec /usr/sbin/sshd -D -e

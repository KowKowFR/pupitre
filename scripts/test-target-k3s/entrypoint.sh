#!/bin/sh
# Starts the K3s server, waits until it is really usable, then sshd.
#
# The same shape as the Docker target's entrypoint: control is only given to sshd
# once the runtime is ready. Otherwise the preflight connects, finds `kubectl`,
# and reports "cluster unreachable" for a scheduling reason rather than a
# configuration one.
set -eu

KUBECONFIG_PATH=/etc/rancher/k3s/k3s.yaml

# ── Cgroups: free the root before starting anything ─────────────────────────
#
# With cgroup v2, a cgroup that contains processes cannot delegate its
# controllers to its children ("no internal process constraint"). The
# container's root contains sshd and this script: `runc` then fails to create
# each pod's cgroup, on "cannot enter cgroupv2 /sys/fs/cgroup/k8s.io with domain
# controllers". The symptom shows on the Kubernetes side — pods stuck in
# `ContainerCreating` — and has nothing to do with Kubernetes.
#
# The maneuver is kind's: move the existing processes into an `/init` subgroup,
# then enable the controllers on the root, now empty.
if [ -w /sys/fs/cgroup/cgroup.procs ]; then
  mkdir -p /sys/fs/cgroup/init
  while read -r pid; do
    echo "$pid" > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || true
  done < /sys/fs/cgroup/cgroup.procs

  # `+cpu +memory …` on `subtree_control`: without that the children inherit no
  # controller and kubelet refuses to start for another reason.
  if [ -r /sys/fs/cgroup/cgroup.controllers ]; then
    sed 's/\([a-z]*\)/+\1/g' /sys/fs/cgroup/cgroup.controllers \
      > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || true
  fi
  echo "[k3s-target] cgroups delegated — root type: $(cat /sys/fs/cgroup/cgroup.type 2>/dev/null || echo unknown)"
fi

echo "[k3s-target] starting the K3s server"

# `--write-kubeconfig-mode 644` is not cosmetic: the driver reads the kubeconfig
# **without sudo** (`[ -r /etc/rancher/k3s/k3s.yaml ]`). As 0600 root, the
# cluster would be reachable for root and invisible for the deployment account —
# an incomprehensible outage on the panel side.
#
# Traefik stays IN PLACE, unlike the usual reflex in a container: the K3s
# rendering publishes as ClusterIP and exposes through an Ingress. Without an
# ingress controller, a deployed application would have no URL, and the parity
# test would prove nothing.
#
# `metrics-server` is removed: it is useless here and consumes memory.
# `cgroups-per-qos=false` and `enforce-node-allocatable=`: kubelet gives up
# creating the `/kubepods` hierarchy. In a container, the cgroup v2 root is in
# the "domain threaded" state and refuses a domain-type subgroup — kubelet then
# fails at startup on "cannot enter cgroupv2 /sys/fs/cgroup/kubepods with domain
# controllers". One can rearrange the cgroups by hand as kind does, or simply not
# ask for them.
#
# What is lost: the resource limits are no longer applied per quality of service
# class. Unimportant here — this target serves to check that an AppSpec deploys
# on K3s, not to measure scheduling.
k3s server \
  --write-kubeconfig-mode 644 \
  --disable metrics-server \
  --disable-cloud-controller \
  --kubelet-arg=cgroups-per-qos=false \
  --kubelet-arg=enforce-node-allocatable= \
  > /var/log/k3s.log 2>&1 &

# The node must be `Ready` AND the default namespace usable. Both arrive a few
# seconds apart, and only waiting for the first lets through `kubectl apply`s
# that fail on a half-raised cluster.
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
  echo "[k3s-target] the cluster is not ready after 240 s:"
  tail -30 /var/log/k3s.log || true
  exit 1
fi

echo "[k3s-target] cluster ready — $(KUBECONFIG=$KUBECONFIG_PATH kubectl version -o json 2>/dev/null | sed -n 's/.*"gitVersion": *"\([^"]*\)".*/\1/p' | head -1)"

# The ingress controller arrives after the node. We wait for it without making
# it a blocking condition: a cluster without Traefik stays testable for
# everything that does not go through a URL, and the failure must read in the
# deployment, not here as a container that refuses to start.
if KUBECONFIG="$KUBECONFIG_PATH" kubectl -n kube-system rollout status \
     deploy/traefik --timeout=120s >/dev/null 2>&1; then
  echo "[k3s-target] Traefik ingress controller ready"
else
  echo "[k3s-target] WARNING: Traefik is not ready — the Ingresses will not answer"
fi

# The deployment account must find the cluster without exporting anything: the
# driver only sets `KUBECONFIG` if it is empty, and reads this path.
echo "export KUBECONFIG=$KUBECONFIG_PATH" > /etc/profile.d/k3s.sh
chmod 644 /etc/profile.d/k3s.sh

echo "[k3s-target] starting sshd"
exec /usr/sbin/sshd -D -e

# SSH test target carrying a real K3s cluster.
#
# The counterpart of `scripts/test-target/`, whose Dockerfile says explicitly that
# `kubectl` is absent from it so that the preflight reports "K3s ✗". This one is
# the reverse: a real cluster, reachable over SSH, on which the `K3sDriver` can be
# exercised for good.
#
# It exists to satisfy the criterion CLAUDE.md calls "the test that validates
# the architecture": deploying the same AppSpec on a Docker target and a K3s
# target. `scripts/render-both.ts` proves that the *rendering* is neutral; it does
# not prove that a K3s deployment succeeds.
#
# Why not the `rancher/k3s` image: it is minimal and has neither a package manager
# nor sshd. Yet the driver goes **through SSH** — a target without sshd looks like
# nothing the panel knows how to reach. So we start from Alpine and set the k3s
# binary, which is self-sufficient: no systemd, no openrc, it is a single
# executable the entrypoint starts like any daemon.
FROM alpine:3.21

ARG K3S_VERSION=v1.33.4+k3s1

RUN apk add --no-cache \
      openssh-server \
      sudo \
      curl \
      ca-certificates \
      iptables \
      ip6tables \
      conntrack-tools \
 && ssh-keygen -A \
 && adduser -D -s /bin/sh tp \
 # `adduser -D` leaves the account locked (`!` in /etc/shadow) and sshd refuses a
 # locked account, even with key authentication. `*` forbids password sign-in
 # without locking the account.
 && sed -i 's/^tp:!:/tp:*:/' /etc/shadow \
 && echo 'tp ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/tp \
 && chmod 0440 /etc/sudoers.d/tp \
 && mkdir -p /home/tp/.ssh \
 && chmod 700 /home/tp/.ssh

# The k3s binary, for the host's architecture. The upstream file names differ
# from `uname -m`'s: k3s (amd64), k3s-arm64, k3s-armhf.
RUN set -eu; \
    case "$(uname -m)" in \
      x86_64)  asset='k3s' ;; \
      aarch64) asset='k3s-arm64' ;; \
      armv7l)  asset='k3s-armhf' ;; \
      *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /usr/local/bin/k3s \
      "https://github.com/k3s-io/k3s/releases/download/${K3S_VERSION}/${asset}"; \
    chmod +x /usr/local/bin/k3s; \
    # `kubectl` is a k3s subcommand: the link is enough, and it is what the
    # preflight looks for (`for b in ufw curl git docker kubectl`).
    ln -s /usr/local/bin/k3s /usr/local/bin/kubectl; \
    ln -s /usr/local/bin/k3s /usr/local/bin/crictl

ARG AUTHORIZED_KEY=""
RUN printf '%s\n' "$AUTHORIZED_KEY" > /home/tp/.ssh/authorized_keys \
 && chmod 600 /home/tp/.ssh/authorized_keys \
 && chown -R tp:tp /home/tp/.ssh

RUN sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config \
 && sed -i 's/^#\?PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config

COPY entrypoint.sh /usr/local/bin/k3s-target-entrypoint.sh
RUN chmod +x /usr/local/bin/k3s-target-entrypoint.sh

# 22 for the driver, 80 for the Ingress: on K3s the panel allocates no port, the
# exposure goes through the ingress controller (Traefik, embedded in k3s).
EXPOSE 22 80

ENTRYPOINT ["/usr/local/bin/k3s-target-entrypoint.sh"]

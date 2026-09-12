# Cible SSH de test portant un vrai cluster K3s.
#
# Pendant de `scripts/test-target/`, dont le Dockerfile dit explicitement que
# `kubectl` en est absent pour que le preflight rapporte « K3s ✗ ». Celle-ci est
# l'inverse : un cluster réel, joignable en SSH, sur lequel le `K3sDriver` peut
# être exercé pour de bon.
#
# Elle existe pour satisfaire le critère que CLAUDE.md appelle « le test qui
# valide l'architecture » : déployer la même AppSpec sur une cible Docker et une
# cible K3s. `scripts/render-both.ts` prouve que le *rendu* est neutre ; il ne
# prouve pas qu'un déploiement K3s aboutit.
#
# Pourquoi pas l'image `rancher/k3s` : elle est minimale et n'a ni gestionnaire
# de paquets, ni sshd. Or le driver passe **par SSH** — une cible sans sshd ne
# ressemble à rien de ce que le panel sait joindre. On part donc d'Alpine et on
# pose le binaire k3s, qui se suffit à lui-même : pas de systemd, pas d'openrc,
# c'est un exécutable unique que l'entrypoint lance comme n'importe quel démon.
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
 # `adduser -D` laisse le compte verrouillé (`!` dans /etc/shadow) et sshd
 # refuse un compte verrouillé, même en authentification par clé. `*` interdit
 # la connexion par mot de passe sans verrouiller le compte.
 && sed -i 's/^tp:!:/tp:*:/' /etc/shadow \
 && echo 'tp ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/tp \
 && chmod 0440 /etc/sudoers.d/tp \
 && mkdir -p /home/tp/.ssh \
 && chmod 700 /home/tp/.ssh

# Le binaire k3s, pour l'architecture de l'hôte. Les noms de fichiers amont
# diffèrent de ceux de `uname -m` : k3s (amd64), k3s-arm64, k3s-armhf.
RUN set -eu; \
    case "$(uname -m)" in \
      x86_64)  asset='k3s' ;; \
      aarch64) asset='k3s-arm64' ;; \
      armv7l)  asset='k3s-armhf' ;; \
      *) echo "architecture non prise en charge : $(uname -m)" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /usr/local/bin/k3s \
      "https://github.com/k3s-io/k3s/releases/download/${K3S_VERSION}/${asset}"; \
    chmod +x /usr/local/bin/k3s; \
    # `kubectl` est un sous-commande de k3s : le lien suffit, et c'est ce que
    # cherche le preflight (`for b in ufw curl git docker kubectl`).
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

# 22 pour le driver, 80 pour l'Ingress : en K3s le panel n'alloue aucun port,
# l'exposition passe par le contrôleur d'ingress (Traefik, embarqué dans k3s).
EXPOSE 22 80

ENTRYPOINT ["/usr/local/bin/k3s-target-entrypoint.sh"]

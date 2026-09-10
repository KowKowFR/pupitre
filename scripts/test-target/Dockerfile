# Cible SSH de test pour les jalons 3 et 4.
#
# La machine porte son PROPRE daemon Docker (docker-in-docker) : les conteneurs
# déployés s'exécutent réellement dessus, et les ports publiés le sont sur ses
# interfaces à elle. C'est la seule topologie qui teste honnêtement le driver —
# monter le socket de l'hôte ferait atterrir les conteneurs ailleurs que sur la
# cible, et la sonde du driver, qui interroge `127.0.0.1` depuis la cible,
# échouerait pour une raison sans rapport avec le code.
#
# `kubectl` en est volontairement absent : le preflight doit rapporter « K3s ✗ ».
FROM docker:29-dind

RUN apk add --no-cache \
      openssh-server \
      sudo \
      curl \
      git \
      ufw \
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

# La clé publique est injectée au build par les scripts de vérification.
ARG AUTHORIZED_KEY=""
RUN printf '%s\n' "$AUTHORIZED_KEY" > /home/tp/.ssh/authorized_keys \
 && chmod 600 /home/tp/.ssh/authorized_keys \
 && chown -R tp:tp /home/tp/.ssh

RUN sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config \
 && sed -i 's/^#\?PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config

# Socket local uniquement : pas de TLS à gérer, le daemon n'est pas exposé.
ENV DOCKER_TLS_CERTDIR=""

COPY entrypoint.sh /usr/local/bin/test-target-entrypoint.sh
RUN chmod +x /usr/local/bin/test-target-entrypoint.sh

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/test-target-entrypoint.sh"]

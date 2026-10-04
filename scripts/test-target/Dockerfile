# SSH test target: preflight and Docker deployments.
#
# The machine carries its OWN Docker daemon (docker-in-docker): the deployed
# containers really run on it, and the published ports are published on its own
# interfaces. It is the only topology that tests the driver honestly — mounting
# the host's socket would make the containers land elsewhere than on the target,
# and the driver's probe, which queries `127.0.0.1` from the target, would fail
# for a reason unrelated to the code.
#
# `kubectl` is deliberately absent from it: the preflight must report "K3s ✗".
FROM docker:29-dind

RUN apk add --no-cache \
      openssh-server \
      sudo \
      curl \
      git \
      ufw \
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

# The public key is injected at build time by the verification scripts.
ARG AUTHORIZED_KEY=""
RUN printf '%s\n' "$AUTHORIZED_KEY" > /home/tp/.ssh/authorized_keys \
 && chmod 600 /home/tp/.ssh/authorized_keys \
 && chown -R tp:tp /home/tp/.ssh

RUN sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config \
 && sed -i 's/^#\?PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config

# Local socket only: no TLS to manage, the daemon is not exposed.
ENV DOCKER_TLS_CERTDIR=""

COPY entrypoint.sh /usr/local/bin/test-target-entrypoint.sh
RUN chmod +x /usr/local/bin/test-target-entrypoint.sh

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/test-target-entrypoint.sh"]

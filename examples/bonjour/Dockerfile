# Built on the target machine, from the archive of the commit Pupitre read.
#
# Pupitre runs the images built from your code with a read-only root, an
# unprivileged user and no capability: an ordinary nginx image does not start
# there (it writes into /var/cache and listens on 80). The "unprivileged"
# variant listens on 8080 and only writes into /tmp.
FROM nginxinc/nginx-unprivileged:1.29-alpine
COPY index.html /usr/share/nginx/html/index.html

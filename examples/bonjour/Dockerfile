# Construit sur la machine cible, depuis l'archive du commit que Pupitre a lu.
#
# Pupitre lance les images construites depuis votre code avec une racine en
# lecture seule, un utilisateur non privilégié et sans capacité : une image
# nginx ordinaire n'y démarre pas (elle écrit dans /var/cache et écoute sur 80).
# La variante « unprivileged » écoute sur 8080 et n'écrit que dans /tmp.
FROM nginxinc/nginx-unprivileged:1.29-alpine
COPY index.html /usr/share/nginx/html/index.html

# Démarrage rapide

D’une machine vide à une première application qui répond sous son domaine, en huit étapes. Chaque étape dit quoi faire, ce que vous devez voir, et où regarder si cela ne se produit pas.

## Avant de commencer

| Il vous faut | Pourquoi |
|---|---|
| Une machine pour le panel, avec Docker et son extension `compose` | le panel tourne en quatre conteneurs |
| Une machine **cible** : Linux, joignable en SSH depuis le panel | c’est là que tournent les applications |
| Sur la cible, Docker Engine (avec `compose`) ou K3s | le runtime avec lequel Pupitre déploie |
| Un compte sur la cible qui peut utiliser `sudo` | Pupitre installe ce dont il a besoin et lit le système |
| Facultatif : un domaine dont vous gérez le DNS | pour servir l’application sous un nom, en HTTPS |

> [!TIP]
> Pas de machine sous la main ? Le panel et une cible peuvent être le même serveur — pratique pour essayer. Le dépôt fournit aussi des cibles jetables en conteneurs : `./scripts/setup-test-target.sh`.

## 1. Installer le panel

Sur la machine du panel, dans le dossier du dépôt :

```bash
cp .env.example .env
openssl rand -hex 32      # à copier dans MASTER_KEY
openssl rand -base64 48   # à copier dans BETTER_AUTH_SECRET
docker compose up -d --build
```

Renseignez `BETTER_AUTH_URL` dans `.env` avec l’adresse à laquelle vous ouvrirez le panel — par exemple `https://pupitre.example.com`. Le panel refuse les écritures qui viennent d’une autre adresse.

Vérifiez que tout est debout :

```bash
docker compose ps                          # postgres, redis, panel, worker
curl -s {{origin}}/api/health              # {"status":"ok","db":"ok","redis":"ok",...}
```

> [!WARNING]
> `MASTER_KEY` chiffre chaque clé SSH et chaque secret que le panel conserve. Gardez-en une copie, avec `BETTER_AUTH_SECRET`, dans un gestionnaire de mots de passe : une clé perdue emporte tout ce qu’elle protège. Elle se change plus tard — voyez [Administration](/docs/administration#master-key-et-sa-rotation).

## 2. Créer le premier compte

Ouvrez le panel. Tant qu’aucun compte n’existe, l’inscription est ouverte : **le premier compte créé devient administrateur**. Ensuite, l’inscription dépend de `ALLOW_SIGNUP` (fermée par défaut), et un nouveau venu reçoit le rôle **Aucun accès** jusqu’à ce qu’un administrateur lui en choisisse un.

À la première connexion, l’**assistant de démarrage** prend la main : identité et langue de l’instance, première cible, reverse proxy, un rôle, un utilisateur, sécurité et IA. Chaque étape est facultative sauf la première ; vous pouvez suivre ce chapitre à la place et relancer l’assistant plus tard depuis **Paramètres → Assistant de démarrage**.

## 3. Préparer la machine cible

Sur la cible, créez un compte pour Pupitre et donnez-lui la clé publique d’une paire de clés SSH générée pour lui :

```bash
# Sur votre poste : une paire de clés dédiée à Pupitre
ssh-keygen -t ed25519 -f pupitre-target -C pupitre -N ""

# Sur la cible, en root
adduser --disabled-password --gecos "" deploy
usermod -aG docker deploy                                  # cibles Docker
echo "deploy ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
cat pupitre-target.pub >> /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
```

Un `sudo` sans mot de passe est le plus simple ; un `sudo` qui demande le mot de passe du compte fonctionne aussi — choisissez alors la méthode sudo **mot de passe** en déclarant la cible.

## 4. Déclarer la cible

**Cibles → Nouvelle cible** (permission `target:create`) :

1. un nom (`prod-1`), l’hôte et le port SSH ;
2. le compte (`deploy`), la méthode **clé**, et le contenu de la clé **privée** `pupitre-target` ;
3. la méthode sudo, et la plage de ports où les applications pourront être publiées (30000-32767 par défaut) ;
4. **Créer la cible**.

Le panel chiffre la clé aussitôt, puis lance un **préflight** : SSH, système, sudo, outils, Docker, K3s, disque, mémoire. La cible passe **ok** dès qu’au moins un runtime est utilisable. L’empreinte de sa clé d’hôte est enregistrée à ce premier contact — voyez [Cibles](/docs/targets#la-cle-d-hote).

## 5. Lui donner un reverse proxy

Pour servir des applications sous un domaine, la cible a besoin d’un reverse proxy. Sur sa fiche, onglet **Reverse proxy** :

1. **Regarder la machine** : Pupitre liste ce qui s’y trouve déjà — un conteneur Traefik, le Traefik d’un cluster K3s, un BunkerWeb — sans rien toucher ;
2. un proxy trouvé ? **Utiliser celui-ci**. Rien ? Installez **Traefik en conteneur** (le choix par défaut) ou **BunkerWeb** pour un pare-feu applicatif ;
3. choisissez l’autorité de certification — **Let’s Encrypt**, ou **Let’s Encrypt (staging)** pour essayer sans limite ;
4. **Tester** : les ports 80 et 443 répondent, et le proxy lit vraiment les routes qu’on lui donne.

Pas de domaine sous la main ? Passez cette étape : les applications se joignent alors par leur port publié.

## 6. Créer une application

**Applications → Nouvelle application** (`application:create`), onglet **Depuis un JSON**, collez cette AppSpec — un seul service nginx :

```json
{
  "name": "hello",
  "version": "1.0.0",
  "services": [
    {
      "name": "web",
      "source": { "type": "image", "ref": "nginxinc/nginx-unprivileged:1.29-alpine" },
      "port": 8080,
      "exposed": true,
      "healthcheck": { "path": "/", "retries": 5 }
    }
  ],
  "ingress": { "host": "hello.example.com", "tls": true, "targetService": "web" }
}
```

Remplacez `hello.example.com` par un nom dont le DNS pointe vers la cible (ou retirez `ingress`), puis **Enregistrer**. Rien n’est encore déployé : l’application existe dans le panel.

> [!TIP]
> Le **Catalogue** propose des applications toutes prêtes — Uptime Kuma, Grafana, WordPress, Vaultwarden… — et l’onglet **Depuis une description** fait écrire l’AppSpec par l’IA de l’instance.

## 7. Déployer

Ouvrez la fiche de l’application et cliquez sur **Déployer** (`deployment:create`) :

1. choisissez la cible et le runtime qu’elle propose ;
2. vérifiez les **Domaines** — le domaine de l’AppSpec est proposé, en HTTPS ;
3. laissez le **retour automatique** coché ;
4. **Déployer**.

Le tiroir suit le pipeline étape par étape, avec le journal en direct. Un premier déploiement prend de quelques secondes (une image à tirer) à quelques minutes (une construction, une première analyse qui télécharge ses bases). À la fin, le déploiement est **réussi** et son URL répond.

## 8. Vérifier, puis aller plus loin

- **Supervision** montre l’application qui tourne sur sa machine, son état et ses journaux.
- **Domaines** montre le domaine, s’il répond par le proxy, et l’échéance de son certificat.
- **Sondes** — ajoutez une sonde HTTP sur l’URL pour être alerté si elle cesse de répondre.

Ensuite, selon ce dont vous avez besoin :

- déployer depuis votre code : [Dépôts et code](/docs/repositories) ;
- écrire une application plus riche : [Référence de l’AppSpec](/docs/appspec) ;
- déployer depuis une CI : [CI/CD](/docs/ci-cd) ;
- laisser un agent IA piloter le panel : [MCP](/docs/mcp).

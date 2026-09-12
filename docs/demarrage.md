# Démarrer

- [La pile complète](#la-pile-complète)
- [Mode développement](#mode-développement)
- [Les cibles de test](#les-cibles-de-test)
- [La cible K3s de test](#la-cible-k3s-de-test)
- [Catalogue des commandes](#catalogue-des-commandes)
- [Les profils compose](#les-profils-compose)

## La pile complète

```bash
cp .env.example .env
docker compose up -d --build
```

Quatre services démarrent : `postgres`, `redis`, `panel`, `worker`. Le panel
applique les migrations puis rejoue le seed RBAC (idempotent) avant d'ouvrir son
port — c'est le rôle de `docker-entrypoint.sh`, qui accepte quatre commandes :
`web`, `worker`, `migrate`, `seed`. Le worker attend que le panel soit `healthy`,
donc les migrations sont toujours passées avant le premier job.

`postgres` et `redis` sont publiés sur **`127.0.0.1` uniquement**, aux ports
**5433** et **6380** — décalés pour ne pas heurter des services déjà installés
sur le poste. Le panel et le worker, eux, se joignent par le réseau compose
(`postgres:5432`, `redis:6379`) et ignorent les URLs du `.env`.

Le premier compte créé devient administrateur. Ensuite l'inscription publique
dépend de `ALLOW_SIGNUP` (défaut `false`), mais reste **toujours ouverte tant
qu'aucun compte n'existe** — sinon personne ne pourrait créer le premier admin.

### Les deux secrets

```bash
openssl rand -hex 32      # → MASTER_KEY        (32 octets en hexadécimal)
openssl rand -base64 48   # → BETTER_AUTH_SECRET (au moins 32 caractères)
```

`MASTER_KEY` dérive, par HKDF-SHA256, les clés qui chiffrent les credentials SSH,
les valeurs de secrets d'application, la clé d'API de l'IA, les secrets des
canaux de notification et les URL de webhook des sondes. **La changer rend tout
cela illisible** — le format `version:iv:authTag:ciphertext` existe pour permettre
une rotation un jour, mais le code de rotation n'est pas écrit. Choisissez-la
avant le premier démarrage.

Le panel et le worker **refusent de démarrer** si elle est absente ou fait moins
de 32 octets.

## Mode développement

Les dépendances tournent dans Docker, le code tourne sur le poste :

```bash
docker compose up -d postgres redis
pnpm install
pnpm dev        # web (3000) + worker, tous deux en watch
```

`pnpm dev` construit d'abord `@pupitre/core` et `@pupitre/db`, puis lance les quatre
projets en parallèle. Node ≥ 24 et pnpm 10 sont requis (`package.json`).

Attention : si la pile complète tourne déjà, son `panel` occupe le port 3000.
Arrêtez-le (`docker compose stop panel worker`) ou lancez le dev sur un autre
port.

## Les cibles de test

Le dépôt fabrique des machines cibles en conteneur, pour qui n'a pas de VM.
Elles ne démarrent **jamais** avec `docker compose up` : elles vivent sous le
profil `test`.

```bash
./scripts/setup-test-target.sh
```

Le script génère une clé SSH (`.test-target-key`, ignorée par git), démarre le
conteneur `ssh-target` — du **docker-in-docker**, avec son propre daemon, comme
une vraie machine — attend qu'il réponde, puis enregistre **deux cibles** dans le
panel :

| Nom | Adresse | Vue depuis |
|---|---|---|
| `cible-de-verification` | `ssh-target:22` | le worker — c'est elle que l'UI et les scripts utilisent |
| `cible-docker-locale` | `127.0.0.1:2222` | votre poste — pour `pnpm test:driver` et `pnpm test:parity` |

C'est la même machine, atteinte par deux chemins réseau. Elle ne publie que dix
ports (30000-30009), d'où le `DRIVER_PORT_RANGE=30000-30009` du `.env.example`.

`kubectl` est volontairement absent de cette image, pour que le preflight
rapporte « Docker ✓ / K3s ✗ » et qu'on voie le cas.

Pour exercer le chemin « UFW actif » :

```bash
TEST_TARGET_UFW=1 ./scripts/setup-test-target.sh
```

Le port 22 est autorisé **avant** l'activation, faute de quoi la politique par
défaut couperait la session SSH qui pilote la machine.

## La cible K3s de test

Elle est le pendant de la précédente : un vrai cluster k3s (v1.33.4), joignable
en SSH, avec Traefik conservé comme contrôleur d'ingress. Elle existe pour le
critère de `CLAUDE.md`, que le rendu seul ne peut pas prouver.

> Il n'y a **pas** de `setup-k3s-target.sh` : contrairement à la cible Docker,
> le démarrage est manuel. `docker-compose.yml` porte les deux commandes en
> commentaire, et cette page les détaille.

```bash
# 1. le conteneur — la clé est celle produite par setup-test-target.sh
TEST_TARGET_PUBLIC_KEY="$(cat .test-target-key.pub)" \
  docker compose --profile test up -d --build k3s-target

# 2. attendre que le cluster soit prêt
docker compose logs -f k3s-target      # jusqu'à « démarrage de sshd »
ssh -i .test-target-key -p 2223 tp@127.0.0.1 'sudo kubectl get nodes'
```

Puis enregistrer deux cibles à la main, dans `/targets` ou par
`POST /api/targets` — même dédoublement que pour Docker :

| Nom | Hôte | Port | Utilisateur | Pour |
|---|---|---|---|---|
| `cible-k3s` | `k3s-target` | 22 | `tp` | le worker : UI, preflight, déploiements |
| `cible-k3s-locale` | `127.0.0.1` | 2223 | `tp` | le poste : `pnpm test:parity` |

Méthode d'authentification : clé, avec le contenu de `.test-target-key` (la clé
**privée**). `sudo` est en `NOPASSWD` sur la cible.

Le cluster publie son port 80 sur `127.0.0.1:8080` : c'est par là qu'on joint une
application exposée par Ingress. Le panel n'alloue **aucun** port en K3s.

Le test de parité se lance ensuite depuis le poste :

```bash
pnpm test:parity cible-docker-locale cible-k3s-locale
```

Il ne passe pas au vert aujourd'hui — voir les limites connues du
[README](../README.md#limites-connues--au-12092026). C'est attendu, et c'est
précisément ce qu'on lui demande de révéler.

## Catalogue des commandes

Toutes ont été exécutées le 12/09/2026 contre ce dépôt.

| Commande | Effet |
|---|---|
| `pnpm dev` | web + worker en watch |
| `pnpm build` | packages, worker (tsc) et web (next build) |
| `pnpm typecheck` | TypeScript strict sur les 4 projets **et** sur `scripts/` |
| `pnpm lint` | ESLint (Next) |
| `pnpm test` | tests unitaires de `@pupitre/core` — 205 tests, 39 suites |
| `pnpm test:driver <cible>` | déploiement de bout en bout sur une cible réelle |
| `pnpm test:parity <docker> <k3s>` | le test de parité — pilote les deux drivers en direct |
| `pnpm test:schedule` | traduction et calcul des expressions cron |
| `pnpm test:ai` | configuration multi-fournisseur, hors ligne |
| `pnpm tsx scripts/render-both.ts <spec.json>` | rend une AppSpec vers Compose **et** vers des manifests K8s, sans rien déployer |
| `pnpm db:generate` | génère une migration Drizzle depuis le schéma |
| `pnpm db:migrate` | applique les migrations |
| `pnpm db:seed` | seed RBAC idempotent (rôles, permissions) |
| `pnpm db:studio` | Drizzle Studio |

Les 22 scripts `./scripts/verify-*.sh` ont leur propre catalogue :
[`verification.md`](verification.md).

## Les profils compose

```bash
docker compose config --services                  # postgres redis panel worker
docker compose --profile test config --services   # + ssh-target k3s-target mailpit
```

| Service | Profil | Rôle |
|---|---|---|
| `postgres` `redis` `panel` `worker` | — | la pile |
| `ssh-target` | `test` | cible Docker jetable (docker-in-docker) |
| `k3s-target` | `test` | cible K3s jetable (vrai cluster) |
| `mailpit` | `test` | serveur SMTP jetable, pour `verify-notifications.sh` — interface sur <http://localhost:8025> |

Les trois services de test sont `privileged` ou exposent des ports : ils ne
doivent jamais démarrer par accident, d'où le profil. `docker compose up -d`
seul ne les touche pas.

### Variables d'environnement

`.env.example` les documente une par une. Deux points qui coûtent du temps :

- **`MONITOR_ALLOWED_CIDRS` doit valoir la même chose côté panel et côté worker.**
  Le panel s'en sert pour refuser une sonde à la création, le worker pour la
  refuser à chaque saut de redirection. Une valeur qui diverge laisse créer des
  sondes que le worker refusera en silence. Les deux la mettent en cache au
  niveau module : **un changement exige un redémarrage** des deux services.
- **`DRIVER_PORT_RANGE` et la plage de la cible disent deux choses différentes**
  — ce que le worker peut atteindre, et ce que la machine accepte d'ouvrir. C'est
  leur *intersection* qui est retenue.

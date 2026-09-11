# Bootstrap TP v2 — Control plane

Panel auto-hébergé qui déploie des web apps sur des machines distantes,
en Docker Compose **ou** en K3s. Voir `CLAUDE.md` (architecture) et `PLAN.md` (jalons).

> **État : jalon 8 terminé — IA et automatisation.**
> `AppSpec`, `DockerComposeDriver`, pipeline en 10 étapes, logs en direct par SSE,
> UI de progression, scanners `TrivyScanner` / `GrypeScanner` / `SyftSBOM` avec
> verdict bloquant, plage de ports **par cible**, règles UFW posées et retirées
> par le driver, healthcheck à backoff avec diagnostic capturé sur la cible,
> **rollback automatique**, historique des versions redéployables. Depuis le
> jalon 8 : **génération d'AppSpec par IA** (OpenRouter via le Vercel AI SDK,
> `generateObject()` + validation Zod, une seule relance sur erreur) et **tâches
> planifiées BullMQ** (scan périodique, healthcheck, purge des versions,
> rafraîchissement des cibles).
>
> **Deux limites, dites franchement :**
> - Le `K3sDriver` du jalon 5 existe et ses tests de rendu passent, mais
>   `scripts/test-parity.ts` n'a **jamais** été joué de bout en bout : aucune
>   cible K3s n'est enregistrée. Le critère « la même AppSpec générée se déploie
>   aussi sur K3s » n'est donc **pas atteint** ; seul le *rendu* K3s de l'AppSpec
>   générée est vérifié (`scripts/render-both.ts`).
> - `OPENROUTER_API_KEY` n'est pas renseignée dans ce dépôt. La chaîne de
>   génération est couverte de bout en bout par des tests unitaires sous **modèle
>   simulé** (`packages/core/test/ai.test.ts`), et `verify-jalon8.sh` saute
>   proprement ce qui exige un fournisseur en le disant.
> - `BunkerWebProvider` n'est **pas** implémenté. Traefik reste le seul
>   `ProxyProvider` — voir « Ce qui n'existe pas encore ».
>
> Les versions des dépendances ont été auditées le 2026-09-09 — voir [VERSIONS.md](VERSIONS.md).

## Reprendre le projet

```bash
cp .env.example .env
docker compose up -d --build
```

C'est tout : le panel applique les migrations, rejoue le seed RBAC, puis passe
`healthy`. Ouvrez <http://localhost:3000> — la base est vierge, donc l'inscription
est ouverte et **le premier compte créé devient administrateur**.

Départ à froid vérifié le 2026-09-10 : 4 conteneurs sains, 18 tables, 3 rôles,
21 permissions, `/api/health` → `{"status":"ok","db":"ok","redis":"ok"}`.

Pour une cible de déploiement sans VM sous la main :

```bash
./scripts/setup-test-target.sh          # conteneur docker-in-docker + 2 cibles
./scripts/verify-jalon4.sh              # déploiement complet de bout en bout
```

### Trois choses à faire de votre côté

| | Sans quoi |
|---|---|
| **`git init` et un premier commit** | 8 jalons et ~30 000 lignes sans aucun historique |
| **Un cluster K3s** + une cible enregistrée | `scripts/test-parity.ts` reste écrit mais jamais joué — c'est le test de vérité de l'architecture, et la moitié de la démo |
| **`OPENROUTER_API_KEY` dans `.env`** | La génération d'AppSpec ne peut pas être montrée en vrai |

Les fichiers ignorés par git — `.env`, `.test-target-key*`, `node_modules/`,
`dist/`, `.next/` — sont tous régénérables par les commandes ci-dessus.

## Structure

```
apps/web        Next.js 16 App Router — UI + Route Handlers REST
apps/worker     Process Node — consomme BullMQ
packages/db     Schéma Drizzle + migrations (source unique du modèle)
packages/core       AppSpec (Zod), crypto AES-256-GCM, RBAC, queue, preflight, ports, scan
packages/core/ssh       Couche SSH (node-ssh) — sous-chemin dédié
packages/core/drivers   DeploymentDriver + DockerComposeDriver + K3sDriver,
                        ufw, sonde des ports en écoute, rétention — sous-chemin dédié
packages/core/scanners  Scanner + Trivy / Grype / Syft — sous-chemin dédié
packages/core/ai        Génération d'AppSpec (Vercel AI SDK + OpenRouter) — sous-chemin dédié
```

Les sous-chemins `ssh`, `drivers` et `scanners` existent pour la même raison :
`ssh2` ne doit pas entrer dans le graphe de dépendances du panel Next. `ai` en est
un quatrième, pour la raison symétrique : le SDK et son provider n'ont rien à
faire dans le worker, qui ne génère rien. Les **types** correspondants
(`preflight.ts`, `ports.ts`, `scan.ts`) restent à la racine `@tp/core`, parce que
l'UI en a besoin et qu'ils n'exécutent rien.

Une seule image Docker, deux commandes au runtime : `web` et `worker`.

## Démarrer

```bash
cp .env.example .env
# Pour autre chose qu'un essai local, régénérer les secrets :
#   openssl rand -hex 32      → MASTER_KEY
#   openssl rand -base64 48   → BETTER_AUTH_SECRET
docker compose up -d --build
```

Le panel applique les migrations au démarrage, puis passe `healthy`.
Le worker n'est lancé qu'ensuite.

## Vérifier le critère de sortie du jalon 8

```bash
./scripts/verify-jalon8.sh
```

Le script joue, dans l'ordre : le chargement du **prompt système** (un fichier
versionné, dont l'absence dans l'image serait invisible autrement), la chaîne de
génération sous modèle simulé, la génération réelle, l'édition puis la validation
de l'AppSpec, son déploiement sur Docker, son rendu vers les **deux** runtimes,
le rejet d'un prompt absurde, les garde-fous de la route, et enfin une tâche
`scan:periodic` toutes les cinq minutes — exécutée, survivant à un redémarrage du
worker, puis désactivée.

Sans `OPENROUTER_API_KEY`, il **saute** la génération réelle et le prompt absurde
en le disant, vérifie que la route répond alors 501 avec un message explicite, et
poursuit sur une AppSpec de repli clairement étiquetée comme telle. Il ne fabrique
aucun faux succès.

Il sort en code non nul au premier point en échec, et il est relançable.

## Vérifier le critère de sortie du jalon 7

```bash
./scripts/setup-test-target.sh            # si la cible n'est plus joignable
TEST_TARGET_UFW=1 ./scripts/setup-test-target.sh   # pour exercer le chemin « ufw actif »
./scripts/verify-jalon7.sh
```

Le script déploie deux applications sur la **même** cible, en détruit une, puis
déploie une v1 saine suivie d'une v2 dont la sonde de santé ne peut pas aboutir :

```
3. Deux applications sur la même cible → deux ports distincts
  ✓ deux ports distincts : 30009 ≠ 30002
  ✓ les deux ports tiennent dans la plage 30000-30009 de la cible
4. Pare-feu UFW
  ✓ deux règles ufw créées, chacune avec son commentaire bootstrap-tp:{slug}
5. Destroy de la première → port libéré, la seconde intacte
  ✓ règle ufw de 30009 retirée par son commentaire, celle de 30002 intacte
6. v1 saine, v2 au healthcheck cassé → rollback automatique
  ✓ statut « rolled_back » — distinct de « failed »
  ✓ diagnostic capturé — docker compose ps + logs, issue « injoignable »
  ✓ http://127.0.0.1:30001 sert de nouveau la v1 (nginx)
7. Traçabilité du rollback
  ✓ l'audit nomme la version quittée, la version restaurée et la raison
8. Historique des versions et redéploiement
  ✓ POST /api/applications/:id/redeploy — rejoue l'AppSpec 1.0.0 figée
  ✓ rétention : 2 répertoire(s) de version conservé(s) sur la cible (max 5)
```

**Les deux chemins UFW sont vérifiés**, et le script dit lequel il vient de
prendre. La cible de test embarque `ufw` sans l'activer :
`TEST_TARGET_UFW=1 ./scripts/setup-test-target.sh` l'active — en autorisant le
port 22 **avant**, faute de quoi la politique par défaut couperait la session SSH
qui pilote la machine.

Le point 9 se contente de `pnpm typecheck` : `scripts/test-parity.ts` compile,
mais il n'est **pas** exécuté — il faudrait une cible K3s, et il n'y en a pas.

## Vérifier le critère de sortie du jalon 6

```bash
./scripts/setup-test-target.sh     # si la cible n'est plus joignable
./scripts/verify-jalon6.sh
```

Le script déploie quatre fois la même application volontairement vulnérable
(`scripts/fixtures/vulnerable.json`, image `nginx:1.20.0`) en changeant seulement
la politique de scan :

```
4. Trivy coché, seuil CRITICAL — le déploiement doit être bloqué
  ✓ déploiement bloqué à l'étape « scan »
  ✓ le déploiement n'a pas eu lieu — « deploy » est skipped
  ✓ Trivy : verdict « fail », 42 CRITICAL
5. Trivy DÉCOCHÉ, Grype coché — même verdict de blocage
  ✓ déploiement bloqué à l'étape « scan », sans Trivy
  ✓ Grype seul : verdict « fail », 40 CRITICAL
  ✓ 40 CVE critique(s) décrites à l'identique — CVE, paquet et sévérité
6. Mêmes scanners, seuil NONE — le déploiement doit passer
  ✓ http://127.0.0.1:30004 → HTTP 200
  ✓ verdict informatif, 972 finding(s) tout de même enregistrés
7. Syft seul, seuil CRITICAL — aucun blocage possible, SBOM téléchargeable
  ✓ SBOM téléchargé — 3537 composants
```

Le point 5 est le vrai test de la normalisation : les quarante CVE critiques
que les deux outils partagent sont comparées **CVE par CVE, paquet par paquet,
sévérité par sévérité**. Deux scanners qui décrivent la même vulnérabilité
doivent produire le même `Finding`.

Le premier scan sur une cible neuve installe les binaires puis télécharge les
bases de vulnérabilités : comptez quelques minutes, une seule fois.

## Vérifier le critère de sortie du jalon 4

```bash
./scripts/setup-test-target.sh     # provisionne une cible Docker jetable
./scripts/verify-jalon4.sh
```

Le script emprunte exactement les mêmes routes que l'UI : il crée une
application depuis `simple.json`, la déploie, suit le flux SSE, et **se
rebranche en cours de déploiement** pour vérifier qu'aucune ligne n'est perdue
ni dupliquée à la couture entre historique et direct.

```
4. POST /api/deployments — la route ne doit pas attendre
  ✓ 202 en 0s
  ✓ les 8 étapes existent déjà, toutes en « pending »
5. Flux SSE en direct
  ✓ 22 ligne(s) reçue(s) en direct
    preflight → success      build       → skipped
    allocate_port → success  deploy      → success
    render → success         healthcheck → success
    upload → success         proxy       → skipped
6. Rafraîchissement en cours : les logs passés sont retrouvés
  ✓ le client rebranché a reçu exactement les mêmes lignes, ni perte ni doublon
7. L'URL répond
  ✓ http://127.0.0.1:30003 → HTTP 200
```

### Le driver seul, sans pipeline

```bash
pnpm test:driver <nom-ou-id-de-cible>
```

Sans VM sous la main, un script provisionne une cible jetable — un conteneur
**docker-in-docker**, donc une machine avec son propre daemon Docker :

```bash
./scripts/setup-test-target.sh
DRIVER_PORT_RANGE=30000-30009 pnpm test:driver cible-docker-locale
```

Le script enchaîne `preflight()`, `allocatePort()`, `render()`, `deploy()`,
`healthcheck()`, va chercher l'URL depuis le poste, puis `destroy()`. Sortie :

```
3. preflight()
  OK Daemon Docker 29.8.0
  OK Docker Compose 2.36.2
  OK Espace disque 406 Gio disponibles
  OK Répertoire de travail /opt/bootstrap/apps/demo-api (provisionné via sudo)
4. allocatePort()
  OK port 30005 réservé dans port_allocations (contrainte unique target_id/port)
6. deploy()
  ✓ déploiement terminé — http://127.0.0.1:30005
7. healthcheck()
  OK sain après 1 tentative(s) — HTTP 200
8. L'URL répond
  OK http://127.0.0.1:30005 → HTTP 200
```

Options : `--keep` conserve le déploiement, `--spec fichier.json` change
l'AppSpec, `--rollback <version>` revient à une version précédente,
`--destroy` nettoie.

### Deux cibles pour une seule machine

`setup-test-target.sh` enregistre la même machine deux fois, parce que le worker
et votre poste ne la voient pas à la même adresse :

| Cible | Adresse | Vue par |
|---|---|---|
| `cible-de-verification` | `ssh-target:22` | le worker (UI, preflight, jalon 3) |
| `cible-docker-locale` | `127.0.0.1:2222` | votre poste (`pnpm test:driver`) |

Les deux sont enregistrées avec une plage de ports **30000-30009** : c'est ce que
le conteneur publie réellement (voir `docker-compose.yml`). Une cible doit
déclarer ce qu'elle sait ouvrir, pas ce que la valeur par défaut suppose.

La cible porte son **propre** daemon Docker. Monter le socket de l'hôte serait
plus simple mais malhonnête : les conteneurs atterriraient ailleurs que sur la
cible, et la sonde du driver — qui interroge `127.0.0.1` *depuis la cible* —
échouerait pour une raison sans rapport avec le code.

Nettoyage : `docker compose --profile test down -v ssh-target`.

## Vérifier le critère de sortie du jalon 3

```bash
./scripts/verify-jalon3.sh
```

Le script monte une **vraie cible SSH** — le conteneur `ssh-target`, profil compose
`test` — équipée d'un client Docker branché sur le socket de l'hôte. Rien n'est
simulé : `docker info` interroge un daemon réel. `kubectl` en est volontairement
absent, ce qui produit « Docker ✓ / K3s ✗ ».

Il vérifie les quatre points du critère :

1. ajout d'une cible avec une clé SSH ed25519 jetable ;
2. preflight lancé, `Docker ✓ 29.x` / `K3s ✗`, données rafraîchies sans
   rechargement (la séquence exacte du hook client est rejouée) ;
3. en base, `encrypted_credential` commence par `v1:` et ne contient aucun
   fragment lisible de la clé ;
4. ni `/api/targets`, ni `/api/targets/:id`, ni le HTML rendu, ni le journal
   d'audit, ni les logs du worker ne laissent filtrer le credential.

Nettoyage de la cible de test :

```bash
docker compose --profile test down ssh-target
```

Les mêmes contrôles à la main :

```bash
ORIGIN='-H origin:http://localhost:3000 -H content-type:application/json'
J='-b /tmp/admin.jar -c /tmp/admin.jar'
curl -s -c /tmp/admin.jar $ORIGIN -X POST localhost:3000/api/auth/sign-in/email \
  -d '{"email":"admin@example.test","password":"motdepasse-tres-long"}' >/dev/null

# 1 — créer la cible (la clé privée est multi-ligne : on passe par jq)
jq -n --arg key "$(cat ~/.ssh/id_ed25519)" \
  '{name:"vm-demo", host:"10.0.0.12", port:22, sshUser:"deploy",
    authMethod:"key", sudoMethod:"nopasswd", credential:$key}' \
| curl -s $J $ORIGIN -X POST localhost:3000/api/targets --data-binary @- | jq -c

# 2 — lancer le preflight et suivre la tâche
TID=$(curl -s $J localhost:3000/api/targets | jq -r '.items[0].id')
JID=$(curl -s $J $ORIGIN -X POST localhost:3000/api/targets/$TID/preflight | jq -r .jobId)
curl -s $J localhost:3000/api/jobs/$JID | jq -c '{state, result}'

# 3 — le credential est chiffré en base
docker compose exec postgres psql -U tp -d tp -tAc \
  "select left(encrypted_credential, 60) from targets;"
#   v1:YdIJVf+ZLvzMV8qL:xmKYtkRyK+BlK2nmUTm4fg==:OJLrjT4WQ6hL6uC7...

# 4 — l'API ne renvoie jamais le credential
curl -s $J localhost:3000/api/targets/$TID \
  | jq '[paths(scalars) | join(".")] | map(select(test("credential|password|secret";"i")))'
#   []   ← aucun champ sensible, à aucune profondeur
```

## Vérifier le critère de sortie du jalon 2

```bash
./scripts/verify-jalon2.sh
```

Le script crée un `viewer`, le connecte, appelle `POST /api/deployments`,
vérifie le **403** et retrouve le refus dans `audit_logs` avec l'acteur et l'IP.
Il amorce le premier administrateur si la base est vierge.

Variables reconnues : `BASE_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`,
`VIEWER_EMAIL`, `VIEWER_PASSWORD`, `CLIENT_IP`.

Le même contrôle à la main :

```bash
ORIGIN='-H origin:http://localhost:3000 -H content-type:application/json'
IP='-H x-forwarded-for:198.51.100.42'

# 1 — premier compte = administrateur
curl -s -c /tmp/admin.jar $ORIGIN $IP -X POST localhost:3000/api/auth/sign-up/email \
  -d '{"name":"Admin","email":"admin@example.test","password":"motdepasse-tres-long"}'

# 2 — créer un viewer
curl -s -b /tmp/admin.jar -c /tmp/admin.jar $ORIGIN $IP -X POST localhost:3000/api/admin/users \
  -d '{"name":"Vera","email":"viewer@example.test","password":"motdepasse-tres-long","role":"viewer"}'

# 3 — se connecter en viewer
curl -s -c /tmp/viewer.jar $ORIGIN $IP -X POST localhost:3000/api/auth/sign-in/email \
  -d '{"email":"viewer@example.test","password":"motdepasse-tres-long"}'

# 4 — le refus attendu
curl -s -b /tmp/viewer.jar $ORIGIN $IP -X POST localhost:3000/api/deployments -d '{}' -w '\nHTTP %{http_code}\n'
# {"error":{"code":"forbidden","message":"Permission « deployment:create » requise",...}}
# HTTP 403

# 5 — la trace, acteur et IP compris
docker compose exec postgres psql -U tp -d tp -c \
  "select a.action, u.email, a.resource_id, a.ip from audit_logs a
     left join users u on u.id = a.actor_id
    where a.action = 'permission.denied' order by a.created_at desc limit 1;"
```

## Vérifier le critère de sortie du jalon 1

```bash
# 1 — les 4 conteneurs sont sains
docker compose ps

# 2 — /api/health répond ok
curl -s localhost:3000/api/health
# {"status":"ok","db":"ok","redis":"ok",...}

# 3 — enfiler un job dans la queue "ops"
#     (route protégée depuis le jalon 2 : permission job:manage)
curl -s -b /tmp/admin.jar -H 'content-type: application/json' -H 'origin: http://localhost:3000' \
  -X POST localhost:3000/api/ping -d '{"message":"jalon 1"}'
# {"jobId":"1","queue":"ops","message":"jalon 1","state":"queued"}

# 4 — le worker l'a consommé
curl -s -b /tmp/admin.jar localhost:3000/api/ping/1
# {"state":"completed","result":{"ok":true,"auditLogId":"...","workerId":"worker-1"},...}

# 5 — la trace est en base
docker compose exec postgres psql -U tp -d tp \
  -c "select action, resource_id, created_at from audit_logs order by created_at;"
# ping.enqueued | 1 | ...
# ping.handled  | 1 | ...
```

## Développement

Les dépendances tournent dans Docker, le code tourne sur le poste :

```bash
docker compose up -d postgres redis
pnpm install
pnpm dev        # web (3000) + worker, tous deux en watch
```

`postgres` et `redis` sont publiés sur `127.0.0.1` aux ports **5433** et **6380**
(décalés pour ne pas heurter des services déjà installés). Les URLs du `.env`
pointent dessus ; dans `docker compose`, le panel et le worker reçoivent leurs
propres URLs et ignorent ces deux lignes.

| Commande | Effet |
|---|---|
| `pnpm dev` | web + worker en watch |
| `pnpm build` | packages, worker (tsc) et web (next build) |
| `pnpm typecheck` | TypeScript strict sur les 4 projets |
| `pnpm lint` | ESLint (Next) |
| `pnpm test` | tests unitaires (crypto, AppSpec, rendu Compose et K8s, normalisation des scans, génération IA sous modèle simulé) |
| `pnpm test:driver <cible>` | déploiement de bout en bout sur une cible réelle |
| `pnpm tsx scripts/render-both.ts <spec.json>` | rend une AppSpec vers Compose **et** vers des manifests K8s, sans rien déployer |
| `./scripts/verify-jalon6.sh` | critère de sortie du jalon 6 : scanners et gate |
| `./scripts/verify-jalon7.sh` | critère de sortie du jalon 7 : ports, ufw, rollback |
| `./scripts/verify-jalon8.sh` | critère de sortie du jalon 8 : génération IA et tâches planifiées |
| `docker compose --profile test up -d --build ssh-target` | cible SSH de test |
| `pnpm db:generate` | génère une migration Drizzle depuis le schéma |
| `pnpm db:seed` | seed RBAC idempotent (rôles, permissions) |
| `pnpm db:migrate` | applique les migrations |
| `pnpm db:studio` | Drizzle Studio |

## Identité, RBAC et audit

**Authentification** — Better Auth (e-mail + mot de passe, plugin `admin`),
sessions en base. Le tout premier compte créé reçoit le rôle `admin`.
L'inscription publique reste ouverte tant qu'aucun compte n'existe, puis dépend
de `ALLOW_SIGNUP` (défaut `false`).

**Rôles seedés** — `admin` (21 permissions), `operator` (12), `viewer` (les 8
permissions en `:read`). `scan:configure` est allé à l'opérateur au jalon 6 :
choisir les scanners fait partie du geste de déploiement. Le seed est idempotent et rejoué à chaque démarrage.

**Un seul point de contrôle.** Toute route protégée appelle :

```ts
const auth = await requirePermission(request, 'deployment:create');
```

→ retourne le contexte si autorisé · `401` sans session · `403` sans la
permission · **écrit systématiquement un `audit_log` sur refus**.
Le wrapper `apiRoute()` traduit ces erreurs typées en réponses HTTP ; aucune
route ne fabrique de 401/403 à la main.

**Le middleware ne vérifie rien.** Il tourne en Edge, sans accès à la base :
il ne fait qu'un filtrage optimiste sur la *présence* du cookie de session.
L'autorisation réelle est faite côté serveur, dans les routes et les pages.

**Journal d'audit** — écrit exclusivement par `logAudit()` (`packages/db`).
Cette fonction ne throw jamais : un audit indisponible dégrade la traçabilité,
il ne casse pas la requête. L'IP est lue derrière un reverse proxy
(`x-forwarded-for`, premier élément).

Tracé dès maintenant : `auth.login.succeeded` / `auth.login.failed` /
`auth.logout` / `auth.signup.succeeded` / `auth.signup.blocked`,
`user.created` / `user.created.by_admin` / `user.deleted`,
`user.role.changed`, `user.disabled` / `user.enabled`,
et **tout `permission.denied`**.

**Chiffrement des secrets** — `packages/core/src/crypto.ts`, AES-256-GCM,
clé dérivée de `MASTER_KEY` par HKDF-SHA256. Format
`version:iv:authTag:ciphertext` pour permettre une rotation de clé.
Le panel et le worker refusent de démarrer si `MASTER_KEY` est absente ou fait
moins de 32 octets. 19 tests unitaires (`pnpm test`).
**Ce module n'est encore utilisé nulle part** — il servira aux credentials SSH
au jalon 3.

## API

| Route | Permission | Rôle |
|---|---|---|
| `GET /api/health` | — | `{ status, db, redis, ai }` — 200 si ok, 503 sinon. `ai` dit si la clé est là, quel modèle est retenu, et si le **prompt système** est chargeable |
| `POST /api/auth/*` | — | Better Auth : `sign-in/email`, `sign-up/email`, `sign-out` |
| `GET /api/audit-logs` | `audit:read` | journal paginé, filtres `actorId` `action` `resourceType` `from` `to` |
| `GET /api/deployments` | `deployment:read` | liste (vide jusqu'au jalon 4) |
| `POST /api/deployments` | `deployment:create` | **501** — le pipeline arrive au jalon 4 |
| `GET /api/admin/users` | `user:read` | liste des comptes et de leurs rôles |
| `POST /api/admin/users` | `user:manage` | crée un compte avec un rôle |
| `PATCH /api/admin/users/:id/role` | `user:manage` | change le rôle |
| `PATCH /api/admin/users/:id/status` | `user:manage` | active / désactive |
| `DELETE /api/admin/users/:id` | `user:manage` | supprime le compte |
| `GET /api/admin/roles` | `role:read` | rôles et permissions associées |
| `GET /api/targets` | `target:read` | liste des cibles, **sans credential** |
| `POST /api/targets` | `target:create` | crée une cible, credential chiffré avant insertion |
| `GET /api/targets/:id` | `target:read` | détail et rapport de preflight |
| `PATCH /api/targets/:id` | `target:update` | modifie ; credential absent = inchangé |
| `DELETE /api/targets/:id` | `target:delete` | refuse si des déploiements sont actifs |
| `POST /api/targets/:id/preflight` | `target:update` | enfile un preflight, renvoie `202 { jobId }` |
| `GET /api/queue/jobs/:id` | `job:read` | état de n'importe quelle tâche `ops` (BullMQ) |
| `GET /api/applications` | `application:read` | liste des applications |
| `POST /api/applications` | `application:create` | corps = AppSpec validée par Zod, `generation` facultatif (prompt + spec d'origine) |
| `POST /api/applications/generate` | `application:create` | prompt → AppSpec **non persistée**. 501 sans clé, 422 si la spec reste invalide, 502 si le fournisseur ne répond pas, 429 au-delà de 10 générations / 10 min / utilisateur |
| `PATCH` `DELETE /api/applications/:id` | `application:update` / `:delete` | modifie, supprime |
| `GET /api/deployments` | `deployment:read` | historique paginé, filtres app / cible / statut |
| `POST /api/deployments` | `deployment:create` (+ `scan:configure` si `scanConfig` non vide) | crée + enfile, répond `202` sans attendre |
| `GET /api/deployments/:id` | `deployment:read` | déploiement et ses étapes |
| `GET /api/deployments/:id/logs` | `deployment:read` | **SSE** — historique puis direct |
| `GET /api/deployments/:id/scans` | `scan:read` | exécutions de scan et compteurs par sévérité |
| `GET /api/scans/:id` | `scan:read` | détail d'une exécution, findings paginés, filtre `severity` |
| `GET /api/scans/:id/sbom` | `scan:read` | téléchargement du SBOM (409 si le scanner n'en produit pas) |
| `GET /api/findings` | `scan:read` | vue transverse, filtres `cveId` `severity` `applicationId` `deploymentId` `scanner` |
| `POST /api/deployments/:id/rollback` | `deployment:rollback` | revient à la version précédente |
| `DELETE /api/deployments/:id` | `deployment:destroy` | détruit, libère le port et sa règle ufw |
| `GET /api/targets/:id/ports` | `target:read` | plage, ports alloués et par quelle app, ports libres |
| `GET /api/applications/:id/versions` | `application:read` | historique version / image / cible / statut / auteur |
| `POST /api/applications/:id/redeploy` | `deployment:create` | rejoue une version antérieure sur une cible |
| `GET /api/jobs` | `job:read` | tâches **planifiées** : cron lisible, dernier run, prochain run, présence dans BullMQ |
| `POST /api/jobs` | `job:manage` | planifie une tâche (`scan`, `healthcheck`, `cleanup`, `preflight`) |
| `GET /api/jobs/:id` | `job:read` | détail d'une tâche planifiée et ses 20 dernières exécutions |
| `PATCH /api/jobs/:id` | `job:manage` | change le cron, le payload, active / désactive |
| `DELETE /api/jobs/:id` | `job:manage` | supprime la tâche et son scheduler BullMQ |
| `POST /api/jobs/:id/run` | `job:manage` | déclenche une occurrence hors calendrier, `202` |
| `POST /api/ping` | `job:manage` | enfile un job `ping` dans `ops` |
| `GET /api/ping/:id` | `job:read` | état du job BullMQ |

Les garde-fous métier : impossible de retirer le rôle admin, de désactiver ou
de supprimer le **dernier administrateur actif**, ni d'agir sur son propre compte.

> **Déplacement au jalon 8.** `GET /api/jobs/:id` renvoyait l'état d'une tâche
> BullMQ ; il vit désormais sous `GET /api/queue/jobs/:id`. `/api/jobs` désigne
> les **tâches planifiées**, qui sont des lignes de `scheduled_jobs` avec un
> cycle de vie CRUD. Une même route ne pouvait pas répondre à la fois « où en est
> le job n° 42 » et « modifie la tâche planifiée `<uuid>` » : deux ressources,
> deux chemins. `use-preflight.ts`, `verify-jalon3.sh` et `setup-test-target.sh`
> ont suivi.

## Pipeline de déploiement

`POST /api/deployments` **crée les dix étapes en base, toutes en `pending`**,
enfile le job, et répond `202` sans rien attendre. L'UI affiche donc le pipeline
complet avant que le worker n'ait commencé.

```
preflight → allocate_port → render → upload → build → scan → deploy → healthcheck → proxy → rollback
```

`rollback` est déclarée comme les autres, et `skipped` quand tout va bien. Le
brief du jalon 7 proposait de l'insérer en cours d'exécution ; ç'aurait été
contredire la décision du jalon 4, qui veut que le pipeline soit **entièrement
connu au moment d'enfiler le job**. Une étape surgissant en cours de route ferait
mentir le compteur « n / total » de l'UI et obligerait le client SSE à gérer un
cas de plus. Un rollback qui n'a pas eu lieu est une information, pas un trou.

Chaque étape va de `pending` à `running` puis à `success`, `failed` ou `skipped`.
Un échec arrête le pipeline et marque le reste `skipped`.

**Aucun `if (runtime === ...)` dans le worker.** Une étape est `skipped` quand le
driver ou le provider renvoie `null` — `allocatePort()` en K3s, `build()` sans
service à construire, `register()` sans `ingress.host`. Le worker enchaîne, il
ne décide pas.

**Le job est idempotent.** Relancer un déploiement échoué remet en `pending` ce
qui n'a pas abouti et laisse les `success` intactes : seules les étapes non
réussies sont rejouées.

## Logs en direct

Le worker publie chaque ligne sur Redis (`deploy:{id}`) **et** l'ajoute à
`deployment_steps.log`. Redis porte le direct, la colonne porte la relecture.
Les écritures en base sont regroupées — une ligne de `docker compose pull`
toutes les 30 ms ferait autant d'`UPDATE`.

`GET /api/deployments/:id/logs` diffuse en SSE. L'ordre des opérations est ce
qui garantit l'absence de trou :

1. abonnement à Redis **avant** la lecture de l'historique ;
2. les messages reçus pendant la lecture sont mis de côté ;
3. envoi de l'historique persisté ;
4. vidage de la file, puis direct.

S'abonner après la lecture perdrait ce qui se produit entre les deux. Les deux
chemins appliquent la même déduplication, de sorte qu'un rafraîchissement de page
affiche exactement le même flux. Battement de cœur toutes les 15 s, connexion
Redis dédiée par flux, relâchée à la déconnexion du client.

## AppSpec et drivers

**`AppSpec` ne connaît ni Docker ni Kubernetes.** Aucun champ ne peut être
rattaché à un runtime : pas de `restart_policy`, pas d'`image_pull_policy`, pas
de `namespace`. Ce que la spec ne sait pas dire, le driver le décide — la
politique de redémarrage, le nommage des images, le réseau. Un test le vérifie
en inspectant les clés déclarées du schéma.

Refinements Zod : un seul service `exposed`, noms uniques, `dependsOn` référence
des services existants, pas de cycle (parcours en profondeur), `ingress.targetService`
existe, pas de clé déclarée à la fois en `env` et en `secrets`.

Trois fixtures dans `packages/core/src/spec/__fixtures__/` : `simple.json`
(une API), `fullstack.json` (front + api + postgres, volumes et `dependsOn`),
`invalid.json` (six violations, une par refinement).

**`DeploymentDriver`** — `preflight` `allocatePort` `render` `deploy`
`healthcheck` `rollback` `destroy` `logs`, plus une fabrique `getDriver(runtime)`.

Le driver **n'importe rien** de `packages/db`, de `apps/web` ni de Redis : il
reçoit tout par `DriverContext`, il exécute, et il émet des lignes via un
callback. C'est l'appelant qui décide de les publier sur Redis, de les écrire en
base, ou de les jeter.

La réservation de ports suit la même règle. Le driver a besoin de la table
`port_allocations`, mais n'a pas le droit de la connaître : le contexte porte une
interface `PortAllocator`, dont l'implémentation Drizzle vit dans `packages/db`.
L'anti-collision reste la contrainte unique `(target_id, port)` — deux workers
qui visent le même port produisent une violation `23505`, et celui qui perd
rejoue. La base tranche, jamais un `if`.

**Rendu Compose** — le driver construit un modèle typé, puis le sérialise en
YAML. Jamais de concaténation de chaînes : un test injecte des guillemets, des
sauts de ligne et des pièges YAML dans les variables d'environnement, et vérifie
qu'ils traversent intacts. Les deux fixtures valides sont soumises à
`docker compose config` — c'est Docker lui-même qui valide le rendu.

Isolation : un projet Compose par application (`app-{slug}`), son réseau bridge
(`app-{slug}-net`), ses volumes nommés préfixés. Les secrets ne sont jamais
inscrits dans le `compose.yml` : ils arrivent par un `.env` déposé en 0600.

## Scanners de sécurité

**Une interface, trois implémentations, une fabrique** — la même règle que pour
les drivers. Ajouter un quatrième outil, c'est ajouter une classe et une entrée
dans `getScanner()`. Le worker, les routes et l'UI ne changent pas.

```ts
interface Scanner {
  readonly key: 'trivy' | 'grype' | 'syft'
  readonly kind: 'vulnerability' | 'sbom'
  ensureInstalled(session): Promise<string>
  run(ctx, onLog): Promise<ScanReport>
}
```

| Outil | `kind` | Commande | Version épinglée |
|---|---|---|---|
| `TrivyScanner` | `vulnerability` | `trivy image --format json --scanners vuln` | 0.74.0 |
| `GrypeScanner` | `vulnerability` | `grype <image> -o json` | 0.118.0 |
| `SyftSBOM` | `sbom` | `syft scan <image> -o cyclonedx-json` | 1.51.1 |

Versions relevées le 2026-09-10 sur `api.github.com/.../releases/latest`, jamais
de mémoire. Elles sont épinglées : un scanner qui change de version sous les
pieds rendrait deux déploiements incomparables.

**Les scanners tournent sur la machine cible, par SSH**, exactement comme les
drivers, et sur l'image locale. Pas de registry, pas de rapatriement d'image, pas
de client embarqué dans le panel. `ensureInstalled()` détecte le binaire par son
`--version`, et ne le télécharge depuis la release GitHub que s'il est absent ou
périmé — l'architecture vient de `uname -m`. Binaires et caches vivent dans
`~/.bootstrap-tp` sur la cible. Dix minutes de délai maximum par scanner.

**La normalisation est le point clé.** Trivy et Grype décrivent la même CVE avec
deux vocabulaires. Chacun ramène le sien sur une échelle commune
(`CRITICAL HIGH MEDIUM LOW UNKNOWN`), dans sa propre classe, et rien en aval ne
sait plus qui a parlé :

| | Trivy | Grype | `Finding` |
|---|---|---|---|
| identifiant | `VulnerabilityID` | `vulnerability.id` | `cveId` |
| sévérité | `Severity` | `vulnerability.severity` (`Negligible` → `LOW`) | `severity` |
| paquet | `PkgName` | `artifact.name` | `package` |
| version | `InstalledVersion` | `artifact.version` | `installedVersion` |
| correctif | `FixedVersion` | `fix.versions[0]` | `fixedVersion` |
| avis | `PrimaryURL` | `dataSource` | `primaryUrl` |

`verify-jalon6.sh` compare les deux sorties CVE par CVE sur une image réelle.

**Le gate est une donnée**, `deployments.scan_config` :

```json
{ "scanners": ["trivy", "grype", "syft"], "failOn": "CRITICAL" }
```

L'étape `scan` s'intercale entre `build` et `deploy`. Elle lance les scanners
sélectionnés **en parallèle** (`Promise.allSettled`) : un outil qui plante est
marqué en erreur — verdict `unknown`, ni bloquant ni dédouanant — et n'empêche
pas les autres de conclure. Chaque couple (scanner, image) donne une ligne
`scan_runs` et ses `findings`. Les logs remontent dans le flux SSE existant,
préfixés du nom de l'outil.

Le verdict : si un scanner de `kind: vulnerability` rapporte au moins un finding
de sévérité `>= failOn`, l'étape passe `failed`, le pipeline s'arrête et **le
déploiement n'a pas lieu**. Avec `failOn: NONE`, le verdict est informatif et les
findings sont enregistrés quand même. Sans scanner sélectionné, l'étape est
`skipped`. Un SBOM ne bloque jamais : c'est son `kind` qui le dit, pas son nom.

Verdict et findings sont audit-loggés via `logAudit()` —
`deployment.scan.blocked` ou `deployment.scan.passed`, avec les scanners, le
seuil, les compteurs par sévérité et les CVE responsables.

**Aucun `if (scanner === 'trivy')` hors des implémentations.** Ce qui reste
partagé est une table de données, `SCANNERS` dans `packages/core/src/scan.ts` :
libellé, `kind`, format de SBOM. L'UI y lit ses libellés, la route SBOM y lit son
type MIME. Vérifiable :

```bash
grep -rn "trivy\|grype\|syft" apps/worker/src apps/web/src   # aucune occurrence
```

**Le SBOM n'a pas de colonne dédiée** : il *est* la sortie brute de l'outil qui
le produit, donc il vit dans `scan_runs.raw`. Une colonne supplémentaire le
dupliquerait octet pour octet, et il faudrait alors décider laquelle fait foi.
`GET /api/scans/:id/sbom` le sert avec le type MIME lu dans `SCANNERS`.

## Cycle de vie

### Ports : la base tranche, la cible vérifie

L'anti-collision **entre applications du panel** est la contrainte unique
`port_allocations (target_id, port)`. L'allocation ne fait jamais « SELECT puis
INSERT » : elle insère, et une violation `23505` renvoie le perdant au tirage
suivant. Deux workers simultanés ne peuvent pas obtenir le même port.

Reste ce que la base ne peut pas savoir : un service installé à la main sur la
machine, qui écoute déjà. Le driver le constate après coup (`ss -tlnH`, ou
`netstat -tln` sur les images qui n'ont pas `iproute2`), **abandonne** la
réservation devenue inutile et rejoue en excluant ce port. Une réservation déjà
acquise par l'application n'est jamais remise en cause : le port est occupé, oui,
mais par elle.

**La plage est portée par la cible** — `targets.port_range_start` /
`port_range_end`, défaut 30000-32767, avec une contrainte
`port_range_start <= port_range_end` en base. `DRIVER_PORT_RANGE` reste utile et
dit autre chose : ce que l'environnement du worker peut atteindre. Les deux sont
vraies, on garde **l'intersection** — garder la dernière lue en trahirait une.

**Le port est rendu à la destruction, et à l'échec.** La libération est dans un
`finally`, y compris pour un crash hors pipeline. La condition n'est pas « le
déploiement a échoué » mais « aucune version de cette application ne tourne sur
cette cible » : un échec survenu après un déploiement réussi — ou après un
rollback — laisse une version en service sur ce port, et le relâcher le donnerait
à quelqu'un d'autre.

`GET /api/targets/:id/ports` répond aux deux questions que la table seule ne sait
pas formuler : combien reste-t-il, et qui a quoi.

### UFW : une capacité du driver, pas un `if` dans le worker

`DeploymentDriver` porte deux méthodes **optionnelles** :

```ts
openFirewall?(ctx, port): Promise<void>
closeFirewall?(ctx, port): Promise<void>
```

`DockerComposeDriver` les implémente ; `K3sDriver` ne les déclare pas du tout —
l'exposition y passe par l'Ingress, il n'y a pas de port hôte à ouvrir. Le
pipeline appelle si la méthode existe. Il ne demande jamais quel runtime il
pilote, il demande ce que le driver sait faire :

```bash
grep -rn "runtime === '" apps/worker/src apps/web/src   # aucune occurrence
```

**La règle est identifiée par son commentaire**, `bootstrap-tp:{slug}`, jamais
par son numéro : `ufw status numbered` renumérote à chaque suppression, et une
règle effacée par index efface la voisine dès qu'une autre est partie
entre-temps. Le commentaire dit aussi à l'administrateur de la machine qui a
ouvert ce port et pour quoi.

**Le panel n'active jamais UFW de sa propre initiative.** Activer le pare-feu
d'une machine qu'on pilote en SSH est un excellent moyen de la perdre. S'il est
inactif ou absent, le driver l'écrit dans les logs du déploiement et continue :
le port publié par Docker reste joignable, c'est le filtrage qui n'existe pas.

### Healthcheck : trois issues, pas deux

La sonde respecte `retries`, `intervalSec` et `timeoutSec` de l'AppSpec, avec un
**backoff exponentiel plafonné** à 30 s — sans plafond, la cinquième tentative
attendrait seize fois l'intervalle demandé et le réglage n'aurait plus de sens.

| Issue | Ce qu'elle veut dire |
|---|---|
| `healthy` | le service répond, et il répond bien |
| `unhealthy` | il répond, mais hors 2xx/3xx — il tourne, il est cassé |
| `unreachable` | rien au bout : conteneur absent, port fermé, pod non prêt |

**Le diagnostic est capturé avant que la sonde ne rende la main** — Docker :
`docker compose ps -a` plus les 200 dernières lignes de logs de chaque service ;
K3s : `kubectl get pods`, `describe` et `logs` des pods en cause. L'ordre est ce
qui compte : un rollback automatique redémarre l'ancienne version et effacerait
la scène. Le diagnostic part dans `deployment_steps.error` **et** dans le flux
SSE.

### Rollback automatique

Trois conditions, toutes des données : l'échec porte sur `healthcheck`,
`deployments.auto_rollback` est vrai (case cochée par défaut au formulaire), et
`previous_deployment_id` existe. Un échec ailleurs — un scan bloquant, un
`deploy` qui n'a jamais démarré — ne déclenche rien : il n'y a rien à défaire, la
version précédente n'a jamais cessé de tourner.

Le pipeline appelle `driver.rollback()`, puis **revérifie la santé de la version
restaurée avec sa propre AppSpec** — pas avec celle qui vient d'échouer. C'est
tout l'intérêt de figer l'AppSpec dans chaque déploiement : la v2 a pu déplacer
sa route de santé ou changer de port, et la sonder avec les réglages de la v2
poserait la mauvaise question à la bonne machine.

Le déploiement finit alors en **`rolled_back`** — un statut qui existe dans
l'enum depuis le jalon 1, aucune migration nécessaire. L'UI le peint en ambre et
non en rouge : quelque chose s'est mal passé, et le filet a fonctionné.

Si le rollback échoue à son tour, le déploiement finit `failed` et l'erreur
nomme les deux échecs. **Jamais de second rollback** : rejouer la même commande
ne réglera pas ce qui vient d'échouer, et enchaîner les tentatives éloignerait la
machine d'un état connu.

Deux traces distinctes au journal : `deployment.rolled_back.automatic`, écrite
par le pipeline, dit **pourquoi** et **vers quoi** (version quittée, version
restaurée, raison) ; `deployment.rolled_back`, écrite par le handler, dit **où en
est** le déploiement. Les confondre donnerait deux charges utiles pour une même
action.

### Versions et rétention

Il n'y a pas de table « versions » : **le déploiement *est* la version**, et son
`app_spec` figée est ce qui rend un redéploiement possible des mois plus tard,
même si l'application a changé depuis.

`POST /api/applications/:id/redeploy` n'est pas un rollback. Le rollback remet en
service une release déjà présente sur la cible ; le redéploiement refait un
pipeline complet — nouveau numéro, nouveaux scans — à partir de l'AppSpec de
l'époque. C'est ce qui permet de rejouer une version sur une *autre* cible, ou
après un `destroy`. La politique de scan de la version d'origine est rejouée
telle quelle, et reste soumise à `scan:configure`.

**Rétention : les cinq derniers répertoires de version**, ménage fait au
déploiement suivant — le seul moment où l'on sait laquelle vient de devenir la
courante. Le tri se fait sur la date de modification et non sur le nom : `1.10.0`
précède `1.9.0` lexicographiquement, et c'est l'ordre de déploiement qui compte.
La release pointée par `current` n'est jamais supprimée, même si elle est
ancienne — ce qui est exactement le cas après un rollback. Elle s'ajoute alors
aux cinq plus récentes : six répertoires au pire, jamais davantage.

## Génération d'AppSpec par IA

Le LLM produit **du JSON validé par Zod**. Jamais de shell, jamais de commande,
jamais un chemin de fichier. C'est notre code qui exécute — et il n'exécute que
ce qui a passé `appSpecSchema`.

### Le flux

```
POST /api/applications/generate     application:create
  { prompt, hints? }
      ↓  generateObject()  — Vercel AI SDK + @openrouter/ai-sdk-provider
      ↓  safeParseAppSpec() — refinements compris
  { appSpec, model, usage, attempts }        ← RIEN n'est persisté
      ↓  l'utilisateur relit, corrige dans l'éditeur JSON
POST /api/applications              application:create
  { appSpec, generation: { prompt, model, appSpec } }
```

La génération n'écrit pas en base et ne déploie pas. Une IA qui créerait
l'application elle-même retirerait à l'opérateur le seul moment où il peut dire
non. Le bouton « Enregistrer » est le même dans les deux onglets de
`/applications/new`, et il emprunte la même route que l'import manuel.

### `generateObject()`, pas `generateText()` + `JSON.parse`

Le schéma passé au SDK est `appSpecShapeSchema` — la *forme* de l'AppSpec, sans
les contraintes croisées. Un JSON Schema ne sait de toute façon pas exprimer
« exactement un service exposé » ni « pas de cycle dans `dependsOn` » : ces
règles disparaissent à la traduction, quel que soit le schéma qu'on donne. En
gardant la validation complète de notre côté, c'est **notre** code qui tient le
verdict et qui peut réinjecter les reproches de Zod dans une relance, au lieu de
la déléguer au SDK et d'aller repêcher un `ZodError` au fond d'une chaîne de
`cause`.

### Une relance, pas deux

Si la spec ne passe pas la validation, on relance **une seule fois** en
réinjectant les erreurs de Zod, chemin par chemin, mot pour mot. Si la seconde
échoue aussi, on rend la main avec la liste des reproches. On ne « répare » pas
le JSON à la main : réparer, c'est écrire soi-même la moitié de la spec sans que
personne ne l'ait demandé.

Trois motifs d'échec, trois codes HTTP, parce que ce sont trois pannes
différentes et qu'elles n'appellent pas la même réaction :

| Motif | HTTP | Ce qui s'est passé |
|---|---|---|
| `invalid_spec` | 422 | le modèle a répondu, sa spec ne passe pas la validation — même après relance |
| `no_object` | 422 | le modèle n'a pas produit d'objet JSON exploitable |
| `provider` | 502 | réseau, quota, clé refusée, délai dépassé — le modèle n'a rien dit |

### Le prompt système est un fichier

`packages/core/src/ai/prompts/generate-appspec.md`, versionné comme du code. Il
décrit le schéma et ses contraintes, impose des images officielles en tag précis
(**jamais `latest`**), un healthcheck par service, des `resources` réalistes, la
compatibilité `runAsNonRoot`, et l'interdiction des secrets en clair dans `env`.

Il porte des marques `{{FIXTURE:nom.json}}` remplacées au chargement par le
contenu **réel** des trois fixtures du jalon 4A. Recopier les fixtures dans le
markdown aurait été plus simple, et faux : les exemples few-shot auraient dérivé
au premier changement de fixture, sans que rien ne le signale.

**Charger ce fichier a été le vrai piège du jalon.** `tsc` ne copie pas les `.md`
vers `dist/` : le script `build` de `packages/core` les recopie. Mais surtout,
Next **inline** `@tp/core` dans ses chunks serveur : `import.meta.url` n'y
désigne plus le paquet, et le traceur ne voit aucun `import` vers un `.md`. Trois
mesures, aucune superflue :

1. `outputFileTracingIncludes` dans `next.config.ts` embarque le prompt et les
   fixtures dans l'arbre `standalone`, à leur chemin depuis la racine du monorepo ;
2. `readCoreAsset()` essaie plusieurs candidats — à côté du module, puis relatifs
   au répertoire courant, où le serveur `standalone` se place dans `apps/web` ;
3. **chaque candidat est validé par son contenu.** Turbopack réécrit
   `new URL(…, import.meta.url)` : le `readFileSync` réussissait parfaitement et
   rendait le code source d'un module JavaScript à la place du prompt. Constaté,
   pas supposé — la sonde annonçait 1 701 octets là où le prompt en fait 9 966.
   Sans validation de contenu, l'erreur est silencieuse et le modèle répond
   n'importe quoi sans que rien n'ait échoué.

C'est aussi pourquoi `/api/health` charge le prompt et publie sa taille : un
fichier manquant dans une image doit se voir dans la sonde, pas devant le premier
utilisateur. `verify-jalon8.sh` vérifie la borne, pas seulement le `ok`.

### Garde-fous

| Garde-fou | Valeur | Où |
|---|---|---|
| Taille du prompt | 8 à 4 000 caractères | Zod, avant tout appel |
| Délai | 60 s | `AbortSignal.timeout` |
| Débit | 10 générations / 10 min / **utilisateur** | Redis, `INCR` + `EXPIRE` |
| Tentatives | 2 au maximum | boucle de `generateAppSpec()` |

Le compteur de débit est par utilisateur et non par IP : derrière un NAT
d'entreprise tout le monde partage une adresse, et la session est de toute façon
obligatoire. Redis indisponible laisse passer — un compteur en panne ne doit pas
couper une fonctionnalité — mais l'incident est journalisé.

Le corps est validé **avant** de regarder la configuration : une requête mal
formée est mal formée sur tous les panels, avec ou sans clé. L'inverse rendrait
la réponse dépendante du déploiement, et un client ne pourrait plus distinguer
« ma requête est fausse » de « ce panel n'a pas d'IA ».

Chaque génération passe par `logAudit()` — prompt, modèle, tokens, durée,
tentatives, succès ou motif d'échec. La clé, elle, n'apparaît nulle part : ni
dans un log, ni dans une entrée d'audit, ni dans la réponse.

### Sans clé

`OPENROUTER_API_KEY` est facultative. Sans elle, la route répond **501** avec un
message explicite, l'onglet « Depuis une description » est désactivé et le dit,
et le reste du panel fonctionne à l'identique. La chaîne complète — prompt,
validation, relance unique, rejet propre, panne du fournisseur — est couverte par
`packages/core/test/ai.test.ts` avec un **modèle simulé** (`MockLanguageModelV3`).

## Tâches planifiées

BullMQ repeatable jobs. **Pas de cron Linux** — décision de `CLAUDE.md`, jamais
rouverte.

| Type (enum) | Tâche BullMQ | Ce qu'elle fait | Ce qu'elle ne fait **pas** |
|---|---|---|---|
| `scan` | `scan:periodic` | relance les scanners configurés sur les déploiements courants, crée un `scan_run` par couple (scanner, image) | ne redéploie rien, ne bloque rien — une CRITICAL **alerte** |
| `healthcheck` | `health:periodic` | sonde les déploiements courants, écrit `deployments.health_status` | **ne déclenche aucun rollback** |
| `cleanup` | `cleanup:versions` | `driver.pruneReleases()` — les 5 dernières versions, plus la courante | ne touche jamais la version en service |
| `preflight` | `target:preflight:all` | enfile un `target:preflight` par cible | ne modifie aucune cible |

La quatrième porte un nom distinct de la tâche `target:preflight` du jalon 3, qui
prend **une** cible et ouvre une session SSH. Le balayage réutilise ce handler au
lieu d'en dupliquer la logique : une seule implémentation du preflight, un seul
endroit où un credential est déchiffré.

### Rien d'automatique et de destructeur

C'est la règle du jalon, et elle est visible dans l'UI : chaque tâche affiche ce
qu'elle **ne** fait pas, à côté de ce qu'elle fait. Un scan périodique qui
remonte une CRITICAL enregistre le finding, marque le verdict et écrit une ligne
de journal. Le déploiement reste en place, l'URL répond toujours.
`verify-jalon8.sh` le vérifie explicitement après chaque exécution.

`deployments.health_status` est distinct de `deployments.status`, et c'est
délibéré : un déploiement `success` peut devenir `unreachable` trois heures plus
tard sans cesser d'avoir réussi. Le statut de santé informe l'opérateur ; c'est
lui qui décide de la suite.

### Réconciliation base ↔ BullMQ

La base est la **source de vérité**, Redis n'est que l'exécutant. Au démarrage du
worker, `reconcileSchedulers()` remet les deux d'accord : une tâche active et
absente de Redis y est réinstallée, un cron modifié est réappliqué, une tâche
désactivée ou supprimée est retirée, et tout scheduler orphelin — reliquat d'une
version antérieure du code, ou d'une tâche supprimée pendant que le worker était
éteint — disparaît.

Sans cette étape, un worker redémarré hériterait de l'état de Redis, qui peut
être n'importe lequel. C'est le quatrième point du critère de sortie : la tâche
survit à `docker compose restart worker` et sa prochaine occurrence tombe.

Le panel écrit lui aussi dans les deux, **base d'abord** : si l'écriture Redis
échoue, la base reste juste et le worker rattrapera l'écart. L'inverse laisserait
tourner une tâche que plus personne ne voit. Une tâche active mais absente de
BullMQ est affichée comme telle dans `/jobs` plutôt que masquée — c'est une
information d'exploitation.

Le handler relit d'ailleurs la ligne en base à chaque occurrence : un scheduler
resté dans Redis alors que la tâche vient d'être désactivée n'exécute rien.

### Périodique ≠ pipeline

`runSecurityScan()` efface les exécutions précédentes du déploiement — une
relance rejoue l'étape et doit repartir d'une ardoise propre. Le scan périodique
passe `clearPrevious: false` : tout son intérêt est d'**empiler** les rapports
dans le temps sur un déploiement qui, lui, n'a pas bougé. Un seul drapeau, nommé,
plutôt que deux fonctions qui divergeraient.

### `pruneReleases` est passée sur l'interface

La purge des versions existait depuis le jalon 7, appelée par les deux drivers en
fin de déploiement. La tâche `cleanup:versions` en avait besoin depuis
l'extérieur — et le chemin des releases est une décision du driver, pas de
l'appelant. Elle est donc devenue une méthode de `DeploymentDriver` : la tâche ne
nomme aucun chemin et ne sait pas sur quel runtime elle tourne.

## Machines cibles

**Le credential ne sort jamais du panel.** Il est chiffré en AES-256-GCM à la
création, et c'est tout : `getTarget()` et `listTargets()` ne sélectionnent pas
la colonne `encrypted_credential`, donc la réponse HTTP ne peut pas la contenir,
même par oubli de filtrage. Le seul point de déchiffrement du projet est
`apps/worker/src/handlers/target-preflight.ts`, au moment d'ouvrir la session.

**Couche SSH** — `@tp/core/ssh`, sur `node-ssh` :
`connect` · `exec` · `execStream` · `upload` · `disconnect` · `withSession`.
Timeout de 30 s par défaut, configurable. Trois tentatives avec backoff
exponentiel sur échec réseau ; **aucune** sur échec d'authentification — une clé
invalide ne le deviendra pas en réessayant, et certaines cibles bannissent l'IP.
Le module ne dépend d'aucun logger : l'appelant injecte le sien, donc les sorties
de commandes traversent le `redact` Pino du jalon 2.

Le sous-chemin `@tp/core/ssh` est délibéré : `ssh2` reste hors du graphe de
dépendances du panel Next. Vérifiable —
`find apps/web/.next/standalone -name ssh2` ne retourne rien.

**Job `target:preflight`** — chaque contrôle est indépendant. Un `kubectl`
absent marque K3s indisponible, il ne fait pas échouer le preflight. Seule
l'impossibilité d'ouvrir la session SSH est fatale.

| Contrôle | Ce qu'il mesure |
|---|---|
| `ssh` | connexion et latence |
| `os` | `uname -a`, `/etc/os-release` |
| `sudo` | `sudo -n true` → nopasswd disponible ou non |
| `tools` | `ufw`, `curl`, `git`, `docker`, `kubectl` |
| `docker` | `docker info` + `docker compose version` |
| `k3s` | `kubectl get nodes -o json` → nodes, nodes prêts, version |
| `disk` | `df -Pk /` |
| `memory` | `free -m` |

Le résultat structuré va dans `targets.runtimes_available` (versions comprises,
le driver du jalon 4 en aura besoin), le rapport complet dans
`targets.preflight_report`, et le statut dans `targets.status` :

- `ok` — au moins un runtime exploitable
- `degraded` — la machine répond, mais rien n'y est déployable
- `unreachable` — session SSH impossible

## Pages

| Page | Accès |
|---|---|
| `/login` `/signup` `/logout` | public |
| `/` | session |
| `/targets` | `target:read` — liste, badges « Docker ✓ 29.x / K3s ✗ », bouton « Tester la connexion » |
| `/targets/new` `/targets/:id/edit` | `target:create` / `target:update` — credential jamais pré-rempli |
| `/targets/:id` | `target:read` — rapport de preflight complet, **jauge des ports alloués**, table app → port, état ufw |
| `/applications` | `application:read` — liste, bouton Déployer, cases Trivy / Grype / Syft, politique de blocage et **case « Rollback automatique »** |
| `/applications/new` | `application:create` — deux onglets : **« Depuis une description »** (textarea, bouton Générer, spinner, éditeur JSON du résultat, erreurs de validation en clair) et **« Depuis un JSON »** (l'import existant). Sans clé OpenRouter, le premier onglet est désactivé et le dit |
| `/applications/:id` | `application:read` — **timeline des versions**, bouton « Redéployer cette version » |
| `/deployments` | `deployment:read` — historique : app, cible, runtime, **scanners et verdict**, statut, durée |
| `/deployments/:id` | `deployment:read` — onglet **Pipeline** (étapes à gauche, logs live à droite, rollback si échec), badge `rolled_back` distinct de `failed` avec la version restaurée, et onglet **Sécurité** |
| `/jobs` | `job:read` — tâches planifiées : cron traduit en français, dernier run, prochain run, activation / désactivation, « Lancer », historique des exécutions dépliable. `job:manage` pour agir |
| `/admin/logs` | `audit:read` — logs d’activité : table paginée avec filtres. L’ancien chemin `/admin/audit` redirige en 308 |
| `/admin/users` | `user:manage` — liste, création, rôle, désactivation |

## Schéma de base

17 tables créées dès le jalon 1 — y compris celles qui ne serviront qu'au jalon 8,
pour n'avoir aucune migration structurelle en cours de projet. Le schéma
`users` / `sessions` / `accounts` / `verifications` correspondait déjà champ pour
champ à ce qu'attend Better Auth (plugin `admin` compris) : **le jalon 2 n'a
demandé aucune migration**.

`users` `sessions` `accounts` `verifications` · `roles` `permissions`
`role_permissions` `user_roles` · `targets` `applications` · `deployments`
`deployment_steps` `port_allocations` · `scan_runs` `findings` · `audit_logs`
`scheduled_jobs` — plus `scheduled_job_runs`, ajoutée au jalon 8.

`scheduled_job_runs` est une table dédiée et non des lignes d'`audit_logs`,
parce que ce ne sont pas les mêmes questions. Le journal d'audit répond à « qui a
fait quoi » : append-only, lu par un humain qui enquête. L'historique des
exécutions répond à « le scan de 4 h du matin a-t-il tourné, combien de temps, et
qu'a-t-il trouvé » : cadré par une clé étrangère, purgé avec sa tâche, affiché en
regard du cron. Les deux existent — chaque exécution passe **aussi** par
`logAudit()`.

Tous les statuts sont des **enums Postgres**. L'anti-collision de ports est la
contrainte unique `port_allocations (target_id, port)`, pas un `if` en TypeScript.
La plage publiable est portée par la cible, et une plage inversée est refusée par
la contrainte `targets_port_range_check` — pas seulement par Zod.

## Schéma — migrations

| Migration | Contenu |
|---|---|
| `0000_rainy_prodigy` | les 17 tables du jalon 1 |
| `0001_ambitious_mordo` | jalon 3 : `targets.sudo_method`, `targets.labels`, `target_status` passe à `unknown \| ok \| degraded \| unreachable`, `runtimes_available` devient un objet structuré |
| `0002_awesome_next_avengers` | jalon 4 : `deployment_steps.log`, `deployments.app_spec` (AppSpec figée au déploiement), `published_port`, `failed_step` |
| `0003_omniscient_redwing` | jalon 6 : `deployments.scan_config` — scanners retenus et seuil de blocage, figés au déploiement |
| `0004_sparkling_skin` | jalon 7 : `targets.port_range_start` / `port_range_end` (défaut 30000-32767) avec la contrainte `targets_port_range_check`, et `deployments.auto_rollback` |
| `0005_sad_gorgon` | jalon 8 : provenance IA sur `applications` (`generation_prompt`, `generation_model`, `generated_app_spec`, `generated_at`), santé constatée sur `deployments` (`health_status`, `last_health_at`, + enum `health_status`), et la table `scheduled_job_runs` |

Les tables `scan_runs` et `findings` existent depuis le jalon 1 : le jalon 6 n'a
demandé qu'une colonne. Deux noms y diffèrent du rapport normalisé
(`findings.version` = `installedVersion`, `findings.reference` = `primaryUrl`) ;
la traduction vit dans `packages/db/src/scans.ts`, pas dans une migration.

Le jalon 2 n'a demandé aucune migration : le schéma d'authentification du jalon 1
correspondait déjà à ce qu'attend Better Auth.

**L'enum `scheduled_job_type` n'a pas été migrée**, et c'est un arbitrage. Elle
vaut `scan | healthcheck | preflight | cleanup` depuis le jalon 1, là où le brief
du jalon 8 nomme les tâches `scan:periodic`, `health:periodic`,
`cleanup:versions`, `target:preflight`. Les quatre valeurs recouvrent exactement
les quatre tâches : migrer une enum Postgres pour un renommage cosmétique, sur
une table déjà appliquée, aurait coûté une migration délicate sans rien apporter.
Le nom BullMQ vit donc dans `scheduled_jobs.key`, qui *est* l'identifiant du job
scheduler côté BullMQ — c'est sa raison d'être. La correspondance
type → nom de tâche est une table de données, `SCHEDULED_JOB_TYPES` dans
`packages/core/src/schedule.ts` ; il n'existe nulle part de `if (type === 'scan')`.

## Ce qui n'existe pas encore

**`BunkerWebProvider`.** Prévu en P1 au jalon 8, il n'a pas été écrit — et c'est
un choix, pas un oubli. Le format de configuration de BunkerWeb a changé entre
ses versions majeures, aucune instance BunkerWeb ne tourne sur la cible de test,
et un provider écrit sur la seule foi d'une documentation, sans qu'une seule
requête ne le traverse jamais, n'est pas une capacité : c'est une affirmation
non vérifiée dans une table de fabrique. `getProxyProvider('bunkerweb')` lève
donc toujours, et `proxy` reste à `traefik`. Traefik seul est un choix assumé —
c'est d'ailleurs celui que `PLAN.md` coupe en premier en cas de retard.

**Pas de déploiement K3s réel.** Voir plus haut : le rendu est vérifié, le
déploiement ne l'est pas.

Trois points restent ouverts depuis le jalon 5, hors périmètre du jalon 7 : le
`securityContext` strict du `K3sDriver`, incompatible avec `nginx` et `postgres`
en `runAsUser: 1000` ; `fullstack.json`, dont `front.replicas: 2` empêche la
publication d'un port côté Docker ; et l'absence de cluster K3s, qui laisse
`scripts/test-parity.ts` non exécuté.

Le `TraefikProvider` écrit bien la configuration dynamique d'un Traefik, mais
**ne déploie pas Traefik** : sans `ingress.host` dans l'AppSpec, l'étape `proxy`
est `skipped` et l'exposition se fait par le port alloué.

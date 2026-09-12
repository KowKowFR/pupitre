# Bootstrap TP v2 — control plane

**Ce panel n'héberge rien. Il orchestre.** Il tourne chez vous en `docker compose`,
et il déploie *vos* applications sur *d'autres* machines, par SSH — en Docker
Compose ou en K3s, au choix, à partir de la même description. Les applications
déployées ne vivent jamais dans le panel : elles vivent sur les machines cibles,
et continueraient de tourner si le panel s'arrêtait.

C'est la confusion la plus fréquente, alors autant la lever tout de suite :

|  | Le panel | Les machines cibles |
|---|---|---|
| Ce que c'est | 4 conteneurs sur votre poste ou un serveur d'admin | des VM ou serveurs que vous possédez déjà |
| Ce qui y tourne | Next.js, un worker, PostgreSQL, Redis | vos applications |
| Ce qu'il faut y installer | rien d'autre que Docker | rien — le panel installe ce dont il a besoin par SSH |
| Si on l'éteint | on ne peut plus déployer ni superviser | les applications continuent de répondre |

Ce qu'il sait faire : déclarer des machines, décrire une application sous forme
d'`AppSpec` neutre (à la main ou par IA), la déployer avec un pipeline en dix
étapes et des logs en direct, l'analyser avec Trivy / Grype / Syft, revenir en
arrière tout seul si la sonde de santé échoue, superviser des sites et des
serveurs, notifier, et tracer chaque geste dans un journal d'activité.

---

## Démarrer

Prérequis : Docker (avec `compose`), et `jq` si vous comptez lancer les scripts
de vérification. Node et pnpm ne servent qu'au développement.

```bash
cp .env.example .env
docker compose up -d --build
```

Le panel applique les migrations, rejoue le seed RBAC, puis passe `healthy` ;
le worker ne démarre qu'ensuite. Ouvrez <http://localhost:3000> — la base est
vierge, donc l'inscription est ouverte et **le premier compte créé devient
administrateur**. Un assistant de démarrage vous prend en charge à la première
connexion : identité de l'instance, première cible, rôle, utilisateur, sécurité.

Contrôle :

```bash
docker compose ps                        # 4 conteneurs
curl -s http://localhost:3000/api/health # {"status":"ok","db":"ok","redis":"ok",...}
```

Pour autre chose qu'un essai local, régénérez les deux secrets avant le premier
démarrage — `MASTER_KEY` chiffre les credentials SSH et **ne peut pas être
changée après coup** sans rendre illisible tout ce qu'elle protège :

```bash
openssl rand -hex 32      # → MASTER_KEY
openssl rand -base64 48   # → BETTER_AUTH_SECRET
```

Pas de VM sous la main ? Le dépôt en fabrique deux, en conteneur :

```bash
./scripts/setup-test-target.sh   # cible Docker (docker-in-docker), enregistrée dans le panel
```

La cible K3s se monte à la main — voir [`docs/demarrage.md`](docs/demarrage.md#la-cible-k3s-de-test).

La suite du démarrage — mode développement, cibles de test, catalogue complet des
commandes — est dans **[`docs/demarrage.md`](docs/demarrage.md)**.

---

## Comment c'est construit

Les décisions sont dans **[`CLAUDE.md`](CLAUDE.md)**, qui est le document
d'autorité et se lit en cinq minutes. Ce qu'elles impliquent quand vous ouvrez
le code :

```
apps/web        Next.js 16 App Router — UI + Route Handlers REST
apps/worker     Process Node — consomme BullMQ, exécute par SSH
packages/db     Schéma Drizzle + migrations (source unique du modèle)
packages/core   AppSpec, RBAC, crypto, paramètres, queue — et quatre sous-chemins :
                  /ssh        node-ssh, preflight, métriques d'hôte
                  /drivers    DeploymentDriver + Docker + K3s
                  /scanners   Scanner + Trivy / Grype / Syft
                  /ai         génération d'AppSpec (Vercel AI SDK)
                  /probe      sondes HTTP et TLS de la supervision de sites
```

Les sous-chemins existent tous pour la même raison : `ssh2`, `nodemailer` et le
SDK IA ne doivent pas entrer dans le graphe de dépendances du panel Next. Les
*types* correspondants restent à la racine de `@tp/core`, parce que l'UI en a
besoin et qu'ils n'exécutent rien.

**Une seule image Docker, deux commandes au runtime : `web` et `worker`.**

Quatre conséquences qui expliquent la forme du code :

**Le driver ne sait rien du panel.** Il reçoit un `DriverContext`, il exécute, il
émet des lignes par un callback. Il n'importe ni `packages/db`, ni Redis. Même la
table `port_allocations` lui arrive derrière une interface `PortAllocator`. Si
vous cherchez « où le driver écrit en base », la réponse est : nulle part.

**Aucun `if (runtime === ...)` hors des drivers.** Le worker ne demande jamais
quel runtime il pilote, il demande ce que le driver sait faire : une étape est
`skipped` parce que la méthode a rendu `null` (`allocatePort()` en K3s), ou parce
qu'elle n'existe pas (`openFirewall?` non déclarée par `K3sDriver`). Vérifiable :
`grep -rn "runtime === '" apps packages --include='*.ts' | grep -v /drivers/`
ne rend rien.

**L'anti-collision de ports est une contrainte de base, pas un `if`.** On insère
dans `port_allocations (target_id, port)`, et une violation `23505` renvoie le
perdant au tirage suivant. Il n'y a pas de « SELECT puis INSERT » à trouver dans
le code, parce qu'il n'y en a pas.

**Tout ce qui est long passe par BullMQ.** Un déploiement, un preflight, un
relevé de métriques, un envoi de notification : la route HTTP enfile et répond
`202`, jamais elle n'attend une session SSH. La seule exception assumée est la
purge d'historique, qui est un `DELETE` en base et rien d'autre.

Le détail — les trois abstractions, l'AppSpec, le pipeline, les logs SSE, les
ports, UFW, le healthcheck, le rollback, la rétention — est dans
**[`docs/architecture.md`](docs/architecture.md)**.

---

## Ce que ça sait faire

| | Où c'est décrit |
|---|---|
| Machines cibles, preflight, charges distantes, suppression et purge | [`docs/exploitation.md`](docs/exploitation.md) |
| RBAC (30 permissions), journal d'activité, chiffrement, magasin de secrets, comptes et TOTP | [`docs/securite.md`](docs/securite.md) |
| Scanners Trivy / Grype / Syft et politique de blocage | [`docs/securite.md`](docs/securite.md#scanners-de-sécurité) |
| Sondes HTTP et TLS, métriques d'hôte, notifications, tâches planifiées | [`docs/supervision.md`](docs/supervision.md) |
| Génération d'AppSpec par IA, trois fournisseurs | [`docs/ia.md`](docs/ia.md) |
| Toutes les pages et toutes les routes d'API, avec leur permission | [`docs/api.md`](docs/api.md) |
| Tables et migrations | [`docs/base-de-donnees.md`](docs/base-de-donnees.md) |
| Les 22 scripts de vérification et ce que chacun prouve | [`docs/verification.md`](docs/verification.md) |

---

## Limites connues — au 12/09/2026

Ce qui suit est l'état du jour, pas une note en bas de page. Un README qui
prétend à l'intemporalité vieillit mal ; celui-ci est daté et le dit.

### Le critère d'architecture est enfin exercé — et il échoue

`CLAUDE.md` désigne un test comme « le test qui valide l'architecture » :
déployer **la même AppSpec** sur une cible Docker et une cible K3s, obtenir deux
URLs qui répondent, puis rollback des deux. Il devait tourner dès le jalon 5.
Il n'a longtemps pas pu : `scripts/test-parity.ts` existait, sans cluster à viser.

Depuis le 12/09/2026 la cible existe (`scripts/test-target-k3s/`, profil compose
`test`, k3s v1.33.4) et **le test tourne de bout en bout**. Il ne passe pas au
vert. C'est une bonne nouvelle : il découvre exactement ce qu'un test de parité
doit découvrir, et ce qu'aucun test de rendu n'aurait pu voir.

Résultat de `pnpm test:parity cible-docker-locale cible-k3s-locale`, rejoué le
12/09/2026 — `—` veut dire « la phase précédente a échoué, celle-ci n'a pas été
tentée » :

```
  Phase    Vérification                     docker   k3s
  ──────────────────────────────────────────────────────
  deploy   preflight()                      ✓       ✓
  deploy   allocatePort()                   ✓       ✓
  deploy   render()                         ✓       ✓
  deploy   upload()                         ✓       ✓
  deploy   build()                          ✓       ✗   ← limite 1
  deploy   deploy()                         ✓       —
  deploy   healthcheck()                    ✓       —
  deploy   l'URL répond 200                 ✗       —   ← limite 3
  rollback rollback()                       ✓       ✗   ← limite 2
  rollback santé après rollback             ✓       —
  rollback l'URL répond toujours            ✗       —   ← limite 3
  destroy  destroy()                        ✓       ✓
  destroy  artefacts supprimés de la cible  ✓       ✓
  destroy  aucun port réservé en base       ✓       ✓
  destroy  aucun conteneur Docker restant   ✓       —
  destroy  namespace K3s disparu            —       ✓

  21/25 vérification(s) au vert
```

Trois choses valent d'être notées avant les limites elles-mêmes. Les cinq
premières phases sont identiques des deux côtés — `preflight`, `allocatePort`
(qui rend `null` en K3s, comme prévu), `render`, `upload`. **La phase `destroy`
est intégralement verte sur les deux runtimes** : artefacts nettoyés, port rendu,
namespace disparu. Et les quatre échecs se rangent sous trois causes, toutes
connues et nommées ci-dessous — aucune n'est une surprise d'architecture.

### 1. Construire une image depuis un Dockerfile ne marche pas sur K3s

Un node K3s fait tourner containerd, pas Docker, et le projet a écarté l'usage
d'un registry. Le driver s'en aperçoit et le dit franchement, à l'étape `build` :

> Aucun `docker` sur le node : impossible de construire l'image sans registry.
> Installez Docker sur la cible, ou fournissez une AppSpec dont les services
> référencent des images déjà publiées (`source.type: "image"`).

Le message est juste et actionnable. Ce qui ne l'est pas, c'est **le moment** :
il tombe après `preflight`, `allocatePort`, `render` et `upload`, donc après que
les manifests aient déjà été déposés sur la machine. Le preflight K3s a l'AppSpec
sous la main et pourrait refuser tout de suite ; il ne le fait pas encore.

Une AppSpec dont tous les services sont en `source.type: "image"` n'est pas
concernée.

### 2. Le `securityContext` du rendu K3s empêche les images standard de démarrer

`packages/core/src/drivers/k3s/render.ts` impose à chaque pod
`runAsNonRoot: true`, `runAsUser: 1000`, `runAsGroup: 1000`, `fsGroup: 1000`,
et à chaque conteneur `capabilities: { drop: ['ALL'] }`.

Les entrypoints officiels de `nginx` et de `postgres` démarrent en root pour
préparer leurs répertoires, puis dégradent leurs privilèges eux-mêmes. En uid
1000, sans `CHOWN` ni `DAC_OVERRIDE`, ils échouent avant d'avoir servi quoi que
ce soit. Constaté, pas supposé — `postgres:16-alpine` en `CrashLoopBackOff` sur
la cible de test :

```
initdb: error: could not change permissions of directory
        "/var/lib/postgresql/data": Operation not permitted
```

C'est ce qui fait échouer la ligne `rollback()` du tableau ci-dessus : le driver
réapplique correctement les manifests, puis attend un `rollout status` qui ne
viendra jamais, et rend au bout de cinq minutes
`error: timed out waiting for the condition`.

Le rendu Docker, lui, n'impose ni `user`, ni `cap_drop`. La même AppSpec démarre
donc d'un côté et pas de l'autre : c'est une rupture de parité, et c'est la plus
gênante des deux.

Aucune échappatoire n'existe dans le code publié : ni champ d'AppSpec, ni réglage
de cible, ni variable d'environnement. Un test verrouille même le comportement
(`packages/core/test/render-k3s.test.ts`, « impose un securityContext strict »).

**Un chantier travaille dessus au moment où ces lignes sont écrites**, et son
travail est déjà dans l'arbre de travail — pas encore commité, donc pas encore
mesuré par le tableau ci-dessus, qui décrit le code publié. La direction prise
est de **distinguer nos images des images tierces** :

- pour une image que *nous* construisons (`source.type: "dockerfile"`), rien ne
  change : `runAsNonRoot`, `runAsUser`, `runAsGroup` et `drop: ['ALL']` — c'est
  notre Dockerfile, il doit s'y conformer ;
- pour une image tierce, on cesse de **choisir le compte** à sa place et on lui
  rend les cinq capabilities dont son entrypoint a besoin — `CHOWN`,
  `DAC_OVERRIDE`, `FOWNER`, `SETGID`, `SETUID` — en gardant `fsGroup`,
  `seccompProfile`, `allowPrivilegeEscalation: false` et `privileged: false`,
  qui ne dépendent d'aucune identité.

La sonde manuelle qui a servi à établir ça fait bien démarrer `nginx:1.27-alpine`
et `postgres:16-alpine` sur la cible de test. **Ce qui n'est pas encore prouvé,
c'est que le test de parité repasse au vert avec** : il faudra le rejouer une
fois le chantier commité.

### 3. `fullstack.json` ne publie pas de port côté Docker

La fixture porte `front.replicas: 2`, et Compose ne sait pas répartir un port
publié entre deux répliques. Le driver rend donc `publishedPort: null` — sans
`ingress.host` servi par un vrai Traefik, l'URL n'est pas joignable depuis le
poste. Le test de parité le compte comme un échec, et il a raison : c'est une
capacité manquante, pas un défaut du test.

### 4. `BunkerWebProvider` n'existe pas

Prévu en P1, il n'a pas été écrit — et c'est un choix. Le format de configuration
de BunkerWeb a changé entre ses versions majeures, aucune instance ne tourne sur
la cible de test, et un provider écrit sur la seule foi d'une documentation, sans
qu'une seule requête ne le traverse jamais, n'est pas une capacité : c'est une
affirmation non vérifiée dans une table de fabrique. `getProxyProvider('bunkerweb')`
lève, et `proxy` reste à `traefik`.

Le `TraefikProvider`, lui, écrit bien la configuration dynamique d'un Traefik mais
**ne déploie pas Traefik**. Sans `ingress.host` dans l'AppSpec, l'étape `proxy`
est `skipped` et l'exposition se fait par le port alloué.

### 5. Pas de clé d'IA dans ce dépôt

`OPENROUTER_API_KEY` et ses équivalents OpenAI / Anthropic ne sont pas renseignés.
La chaîne de génération est couverte de bout en bout par des tests unitaires sous
modèle simulé (`packages/core/test/ai.test.ts`), et `verify-ai.sh` saute
proprement ce qui exige un vrai fournisseur, en le disant. Personne n'a donc vu
un vrai modèle répondre sur cette instance.

### Détails plus petits, mais réels

- `GET /api/health` rapporte un état `ai` qui ne lit que `OPENROUTER_API_KEY` en
  variable d'environnement : il ignore les paramètres d'instance et les deux
  autres fournisseurs. Une instance parfaitement configurée en base y apparaît
  `ai.enabled: false`.
- La supervision de sites n'est **pas** branchée sur la couche de notifications :
  elle poste vers son propre webhook, par sonde. Le raccord est nommé dans le
  code (`apps/worker/src/monitors/notify.ts`) et tient en un corps de fonction.

---

## Versions

Les dépendances ont été auditées le 2026-09-09 — voir [`VERSIONS.md`](VERSIONS.md).
Le découpage par jalons et ce qu'on coupe en cas de retard sont dans
[`PLAN.md`](PLAN.md).

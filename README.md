# Pupitre — control plane

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
*types* correspondants restent à la racine de `@pupitre/core`, parce que l'UI en a
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
| Les 26 scripts de vérification et ce que chacun prouve | [`docs/verification.md`](docs/verification.md) |

---

## Limites connues — au 13/09/2026

Ce qui suit est l'état du jour, pas une note en bas de page. Un README qui
prétend à l'intemporalité vieillit mal ; celui-ci est daté et le dit.

### Le critère d'architecture est exercé, et il passe

`CLAUDE.md` désigne un test comme « le test qui valide l'architecture » :
déployer **la même AppSpec** sur une cible Docker et une cible K3s, obtenir deux
URLs qui répondent, puis rollback des deux. Il devait tourner dès le jalon 5. Il
n'a longtemps pas pu : `scripts/test-parity.ts` existait, sans cluster à viser.

La cible existe depuis le 12/09/2026 (`scripts/test-target-k3s/`, profil compose
`test`, k3s v1.33.4), et le test passe :

```
  Phase    Vérification                     docker   k3s
  ──────────────────────────────────────────────────────
  deploy   preflight()                      ✓       ✓
  deploy   allocatePort()                   ✓       ✓
  deploy   render()                         ✓       ✓
  deploy   upload()                         ✓       ✓
  deploy   build()                          ✓       ✓
  deploy   deploy()                         ✓       ✓
  deploy   healthcheck()                    ✓       ✓
  deploy   l'URL répond 200                 ✓       ✓
  rollback rollback()                       ✓       ✓
  rollback santé après rollback             ✓       ✓
  rollback l'URL répond toujours            ✓       ✓
  destroy  destroy()                        ✓       ✓
  destroy  artefacts supprimés de la cible  ✓       ✓
  destroy  aucun port réservé en base       ✓       ✓
  destroy  aucun conteneur Docker restant   ✓       —
  destroy  namespace K3s disparu            —       ✓

  30/30 vérification(s) au vert
```

La fixture (`packages/core/src/spec/__fixtures__/parity.json`) n'est pas
complaisante : quatre services reliés par `dependsOn`, dont **deux construits
depuis un Dockerfile** — `front`, la porte d'entrée, et `api` en deux répliques
avec son Dockerfile dans un sous-répertoire — plus `redis` et `postgres` sur
étagère, deux volumes, deux secrets dont un alias, et un ingress TLS. L'URL qui
répond des deux côtés est servie par une image que le panel a fabriquée
lui-même.

Trois choses valent d'être notées. Les phases de préparation sont identiques des
deux côtés — `preflight`, `allocatePort` (qui rend `null` en K3s, comme prévu),
`render`, `upload`. `destroy` est intégralement verte : artefacts nettoyés, port
rendu, namespace disparu. Et le port d'écoute des services construits est 8080 et
non 80, parce que nos images tournent en uid 1000 sans `CAP_NET_BIND_SERVICE` —
ce n'est pas un contournement du test, c'est la conséquence directe du
durcissement décrit plus bas.

### Comment une image se construit sans registry

Le problème est réel et il a longtemps été une limite : un node K3s fait tourner
containerd, pas Docker, et le projet a écarté l'usage d'un registry. `k3s ctr`
sait importer une image, pas la construire.

La réponse est **BuildKit en pod, worker OCI**, dont la sortie est un tar OCI
importé par `k3s ctr -n k8s.io images import -`. Le namespace `k8s.io` est le
point qui casse tout s'il change : c'est là que le kubelet cherche ses images.
Le tar transite par `kubectl exec`, ne touche jamais le disque du nœud et ne sort
jamais de la machine.

Le worker **containerd** de BuildKit serait plus élégant — l'image atterrirait
directement au bon endroit, sans tar. Il a été essayé en premier et il échoue :
ses étapes `RUN` sont exécutées par le shim containerd, qui tourne sur l'hôte, et
le faire fonctionner exige de propager des montages depuis le pod. Le kubelet
refuse alors le pod, `path "/var/lib/buildkit" is mounted on "/" but it is not a
shared mount`. Le worker OCI fait tourner `runc` **dans** le pod : rien à
propager, aucun hostPath, aucune hypothèse sur la topologie de montage du nœud.

Ce que ça laisse : le constructeur reste en place entre deux builds, parce que
son cache de couches vit dedans. C'est un pod privilégié qui attend sur le
cluster, volontairement dépourvu d'étiquette `managed-by` pour rester supprimable
depuis l'écran des charges, et la commande pour s'en défaire est journalisée à
chaque build. Rien ne le supprime automatiquement.

Un refus, lui, tombe désormais au **preflight** et non plus à l'étape `build` :
le contrôle `image_build` soumet le constructeur au cluster en `--dry-run=server`
et prend sa réponse. Avant, le refus arrivait après `upload`, donc après avoir
déposé les manifests sur la machine — Secrets rendus compris, en clair, pour un
déploiement qui n'aurait jamais lieu.

### Compose ne sait pas publier un port derrière plusieurs répliques

Un service à `replicas: 2` reçoit `publishedPort: null` côté Docker : Compose ne
sait pas répartir un port publié entre deux conteneurs. Sans `ingress.host`
servi par un vrai Traefik, un tel service n'est donc pas joignable depuis
l'extérieur en Docker — alors qu'il l'est en K3s, où un Service ClusterIP fait
exactement ce travail.

C'est une capacité manquante du runtime, pas un défaut du driver, et c'est la
seule asymétrie fonctionnelle qui subsiste entre les deux. La fixture de parité
la contourne en n'exposant que son service à réplique unique.

### `BunkerWebProvider` n'existe pas

Prévu en P1, il n'a pas été écrit — et c'est un choix. Le format de configuration
de BunkerWeb a changé entre ses versions majeures, aucune instance ne tourne sur
la cible de test, et un provider écrit sur la seule foi d'une documentation, sans
qu'une seule requête ne le traverse jamais, n'est pas une capacité : c'est une
affirmation non vérifiée dans une table de fabrique. `getProxyProvider('bunkerweb')`
lève, et `proxy` reste à `traefik`.

Le `TraefikProvider`, lui, écrit bien la configuration dynamique d'un Traefik mais
**ne déploie pas Traefik**. Sans `ingress.host` dans l'AppSpec, l'étape `proxy`
est `skipped` et l'exposition se fait par le port alloué.

### Pas de clé d'IA sur cette instance

`OPENROUTER_API_KEY` et ses équivalents OpenAI / Anthropic ne sont pas renseignés.
La chaîne de génération est couverte de bout en bout par des tests unitaires sous
modèle simulé (`packages/core/test/ai.test.ts`), et `verify-ai.sh` saute
proprement ce qui exige un vrai fournisseur, en le disant. Personne n'a donc vu
un vrai modèle répondre sur cette instance.

### Détails plus petits, mais réels

- **Trivy ne verra pas les images construites sur K3s.** Il cherche containerd
  sur `/run/containerd/containerd.sock`, namespace `default` ; k3s écoute sur
  `/run/k3s/containerd/containerd.sock`, namespace `k8s.io`. L'étape de scan rend
  donc `unknown` — non bloquant, mais silencieusement inutile. Deux variables
  d'environnement dans `packages/core/src/scanners/trivy.ts` suffiraient.
- **`destroy()` ne retire pas de containerd les images qu'il a fait construire.**
  Symétrique du driver Docker, mais ça s'accumule sur le nœud.
- **Le compteur de limitation de débit de l'authentification est en mémoire**,
  donc par processus. Correct pour un panel mono-conteneur, faux dès qu'on en
  met deux derrière un répartiteur.
- **Aucune alerte sur « machine injoignable ».** Les relevés en échec sont
  enregistrés avec leur raison, mais ne franchissent aucun seuil : une machine
  éteinte ne déclenche rien.

---

## Versions

Les dépendances ont été auditées le 2026-09-09 — voir [`VERSIONS.md`](VERSIONS.md).
Le découpage par jalons et ce qu'on coupe en cas de retard sont dans
[`PLAN.md`](PLAN.md).

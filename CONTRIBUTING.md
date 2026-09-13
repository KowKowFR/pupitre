# Contribuer à Pupitre

Merci de vous y intéresser. Ce guide décrit **ce projet-ci** : ses trois
abstractions, sa règle d'immuabilité des migrations, ses 26 scripts de
vérification. Ce n'est pas un modèle générique, et suivre un modèle générique ne
suffira pas à faire passer une revue ici.

Le français est la langue du projet : code, commentaires, messages de commit,
issues et documentation. Un système FR/EN pour l'interface est prévu ; il
n'existe pas encore.

- [Avant d'écrire du code](#avant-décrire-du-code)
- [Monter l'environnement](#monter-lenvironnement)
- [Les règles qui font échouer une revue](#les-règles-qui-font-échouer-une-revue)
- [Migrations : la règle d'immuabilité](#migrations--la-règle-dimmuabilité)
- [Vérifier son travail](#vérifier-son-travail)
- [Commits et pull requests](#commits-et-pull-requests)
- [Licence des contributions](#licence-des-contributions)

## Avant d'écrire du code

**Lisez [`CLAUDE.md`](CLAUDE.md).** Il fait cinq minutes et il fait autorité sur
la forme du code. Les huit « règles non négociables » qu'il porte ne sont pas des
préférences de style : une contribution qui en enfreint une est refusée, même si
elle marche.

Ensuite, selon ce que vous touchez :

| Vous touchez à… | Lisez d'abord |
|---|---|
| un driver, l'AppSpec, le pipeline | [`docs/architecture.md`](docs/architecture.md) |
| l'authentification, le RBAC, le chiffrement, les scanners | [`docs/securite.md`](docs/securite.md) |
| une sonde, une notification, une tâche planifiée | [`docs/supervision.md`](docs/supervision.md) |
| une route d'API | [`docs/api.md`](docs/api.md) |
| une table | [`docs/base-de-donnees.md`](docs/base-de-donnees.md) |
| la génération par IA | [`docs/ia.md`](docs/ia.md) |

Pour un changement qui dépasse la correction de bug, **ouvrez une issue avant**.
Le projet a des décisions figées (section « Décisions déjà tranchées » de
`CLAUDE.md`) : une pull request qui les rouvre sans discussion préalable coûte du
temps à tout le monde. Ce qui est ouvert, en revanche, est listé dans
[`docs/feuille-de-route.md`](docs/feuille-de-route.md).

## Monter l'environnement

Monorepo pnpm, quatre projets. Node ≥ 24 et pnpm 10 (la version exacte est dans
le champ `packageManager` du `package.json` racine — laissez Corepack la lire,
ne l'écrivez nulle part ailleurs).

```bash
cp .env.example .env
docker compose up -d postgres redis   # les dépendances dans Docker
pnpm install
pnpm dev                              # web (3000) + worker, en watch
```

Le détail — pile complète, cibles de test, profils compose — est dans
[`docs/demarrage.md`](docs/demarrage.md).

**`pnpm build:packages` avant tout typecheck.** `@pupitre/core` et `@pupitre/db`
sont consommés par leur `dist`, pas par leurs sources : sur une copie neuve,
lancer `pnpm -r typecheck` en premier produit une trentaine d'erreurs
`TS2307: Cannot find module '@pupitre/core'` sur des symboles qui existent
pourtant. `pnpm typecheck` à la racine enchaîne déjà la construction ; c'est
seulement si vous appelez les commandes une par une que l'ordre compte. Le
raisonnement complet est dans [`.github/ci-local.md`](.github/ci-local.md).

## Les règles qui font échouer une revue

### 1. Les trois abstractions ne se contournent pas

| Interface | Fichier | Implémentations |
|---|---|---|
| `DeploymentDriver` | `packages/core/src/drivers/types.ts` | `DockerComposeDriver`, `K3sDriver` |
| `ProxyProvider` | `packages/core/src/drivers/proxy.ts` | `TraefikProvider` |
| `Scanner` | `packages/core/src/scan.ts` | `TrivyScanner`, `GrypeScanner`, `SyftSBOM` |

Le critère de qualité est écrit dans `CLAUDE.md` : **ajouter un runtime, un proxy
ou un scanner doit se faire en ajoutant une classe, sans modifier une ligne
ailleurs.** Si votre patch a besoin de changer le worker pour ajouter un scanner,
c'est le patch qui est faux, pas l'abstraction.

Corollaire vérifiable en une commande :

```bash
grep -rn "runtime === '" apps packages --include='*.ts' --include='*.tsx' \
  | grep -v /drivers/ | grep -v /dist/
```

Elle rend **une ligne aujourd'hui**, et une seule :
`packages/db/src/deployments.ts:1329`, qui choisit un mot dans un message destiné
à un humain. Votre patch ne doit pas en ajouter une deuxième.

Une divergence entre runtimes se traite dans le driver : soit une méthode qui
rend `null` (comme `allocatePort()` en K3s), soit une méthode optionnelle qu'un
driver ne déclare pas (comme `openFirewall?`). Le pipeline appelle si la méthode
existe ; il ne demande jamais quel runtime il pilote.

### 2. L'AppSpec ne connaît ni Docker ni Kubernetes

`packages/core/src/spec/app-spec.ts`. Aucun champ ne doit pouvoir être rattaché à
un runtime : pas de `restart_policy`, pas de `image_pull_policy`, pas de
`namespace`. Un test le vérifie en inspectant les clés déclarées du schéma. Si
vous ajoutez un champ, demandez-vous d'abord si les deux drivers savent le
traduire ; sinon, c'est une décision du driver, pas une donnée de la spec.

### 3. Toute opération longue passe par BullMQ

Une route HTTP enfile et répond `202`. Elle n'attend jamais une session SSH.
La seule exception assumée aujourd'hui est la purge d'historique, qui est un
`DELETE` en base et rien d'autre.

Et des **Route Handlers REST**, pas de Server Actions pour les déploiements : le
worker et d'éventuels webhooks doivent pouvoir appeler la même API.

### 4. Rien de secret ne sort

Les credentials SSH, les valeurs de secrets d'application, la clé d'API d'IA, les
secrets des canaux de notification et les URL de webhook des sondes sont chiffrés
en base (AES-256-GCM, clés dérivées de `MASTER_KEY` par HKDF). Une requête de
lecture ne sélectionne pas la colonne chiffrée : la réponse HTTP ne *peut* donc
pas la contenir, même par accident. Gardez cette propriété — ne l'obtenez pas en
filtrant au dernier moment.

Le journal d'activité passe par **`logAudit()`**, point d'entrée unique. Jamais
d'insert dispersé dans un handler.

### 5. L'anti-collision de ports est une contrainte de base

Une unicité `(target_id, port)` sur `port_allocations`, et une violation `23505`
renvoie le perdant au tirage suivant. Pas de « SELECT puis INSERT ». Pas de `if`.

### 6. Les permissions sont des chaînes `ressource:action`

Trente aujourd'hui, dans `packages/core/src/permissions.ts` :

```bash
grep -oE "'[a-z0-9-]+:[a-z0-9-]+'" packages/core/src/permissions.ts | sort -u | wc -l
```

Toute route protégée passe par `requirePermission()`. Une nouvelle capacité
ajoute une permission au catalogue — elle ne réutilise pas une permission
voisine parce que c'était plus court.

## Migrations : la règle d'immuabilité

**Jamais éditer une migration déjà appliquée. Toujours en créer une nouvelle.**

Une migration passée sur une instance ne sera jamais rejouée : la modifier ne
change rien là-bas, et tout ailleurs. Le dépôt en compte quinze
(`packages/db/migrations/*.sql`), et **une garde de CI refuse toute modification,
suppression ou renommage** d'un fichier déjà présent sur la branche par défaut.
Un ajout reste évidemment permis.

Le flux normal :

```bash
# modifiez packages/db/src/schema/*.ts, puis
pnpm db:generate      # produit un nouveau fichier .sql
pnpm db:migrate       # l'applique en local
```

Relisez le SQL généré avant de le committer. Drizzle produit parfois un `DROP`
là où vous vouliez un `RENAME`.

## Vérifier son travail

### Le socle, sans aucun service

Il tourne en une trentaine de secondes sur un poste et c'est ce que la CI exige
de toute pull request :

```bash
pnpm install --frozen-lockfile
pnpm build:packages
pnpm -r typecheck
pnpm exec tsc --noEmit -p scripts/tsconfig.json
pnpm --filter @pupitre/web lint
pnpm --filter @pupitre/core test
pnpm test:schedule
pnpm test:ai
```

### Les scripts de vérification

Vingt-six `scripts/verify-*.sh`. Ce ne sont **pas** des tests unitaires : ils
empruntent exactement les mêmes routes que l'interface, contre une pile qui
tourne, avec `curl` et `jq`, et vérifient souvent l'effet réel sur la machine
cible ou en SQL. [`docs/verification.md`](docs/verification.md) dit ce que chacun
prouve.

Neuf d'entre eux ne demandent que la pile compose :

```bash
docker compose up -d --wait
docker compose --profile test up -d mailpit
./scripts/verify-rbac-audit.sh
./scripts/verify-roles.sh
# … voir .github/ci-local.md pour la liste des neuf
```

Les autres exigent une cible SSH déployable, que
`./scripts/setup-test-target.sh` provisionne en conteneur.

**Si vous ajoutez une capacité, ajoutez son script de vérification.** Les
conventions à respecter : sortir en code non nul au premier point en échec ;
créer sa propre matière et la démonter par un `trap` ; être relançable ; et
surtout, quand quelque chose ne *peut pas* être vérifié dans l'environnement
courant, **le dire et sauter** — jamais fabriquer un faux succès. C'est la
convention la plus importante du dépôt.

Si vous renommez un script, pensez aux références croisées :
`docs/verification.md`, `.github/workflows/e2e.yml`, `.github/ci-local.md`, et
les scripts qui s'appellent entre eux.

### La parité des runtimes

```bash
pnpm test:parity <cible-docker> <cible-k3s>
```

Une seule AppSpec, deux runtimes, jamais un champ modifié entre les deux. C'est
le test qui valide l'architecture, et il doit rester vert. Il exige deux cibles
enregistrées et joignables depuis le poste ;
[`docs/demarrage.md`](docs/demarrage.md#la-cible-k3s-de-test) explique comment
monter la cible K3s.

## Commits et pull requests

- **Une pull request, un sujet.** Un renommage massif mélangé à une correction
  de bug est irrelisable.
- **Messages de commit en français**, à l'impératif ou au constat, décrivant
  l'effet et non le fichier touché. Regardez `git log` : la forme y est établie.
- **Pas de secret dans le dépôt.** Une garde de CI cherche les clés à la forme
  réelle de leur fournisseur, les valeurs de `MASTER_KEY` et de
  `BETTER_AUTH_SECRET` à la forme d'un secret, et les clés privées complètes.
  `.env` et `.test-target-key*` sont ignorés par git — laissez-les l'être.
- **Décrivez ce que vous avez lancé**, avec la sortie réelle. Le modèle de pull
  request le demande. « Ça marche chez moi » n'est pas une vérification.
- Les changements de comportement documenté mettent la documentation à jour dans
  la même pull request. Un `docs/` en retard est une régression.

## Licence des contributions

Pupitre est sous **GNU AGPL v3 ou ultérieure** ([`LICENSE`](LICENSE)). En
proposant une contribution, vous acceptez qu'elle soit distribuée sous cette
licence. Il n'y a pas de CLA.

Conséquence à connaître avant de contribuer du code venu d'ailleurs : n'importez
pas de code sous une licence incompatible avec l'AGPL, et signalez toute
dépendance nouvelle dans votre pull request — les dépendances font l'objet d'un
journal de décisions, [`docs/dependances.md`](docs/dependances.md), et sont
souvent épinglées à la version exacte pour de bonnes raisons.

Pour signaler une faille de sécurité, **n'ouvrez pas d'issue** :
[`SECURITY.md`](SECURITY.md) décrit la voie privée.

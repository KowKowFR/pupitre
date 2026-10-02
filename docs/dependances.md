# Dépendances — ce qui est retenu, et pourquoi

Ce document est un **journal de décisions**, pas une liste de versions. Le
`package.json` et le `pnpm-lock.yaml` disent ce qui est installé ; ce fichier dit
pourquoi, et surtout pourquoi deux montées de version disponibles ont été
refusées.

Méthode : `npm view <pkg> dist-tags`, l'API tags du Docker Hub et
`api.github.com/repos/<owner>/<repo>/releases/latest`. **Aucune version n'a été
retenue de mémoire.** Les relevés sont datés parce qu'ils périment.

- [L'audit du 2026-09-09](#laudit-du-2026-09-09)
- [Correctifs de sécurité du 2026-10-02](#correctifs-de-sécurité-du-2026-10-02)
- [Images Docker](#images-docker)
- [Outils de scan, installés sur la cible](#outils-de-scan-installés-sur-la-cible)
- [Paquets d'IA](#paquets-dia)
- [Radix, pour une seule modale](#radix-pour-une-seule-modale)
- [Les deux montées écartées](#les-deux-montées-écartées)
- [Changements de code induits](#changements-de-code-induits)
- [Ce qui a été rejoué après les montées](#ce-qui-a-été-rejoué-après-les-montées)

## L'audit du 2026-09-09

| Package | Avant | Dernière stable | Majeure de retard | Retenu | Breaking changes rencontrés |
|---|---|---|---|---|---|
| `next` | 15.5.4 | **16.3.4** | oui (1) | ✅ 16.3.4 | `middleware.ts` déprécié → renommé `proxy.ts` ; Turbopack par défaut ; `NODE_OPTIONS` propagé aux workers, ce qui casse `node --env-file-if-exists` |
| `react` / `react-dom` | 19.2.0 | 19.3.0 | non | ✅ 19.3.0 | aucun |
| `typescript` | 5.9.3 | **7.0.2** | oui (2) | ❌ **5.9.3 conservé** | portage natif Go. `@typescript-eslint` (tiré par `eslint-config-next`) déclare `typescript >=4.8.4 <6.1.0` : lint non supporté. Voir plus bas |
| `tailwindcss` / `@tailwindcss/postcss` | 4.1.14 | 4.3.3 | non | ✅ 4.3.3 | aucun |
| `drizzle-orm` | 0.44.6 | 0.45.2 | n/a (0.x) | ✅ 0.45.2 | aucun. Une v1.0.0-rc existe, écartée : pas stable |
| `drizzle-kit` | 0.31.5 | 0.31.10 | non | ✅ 0.31.10 | aucun |
| `pg` | 8.16.3 | 8.23.0 | non | ✅ 8.23.0 | aucun |
| `bullmq` | 5.60.0 | **6.3.4** | oui (1) | ✅ 6.3.4 | aucun sur notre usage (queue + worker + repeatable jobs) |
| `ioredis` | 5.8.2 | **6.0.0** | oui (1) | ✅ 6.0.0 | RESP3. Aucun impact constaté avec BullMQ 6 |
| `better-auth` | 1.7.3 | 1.7.3 | non | ✅ 1.7.3 | déjà à jour. Une 1.0.0-canary existe, écartée |
| `node-ssh` | — | 13.2.1 | — | ✅ 13.2.1 | nouvelle dépendance |
| `ssh2` | — | 1.17.0 | — | ✅ transitif | tiré par `node-ssh` (`^1.14.0`) |
| `zod` | 4.6.0 | 4.6.0 | non | ✅ 4.6.0 | déjà à jour (migré 3 → 4 plus tôt) |
| `pino` | 9.13.1 | **10.3.1** | oui (1) | ✅ 10.3.1 | aucun sur notre usage (`redact`, `child`, transport) |
| `pino-pretty` | 13.1.2 | 13.1.3 | non | ✅ 13.1.3 | aucun |
| `eslint` | 9.37.0 | **10.10.0** | oui (1) | ❌ **9.39.5 conservé** | `eslint-plugin-react` et `eslint-plugin-jsx-a11y`, tirés par `eslint-config-next@16`, plafonnent à `eslint@^9` |
| `eslint-config-next` | 15.5.4 | 16.3.4 | oui (1) | ✅ 16.3.4 | exporte du flat config natif → `FlatCompat` et `@eslint/eslintrc` supprimés |
| `@types/node` | 22.20.2 | 24.13.4 | oui (1) | ✅ 24.13.4 | aligné sur l'image Docker. Le tag `latest` de `@types/node` est périmé (22.x) : il faut lire le tag `ts5.9` |
| `lucide-react` | 0.545.0 | 1.43.0 | oui | ✅ 1.43.0 | aucun (aucune icône encore importée à ce moment-là) |
| `tailwind-merge` | 3.3.1 | 3.6.0 | non | ✅ 3.6.0 | aucun |
| `concurrently` | 9.1.2 | 10.0.5 | oui (1) | ✅ 10.0.5 | aucun |
| `tsx` | 4.20.6 | 4.23.13 | non | ✅ 4.23.13 | aucun |
| `@eslint/eslintrc` | 3.3.1 | 3.3.7 | non | ❌ **supprimé** | plus nécessaire avec le flat config natif |
| `dotenv-cli` | — | 11.0.0 | — | ✅ 11.0.0 | nouvelle dépendance, voir « chargement du `.env` » |

## Correctifs de sécurité du 2026-10-02

`pnpm audit --prod` remontait deux failles dans des dépendances de production,
corrigées par des montées de version corrective, sans changement de code :

| Package | Avant | Après | Faille |
|---|---|---|---|
| `next` (et `eslint-config-next`) | 16.3.4 | **16.3.8** | critique : exécution de code dans `next/og` (`ImageResponse`). Pupitre ne s'en sert pas — pas exploitable ici, corrigé quand même |
| `nodemailer` | 10.0.5 | **10.0.13** | haute : déni de service par le parseur d'adresses ; modérée : enveloppe malformée à partir d'une partie locale entre guillemets |

Reste une alerte modérée sur `esbuild` (le serveur de développement répond à
n'importe quel site) : elle vient de `drizzle-kit`, outil de développement de
`@pupitre/db` qui génère les migrations. Rien de cela ne tourne en production.

## Images Docker

| Image | Avant | Dernière stable | Retenu | Raison |
|---|---|---|---|---|
| `node` | 22-alpine | 26-alpine (Current) | ✅ **24-alpine** | Node 24 « Krypton » est la LTS active. Node 26 est encore Current au 2026-09-09 |
| `postgres` | 16-alpine | 18-alpine | ❌ **16-alpine conservé** | [`CLAUDE.md`](../CLAUDE.md) fige « PostgreSQL 16 » dans la stack — décision de projet, pas un oubli |
| `redis` | 7-alpine | 8-alpine | ✅ **8-alpine** | stable, supporté par BullMQ 6 |

## Outils de scan, installés sur la cible

Relevés le 2026-09-10 sur
`api.github.com/repos/<owner>/<repo>/releases/latest`. Ces versions sont
**épinglées** dans les implémentations : un scanner qui change de version sous
les pieds rendrait deux déploiements incomparables. Elles sont installées sur la
machine cible depuis les archives des releases GitHub, jamais par le
gestionnaire de paquets — la cible n'est pas forcément Debian, et les dépôts
distribuent des versions arbitrairement anciennes. Un scanner de sécurité périmé
est pire qu'aucun scanner.

| Outil | Dernière release | Date de relevé | Retenu | Où |
|---|---|---|---|---|
| `aquasecurity/trivy` | v0.74.0 | 2026-09-10 | ✅ 0.74.0 | `packages/core/src/scanners/trivy.ts` |
| `anchore/grype` | v0.118.0 | 2026-09-10 | ✅ 0.118.0 | `packages/core/src/scanners/grype.ts` |
| `anchore/syft` | v1.51.1 | 2026-09-10 | ✅ 1.51.1 | `packages/core/src/scanners/syft.ts` |

Le nommage des archives diffère d'un projet à l'autre — Trivy publie
`trivy_<v>_Linux-ARM64.tar.gz`, Anchore `<outil>_<v>_linux_arm64.tar.gz` : la
traduction de `uname -m` vit dans chaque classe, pas dans l'installateur commun.

## Paquets d'IA

| Package | Dernière stable | Retenu | Compatibilité zod 4 |
|---|---|---|---|
| `ai` (Vercel AI SDK) | 7.0.97 | ✅ **7.0.97**, épinglé | `peerDependencies: { zod: "^3.25.76 \|\| ^4.1.8" }` — notre 4.6.0 est dans la plage |
| `@openrouter/ai-sdk-provider` | 3.0.0 | ✅ **3.0.0**, épinglé | `{ ai: "^7.0.0", zod: "^3.25.76 \|\| ^4.1.8" }` |
| `yaml` (racine, devDependency) | 2.9.x | ✅ ^2.9.0 | — ajouté pour `scripts/render-both.ts`, qui relit le YAML qu'il produit |

Les deux paquets d'IA sont **épinglés à la version exacte**, sans `^`, pour la
même raison que les scanners : la sortie structurée d'un SDK qui change de
version sous les pieds rendrait deux générations incomparables, et une
régression du provider se manifesterait par un JSON refusé, pas par une erreur
d'installation.

Deux vérifications faites à l'installation, et pas de mémoire :

1. `z.toJSONSchema(appSpecSchema)` fonctionne en zod 4.6 pour `io: 'input'` comme
   pour `io: 'output'` — `.prefault()`, `z.record` à clé contrainte et
   `discriminatedUnion` compris.
2. Le protocole provider v3 attend un usage **détaillé**
   (`usage: { inputTokens: { total }, outputTokens: { total } }`), pas des entiers
   plats. Le mock des tests le respecte ; s'en tenir à la forme « v2 » rendait des
   compteurs vides sans lever la moindre erreur.

**Modèle par défaut** : `anthropic/claude-sonnet-4.5`, surchargeable par
`OPENROUTER_MODEL`. Choisi pour sa fiabilité en sortie structurée et non pour son
prix : une AppSpec mal formée coûte une relance, donc deux appels.

## Radix, pour une seule modale

Relevé le 2026-09-10 avec `npm view @radix-ui/react-dialog version`.

| Package | Dernière stable | Retenu | Pourquoi |
|---|---|---|---|
| `@radix-ui/react-dialog` | 1.1.23 | ✅ **1.1.23**, épinglé | première et seule dépendance Radix du projet |

Les composants `ui/` ont été écrits à la main, sans Radix, faute de réseau au
moment de les écrire. Une modale ne peut pas l'être honnêtement : piège de focus,
`Escape`, `aria-modal`, restitution du focus au déclencheur et inertie du reste
de la page sont un travail à part entière, et le faire à moitié donne une boîte
qui *ressemble* à une modale sans en être une au clavier. Le paquet est épinglé à
la version exacte, comme les paquets d'IA : le comportement d'accessibilité ne
doit pas changer sous les pieds.

Aucun autre composant `ui/` n'a été réécrit : `dialog.tsx` est le seul à dépendre
de Radix.

## Les deux montées écartées

### TypeScript 7 — écarté

`typescript@7.0.2` est le portage natif en Go (les `optionalDependencies`
`@typescript/typescript-<os>-<arch>` le confirment). Il n'existe pas de 6.x :
le saut est 5.9 → 7.0.

Bloquant : `@typescript-eslint/*`, tiré transitivement par `eslint-config-next@16`,
déclare `peerDependencies: { typescript: ">=4.8.4 <6.1.0" }`. Adopter TS 7
signifierait linter dans une configuration non supportée par l'outil.

À réévaluer quand `typescript-eslint` publiera une version compatible TS 7.

**L'essai n'a pas été inutile** : la résolution de types plus stricte de TS 7 a
révélé que `packages/core` ne déclarait pas `@types/node` alors qu'il utilise
`Buffer`, `process` et `node:crypto`. Le paquet compilait par chance, grâce au
hoisting pnpm. Corrigé — `@types/node` est désormais une dépendance explicite,
avec `"types": ["node"]` dans son `tsconfig.json`.

### ESLint 10 — écarté

`eslint-plugin-react@7.37.5` et `eslint-plugin-jsx-a11y@6.10.2`, tous deux tirés
par `eslint-config-next@16`, plafonnent à `eslint@^9`. On reste en 9.39.5, la
dernière 9.x. À réévaluer avec la prochaine `eslint-config-next`.

## Changements de code induits

1. **`apps/web/src/middleware.ts` → `apps/web/src/proxy.ts`**, avec
   `export default function proxy(...)`. Next 16 déprécie la convention
   `middleware`. Le comportement est inchangé : filtrage optimiste sur la
   présence du cookie, aucune vérification en base (toujours en Edge).

2. **Chargement du `.env` en développement.** Le `.env` vit à la racine du
   monorepo ; Next ne le cherche que dans `apps/web`. Le contournement d'origine
   était `node --env-file-if-exists=../../.env next dev`. Next 16 propage
   `NODE_OPTIONS` à ses workers, qui refusent ce flag
   (`--env-file-if-exists= is not allowed in NODE_OPTIONS`). Les scripts
   `dev` et `start` passent désormais par `dotenv-cli` :
   `dotenv -c -e ../../.env -- next dev`. En production, docker compose injecte
   l'environnement directement — rien ne change.

3. **`apps/web/eslint.config.mjs`** utilise le flat config natif de
   `eslint-config-next@16` (`eslint-config-next/core-web-vitals` et
   `/typescript`). `FlatCompat` et `@eslint/eslintrc` ont été supprimés.

4. **`packages/core`** déclare `@types/node` et `"types": ["node"]`.

## Ce qui a été rejoué après les montées

Après la montée du 2026-09-09, puis après l'installation des paquets d'IA :
`pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, et les scripts de
vérification qui tournaient à ces dates — `verify-rbac-audit.sh`,
`verify-targets-preflight.sh` (après le déplacement de `/api/jobs/:id` vers
`/api/queue/jobs/:id`), `verify-deploy-logs.sh`, `verify-scanners.sh`,
`verify-ports-rollback.sh` et `verify-appspec-generation.sh`.

Les compteurs de tests de ces relevés sont périmés depuis longtemps ; l'état
courant se lit en lançant `pnpm test`. Ce qui compte et n'a pas bougé :

- `find apps/web/.next/standalone -name ssh2` reste **vide**. Le sous-chemin
  `@pupitre/core/ai` n'importe ni `ssh`, ni les drivers, ni les scanners — c'est
  toute la raison d'être du découpage en sous-chemins.
- La chaîne asynchrone traverse bien BullMQ 6 + ioredis 6 : `POST /api/ping` →
  job consommé → écriture dans `audit_logs`.

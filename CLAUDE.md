# Pupitre — contrat d'architecture

Ce document fait autorité sur la forme du code. Il se lit en cinq minutes et il
est le premier à consulter avant de contribuer — les règles ci-dessous ne sont
pas des conseils, une revue les fait respecter. Le « pourquoi » développé, avec
les conséquences pratiques, est dans [`docs/architecture.md`](docs/architecture.md).

## Ce qu'on construit

Un **control plane auto-hébergé** déployé via `docker compose up`, qui sert à déployer
des web apps sur des machines cibles distantes, en Docker Compose **ou** en K3s au choix,
avec génération de l'app par IA, scans de sécurité, RBAC et audit log.

Le panel n'est pas l'app déployée. Le panel orchestre. Ne jamais confondre les deux.

## Stack

- Next.js 16 App Router + shadcn/ui + Tailwind
- Worker Node séparé (`apps/worker`), même monorepo pnpm
- PostgreSQL 16 + Drizzle (migrations SQL versionnées)
- Redis + BullMQ (queue ET scheduler via repeatable jobs)
- Better Auth (plugin admin)
- node-ssh pour l'exécution distante
- Vercel AI SDK + `@openrouter/ai-sdk-provider`
- Zod pour toute validation, Pino pour les logs

## Structure

```
apps/web        Next.js — UI + Route Handlers
apps/worker     Process Node — consomme BullMQ, exécute les déploiements
packages/db     Schéma Drizzle + migrations (source unique)
packages/core   AppSpec, DeploymentDriver, ProxyProvider, Scanner
```

## Les 4 abstractions — ne jamais les contourner

### DeploymentDriver
`preflight() deploy() healthcheck() rollback() destroy() logs() allocatePort()`
Implémentations : `DockerComposeDriver`, `K3sDriver`.

### ProxyProvider
`register(app, target, port, runtime)` / `unregister(app)`
Implémentations : `TraefikProvider` (défaut), `BunkerWebProvider` (P1).

### Scanner
`run(image): Promise<ScanReport>` — rapport normalisé
Implémentations : `TrivyScanner`, `GrypeScanner`, `SyftSBOM`.

### SourceProvider
`resolveHead() compare() readFile() commit() downloadArchive() reportStatus() listRepositories()`
Implémentation : `GitHubSourceProvider` (GitHub App, polling — jamais de webhook).

**Critère de qualité :** ajouter un runtime, un proxy, un scanner ou un fournisseur
de code doit se faire en ajoutant une classe, sans modifier une seule ligne ailleurs.

## AppSpec — la spec neutre

L'IA et les formulaires produisent une `AppSpec` qui **ne connaît ni Docker ni Kubernetes**.
Elle est stockée en base. Le rendu vers `compose.yml` ou vers des manifests K8s se fait
au moment du déploiement, par le driver.

Conséquence : la même app se redéploie sur l'autre runtime en changeant un champ.

## Règles non négociables

1. **Aucun `if (runtime === 'docker')` hors des drivers.** Les divergences
   (allocation de ports, UFW, isolation) sont des responsabilités du driver.
2. **Toute opération longue passe par BullMQ.** Jamais dans une route HTTP.
3. **Route Handlers REST**, pas de Server Actions pour les déploiements.
   Le worker et d'éventuels webhooks doivent pouvoir appeler l'API.
4. **Le LLM ne produit jamais de shell.** Il produit du JSON validé par Zod.
   C'est notre code qui exécute.
5. **L'anti-collision de ports est une contrainte unique `(target_id, port)` en base.**
   Pas un `if` en TypeScript.
6. **L'audit log passe par `logAudit()`**, un point d'entrée unique.
   Jamais d'insert dispersé dans les handlers.
7. **Les credentials SSH sont chiffrés en base** (AES-256-GCM, `MASTER_KEY`).
   Jamais en clair, jamais dans les logs.
8. **Les logs de déploiement transitent par Redis pub/sub** sur `deploy:{id}`,
   relayés en SSE. Pas de `tail` sur fichier.
9. **Un dépôt lié ne porte que l'AppSpec** (`pupitre.json`). Ni cible, ni runtime,
   ni script : le dépôt dit quoi, le panel dit où et quand. Et Pupitre interroge
   le dépôt (polling) — le panel reste privé, aucun webhook entrant.

## Conventions

- Namespace / projet compose : `app-{slug}`
- Permissions : chaînes `ressource:action` (`deployment:create`, `target:delete`)
- Statuts de step : `pending | running | success | failed | skipped`
- Migrations : jamais éditer une migration appliquée, toujours en créer une nouvelle

## Décisions déjà tranchées — ne pas rouvrir

- Build des images **sur la machine cible** via SSH, pas de registry
- **Pas d'Ansible**
- **Pas de cron Linux** — BullMQ repeatable jobs
- Traefik par défaut sur les deux runtimes ; BunkerWeb est P1

## Commandes

```bash
pnpm dev                          # web + worker en watch
pnpm db:generate                  # génère une migration Drizzle
pnpm db:migrate                   # applique les migrations
pnpm test                         # tests unitaires de @pupitre/core
pnpm test:parity <docker> <k3s>   # la même AppSpec sur les deux runtimes
docker compose up -d              # stack complète
```

## Le test qui valide l'architecture

Déployer **la même AppSpec** sur une cible Docker et une cible K3s, obtenir deux URLs
qui répondent, puis rollback des deux. C'est `pnpm test:parity`, et il doit rester vert.
Si du code spécifique au runtime a fui hors des drivers, corriger immédiatement.

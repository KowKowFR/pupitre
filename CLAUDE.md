# Pupitre — architecture contract

This document is the authority on the shape of the code. It takes five minutes
to read and comes first before contributing — the rules below are not advice,
review enforces them. The detailed "why", with its practical consequences, is
in [`docs/architecture.md`](docs/architecture.md).

## What we are building

A **self-hosted control plane** deployed with `docker compose up`, used to deploy
web apps to remote target machines, with Docker Compose **or** K3s as you choose,
with AI-generated apps, security scans, RBAC and an audit log.

The panel is not the deployed app. The panel orchestrates. Never confuse the two.

## Stack

- Next.js 16 App Router + shadcn/ui + Tailwind
- Separate Node worker (`apps/worker`), same pnpm monorepo
- PostgreSQL 16 + Drizzle (versioned SQL migrations)
- Redis + BullMQ (queue AND scheduler through repeatable jobs)
- Better Auth (admin plugin)
- node-ssh for remote execution
- Vercel AI SDK + `@openrouter/ai-sdk-provider`
- Zod for all validation, Pino for logs

## Layout

```
apps/web        Next.js — UI + Route Handlers
apps/worker     Node process — consumes BullMQ, runs deployments
packages/db     Drizzle schema + migrations (single source)
packages/core   AppSpec, DeploymentDriver, ProxyProvider, Scanner
```

## The 4 abstractions — never bypass them

### DeploymentDriver
`preflight() deploy() healthcheck() rollback() destroy() logs() allocatePort() upstream()`
Implementations: `DockerComposeDriver`, `K3sDriver`.

### ProxyProvider
`detect() install() check() apply(routes) probe(route) uninstall()`
Implementations: `TraefikProvider` (default), `BunkerWebProvider` (WAF, through its API).
A domain is a **route** set by the proxy toward the upstream the driver
announces (`upstream()`: published port, cluster Service). The driver never
sets a route; the proxy does not know which runtime it routes to. How to
publish the application for its proxy — the machine's own, or another
machine's (central proxy, `proxy_links`) — is an intent (`DriverContext.exposure`)
that each driver translates: loopback, private address, NodePort, firewall.
A proxy **outside the targets**, reached through its API and never through
SSH, implements `RemoteProxyProvider` — `check() apply(routes) probe(route) reach()`:
`NginxProxyManagerProvider`. The worker only sees `openProxy()`.

### Scanner
`run(image): Promise<ScanReport>` — normalized report
Implementations: `TrivyScanner`, `GrypeScanner`, `SyftSBOM`.

### SourceProvider
`resolveHead() compare() readFile() findFiles() commit() downloadArchive() reportStatus() listRepositories()`
Implementations: `GitHubSourceProvider` (GitHub App), `GitLabSourceProvider` (gitlab.com or
self-hosted, by token), `GiteaSourceProvider` (Gitea, Forgejo, Codeberg, by token) — polling,
never webhooks. `createSourceProvider()` builds the client of a connection.

**Quality bar:** adding a runtime, a proxy, a scanner or a code provider must be
done by adding a class, without changing a single line elsewhere.

## AppSpec — the neutral spec

The AI and the forms produce an `AppSpec` that **knows neither Docker nor Kubernetes**.
It is stored in the database. Rendering to `compose.yml` or to K8s manifests happens
at deployment time, in the driver.

Consequence: the same app redeploys on the other runtime by changing one field.

## Non-negotiable rules

1. **No `if (runtime === 'docker')` outside the drivers.** Divergences
   (port allocation, UFW, isolation) are the driver's responsibility.
2. **Every long-running operation goes through BullMQ.** Never in an HTTP route.
3. **REST Route Handlers**, no Server Actions for deployments.
   The worker and any webhooks must be able to call the API.
4. **The LLM never produces shell.** It produces JSON validated by Zod.
   Our code does the executing.
5. **Port collision avoidance is a unique `(target_id, port)` constraint in the database.**
   Not an `if` in TypeScript.
6. **The audit log goes through `logAudit()`**, a single entry point.
   Never scattered inserts in handlers.
7. **SSH credentials are encrypted in the database** (AES-256-GCM, `MASTER_KEY`).
   Never in clear, never in logs.
8. **Deployment logs travel through Redis pub/sub** on `deploy:{id}`,
   relayed over SSE. No `tail` on a file.
9. **A linked repository carries only the AppSpec** (`pupitre.json`). No target,
   no runtime, no script: the repository says what, the panel says where and when.
   And Pupitre polls the repository — the panel stays private, no incoming
   webhook. Single exception, read-only: its **published** status pages (`/status…`).

## Conventions

- Language: **English** for code, comments, documentation, commits and pull
  requests. The product itself is bilingual (French and English): every
  user-facing text lives in a dictionary, never hard-coded — test guards
  enforce it. Older French comments are being translated; write new ones in English.
- Compose namespace / project: `app-{slug}`
- Permissions: `resource:action` strings (`deployment:create`, `target:delete`)
- Step statuses: `pending | running | success | failed | skipped`
- Domains: one route per name, **unique in the database** (`routes.hostname`). The AppSpec
  (`ingress.host`) only gives the default value at the first deployment
- Migrations: never edit an applied migration, always create a new one
- Real time: a Redis channel `pupitre:realtime` relayed over SSE. A screen receives a
  signal, never data — it re-reads itself (`<LiveRefresh>`) with its permissions

## Decisions already made — do not reopen

- Images are **built on the target machine** over SSH, no registry
- **No Ansible**
- **No Linux cron** — BullMQ repeatable jobs
- Traefik by default on both runtimes; BunkerWeb as a Docker container, through its API

## Commands

```bash
pnpm dev                          # web + worker in watch mode
pnpm db:generate                  # generate a Drizzle migration
pnpm db:migrate                   # apply migrations
pnpm test                         # unit tests of @pupitre/core
pnpm test:parity <docker> <k3s>   # the same AppSpec on both runtimes
pnpm test:proxy <docker> <k3s>    # the reverse proxy end to end, certificates included
pnpm test:npm <docker> <k3s>      # Nginx Proxy Manager, a remote proxy, end to end
pnpm test:rollback <docker> <k3s> # rolling back finds the right code, same version
pnpm test:source-isolation <docker> <k3s>  # a booby-trapped repository does not get through
pnpm test:catalog <target>        # every catalog template deployed, probed, destroyed
docker compose up -d              # full stack
```

## The test that validates the architecture

Deploy **the same AppSpec** to a Docker target and a K3s target, get two URLs
that answer, then roll both back. That is `pnpm test:parity`, and it must stay green.
If runtime-specific code has leaked out of the drivers, fix it immediately.

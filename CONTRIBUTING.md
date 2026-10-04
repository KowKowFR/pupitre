# Contributing to Pupitre

Thank you for your interest. This guide describes **this project**: its four
abstractions, its migration immutability rule, its verification scripts. It is
not a generic template, and following a generic template will not be enough to
get a review through here.

English is the project language: code, comments, commit messages, issues and
documentation. The interface itself is bilingual: a screen text goes in
`apps/web/src/i18n/messages/`, in French **and** in English — a test guard
refuses a French text hard-coded in the panel. The same goes for what the
worker, `@pupitre/core` and `@pupitre/db` say to a user (a deployment log, an
error, a schema complaint): it goes through their dictionaries.

- [Before writing code](#before-writing-code)
- [Setting up the environment](#setting-up-the-environment)
- [The rules that fail a review](#the-rules-that-fail-a-review)
- [Migrations: the immutability rule](#migrations-the-immutability-rule)
- [Verifying your work](#verifying-your-work)
- [Commits and pull requests](#commits-and-pull-requests)
- [License of contributions](#license-of-contributions)

## Before writing code

**Read [`CLAUDE.md`](CLAUDE.md).** It takes five minutes and it is the authority
on the shape of the code. Its nine "non-negotiable rules" are not style
preferences: a contribution that breaks one is refused, even if it works.

Then, depending on what you touch:

| You are touching… | Read first |
|---|---|
| a driver, the AppSpec, the pipeline | [`docs/architecture.md`](docs/architecture.md) |
| authentication, RBAC, encryption, the scanners | [`docs/security.md`](docs/security.md) |
| a probe, a notification, a scheduled task | [`docs/monitoring.md`](docs/monitoring.md) |
| an API route | [`docs/api.md`](docs/api.md) |
| a table | [`docs/database.md`](docs/database.md) |
| AI generation | [`docs/ai.md`](docs/ai.md) |

For a change that goes beyond a bug fix, **open an issue first**. The project
has settled decisions (the "Decisions already made" section of `CLAUDE.md`): a
pull request that reopens one without prior discussion costs everyone time.
What is open, on the other hand, is listed in
[`docs/roadmap.md`](docs/roadmap.md).

## Setting up the environment

A pnpm monorepo, four projects. Node ≥ 24 and pnpm 10 (the exact version is in
the `packageManager` field of the root `package.json` — let Corepack read it,
write it nowhere else).

```bash
cp .env.example .env
docker compose up -d postgres redis   # the dependencies in Docker
pnpm install
pnpm dev                              # web (3000) + worker, in watch mode
```

The details — full stack, test targets, compose profiles — are in
[`docs/getting-started.md`](docs/getting-started.md).

**`pnpm build:packages` before any typecheck.** `@pupitre/core` and `@pupitre/db`
are consumed through their `dist`, not their sources: on a fresh clone, running
`pnpm -r typecheck` first produces some thirty
`TS2307: Cannot find module '@pupitre/core'` errors on symbols that do exist.
`pnpm typecheck` at the root already chains the build; the order only matters
if you call the commands one by one. The full reasoning is in
[`.github/ci-local.md`](.github/ci-local.md).

## The rules that fail a review

### 1. The four abstractions are not bypassed

| Interface | File | Implementations |
|---|---|---|
| `DeploymentDriver` | `packages/core/src/drivers/types.ts` | `DockerComposeDriver`, `K3sDriver` |
| `ProxyProvider` / `RemoteProxyProvider` | `packages/core/src/proxy/types.ts` | `TraefikProvider`, `BunkerWebProvider` / `NginxProxyManagerProvider` |
| `Scanner` | `packages/core/src/scan.ts` | `TrivyScanner`, `GrypeScanner`, `SyftSBOM` |
| `SourceProvider` | `packages/core/src/sources/types.ts` | `GitHubSourceProvider`, `GitLabSourceProvider`, `GiteaSourceProvider` |

The quality bar is written in `CLAUDE.md`: **adding a runtime, a proxy, a
scanner or a code provider must be done by adding a class, without changing a
line elsewhere.** If your patch needs to change the worker to add a scanner, it
is the patch that is wrong, not the abstraction.

A corollary you can check with one command:

```bash
grep -rn "runtime === '" apps packages --include='*.ts' --include='*.tsx' \
  | grep -v /drivers/ | grep -v /dist/
```

It returns **no line** today. Your patch must not add one.

A divergence between runtimes is handled in the driver: either a method that
returns `null` (like `allocatePort()` on K3s), or an optional method a driver
does not declare (like `openFirewall?`). The pipeline calls it if the method
exists; it never asks which runtime it is driving.

### 2. The AppSpec knows neither Docker nor Kubernetes

`packages/core/src/spec/app-spec.ts`. No field may be tied to a runtime: no
`restart_policy`, no `image_pull_policy`, no `namespace`. A test checks it by
inspecting the keys the schema declares. If you add a field, first ask whether
both drivers can translate it; if not, it is a driver decision, not spec data.

### 3. Every long-running operation goes through BullMQ

An HTTP route enqueues and answers `202`. It never waits for an SSH session.
The only accepted exception today is the history purge, which is a `DELETE` in
the database and nothing else.

And **REST Route Handlers**, no Server Actions for deployments: the worker and
any webhooks must be able to call the same API.

### 4. Nothing secret gets out

SSH credentials, application secret values, the AI API key, notification
channel secrets and probe webhook URLs are encrypted in the database
(AES-256-GCM, keys derived from `MASTER_KEY` with HKDF). A read query does not
select the encrypted column: the HTTP response therefore *cannot* contain it,
even by accident. Keep that property — do not get it by filtering at the last
moment.

The audit log goes through **`logAudit()`**, a single entry point. Never
scattered inserts in a handler.

### 5. Port collision avoidance is a database constraint

A `(target_id, port)` uniqueness on `port_allocations`, and a `23505` violation
sends the loser to the next draw. No "SELECT then INSERT". No `if`.

### 6. Permissions are `resource:action` strings

Thirty-eight today, in `packages/core/src/permissions.ts`:

```bash
grep -oE "'[a-z0-9_-]+:[a-z0-9_-]+'" packages/core/src/permissions.ts | sort -u | wc -l
```

Every protected route goes through `requirePermission()`. A new capability adds
a permission to the catalog — it does not reuse a neighboring permission
because that was shorter.

### 7. What a user reads goes through a dictionary

A screen text, a line of a deployment log, a driver error, a schema complaint:
each lives in a French dictionary and its English counterpart
(`Translated<typeof fr>` makes a missing key a compile error), and is rendered
in the instance language. Two test guards refuse French hard-coded in the panel
(`apps/web/test/i18n.test.mjs`) and in `core`, the worker and the database
(`apps/web/test/product-messages.test.mjs`). Pino logs and programming
invariants (`new Error()`) are not shown to users and stay out of it.

## Migrations: the immutability rule

**Never edit a migration that has been applied. Always create a new one.**

A migration that has run on an instance will never be replayed: changing it
changes nothing there, and everything elsewhere. The repository has
forty-six of them (`packages/db/migrations/*.sql`), and **a CI guard refuses any
change, deletion or rename** of a file already present on the default branch.
An addition is of course allowed.

The normal flow:

```bash
# edit packages/db/src/schema/*.ts, then
pnpm db:generate      # produces a new .sql file
pnpm db:migrate       # applies it locally
```

Read the generated SQL before committing it. Drizzle sometimes produces a
`DROP` where you wanted a `RENAME`.

## Verifying your work

### The base, without any service

It runs in about thirty seconds on a workstation, and it is what CI requires of
every pull request:

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

### The verification scripts

Thirty-three `scripts/verify-*.sh`. They are **not** unit tests: they take
exactly the same routes as the interface, against a running stack, with `curl`
and `jq`, and often check the real effect on the target machine or in SQL.
[`docs/verification.md`](docs/verification.md) says what each one proves.

Some of them only need the compose stack:

```bash
docker compose up -d --wait
docker compose --profile test up -d mailpit
./scripts/verify-rbac-audit.sh
./scripts/verify-roles.sh
# … see .github/ci-local.md for the list
```

The others need a deployable SSH target, which
`./scripts/setup-test-target.sh` provisions in a container.

**If you add a capability, add its verification script.** The conventions to
follow: exit with a non-zero code at the first failing point; create your own
material and tear it down with a `trap`; be re-runnable; and above all, when
something *cannot* be verified in the current environment, **say so and skip**
— never fabricate a false success. It is the most important convention of the
repository.

If you rename a script, think of the cross-references:
`docs/verification.md`, `.github/workflows/e2e.yml`, `.github/ci-local.md`, and
the scripts that call one another.

### Runtime parity

```bash
pnpm test:parity <docker-target> <k3s-target>
```

One AppSpec, two runtimes, never a field changed between the two. It is the
test that validates the architecture, and it must stay green. It needs two
targets registered and reachable from the workstation;
[`docs/getting-started.md`](docs/getting-started.md#the-k3s-test-target)
explains how to set up the K3s target.

## Commits and pull requests

- **One pull request, one topic.** A mass rename mixed with a bug fix cannot be
  reviewed.
- **Commit messages in English**, in the imperative or as a statement,
  describing the effect rather than the file touched. Look at `git log`: the
  form is established there (`type(scope): summary`).
- **No secret in the repository.** A CI guard looks for keys shaped like their
  provider's real keys, `MASTER_KEY` and `BETTER_AUTH_SECRET` values shaped like
  a secret, and full private keys. `.env` and `.test-target-key*` are ignored by
  git — leave them that way.
- **Describe what you ran**, with the real output. The pull request template
  asks for it. "Works on my machine" is not a verification.
- Changes to documented behavior update the documentation in the same pull
  request. A `docs/` that lags behind is a regression.

## License of contributions

Pupitre is under the **GNU AGPL v3 or later** ([`LICENSE`](LICENSE)). By
submitting a contribution, you agree that it is distributed under this license.
There is no CLA.

A consequence to know before contributing code from elsewhere: do not import
code under a license incompatible with the AGPL, and point out any new
dependency in your pull request — dependencies have a decision log,
[`docs/dependencies.md`](docs/dependencies.md), and are often pinned to the
exact version for good reasons.

To report a security vulnerability, **do not open an issue**:
[`SECURITY.md`](SECURITY.md) describes the private channel.

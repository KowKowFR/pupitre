# Dependencies — what is kept, and why

This document is a **decision log**, not a list of versions. `package.json` and
`pnpm-lock.yaml` say what is installed; this file says why, and above all why two
available version upgrades were refused.

Method: `npm view <pkg> dist-tags`, the Docker Hub tags API and
`api.github.com/repos/<owner>/<repo>/releases/latest`. **No version was picked
from memory.** The readings are dated because they go stale.

- [The 2026-09-09 audit](#the-2026-09-09-audit)
- [Security fixes of 2026-10-02](#security-fixes-of-2026-10-02)
- [Docker images](#docker-images)
- [Scan tools, installed on the target](#scan-tools-installed-on-the-target)
- [AI packages](#ai-packages)
- [Radix, for a single modal](#radix-for-a-single-modal)
- [MCP, without the SDK](#mcp-without-the-sdk)
- [The two upgrades set aside](#the-two-upgrades-set-aside)
- [Resulting code changes](#resulting-code-changes)
- [What was replayed after the upgrades](#what-was-replayed-after-the-upgrades)

## The 2026-09-09 audit

| Package | Before | Latest stable | Major behind | Kept | Breaking changes met |
|---|---|---|---|---|---|
| `next` | 15.5.4 | **16.3.4** | yes (1) | ✅ 16.3.4 | `middleware.ts` deprecated → renamed `proxy.ts`; Turbopack by default; `NODE_OPTIONS` propagated to workers, which breaks `node --env-file-if-exists` |
| `react` / `react-dom` | 19.2.0 | 19.3.0 | no | ✅ 19.3.0 | none |
| `typescript` | 5.9.3 | **7.0.2** | yes (2) | ❌ **5.9.3 kept** | native Go port. `@typescript-eslint` (pulled in by `eslint-config-next`) declares `typescript >=4.8.4 <6.1.0`: lint not supported. See below |
| `tailwindcss` / `@tailwindcss/postcss` | 4.1.14 | 4.3.3 | no | ✅ 4.3.3 | none |
| `drizzle-orm` | 0.44.6 | 0.45.2 | n/a (0.x) | ✅ 0.45.2 | none. A v1.0.0-rc exists, set aside: not stable |
| `drizzle-kit` | 0.31.5 | 0.31.10 | no | ✅ 0.31.10 | none |
| `pg` | 8.16.3 | 8.23.0 | no | ✅ 8.23.0 | none |
| `bullmq` | 5.60.0 | **6.3.4** | yes (1) | ✅ 6.3.4 | none for our use (queue + worker + repeatable jobs) |
| `ioredis` | 5.8.2 | **6.0.0** | yes (1) | ✅ 6.0.0 | RESP3. No impact observed with BullMQ 6 |
| `better-auth` | 1.7.3 | 1.7.3 | no | ✅ 1.7.3 | already up to date. A 1.0.0-canary exists, set aside |
| `node-ssh` | — | 13.2.1 | — | ✅ 13.2.1 | new dependency |
| `ssh2` | — | 1.17.0 | — | ✅ transitive | pulled in by `node-ssh` (`^1.14.0`) |
| `zod` | 4.6.0 | 4.6.0 | no | ✅ 4.6.0 | already up to date (migrated 3 → 4 earlier) |
| `pino` | 9.13.1 | **10.3.1** | yes (1) | ✅ 10.3.1 | none for our use (`redact`, `child`, transport) |
| `pino-pretty` | 13.1.2 | 13.1.3 | no | ✅ 13.1.3 | none |
| `eslint` | 9.37.0 | **10.10.0** | yes (1) | ❌ **9.39.5 kept** | `eslint-plugin-react` and `eslint-plugin-jsx-a11y`, pulled in by `eslint-config-next@16`, cap at `eslint@^9` |
| `eslint-config-next` | 15.5.4 | 16.3.4 | yes (1) | ✅ 16.3.4 | exports native flat config → `FlatCompat` and `@eslint/eslintrc` removed |
| `@types/node` | 22.20.2 | 24.13.4 | yes (1) | ✅ 24.13.4 | aligned with the Docker image. The `latest` tag of `@types/node` is stale (22.x): read the `ts5.9` tag |
| `lucide-react` | 0.545.0 | 1.43.0 | yes | ✅ 1.43.0 | none (no icon imported yet at that time) |
| `tailwind-merge` | 3.3.1 | 3.6.0 | no | ✅ 3.6.0 | none |
| `concurrently` | 9.1.2 | 10.0.5 | yes (1) | ✅ 10.0.5 | none |
| `tsx` | 4.20.6 | 4.23.13 | no | ✅ 4.23.13 | none |
| `@eslint/eslintrc` | 3.3.1 | 3.3.7 | no | ❌ **removed** | no longer needed with native flat config |
| `dotenv-cli` | — | 11.0.0 | — | ✅ 11.0.0 | new dependency, see "loading `.env`" |

## Security fixes of 2026-10-02

`pnpm audit --prod` reported two vulnerabilities in production dependencies,
fixed by patch upgrades, without code changes:

| Package | Before | After | Vulnerability |
|---|---|---|---|
| `next` (and `eslint-config-next`) | 16.3.4 | **16.3.8** | critical: code execution in `next/og` (`ImageResponse`). Pupitre does not use it — not exploitable here, fixed anyway |
| `nodemailer` | 10.0.5 | **10.0.13** | high: denial of service through the address parser; moderate: malformed envelope from a quoted local part |

A moderate alert remains on `esbuild` (the development server answers any
site): it comes from `drizzle-kit`, a development tool of `@pupitre/db` that
generates migrations. None of it runs in production.

## Docker images

| Image | Before | Latest stable | Kept | Reason |
|---|---|---|---|---|
| `node` | 22-alpine | 26-alpine (Current) | ✅ **24-alpine** | Node 24 "Krypton" is the active LTS. Node 26 is still Current on 2026-09-09 |
| `postgres` | 16-alpine | 18-alpine | ❌ **16-alpine kept** | [`CLAUDE.md`](../CLAUDE.md) freezes "PostgreSQL 16" in the stack — a project decision, not an oversight |
| `redis` | 7-alpine | 8-alpine | ✅ **8-alpine** | stable, supported by BullMQ 6 |

## Scan tools, installed on the target

Read on 2026-09-10 from `api.github.com/repos/<owner>/<repo>/releases/latest`.
These versions are **pinned** in the implementations: a scanner changing version
underfoot would make two deployments incomparable. They are installed on the
target machine from the GitHub release archives, never through the package
manager — the target is not necessarily Debian, and distribution repositories
ship arbitrarily old versions. An outdated security scanner is worse than no
scanner.

| Tool | Latest release | Read on | Kept | Where |
|---|---|---|---|---|
| `aquasecurity/trivy` | v0.74.0 | 2026-09-10 | ✅ 0.74.0 | `packages/core/src/scanners/trivy.ts` |
| `anchore/grype` | v0.118.0 | 2026-09-10 | ✅ 0.118.0 | `packages/core/src/scanners/grype.ts` |
| `anchore/syft` | v1.51.1 | 2026-09-10 | ✅ 1.51.1 | `packages/core/src/scanners/syft.ts` |

Archive naming differs from one project to the other — Trivy publishes
`trivy_<v>_Linux-ARM64.tar.gz`, Anchore `<tool>_<v>_linux_arm64.tar.gz`: the
translation of `uname -m` lives in each class, not in the shared installer.

## AI packages

| Package | Latest stable | Kept | zod 4 compatibility |
|---|---|---|---|
| `ai` (Vercel AI SDK) | 7.0.97 | ✅ **7.0.97**, pinned | `peerDependencies: { zod: "^3.25.76 \|\| ^4.1.8" }` — our 4.6.0 is in range |
| `@openrouter/ai-sdk-provider` | 3.0.0 | ✅ **3.0.0**, pinned | `{ ai: "^7.0.0", zod: "^3.25.76 \|\| ^4.1.8" }` |
| `yaml` (root, devDependency) | 2.9.x | ✅ ^2.9.0 | — added for `scripts/render-both.ts`, which re-reads the YAML it produces |

Both AI packages are **pinned to the exact version**, without `^`, for the same
reason as the scanners: the structured output of an SDK changing version
underfoot would make two generations incomparable, and a provider regression
would show up as a refused JSON, not as an installation error.

Two checks made at installation, and not from memory:

1. `z.toJSONSchema(appSpecSchema)` works in zod 4.6 for `io: 'input'` as for
   `io: 'output'` — `.prefault()`, `z.record` with a constrained key and
   `discriminatedUnion` included.
2. The provider v3 protocol expects a **detailed** usage
   (`usage: { inputTokens: { total }, outputTokens: { total } }`), not flat
   integers. The tests' mock respects it; sticking to the "v2" shape returned
   empty counters without raising any error.

**Default model**: `anthropic/claude-sonnet-4.5`, overridable with
`OPENROUTER_MODEL`. Chosen for its reliability in structured output and not for
its price: a malformed AppSpec costs a retry, hence two calls.

## Radix, for a single modal

Read on 2026-09-10 with `npm view @radix-ui/react-dialog version`.

| Package | Latest stable | Kept | Why |
|---|---|---|---|
| `@radix-ui/react-dialog` | 1.1.23 | ✅ **1.1.23**, pinned | first and only Radix dependency of the project |

The `ui/` components were written by hand, without Radix, for lack of network
access when they were written. A modal cannot honestly be: focus trap,
`Escape`, `aria-modal`, returning focus to the trigger and making the rest of
the page inert are a job in themselves, and doing it halfway gives a box that
*looks* like a modal without being one on the keyboard. The package is pinned to
the exact version, like the AI packages: accessibility behavior must not change
underfoot.

No other `ui/` component was rewritten: `dialog.tsx` is the only one depending on
Radix.

## MCP, without the SDK

Read on 2026-10-07 with `npm view @modelcontextprotocol/sdk version dependencies`.

| Package | Latest stable | Kept | Why |
|---|---|---|---|
| `@modelcontextprotocol/sdk` | 1.32.1 | ❌ **not installed** | it brings Express, Hono, CORS, `express-rate-limit`, an OAuth client and Ajv — a second HTTP server inside the Next one |

The MCP endpoint (`POST /api/mcp`) only needs the protocol's envelope —
JSON-RPC, version negotiation, `initialize`, `ping`, tools, resources — in its
stateless Streamable HTTP form. That fits in `apps/web/src/lib/mcp/protocol.ts`
and is tested on its own. Authentication, permissions, validation and the audit
log are already the panel's: each tool hands its request to the REST route.

The revisions understood are those the SDK announced on that date
(`LATEST_PROTOCOL_VERSION = '2025-11-25'`, then `2025-06-18` and `2025-03-26`),
read from the package itself rather than from memory. Supporting a new revision
is a line in `SUPPORTED_PROTOCOL_VERSIONS`, once what it changes is read.

## The two upgrades set aside

### TypeScript 7 — set aside

`typescript@7.0.2` is the native Go port (the `optionalDependencies`
`@typescript/typescript-<os>-<arch>` confirm it). There is no 6.x: the jump is
5.9 → 7.0.

Blocking: `@typescript-eslint/*`, pulled in transitively by
`eslint-config-next@16`, declares `peerDependencies: { typescript: ">=4.8.4 <6.1.0" }`.
Adopting TS 7 would mean linting in a configuration the tool does not support.

To reassess when `typescript-eslint` publishes a TS 7-compatible version.

**The attempt was not useless**: TS 7's stricter type resolution revealed that
`packages/core` did not declare `@types/node` although it uses `Buffer`,
`process` and `node:crypto`. The package compiled by luck, thanks to pnpm
hoisting. Fixed — `@types/node` is now an explicit dependency, with
`"types": ["node"]` in its `tsconfig.json`.

### ESLint 10 — set aside

`eslint-plugin-react@7.37.5` and `eslint-plugin-jsx-a11y@6.10.2`, both pulled in
by `eslint-config-next@16`, cap at `eslint@^9`. We stay on 9.39.5, the latest
9.x. To reassess with the next `eslint-config-next`.

## Resulting code changes

1. **`apps/web/src/middleware.ts` → `apps/web/src/proxy.ts`**, with
   `export default function proxy(...)`. Next 16 deprecates the `middleware`
   convention. Behavior is unchanged: optimistic filtering on the presence of
   the cookie, no database check (still on the Edge).

2. **Loading `.env` in development.** `.env` lives at the monorepo root; Next
   only looks for it in `apps/web`. The original workaround was
   `node --env-file-if-exists=../../.env next dev`. Next 16 propagates
   `NODE_OPTIONS` to its workers, which refuse that flag
   (`--env-file-if-exists= is not allowed in NODE_OPTIONS`). The `dev` and
   `start` scripts now go through `dotenv-cli`:
   `dotenv -c -e ../../.env -- next dev`. In production, docker compose injects
   the environment directly — nothing changes.

3. **`apps/web/eslint.config.mjs`** uses the native flat config of
   `eslint-config-next@16` (`eslint-config-next/core-web-vitals` and
   `/typescript`). `FlatCompat` and `@eslint/eslintrc` were removed.

4. **`packages/core`** declares `@types/node` and `"types": ["node"]`.

## What was replayed after the upgrades

After the 2026-09-09 upgrade, then after installing the AI packages:
`pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, and the verification
scripts that ran on those dates — `verify-rbac-audit.sh`,
`verify-targets-preflight.sh` (after moving `/api/jobs/:id` to
`/api/queue/jobs/:id`), `verify-deploy-logs.sh`, `verify-scanners.sh`,
`verify-ports-rollback.sh` and `verify-appspec-generation.sh`.

The test counts of those readings have long been stale; the current state reads
by running `pnpm test`. What matters and has not moved:

- `find apps/web/.next/standalone -name ssh2` stays **empty**. The
  `@pupitre/core/ai` subpath imports neither `ssh`, nor the drivers, nor the
  scanners — that is the whole reason for splitting into subpaths.
- The asynchronous chain does go through BullMQ 6 + ioredis 6:
  `POST /api/ping` → job consumed → write to `audit_logs`.

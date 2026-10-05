# Replaying CI on your workstation

Two workflows, two natures.

| Workflow | Trigger | Measured duration | What it needs |
| --- | --- | --- | --- |
| `ci.yml` | every push, every PR | **25 s** from a fresh clone | nothing but Node and pnpm |
| `e2e.yml` | manual, and 03:00 UTC on weekdays | ~6 min here, ~12 min on a runner | Docker, the full stack |

---

## `ci.yml` — the base

### The order is not decorative

`@pupitre/core` and `@pupitre/db` are consumed **through their `dist`**: the
`exports` field of their `package.json` points to `./dist/*.js` and
`./dist/*.d.ts`, never to `src`. On a fresh clone, `dist/` does not exist.

Consequence, measured and not assumed: running `pnpm -r typecheck` first gives
**35 errors** of the form

```
src/schema/infra.ts(1,66): error TS2307: Cannot find module '@pupitre/core'
```

on symbols that do exist in the sources. `pnpm -r` does respect the topological
order, but that is not enough: `@pupitre/core`'s `typecheck` runs with
`--noEmit`, so it does not produce the `dist` that `@pupitre/db` needs. A real
build is required.

**`pnpm build:packages` first. Always.**

### The base, in the workflow's exact order

From a clean clone — without `node_modules`, without `dist`:

```bash
pnpm install --frozen-lockfile              #  3.5 s
pnpm build:packages                         #  3.3 s   ← prerequisite of both typechecks
pnpm -r typecheck                           #  6.6 s
pnpm exec tsc --noEmit -p scripts/tsconfig.json   #  0.9 s
pnpm --filter @pupitre/web lint                  #  5.0 s
pnpm --filter @pupitre/core test                 #  1.2 s
pnpm test:schedule                          #  0.5 s
pnpm test:ai                                #  3.7 s   (offline, no key)
```

Durations noted on an M-series Mac. Count two to three times more on a 2-vCPU
GitHub runner.

`pnpm typecheck` at the root already chains the first three lines; the workflow
separates them so that the red line names the failing check.

In CI, the six checks that follow the build are independent and **all** run,
even if one of them fails: a single run gives the real extent of the damage.
The summary table is at the bottom of the run's page.

### Versions

Neither Node nor pnpm is chosen at random, and neither is "the latest":

- **pnpm** — never written in the workflow. `pnpm/action-setup` reads
  `packageManager` in the root `package.json` (`pnpm@10.32.1`).
- **Node 24** — `NODE_VERSION` at the top of `ci.yml`. Must follow the
  `Dockerfile`'s `ARG NODE_VERSION` (`24-alpine`) and `engines.node` (`>=24`).
  There is no `.nvmrc`; if one appears, they will have to agree.

---

## The two guards

They run in their own job (`gardes`), in parallel with the base: a checkout, no
dependencies, a few seconds.

### Guard 1 — no secret in the repository

Five checks, written by hand rather than borrowed from a generic detector:

1. neither `.env` nor `.test-target-key*` in the index (at any depth);
2. `.gitignore` still covers them — the original protection has not gone;
3. no `MASTER_KEY` or `BETTER_AUTH_SECRET` value that has **the shape of a
   secret**: ≥ 32 characters, hex/base64 alphabet only. The criterion is the
   shape, not a list: `z.string().min(32)` and `${MASTER_KEY}` pass without
   noise, a real secret does not;
4. no API key shaped like its provider's real keys (`sk-or-v1-` + hex,
   `sk-ant-`, `sk-proj-`, `ghp_`, `AKIA`);
5. no **complete** private key. The PEM header alone is not enough to accuse:
   the add-target screen shows it as an example. It is the body — long lines of
   base64 in the same file — that betrays a real key.

Replaying on your workstation:

```bash
# extracts the workflow's `run:` block and runs it as is
python3 - <<'PY' > /tmp/guard-secrets.sh
import yaml
wf = yaml.safe_load(open('.github/workflows/ci.yml'))
print(next(s['run'] for s in wf['jobs']['gardes']['steps'] if s.get('id') == 'secrets'))
PY
bash /tmp/guard-secrets.sh
```

### Guard 2 — migrations are immutable

`CLAUDE.md`: "never edit an applied migration, always create a new one". A
migration that already ran on an instance will never be replayed: changing it
changes nothing there and everything elsewhere.

The guard refuses any **change**, **deletion** or **rename** of a
`packages/db/migrations/*.sql` already present on the default branch. An
addition is of course allowed.

The comparison base is **always** the default branch's state, never the previous
push — otherwise a migration added then touched up before merging would be
wrongly refused, although it was never applied anywhere. The only exception: a
push to the default branch itself, where the base is indeed
`github.event.before`.

```bash
python3 - <<'PY' > /tmp/guard-migrations.sh
import yaml
wf = yaml.safe_load(open('.github/workflows/ci.yml'))
print(next(s['run'] for s in wf['jobs']['gardes']['steps'] if s.get('id') == 'migrations'))
PY
GITHUB_EVENT_NAME=push GITHUB_REF=refs/heads/work BRANCHE_DEFAUT=main AVANT='' \
  bash /tmp/guard-migrations.sh
```

---

## `e2e.yml` — the end-to-end scripts

Ten of the thirty-three `verify-*.sh` run there: those that make do with
`postgres`, `redis`, `panel`, `worker` and `mailpit`. The workflow draws
`MASTER_KEY`, `BETTER_AUTH_SECRET` and the Postgres password at random itself —
**no GitHub secret is needed**.

The others require a privileged docker-in-docker SSH target, a real K3s cluster,
a forge or an identity provider, or have not been tried on a runner yet. The
full reasoning, with figures, is at the top of `.github/workflows/e2e.yml`.

On your workstation, these ten scripts run against the usual stack:

```bash
docker compose up -d --wait
docker compose --profile test up -d mailpit
for s in rbac-audit onboarding roles api-tokens account 2fa-reset settings schedules notifications monitors; do
  ./scripts/verify-$s.sh || echo "FAILED: verify-$s.sh"
done
```

Measured durations: `roles` 2 s, `rbac-audit` 1 s, `settings` 4 s,
`schedules` 5 s, `notifications` 17 s, `onboarding` 23 s, `2fa-reset` 37 s,
`account` 48 s, `monitors` 2 min 24 (it waits for real probe cycles) — **281 s**
in all, before `api-tokens` was added.

---

## Validating a workflow change without pushing

```bash
# YAML syntax + GitHub Actions schema + shellcheck of the `run:` blocks
actionlint .github/workflows/*.yml
```

`actionlint` is not a project dependency: a standalone binary, to get from the
`rhysd/actionlint` releases page.

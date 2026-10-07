# Getting started

- [The full stack](#the-full-stack)
- [Development mode](#development-mode)
- [The test targets](#the-test-targets)
- [The K3s test target](#the-k3s-test-target)
- [Command catalog](#command-catalog)
- [Compose profiles](#compose-profiles)

## The full stack

```bash
cp .env.example .env
docker compose up -d --build
```

Four services start: `postgres`, `redis`, `panel`, `worker`. The panel applies
the migrations then replays the RBAC seed (idempotent) before opening its port —
that is the job of `docker-entrypoint.sh`, which accepts four commands: `web`,
`worker`, `migrate`, `seed`. The worker waits for the panel to be `healthy`, so
the migrations have always run before the first job.

`postgres` and `redis` are published on **`127.0.0.1` only**, on ports **5433**
and **6380** — shifted so as not to clash with services already installed on the
workstation. The panel and the worker reach each other through the compose
network (`postgres:5432`, `redis:6379`) and ignore the URLs in `.env`.

The first account created becomes an administrator, and public sign-up **closes
for good** right after: it only exists to create that first account. There is no
variable to reopen it — a panel that holds SSH keys has no business taking in
strangers. People are then created or invited from **Users** (`user:manage`), or
come through single sign-on, whose default role is **No access** (`no-access`)
until an administrator chooses one; the `security.signup_pending` event announces
such an arrival. A sign-up attempt afterwards is refused and logged
(`auth.signup.blocked`).

The panel speaks English or French, as set for the instance in **Settings →
Regional settings**. A new instance starts in English (`en-US`); the setup
guide offers to change it at the first sign-in.

### The two secrets

```bash
openssl rand -hex 32      # → MASTER_KEY        (32 bytes in hexadecimal)
openssl rand -base64 48   # → BETTER_AUTH_SECRET (at least 32 characters)
```

`MASTER_KEY` derives, through HKDF-SHA256, the keys that encrypt the SSH
credentials, application secret values, the AI API key, notification channel
secrets, probe webhook URLs and the other secrets listed in
[`security.md`](security.md#encryption). **Changing it makes all of that
unreadable** — the `version:iv:authTag:ciphertext` format exists to allow a
rotation one day, but the rotation code is not written. Choose it before the
first start.

The panel and the worker **refuse to start** if it is missing or shorter than 32
bytes.

## Development mode

The dependencies run in Docker, the code runs on the workstation:

```bash
docker compose up -d postgres redis
pnpm install
pnpm dev        # web (3000) + worker, both in watch mode
```

`pnpm dev` first builds `@pupitre/core` and `@pupitre/db`, then starts the four
projects in parallel. Node ≥ 24 and pnpm 10 are required (`package.json`).

Careful: if the full stack is already running, its `panel` takes port 3000. Stop
it (`docker compose stop panel worker`) or run dev on another port.

## The test targets

The repository makes target machines in containers, for whoever has no VM. They
**never** start with `docker compose up`: they live under the `test` profile.

```bash
./scripts/setup-test-target.sh
```

The script generates an SSH key (`.test-target-key`, ignored by git), starts the
`ssh-target` container — **docker-in-docker**, with its own daemon, like a real
machine — waits for it to answer, then registers **two targets** in the panel:

| Name | Address | Seen from |
|---|---|---|
| `verification-target` | `ssh-target:22` | the worker — it is the one the UI and the scripts use |
| `local-docker-target` | `127.0.0.1:2222` | your workstation — for `pnpm test:driver` and `pnpm test:parity` |

It is the same machine, reached through two network paths. It only publishes ten
ports (30000-30009), hence the `DRIVER_PORT_RANGE=30000-30009` in
`.env.example`.

`kubectl` is deliberately absent from this image, so that the preflight reports
"Docker ✓ / K3s ✗" and you see that case.

To exercise the "UFW active" path:

```bash
TEST_TARGET_UFW=1 ./scripts/setup-test-target.sh
```

Port 22 is allowed **before** enabling it, otherwise the default policy would
cut the SSH session driving the machine.

## The K3s test target

It is the counterpart of the previous one: a real k3s cluster (v1.33.4),
reachable over SSH, with the Traefik it ships — the reverse proxy Pupitre
configures and hands domains to. It exists for the `CLAUDE.md` criterion, which
rendering alone cannot prove.

> There is **no** `setup-k3s-target.sh`: unlike the Docker target, startup is
> manual. `docker-compose.yml` carries the two commands as a comment, and this
> page details them.

```bash
# 1. the container — the key is the one produced by setup-test-target.sh
TEST_TARGET_PUBLIC_KEY="$(cat .test-target-key.pub)" \
  docker compose --profile test up -d --build k3s-target

# 2. wait for the cluster to be ready
docker compose logs -f k3s-target      # until sshd starts
ssh -i .test-target-key -p 2223 tp@127.0.0.1 'sudo kubectl get nodes'
```

Then register two targets by hand, in `/targets` or through `POST /api/targets`
— the same doubling as for Docker:

| Name | Host | Port | User | For |
|---|---|---|---|---|
| `verification-k3s-target` | `k3s-target` | 22 | `tp` | the worker: UI, preflight, deployments |
| `local-k3s-target` | `127.0.0.1` | 2223 | `tp` | the workstation: `pnpm test:parity` |

Authentication method: key, with the content of `.test-target-key` (the
**private** key). `sudo` is `NOPASSWD` on the target.

The cluster publishes its port 80 on `127.0.0.1:8080`: that is how you reach an
application by its domain, through Traefik. The panel allocates **no** port on
K3s.

The parity test then runs from the workstation:

```bash
pnpm test:parity local-docker-target local-k3s-target
```

It returned **32/32 green** on its last run, with a reverse proxy set on each
target; the detailed table and its analysis are in the README's
[known limits](../README.md#known-limits). A red dot there would be information,
not a script failure: it is what it is asked to reveal.

## Command catalog

| Command | Effect |
|---|---|
| `pnpm dev` | web + worker in watch mode |
| `pnpm build` | packages, worker (tsc) and web (next build) |
| `pnpm typecheck` | strict TypeScript on the 4 projects **and** on `scripts/` |
| `pnpm lint` | ESLint (Next) |
| `pnpm test` | unit tests of `@pupitre/core` and of the panel |
| `pnpm test:driver <target>` | end-to-end deployment on a real target |
| `pnpm test:parity <docker> <k3s>` | the parity test — drives both drivers live |
| `pnpm test:proxy <docker> <k3s>` | the reverse proxy end to end, certificates included |
| `pnpm test:npm <docker> <k3s>` | Nginx Proxy Manager, a remote proxy, end to end |
| `pnpm test:rollback <docker> <k3s>` | going back finds the right code, same version |
| `pnpm test:source-isolation <docker> <k3s>` | a booby-trapped repository does not get through |
| `pnpm test:catalog <target>` | each catalog template deployed, probed, destroyed |
| `pnpm test:schedule` | translation and computation of cron expressions |
| `pnpm test:ai` | multi-provider configuration, offline |
| `pnpm tsx scripts/render-both.ts <spec.json>` | renders an AppSpec to Compose **and** to K8s manifests, without deploying anything |
| `pnpm db:generate` | generates a Drizzle migration from the schema |
| `pnpm db:migrate` | applies the migrations |
| `pnpm db:seed` | idempotent RBAC seed (roles, permissions) |
| `pnpm db:studio` | Drizzle Studio |

The `./scripts/verify-*.sh` scripts have their own catalog:
[`verification.md`](verification.md).

## Compose profiles

```bash
docker compose config --services                  # postgres redis panel worker
docker compose --profile test config --services   # + the test services below
```

| Service | Profile | Role |
|---|---|---|
| `postgres` `redis` `panel` `worker` | — | the stack |
| `ssh-target` | `test` | throwaway Docker target (docker-in-docker) |
| `k3s-target` | `test` | throwaway K3s target (real cluster) |
| `pebble` `pebble-dns` `acme-front` | `test` | a test ACME server and its DNS, for `pnpm test:proxy` |
| `npm-proxy` | `test` | a throwaway Nginx Proxy Manager, for `pnpm test:npm` — interface on <http://localhost:8181> |
| `mailpit` | `test` | throwaway SMTP server, for `verify-notifications.sh` — interface on <http://localhost:8025> |
| `keycloak` | `test` | throwaway OpenID Connect provider, `pupitre` realm imported, for `verify-sso.sh` — <http://localhost:8180> (`admin` / `admin`) |
| `gitea` `gitlab` | `test` | throwaway forges, for `verify-source-gitea.sh` and `verify-source-gitlab.sh` |
| `capture-browser` | `capture` | a headless Chromium on an isolated network, for screenshots of a site that is down |

The test services are `privileged` or publish ports: they must never start by
accident, hence the profile. `docker compose up -d` alone does not touch them.

### Environment variables

`.env.example` documents them one by one. Two points that cost time:

- **`MONITOR_ALLOWED_CIDRS` must have the same value on the panel and on the
  worker.** The panel uses it to refuse a probe at creation, the worker to refuse
  it at each redirect hop. A diverging value lets you create probes that the
  worker will silently refuse. Both cache it at module level: **a change requires
  restarting** both services.
- **`DRIVER_PORT_RANGE` and the target's range say two different things** —
  what the worker can reach, and what the machine accepts to open. It is their
  *intersection* that is kept.

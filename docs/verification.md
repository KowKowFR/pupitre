# Verifying

Thirty-three `./scripts/verify-*.sh` scripts. They are not unit tests: they take
**exactly the same routes as the UI**, against a running stack, with `curl` +
`jq`, and often check the real effect on the target machine or in SQL.

They share their conventions:

```bash
./scripts/verify-secrets.sh
BASE_URL=http://localhost:3200 ./scripts/verify-secrets.sh
TARGET_NAME=my-vm ./scripts/verify-purge.sh
```

- Each one exits with a non-zero code at the first failing point, and can be run
  again.
- Each one creates **its own material** and tears it down at the end, with a
  `trap`. Several compare the inventory of applications before and after to
  prove they touched nothing else.
- `jq` is required. Most need a deployable Docker target —
  `./scripts/setup-test-target.sh` provisions one.
- When a script *cannot* verify something, it says so and skips, without
  fabricating a false success. That is the case of everything that depends on an
  AI provider on this instance.

## What each one proves

### Foundations

| Script | What it establishes |
|---|---|
| `verify-rbac-audit.sh` | a viewer gets a `403` on `POST /api/deployments`, and the refusal appears in the activity log with the actor **and the IP behind the reverse proxy**; it reads deployments, but not the audit log |
| `verify-api-tokens.sh` | an API token is shown only once and kept as a hash; it opens the API within its permissions, not the interface nor the token factory; **it loses what its author loses** and disappears with them; limited to one application, it is refused everywhere else, even on a route of its own application that does not check the scope; revoked, expired, unknown: 401; the audit log names the token and never contains it. No target — **37/37** on the last run |
| `verify-sso.sh` | single sign-on against a real Keycloak (`docker compose --profile test up -d keycloak`): **Test** recognizes the right issuer and refuses a nonexistent realm; an unknown role is refused; the client secret never comes back out and it is encrypted; an account is born **directly** with its groups' role; creation disabled → `signup_disabled` without an account; email not verified at the provider → no link, local account intact; a group changed in Keycloak changes the role at the next sign-in, both ways. **17/17** on the last run |
| `verify-targets-preflight.sh` | a target is added with an SSH key, the preflight reports "Docker ✓ / K3s ✗" without reloading the page, the credential is unreadable in the database, and the API never returns it — checked at every depth of the JSON |
| `verify-roles.sh` | roles are data: one is created, its permissions changed, `admin` refuses to be touched, a role in use refuses to be deleted, and **the seed does not rewrite a customization** at restart |
| `verify-account.sh` | password (the old one required, the old one dies, the *other* sessions drop), two-stage TOTP with real RFC 6238 codes, a backup code that only works once, and the secret absent from the database as from the logs |
| `verify-2fa-reset.sh` | the way out for whoever lost their phone: `403` without `user:reset-2fa`, the row **and** the flag erased in the same gesture, sessions closed, old backup codes dead, an admin resetting themselves keeps their session, and nothing secret in the audit log |
| `verify-source-gitea.sh` | a second code provider against a real Gitea forge (`docker compose --profile test up -d gitea`, account and repository made by `scripts/test-gitea/setup.sh`): **Test** refuses a wrong token and names the right one's account; the token is encrypted and never comes back out; its repositories are listed next to GitHub's; an application created from the repository builds on Docker with the code downloaded from Gitea, and `success` is written on the commit; a commit is seen by polling and redeployed where the application runs; the link is checked by the Gitea client, without error; an infrastructure change waits for an approval and says so on the commit; nothing secret in the audit log. **15/15** on the last run |
| `verify-source-gitlab.sh` | the third code provider against a real GitLab CE instance (`docker compose --profile test up -d gitlab`, several minutes at first start; group, subgroup, project and project token made by `scripts/test-gitlab/setup.sh`): **Test** refuses a wrong token **and a token without the `api` scope**, names the right one's bot and its expiry; the token is encrypted and never comes back out; a subgroup project (`atelier/web/bonjour`) is listed and its `pupitre.json` found; the application builds on Docker with the archive downloaded from GitLab, and `success` is written on the commit; a commit is seen by polling (comparison included) and redeployed; an infrastructure change waits for an approval and says so on the commit; a second "pending" is refused by GitLab's state machine with the message the client recognizes; nothing secret in the audit log. **16/16** on the last run |
| `verify-source-archive.sh` | uploaded code, end to end on a Docker target and a K3s target (`DOCKER_TARGET`, `K3S_TARGET`): without code, the deployment is refused before it starts; a booby-trapped archive (a link that would leave the code once the leading folder is removed) is refused by the worker and its bytes deleted; a healthy zip is ready, its SHA-256 is the file's, it builds and serves its page — execute bit kept, code under `source/`, nothing at the root of the release; a V2 as tar.gz replaces it, and redeploying version 1 rebuilds **its** code; on K3s, the pod serves the latest archive; a token limited to the application uploads, limited to another one it is refused; a deleted archive can no longer be redeployed; only the last five are kept; everything is in the audit log, without the token. **20/20** on the last run |
| `verify-account-security.sh` | **Accounts and sessions**: requiring the second factor without having it yourself → `409`; under "sensitive permissions", an operator without a second factor only has the activation screen left — `403 two_factor_required` on the API, the chat **and their API token**, all their pages send to `/two-factor-setup` —, the viewer is not affected, nor an account without a password (single sign-on); the direct routes of Better Auth's `twoFactor` plugin answer 404; once enabled, everything opens again in the same session and the factor can no longer be removed (`409`); "every account" affects the viewer; shortening the idle duration brings open sessions back; the absolute cap closes a session that is too old and removes it from the database; nothing secret in the audit log. **33/33** on the last run |
| `verify-onboarding.sh` | the setup guide redirects on an empty state and **does not give in on the second pass**, the shell is bare (no navigation link), leaving goes through a modal (looked for even in the JS chunks), a completed step survives a new sign-in, skipping ≠ finishing, and **a target created by the guide is identical in SQL to a target created by `/targets/new`** |
| `verify-settings.sh` | complete defaults on an empty database, a made-up time zone refused, **a partial PATCH resets no other section** (to the bit, by hash), the API key absent from every page, and an auditor sees the sections without being able to change them |

### Deployment

| Script | What it establishes |
|---|---|
| `verify-deploy-logs.sh` | an application created from `simple.json` deploys, the steps follow one another, the logs scroll live, the URL answers — and **reconnecting during the deployment finds the logs already gone by** |
| `verify-scanners.sh` | four deployments of the same deliberately vulnerable image, changing only the scan policy: blocked by Trivy, blocked by Grype alone, passing with `failOn: NONE`, SBOM downloadable. The key point is the **CVE by CVE** comparison between the two scanners |
| `verify-ports-rollback.sh` | two applications on the same target → two distinct ports and two UFW rules named by comment; a destroy releases one without touching the other; a v2 with a broken healthcheck → **automatic rollback**, `rolled_back` status distinct from `failed`, diagnosis captured, and the URL serves v1 again |
| `verify-appspec-generation.sh` | the system prompt is really loaded from the image (size included, not just an `ok`), the generation chain with a mock model, the rendering to both runtimes, and a `scan:periodic` task that runs, survives a worker restart, then is disabled |
| `verify-secrets.sh` | the secret store, in 23 steps: a generated non-empty value **accepted by the database engine**, `.env` with mode 0600, identical hash after redeployment, a single row in the database, invisible everywhere, a render that fails **naming** the missing secret while accepting an empty value. Then aliases: unknown reference and cycle refused at validation, one row for two names, **WordPress really authenticating on MariaDB**, and the same secret map on the Compose side and on the Kubernetes side |
| `verify-export.sh` | exporting a deployment's logs as text and as JSONL, with the right headers, **as many lines as in the database** (which proves pagination does not truncate), 404/422 on a wrong identifier, and the export traced |

### Life cycle

| Script | What it establishes |
|---|---|
| `verify-app-actions.sh` | a running application's operations gestures, on **both** runtimes: stopping keeps the volume's data and the reserved port, starting brings the same version back healthy; stopping twice, starting what runs, restarting what is stopped, rolling back without a previous version: four `409`s that name the reason; a viewer gets `403` on `deployment:restart`, traced; the audit log carries each gesture with actor and IP; destroying from the application's screen leaves nothing on the machine |
| `verify-force-delete.sh` | the guard, the cascade and forcing. The central case: the target is unplugged, forcing requires the slug typed again, the record goes — then **the target is plugged back, the containers are still running, and the script cleans the machine with the command read in the activity log**. If the log were not enough, the test would fail |
| `verify-purge.sh` | purging is not destroying: exact count in the preview, a running application refuses (`409`), the purged run's audit entries are still there, an orphan reservation is released — and, the gap fixed, a version in service whose last update failed still refuses the purge |
| `verify-workloads.sh` | the inventory tells the panel's workloads from the others, a panel workload **refuses** to be deleted (`409`), a foreign workload is updated and deleted through the queue publishing its progress over SSE, and the panel's applications are still running at the end |

### Monitoring

| Script | What it establishes |
|---|---|
| `verify-supervision.sh` | the list only shows what runs, the SSE stream brings up the state of services and logs attributed to the right service, **it holds over time** (the SSH timeout guards trap), the restart goes through the queue, and an application whose last update failed stays listed with a state that says so |
| `verify-server-supervision.sh` | the metrics are **cross-checked with the machine itself** (`nproc`, `/proc/loadavg`, `/proc/meminfo`); then `nproc` is temporarily hidden to prove that a missing metric returns `null` **and not zero**, without taking the rest down; an unreachable target keeps its applications on screen; the fold-out is a real keyboard-accessible button; and the reading really goes through the queue — checked by looking for `ssh2` in the panel's bundle, where it must not be |
| `verify-monitors.sh` | SSRF (metadata, outside the list, `localhost`, `file://`, credentials in the URL, **and the webhook URL**), the minimum interval per type, an isolated blip creating no incident, the outage confirmed at the threshold with **a single** alert, closing on recovery, the availability rate compared with a fabricated history, retention that really deletes, and a TLS probe to prove the abstraction welcomes something other than HTTP |
| `verify-notifications.sh` | the catalog is data (and **no Zod `schema` leaks into the JSON**, which would give an empty form without an error), the four channels are configured and tested against real servers, each channel renders in **its** shape (escaped MarkdownV2, Discord embed, webhook headers), an unreachable channel does not break the notified action, and one event triggers **one** send and only one |
| `verify-schedules.sh` | simple input writes the expected cron **in the database**, reading back gives simple mode, an exotic expression switches to expert mode, the time zone is really applied ("3 am in Paris" falls at 01:00 or 02:00 UTC depending on the season, never 03:00), changing the time zone **reschedules** the occurrence in BullMQ, and the tasks older than `0009` did not move |
| `verify-ai.sh` | the three providers are configurable and the default model follows the provider, a `501` that names what is missing, and above all: the key appears **nowhere**, including after a real call to each of the three providers with a dummy key — the script also looks for the **prefix**, because OpenAI literally answers `Incorrect API key provided: sk-senti***…***0000` |
| `verify-monitor-notifications.sh` | an oscillating probe produces **no** message (hysteresis is upstream of the audit, so a blip writes nothing), a confirmed outage goes to the subscribed channels within seconds, twelve sites down produce **two** messages and not twelve — an immediate alert and a summary naming the eleven others —, and a probe's secret leaks neither in the API, nor in the HTML, nor in the audit log, nor in the logs |
| `verify-host-history.sh` | a reading writes exactly one row, the 24 h curve is rebuilt on read, the three layers of thresholds resolve in the right order, a second global threshold is refused **by the database** and not by an `if`, a confirmed breach writes **one** audit entry and not one per reading, the purge deletes readings beyond 30 days without taking the breaches along, and the sweep runs without anybody asking |
| `verify-stuck-deployment.sh` | a slow deployment is **not** a ghost — the detector is not a timer —, a task abandoned by BullMQ is noticed by the worker which stops the deployment at `failed` without replay, the recorded message names the Compose project, the target and the port still reserved, and manual unblocking requires `deployment:purge` and not `deployment:destroy` |
| `verify-invitations.sh` | without an SMTP channel the flow is not offered and no orphan account is created, an invited account has **literally no** `credential` row, the link works once and only once, a reset cuts the sessions in progress, an unknown address cannot be told from a known one — neither by the body, nor by the response time —, and no token appears in the audit log, the logs, or Redis's BullMQ keys |

## The other tools

| Command | What it does |
|---|---|
| `pnpm test` | the unit tests of `@pupitre/core` (crypto, AppSpec and its refinements, secret aliases, Compose and K8s rendering, scan normalization, AI generation with a mock model, the probes' state machine, messages in both languages…) and of the panel (dictionaries, the guards against hard-coded French, security headers…) |
| `pnpm typecheck` | strict TypeScript on the four projects **and** on `scripts/` |
| `pnpm tsx scripts/render-both.ts <spec>` | renders an AppSpec to both runtimes without deploying anything, and **re-parses each serialized manifest** — a rendering that does not go back through its own parser has proven nothing |
| `pnpm test:driver <target>` | an end-to-end deployment, driving the driver live |
| `pnpm test:parity <docker> <k3s>` | the test of truth — see below |
| `pnpm test:schedule` | translation and computation of cron expressions, offline |
| `pnpm test:ai` | multi-provider configuration, offline |

## `pnpm test:parity` — the test of truth

A single AppSpec, two runtimes, never a field changed between the two. It drives
the drivers **live**, without going through the worker or the queue, and returns
a two-column table.

```bash
pnpm test:parity local-docker-target local-k3s-target
pnpm test:parity local-docker-target local-k3s-target --spec my-spec.json --keep
```

It chains, for each side: `preflight` → `allocatePort` → `render` → `upload` →
`build` → `deploy` → `healthcheck` → **route set on the target's proxy** and
probed through it from the target (without a proxy, through the published port),
then `rollback` + probe again, then `destroy` + check for leftovers. It exits
with code 1 if **a single** check fails.

It returned **32/32 green** on its last run, with a Traefik on each target. The
table and its analysis are in the [README](../README.md#known-limits): it is the
document that carries the project's dated state.

Prerequisites: both targets must be registered and reachable **from the
workstation** (`local-docker-target`, `local-k3s-target`) —
[`getting-started.md`](getting-started.md#the-k3s-test-target) explains how to
set up the second one, which has no script.

## `pnpm test:proxy` — the reverse proxy, end to end

The counterpart of parity for domains: on each target, with the same code, it
installs Traefik through Pupitre (a container on Docker, K3s's Traefik
configured), tests it, finds it again through detection, deploys a small
application through its driver, sets two domains on it — one over HTTPS with a
redirect, the other over HTTP —, checks that they answer **through the proxy**,
that the certificate is issued, that a removed domain no longer answers.

Before any installation, a **phase 0**: do the two machines reach each other,
both ways? Through the product's own test (`checkReach()`, the one used by the
link test and the preflight): a connection opened from one to an ephemeral
listener on the other, on a port in the applications' range. An unreachable
address must be reported as such, without leaving anything behind. If the
machines do not reach each other, the central proxy is not exercised — and that
counts as a failure.

Then the **central proxy**, both ways: the Docker machine's Traefik serves the
application deployed on the K3s machine, and K3s's the Docker machine's
application. The proxy's arrival address is recorded the way the link test does
it; the application is published for it alone — a `NodePort` reserved by a
`NetworkPolicy` on K3s, a port published on the private address on Docker (the
loopback no longer answers); on K3s, a first deployment reserved to another
address checks that the proxy is **refused** there. Its two domains answer
through the other machine's proxy, certificate issued, then everything is removed
and nothing must remain at the proxy. Finally, everything is destroyed and
Traefik uninstalled.

With **`--proxy=bunkerweb`**, the same run tests BunkerWeb: installed as a
container on the Docker machine — on the K3s machine, the option must say it is
unavailable and point to the link —, tested, detected, two domains, then its
**WAF tested from the other machine**, an address no whitelist covers: an SQL
injection refused (403) in **Protection**, twenty simultaneous requests all
served, the same injection getting through in **Detection only**. Since
BunkerWeb only accepts Let's Encrypt, its certificates come from Pebble through
the `acme-front` relay (Caddy), whose names and authority the script makes known
**to the test container only** — none of it in the product's code. The central
proxy: the Docker machine's BunkerWeb serves the K3s application, NetworkPolicy
included.

```bash
docker compose --profile test up -d pebble pebble-dns acme-front
pnpm test:proxy local-docker-target k3s-locale
pnpm test:proxy local-docker-target k3s-locale --proxy=bunkerweb
```

The certificates come from **Pebble**, the Let's Encrypt team's test ACME
server: it really validates the HTTP-01 challenge on the target's port 80, and
`pebble-dns` resolves the test domains to it. Without them (`--no-acme`),
everything else is checked, except issuance. On the Docker side, it also checks
that the application's port is only published on the loopback. **45/45** on the
last run for Traefik, **30/30** for BunkerWeb (`--proxy=bunkerweb`).

## `pnpm test:npm` — Nginx Proxy Manager, a remote proxy

Against a real instance (2.16, the `npm-proxy` service of the `test` profile,
its certificates issued by Pebble) and the two test targets. Its administrator
creates Pupitre's account with the recommended rights — *Manage* on hosts and
certificates, *Created Items* visibility —, then: **Test** passes, a wrong
password is refused, saying so; the link is tested **through NPM** to each target
(the arrival recorded on Docker; on K3s's Alpine, the `nc` listener does not
note it, and the result must say so), an address that leads nowhere is reported
as such, no test host remains; on each runtime, a domain set — HTTP redirects to
HTTPS, Pebble certificate, probed from the panel; two certificates requested at
the same time are both obtained; another account's domain is refused without
disturbing the others; a wildcard already in NPM is reused; on removal,
Pupitre's hosts and certificates go, the wildcard and the other account's host
stay, and one machine does not touch the other's domains. **15/15** on the last
run.

```bash
docker compose --profile test up -d pebble pebble-dns npm-proxy
pnpm test:npm local-docker-target k3s-locale
```

The same path was walked through the panel and its worker: connection (refused
then accepted), linking both targets, a deployment with a domain on each runtime
through the pipeline, **Apply** requesting a certificate again, periodic probe,
destruction removing hosts and certificates from NPM.

## `pnpm test:rollback` — going back finds the right code

A code commit does not change the AppSpec's version. On each runtime, an
application built from its code: release A, then release B **of the same
version** — each with its directory and its image —, then going back, which must
serve A again. On Docker, a release from before the `{version}-r{number}` naming
is still found, and an application deployed before the update stays drivable.
Finally, enough deployments for the cleanup to run: the five most recent
releases stay, the others go with their built images; and destruction leaves no
built image behind. **12/12** on the last run.

```bash
pnpm test:rollback local-docker-target k3s-locale
```

## `pnpm test:source-isolation` — a booby-trapped repository does not get through

On each runtime, an application built from the archive of a "repository" that
carries, besides its code, a `compose.override.yml` (privileged container,
machine disk mounted), a `docker-compose.yml` and a `.env` that hijack the
project name, and a `k8s/` folder to apply. The script checks that the code is
placed in `source/`, that the application builds there and starts healthy, and
that no trap worked: an unprivileged container without mounts, no hijacked
project nor intruding service, no object of the `k8s/` folder in the cluster.
**7/7** on the last run.

```bash
pnpm test:source-isolation local-docker-target k3s-locale
```

## What is not verified

- **No real AI model has answered on this instance.** See
  [`ai.md`](ai.md#without-a-key).
- **A real Let's Encrypt certificate through BunkerWeb.** `test:proxy
  --proxy=bunkerweb` gets real certificates, but from Pebble, which the
  `acme-front` relay passes off as Let's Encrypt in the test container. A
  certificate from the real authority requires a public domain pointed at a
  machine open to the Internet.
- **Backups have no end-to-end script.** `pnpm test` covers the encrypted format
  (round trip, tampering, wrong key), the SigV4 signature against AWS's test
  vector, the plan, retention, destinations and the local folder. The rest was
  played by hand on the test targets — PostgreSQL, MariaDB and MongoDB export
  and restore, brief stop, restoring a Docker backup on K3s, the panel database
  through the command line — to an SFTP and an S3-compatible store
  (CloudServer), **never to the real AWS, Scaleway or Backblaze**.
- Point 9 of `verify-ports-rollback.sh` settles for a `pnpm typecheck` on
  `test-parity.ts` instead of running it: it only has a Docker target at hand.
  Parity itself is played by `pnpm test:parity`, separately.

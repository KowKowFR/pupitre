# Architecture

[`CLAUDE.md`](../CLAUDE.md) holds the decisions. This document explains what
they imply when you open the code — where to look, and what will surprise you.

- [The four abstractions](#the-four-abstractions)
- [Linked repositories](#linked-repositories)
- [AppSpec — the neutral spec](#appspec--the-neutral-spec)
- [Deployment pipeline](#deployment-pipeline)
- [Live logs](#live-logs)
- [Ports: the database decides, the target checks](#ports-the-database-decides-the-target-checks)
- [UFW: a driver capability](#ufw-a-driver-capability-not-an-if-in-the-worker)
- [Healthcheck: three outcomes, not two](#healthcheck-three-outcomes-not-two)
- [Automatic rollback](#automatic-rollback)
- [Versions and retention](#versions-and-retention)
- [Backups: one place, one format, two runtimes](#backups-one-place-one-format-two-runtimes)
- [Reverse proxy: the route to the proxy, the upstream to the driver](#reverse-proxy-the-route-to-the-proxy-the-upstream-to-the-driver)
- [Languages: one product, two languages](#languages-one-product-two-languages)

## The four abstractions

The quality bar is written in `CLAUDE.md`: **adding a runtime, a proxy, a
scanner or a code provider must be done by adding a class**. What follows is the
practical consequence.

| Interface | File | Implementations |
|---|---|---|
| `DeploymentDriver` | `packages/core/src/drivers/types.ts` | `DockerComposeDriver`, `K3sDriver` |
| `ProxyProvider` | `packages/core/src/proxy/types.ts` | `TraefikProvider` (files or Ingress), `BunkerWebProvider` (REST API, WAF) |
| `Scanner` | `packages/core/src/scan.ts` | `TrivyScanner`, `GrypeScanner`, `SyftSBOM` |
| `SourceProvider` | `packages/core/src/sources/types.ts` | `GitHubSourceProvider`, `GitLabSourceProvider`, `GiteaSourceProvider` |

**`DeploymentDriver`** — `preflight` `allocatePort` `render` `upload` `build`
`deploy` `healthcheck` `rollback` `destroy` `logs` `pruneReleases`, plus the
inventory methods `listWorkloads` `removeWorkload` `updateWorkload`
`controlWorkload` `workloadLogs` `execInWorkload`, the `runningImages` reading
(the digests of what runs, for image updates), the four backup methods
`exportVolume` `importVolume` `exportFromService` `importIntoService`,
`upstream` — how a reverse proxy reaches the application —, plus a
`getDriver(runtime)` factory.

The driver **imports nothing** from `packages/db`, `apps/web` or Redis: it
receives everything through `DriverContext`, it executes, and it emits lines
through a callback. It is the caller that decides to publish them on Redis,
write them to the database, or drop them.

Port reservation follows the same rule. The driver needs the
`port_allocations` table, but is not allowed to know it: the context carries a
`PortAllocator` interface, whose Drizzle implementation lives in `packages/db`.

**`ProxyProvider`** — `detect` `installOptions` `install` `uninstall` `check`
`apply` `probe` `publishAddress`, plus a `getProxyProvider(kind)` factory. See
[Reverse proxy](#reverse-proxy-the-route-to-the-proxy-the-upstream-to-the-driver).

**Three methods are optional** — `openFirewall?` and `closeFirewall?`, which
`DockerComposeDriver` implements and `K3sDriver` does not declare at all;
`pruneIdleBuilder?`, conversely, which only `K3sDriver` implements. The pipeline
and the worker call it if the method exists; they never ask which runtime they
are driving, they ask what the driver can do.

The rule can be checked with one command:

```bash
grep -rn "runtime === '" apps packages --include='*.ts' --include='*.tsx' \
  | grep -v /drivers/ | grep -v /dist/
```

It returns **no line**. The last one picked the word "namespace" or "Compose
project" in the message of an abandoned deployment; the message now names
`app-{slug}`, which holds for both runtimes. The only place in the repository
allowed to know which runtime it runs on is a driver.

## Linked repositories

An application can be linked to a branch of a **GitHub** repository (through a
GitHub App), of a **GitLab** instance (through a project, group or account
token) or of a **Gitea / Forgejo / Codeberg** forge (through the token of an
account on the forge). The repository carries a `pupitre.json` — the AppSpec,
nothing else — at its root, or in the application's folder for a monorepo.

- **One provider, one class.** Each link goes through its forge's connection;
  `createSourceProvider()` (`packages/core/src/sources/registry.ts`) builds its
  client from its decrypted secrets. The worker, polling, commit statuses and
  code download only know the `SourceProvider` contract. One connection per
  provider and per instance.
- **What differs stays in the class.** GitHub answers "nothing new" with an ETag
  (304); Gitea sets none on a branch, and polling compares the hash with the
  last commit seen. Gitea does not tell a rename's old path, nor a base that is
  not an ancestor: the comparison then declares itself "unknown", and
  everything counts as changed. The repositories offered are those of the
  token's account — never the forge's public search, which on Codeberg would
  return hundreds of thousands of repositories.
- **GitLab names a repository by its full path** — `group/subgroup/project` —,
  which the API takes encoded in one block as the project identifier; a
  repository name therefore accepts more than two segments
  (`sourceRepositorySchema`), never `.` or `..`. GitLab does tell a rename's old
  path, and reports a comparison truncated at its limits (`compare_timeout`): it
  then declares itself "unknown". Its status state machine refuses to say
  "pending" again on a status already pending — the client takes it for what it
  is, a state already reached. The repositories offered are the projects the
  token is a member of.
- **A deployment keeps its repository's web address**
  (`deployments.source_url`): the link to its commit follows from it, on GitHub,
  GitLab and Gitea alike, even if the link disappears afterwards.

- **The repository says what, the panel says where and when.** Targets, runtime
  and trigger mode live in the link, under RBAC. The file carries no target, no
  runtime, no script: write access to the repository does not become execution
  rights on the machines.
- **Polling, never a webhook.** The panel is private. Every minute the worker
  asks for the latest commit of each linked branch (`source:poll`, supervision
  queue), with an ETag: "nothing new" answers 304 and costs nothing.
- **Where a commit goes** (`deploy_to`), set per link:
  - `none` — **update the application**: it takes the commit's AppSpec, nothing
    deploys; you then deploy it where you want;
  - `running` — **redeploy it where it runs**: the targets are those where a
    version is in service at the time of the commit; elsewhere, nothing is
    installed;
  - `targets` — on the link's targets, whether it runs there or not.
- **Three modes**, for `running` and `targets`: automatic; automatic except
  infrastructure changes (the default); always approved. What counts as
  infrastructure is decided by `classifySpecChange()`: port, exposure, domain,
  volumes, secrets, variables, resources, services added or removed.
- **The application's commit.** Each link keeps the commit whose AppSpec the
  application carries (`synced_sha`). A deployment started by hand — drawer,
  **New application** — takes that commit: it is its code that gets built,
  wherever the application goes.
- **Creating from the repository.** **New application → From a repository**
  looks for the branch's `pupitre.json` files (`findFiles()`), reads and
  validates the chosen one at the head commit, then creates the application and
  its link, without a target: the file's `name` becomes the application's.
- **The code travels as an archive, and stays apart.** The worker downloads the
  archive of the exact commit and passes it to the driver
  (`DriverContext.sourceArchive`), which unpacks it into the release's
  **`source/`** — never next to its own files (`compose.yml`, `.env`, `k8s/`).
  The AppSpec's build contexts are relative to the repository root and resolve
  there (`buildContextPath()`), and they cannot leave it: no absolute path, no
  `..`. The build stays on the target, without a registry.
- **Compose is always designated.** Each call passes `-p app-{slug}
  -f compose.yml`: nothing lying around in the folder — a
  `compose.override.yml`, a `.env` that would rename the project — is read. On
  K3s, the `k8s/` folder is emptied before each render: `kubectl apply` only
  applies what Pupitre just wrote.
- **Everything is traced.** Each deployment keeps the repository, the branch and
  the commit; its state is sent back to the GitHub commit (`pupitre/{target}`).

A link's first check records the head commit without deploying: linking a
repository must not redeploy what runs. **Deploy this commit** does it on
demand.

## Uploaded code

The other way in for code, for an application **without a linked repository** —
created by the form, by AI, from the catalog or by importing a `compose.yml` —
one of whose services is built from a Dockerfile. Its page carries an
**Application code** card: you upload a `.tar.gz`, `.tar` or `.zip` archive
there (100 MiB at most), and a CI can do the same with a token
(`POST /api/applications/:id/archives`).

- **It only brings the code.** The AppSpec stays the panel's; a `pupitre.json`
  in the archive is ignored. It is not a `SourceProvider`: there is no branch to
  follow, no commit to query — a human or a CI sends, that is all.
- **The route stores, the worker judges.** The panel recognizes the format from
  the first bytes, stores the upload in the database in one-megabyte chunks with
  its SHA-256, and returns `202`. The worker (`source:archive-inspect`,
  supervision queue) reads the archive entry by entry
  (`@pupitre/core/source-upload`), refuses what would leave the folder, removes
  a single leading folder (`my-app/…`), drops `.git/`, `__MACOSX/`, `.DS_Store`
  and the AppleDouble `._*` files of macOS's `tar`, and stores **a rebuilt
  archive** in place of the upload: it is that one, and that one only, that
  goes to the machines.
- **The panel and the worker share no disk**: the bytes live in
  `source_archive_chunks`. Nothing is held in memory whole, and a panel backup
  takes them along.
- **The application's code is its latest archive.** A deployment takes its
  identifier, name and hash; the worker reads it again and passes it to the
  driver exactly like a commit's archive (`DriverContext.sourceArchive`,
  unpacked into `source/`). The drivers did not change by a line.
- **Refused early.** Without an archive, with an archive still being read or
  refused, or when an expected Dockerfile is not in it, `POST /api/deployments`
  answers 409 without enqueuing anything — rather than a failure at the `build`
  step.
- **The last five** are kept: redeploying a recent version rebuilds **its** code.
  Beyond that, the version keeps its archive's name and hash, but can no longer
  be redeployed (409 `archive_gone`). Rollback does not need it: it puts back in
  service a release already on the machine.
- An application linked to a repository does not accept an archive (409): its
  code comes from the commit.

## AppSpec — the neutral spec

`packages/core/src/spec/app-spec.ts`. **No field can be tied to a runtime**: no
`restart_policy`, no `image_pull_policy`, no `namespace`. What the spec cannot
say, the driver decides — the restart policy, image naming, the network. A test
checks it by inspecting the keys the schema declares (runtime neutrality).

Zod refinements: a single `exposed` service, unique names, `dependsOn`
references existing services, no cycle (depth-first traversal),
`ingress.targetService` exists, no key declared both in `env` and in
`secrets`, no secret alias to an unknown name, no alias cycle.

Three fixtures in `packages/core/src/spec/__fixtures__/`: `simple.json` (an
API), `fullstack.json` (front + api + postgres, volumes and `dependsOn`),
`invalid.json` (violations, one per refinement).

**Compose rendering** — the driver builds a typed model, then serializes it to
YAML. Never string concatenation: a test injects quotes, line breaks and YAML
traps into environment variables, and checks that they come through intact.
Both valid fixtures are submitted to `docker compose config` — it is Docker
itself that validates the rendering.

Isolation: one Compose project per application (`app-{slug}`), its bridge
network (`app-{slug}-net`), its prefixed named volumes. Secrets are never
written into `compose.yml`: they arrive through a `.env` placed with mode 0600.

**K3s rendering** — an `app-{slug}` namespace, then manifests numbered in
application order: `0-namespace`, `10-configmap`, `20-secret`,
`30-persistentvolumeclaim`, `40-deployment`, `50-service`. No host port and no
Ingress: exposure goes through the cluster's reverse proxy, which reaches the
Service — `allocatePort()` returns `null` and the step is `skipped`,
`upstream()` returns the Service.

To see both renderings side by side without deploying anything:

```bash
pnpm tsx scripts/render-both.ts packages/core/src/spec/__fixtures__/simple.json
```

## Catalog — ready-made AppSpecs

`packages/core/src/catalog/`. A template is a **function that returns an
AppSpec** from four parameters (name, domain, TLS, email of the person
installing) — never a `compose.yml` copied from a README. It goes through the
same `appSpecSchema` as the rest, therefore deploys on both runtimes, and a test
instantiates each template with and without a domain.

What the AppSpec cannot say, the catalog does not say: an image that requires a
start command (MinIO, Keycloak), a database URL with the password inside
(Umami, Outline) or the Docker socket (Portainer) does not get in. Passwords
shared between an application and its database go through `{ name, from }`
secret aliases.

The secrets used to **sign in** are entered at installation (`askedSecrets`): a
generated secret is never read back, a generated administration password would
be lost. The others are generated.

Installing (`POST /api/catalog/{id}`) creates the application, without
deploying it. Choosing the target stays the usual gesture, with its pipeline and
its scans. Adding a template: an entry in `templates.ts`, nothing else.
Templates carry their texts in both languages, inline.

**The proof, on a real target** — `pnpm test:catalog <target>` deploys each
template through the driver (pull included), waits for its probe, requests it
over HTTP from the target on its health path, then destroys it and checks that
nothing remains. `--prune-images` empties the images between two templates:
reserved for a test target. An image without a variant for the target's
architecture is reported separately, outside the failures: it is a fact about
the image, not about the template.

## Importing a docker-compose.yml

`packages/core/src/compose/` (subpath `@pupitre/core/compose`, so the YAML
parser stays out of the browser). The file becomes a **proposed** AppSpec, never
saved automatically: it goes into the **New application** editor, and it is the
usual creation that saves it.

Nothing is silent: each key of the file is translated, or named in a message,
at one of three levels.

- **blocking** — the application will probably not work without a human
  decision: `command`/`entrypoint` (the AppSpec carries none), the Docker
  socket, a mounted host file, `privileged`, `network_mode`… What touches
  isolation is never translated "as best we can".
- **approximation** — a host folder becomes an empty named volume, an
  undeclared port is guessed from the image, a `${…}` variable takes its default
  value.
- **deliberately ignored** — `restart`, `container_name`, networks: Pupitre
  decides them.

Variables that look like secrets are never taken over in clear: they become
generated secrets, and two names that shared the same value (or the same shell
variable) become a secret and an alias. A single service is exposed — the one
that publishes a port, the best named if there are several — and a domain is
read from the Traefik labels. The YAML is read with an alias limit: a booby-trapped
file does not blow up memory.

## Deployment pipeline

`POST /api/deployments` **creates the eleven steps in the database, all
`pending`**, enqueues the job, and answers `202` without waiting for anything.
The UI therefore shows the full pipeline before the worker has started.

```
preflight → allocate_port → render → upload → build → scan → backup → deploy → healthcheck → proxy → rollback
```

`backup` backs up the application's data just before touching what runs —
`skipped` without a "before each deployment" policy, and at the first
deployment, where there is nothing to back up. Its failure stops the pipeline:
better a deployment that does not happen than an update without a safety net.

`rollback` is declared like the others, and `skipped` when all goes well. A step
appearing midway would make the UI's "n / total" counter lie and force the SSE
client to handle one more case. A rollback that did not happen is information,
not a gap.

Each step goes from `pending` to `running` then to `success`, `failed` or
`skipped`. A failure stops the pipeline and marks the rest `skipped`.

**No `if (runtime === ...)` in the worker.** A step is `skipped` when the driver
or the proxy have nothing to do — `allocatePort()` on K3s, `build()` with no
service to build, an application without a domain or a target without a reverse
proxy. The worker chains, it does not decide.

**The job is idempotent.** Retrying a failed deployment puts back to `pending`
what did not succeed and leaves the `success` steps intact: only the steps that
did not succeed are replayed.

## Live logs

The worker publishes each line on Redis (`deploy:{id}`) **and** appends it to
`deployment_steps.log`. Redis carries the live stream, the column carries the
replay. Database writes are batched — a `docker compose pull` line every 30 ms
would make as many `UPDATE`s.

`GET /api/deployments/:id/logs` streams over SSE. The order of operations is
what guarantees there is no gap:

1. subscribe to Redis **before** reading the history;
2. messages received during the read are set aside;
3. send the persisted history;
4. flush the queue, then go live.

Subscribing after the read would lose what happens in between. Both paths apply
the same deduplication, so that a page refresh shows exactly the same stream.
Heartbeat every 15 s, a dedicated Redis connection per stream, released when the
client disconnects.

The same mechanism serves elsewhere: `workload:{targetId}` for the progress of
actions on a target's workloads, and the service state stream of `/apps`.

## Real time: presence, chat, live screens

A single Redis channel, `pupitre:realtime`, carries typed and validated events
(`@pupitre/core` → `realtime.ts`): presence, chat messages, screen signals
(`live`), audit activity. `GET /api/realtime` relays them over SSE — **one
Redis subscriber per process**, not per tab, which dispatches in memory to the
open streams.

In the browser, **a single stream for all tabs**: they elect a leader (Web
Locks) that opens the stream and relays to the others (BroadcastChannel). Over
HTTP/1.1, one stream per tab would exhaust the six connections per origin.

**Screens never receive data through this channel.** A signal says "deployments
have moved"; the page listening to it (`<LiveRefresh>`) reads itself again from
the server, with the session's permissions. Signals come from the worker (start
and end of BullMQ tasks) and from the audit log (a named observer, next to the
notifications one). At most one refresh every 4 s, nothing while the tab is
hidden. Audit activity only goes to sessions that have `audit:read`.

**Presence** — in Redis, not in the database: number of open tabs, last sign of
life of the stream, last interaction, the person's choice (away, do not
disturb). The displayed state is derived (`effectivePresence`): offline without
a tab or after 75 s of silence (killed process), away after 5 min without
interaction. A sweep every 20 s, under a Redis lock, announces what time alone
changes.

**Chat** — a bubble at the bottom right of each screen, which opens the thread
over the page (layer 55: under drawers and dialogs, which trap focus). It lives
in the layout: it survives navigation, and the thread stays up to date live
even when closed. The bubble carries the unread count — in red when one of them
mentions the person or replies to one of their messages — and a "+1" floats
away at each arrival.

In the database: `chat_messages` (with `reply_to_id`), `chat_reads`,
`chat_reactions` (key `(message, person, emoji)`: reacting twice removes). A
mention is a `<@user|target|app:id>` token set by the composer, with its label of
the moment; the route only keeps those the author is allowed to open. A
reaction is only an emoji (`isChatEmoji`), never text — otherwise it would
become a second message channel. Plain text, never HTML. A deleted message
keeps its row, emptied, and loses its reactions; deleting someone else's
requires `user:manage` and goes through `logAudit()`.

## Records, in drawers

An application, a target, a probe, a run, a running application do not open in
a separate page: their record is a **drawer** (with tabs when it has several)
over their list (`components/record-drawer.tsx`). You open, read, act, close,
and the list has not moved.

- **The selection lives in the URL** (`?app=blog`, `?target=prod-1`,
  `?monitor=<id>`, `/deployments?run=<id>`, `/apps?app=<id>`), with the tab
  (`&tab=versions`) and edit mode (`&edit=1`): a record can be shared and
  reloads at the same place; J/K move to the next one without changing tab. A
  run can be followed even if it is not on the displayed page of the list: its
  header then comes from the record rendered on the server.
- **What the row carries shows right away** — the **Overview** tab. The rest
  (versions, secrets, workloads, measurements…) is rendered **on the server** by
  the list's page, which reads `?app=` and passes each tab as a `ReactNode` to
  the drawer. That is why it is opened by a navigation (`router.push`), not by a
  `pushState`: the page reads itself again, with the record. A tab is only
  mounted when first opened (a workload list queries the machine), then stays
  mounted, hidden.
- **Edit** replaces the record with its form, in the same drawer.
- The old addresses (`/applications/<id>`, `/targets/<id>`,
  `/targets/<id>/edit`, `/monitors/<id>`, `/deployments/<id>`, `/apps/<id>`)
  redirect to the list, drawer open (`next.config.ts`): links in emails and in
  the chat still lead somewhere.

## The ⌘K palette

It searches targets, applications, running applications, runs, probes,
domains, roles, catalog templates and settings tabs; a result opens its drawer.
The search goes through `GET /api/search`, which only reads a family with its
permission.

- **Tolerant** (`packages/core/src/fuzzy.ts`): accents and case ignored, each
  typed word must match, then — on names only — the letters in order ("prd1" →
  "prod-1") and one typo ("graphana"). A description only matches a real piece
  of text.
- **Actions**: a verb typed with the name ("test prod-1", "restart umami",
  "probe glpi", "pause", "deploy", "edit", "logs", "versions" — in French or in
  English), or → on a highlighted object. Each action requires its permission
  (`visibleCommands`) and does not appear without it. Restarting asks for a
  confirmation, in the palette.
- **Recent items** at rest, kept in this browser only; **Search elsewhere**
  continues the query in the audit log or the deployments.

## Ports: the database decides, the target checks

Collision avoidance **between the panel's applications** is the unique
constraint `port_allocations (target_id, port)`. Allocation never does "SELECT
then INSERT": it inserts, and a `23505` violation sends the loser to the next
draw. Two simultaneous workers cannot get the same port.

What remains is what the database cannot know: a service installed by hand on
the machine, already listening. The driver notices it afterwards (`ss -tlnH`, or
`netstat -tln` on images without `iproute2`), **abandons** the now useless
reservation and tries again excluding that port. A reservation already held by
the application is never questioned: the port is taken, yes, but by it.

**The range is carried by the target** — `targets.port_range_start` /
`port_range_end`, default 30000-32767, with a
`port_range_start <= port_range_end` constraint in the database.
`DRIVER_PORT_RANGE` stays useful and says something else: what the worker's
environment can reach. Both are true, we keep **the intersection** — keeping the
last one read would betray the other.

**The port is released on destruction, and on failure.** Release is in a
`finally`, including for a crash outside the pipeline. The condition is not "the
deployment failed" but "no version of this application runs on this target": a
failure after a successful deployment — or after a rollback — leaves a version
in service on that port, and releasing it would hand it to someone else.

`GET /api/targets/:id/ports` answers the two questions the table alone cannot
phrase: how many are left, and who has what.

## UFW: a driver capability, not an `if` in the worker

```ts
openFirewall?(ctx, port): Promise<void>
closeFirewall?(ctx, port): Promise<void>
```

**The rule is identified by its comment**, `pupitre:{slug}`, never by its number:
`ufw status numbered` renumbers on each deletion, and a rule deleted by index
deletes its neighbor as soon as another one has gone in the meantime. The comment
also tells the machine's administrator who opened this port and for what.

**The panel never enables UFW on its own initiative.** Enabling the firewall of
a machine you drive over SSH is an excellent way to lose it. If it is inactive or
absent, the driver writes so in the deployment logs and carries on: the port
published by Docker stays reachable, it is the filtering that does not exist.

## Healthcheck: three outcomes, not two

The probe honors the AppSpec's `retries`, `intervalSec` and `timeoutSec`, with an
**exponential backoff capped** at 30 s — without a cap, the fifth attempt would
wait sixteen times the requested interval and the setting would no longer make
sense.

| Outcome | What it means |
|---|---|
| `healthy` | the service answers, and answers well |
| `unhealthy` | it answers, but outside 2xx/3xx — it runs, it is broken |
| `unreachable` | nothing at the other end: container missing, port closed, pod not ready |

A **non-exposed** service is probed over TCP, not HTTP: a `postgres` image ships
neither `curl` nor `wget`, and asking it an HTTP question would produce a false
negative.

**The diagnosis is captured before the probe returns** — Docker:
`docker compose ps -a` plus the last 200 log lines of each service; K3s:
`kubectl get pods`, `describe` and `logs` of the pods involved. The order is what
matters: an automatic rollback restarts the old version and would wipe the
scene. The diagnosis goes into `deployment_steps.error` **and** into the SSE
stream.

## Automatic rollback

Three conditions, all of them data: the failure is on `healthcheck` — or on a
`deploy` whose new version never became healthy —, `deployments.auto_rollback` is
true (box ticked by default in the form), and `previous_deployment_id` exists. A
failure elsewhere — a blocking scan, a `deploy` that never started — triggers
nothing: there is nothing to undo, the previous version never stopped running.

The pipeline calls `driver.rollback()`, then **checks the health of the restored
version again with its own AppSpec** — not with the one that just failed. That
is the whole point of freezing the AppSpec in each deployment: v2 may have moved
its health route or changed port, and probing it with v2's settings would ask the
right machine the wrong question.

The deployment then ends as **`rolled_back`**. The UI paints it amber and not
red: something went wrong, and the safety net worked.

If the rollback fails in turn, the deployment ends `failed` and the error names
both failures. **Never a second rollback**: replaying the same command will not
fix what just failed, and chaining attempts would take the machine further from
a known state.

## Versions and retention

There is no "versions" table: **the deployment *is* the version**, and its frozen
`app_spec` is what makes a redeployment possible months later, even if the
application has changed since.

`POST /api/applications/:id/redeploy` is not a rollback. Rollback puts back in
service a release already present on the target; redeployment runs a full
pipeline again — new number, new scans — from the AppSpec of the time. It is
what allows replaying a version on *another* target, or after a `destroy`.

**One release per deployment.** On the target, each deployment places its
release in `{root}/apps/{slug}/{version}-r{number}` (`releaseName()`), and the
images it builds carry the same tag: `app-{slug}/{service}:1.0.0-r12`. The
version alone was not enough — a code commit does not change it —: two
deployments of `1.0.0` shared a directory and a tag, the second overwrote the
first, and going back restarted the new code. The number is the deployment's,
specific to the application. A release placed before this naming, under the
version alone, is still found: rollback and day-to-day operations (logs, health,
restart) look for it under the old name when the new one does not exist. On K3s,
the new tag changes the pods' template: they are replaced, and `rollout undo`
finds the previous image.

**Retention: the last five release directories**, cleaned up at the next
deployment — the only moment you know which one just became current. Sorting is
by modification date and not by name: `1.10.0` comes before `1.9.0`
lexicographically, and it is the deployment order that matters. The release
pointed to by `current` is never deleted, even if it is old — which is exactly
the case after a rollback. It then adds to the five most recent: six directories
at worst, never more. The built images of a deleted release go with it
(`docker image rm`, `crictl rmi`) — one tag per release, without cleanup, would
fill the disk; an image still in use is refused, and that is intended.

The **destruction** of a deployment likewise removes all the images built for
the application, all releases together: those whose name starts with
`app-{slug}/`, on Docker as in K3s's containerd.

`pruneReleases()` is an **interface method** and not an internal detail: the
`cleanup:versions` scheduled task needs it from the outside, and the release path
is a driver decision, not the caller's.

The K3s **image builder** — a BuildKit in a pod, which the driver sets up at the
first build and keeps for its cache — expires the same way, through
`pruneIdleBuilder?()`. Each build stamps it in the manifest it applies
(`pupitre.io/last-build`, on the Deployment and not on the pod: nothing
restarts). Every hour, the worker (`builder:prune`, `ops` queue) asks each
target, for each runtime whose driver declares the method, to remove what has
not been used for 24 hours — a duration written in the driver. The deletion
carries a precondition on the version read (`kubectl delete --raw` with
`preconditions.resourceVersion`): a build that claims it between the read and the
deletion changes that version, the API answers `Conflict`, and it stays. Neither
the namespace nor already imported images are touched; the removal is in the
audit log (`target.builder.removed`). Docker builds without setting anything up:
its driver does not declare the method, and no session is opened to a target that
has nothing to expire.

## Backups: one place, one format, two runtimes

Three pieces, each in its place.

**The driver knows how to read and write data, not where to store it.** Its four
backup methods exchange a **byte stream** with the target, through `execPipe` —
an SSH command whose stdin and stdout are raw streams, without line splitting:

| Method | `DockerComposeDriver` | `K3sDriver` |
|---|---|---|
| `exportVolume` / `importVolume` | an ephemeral `busybox` container mounts the volume, found through its Compose labels, and `tar` | a helper pod mounts the PVC, `tar` through `kubectl exec`, pod deleted in every case |
| `exportFromService` / `importIntoService` | `docker exec` in the service's container | `kubectl exec` in the service's pod |

The command run in the service — `pg_dumpall`, `mariadb-dump`, `mongodump` and
their counterparts — comes from `packages/core/src/backup/model.ts`, not from the
driver: what to export is a matter of database engine, not of runtime. It reads
its credentials from the environment the image already received; the panel never
sees them.

**`BackupStore` says where.** `check` `put` `get` `remove` `removePrefix` `list`
— in `packages/core/src/backup/stores/`, three implementations: `S3BackupStore`
(SigV4 signing written by hand, multipart upload of 16 MiB), `SftpBackupStore`
(verifiable host fingerprint), `LocalBackupStore` (a folder mounted in the
worker). One more destination is a class, its Zod schema in `destinations.ts`
and a line in `openBackupStore`'s table.

**The `.pupb` format says how.** Each chunk is encrypted as a stream,
AES-256-GCM, under a key **derived** from `MASTER_KEY` with HKDF and a random
salt for each file. The header — `PUPB`, version, salt, IV — is authenticated
with the content, the GCM tag closes the file. One byte changed, a different key:
decryption fails, it never returns wrong content. Each backup also places its
`manifest.json.pupb`: the list of its chunks, their sizes and SHA-256 hashes,
enough to read the destination **without** the panel database — it is the day
that one is lost that you need it.

A backup's path never touches the worker's disk: target → SSH → gzip →
encryption → destination, as a stream, with backpressure. Restore does the
reverse **in two stages**: it downloads and verifies everything (hash and GCM
tag) in `BACKUP_TMP_DIR`, and applies nothing while a single chunk is doubtful.
A corrupted archive must not find a half-erased application.

A consequence of neutrality: a backup only knows AppSpec names — service,
volume, engine. Nothing in it says Docker or Kubernetes.

## Reverse proxy: the route to the proxy, the upstream to the driver

Three notions, each in its place (`packages/core/src/proxy/model.ts`):

- **the connection** — a proxy the panel drives, stored in `proxies`: its kind,
  its configuration, and whether it was installed by Pupitre (`managed`) or only
  found. At most one per machine; a machine without a proxy can go through
  another one's, through a **link** (`proxy_links`) — see below;
- **the route** — a domain name, an application, a target, stored in `routes`.
  **Unique per name, held by the database**: two applications do not claim the
  same domain, and the loser of a race gets a 23505, as for ports;
- **the upstream** — how the proxy reaches the application. It is
  `driver.upstream()` that says it: the published port on Compose, the Service on
  K3s. The driver never sets a route; the proxy does not know which runtime it
  routes to.

**Declarative.** `apply()` receives all of an application's routes and makes sure
the proxy has no others: adding, removing, changing a domain is the same call,
and an empty list cleans up. Each object set carries Pupitre's mark and the
application's name — a proxy shared with routes made by hand never sees those
touched.

**Traefik, two ways of being driven** — they are its own providers:

| Mode | What Pupitre places | Expected upstream |
|---|---|---|
| `file` | `{folder}/{slug}.yml`, reloaded live by Traefik | a port on the machine |
| `kubernetes` | `Ingress` objects (and a redirect `Middleware`) in the application's namespace | a cluster Service |

The mode follows the installation found on the machine, not the applications'
runtime: it is a property of the proxy. An upstream the mode cannot reach is
refused, saying so.

**What a proxy says about itself, without executing anything.** The screen and
the API never name a proxy: each one declares a record (`traefik/config.ts`,
`bunkerweb/config.ts`), gathered in `catalog.ts` — reading its configuration,
describing itself, and its **capabilities**: HTTPS, automatic certificates, WAF
(the Domains field then offers a protection per domain), and how it reaches
another machine (`remoteUpstream`: any address, IPv4 only — a cluster's Traefik
—, or not at all). An installation option says which certificate authorities it
accepts; the probe receives from the proxy its **signatures** — what it serves to
an unknown name (Traefik: 404 and its body; BunkerWeb: its default page, **with
a 200**) and the certificate it presents while waiting for the real one. Without
them, a missing route would pass for a route that answers.

**BunkerWeb, through its API.** One BunkerWeb service per domain, created,
changed or removed through BunkerWeb's REST API, called from its machine over
SSH. The token is read in the container on each call and passed to `curl`
through a temporary file: it never leaves the machine. Since BunkerWeb has no
label in which to mark what is Pupitre's, a **registry** per application
(`{root}/bunkerweb/routes/*.json`, on its machine) says which domains Pupitre set
there: `planServices()` derives what to create, change, remove — without ever
touching a service made by hand, or removing a domain another application took
over. Since its API reads and rewrites the whole configuration on each call, two
changes on the same BunkerWeb go one after the other. Since its nginx resolves
through DNS and not `/etc/hosts`, the upstream is always an IP address: the
Docker gateway for an application on its machine — that is where the driver
publishes it (`publishAddress()`), and not on every interface — or the link's
address for the central proxy. Since BunkerWeb applies lazily and silently goes
back to the previous configuration when nginx refuses the new one, `apply()`
waits to see the domains served and, otherwise, reports the refusal read in its
log. Its probes pass its whitelist with a secret header
(`ProbeSignatures.headerFile`, read by `curl -H @file`), not by their address.

**The application's port is no longer open to the world.** The pipeline tells
the driver how to publish it — `DriverContext.exposure`, an **intention**, not a
runtime: `bindAddress` (where to listen), `allowFrom` (who to let in), `byPort`
(a port is needed). Each driver translates it its own way:

| Who serves the application | `exposure` | Compose | K3s |
|---|---|---|---|
| a proxy on the machine | `bindAddress: 127.0.0.1` | port on the loopback, firewall closed | nothing: the cluster's proxy reaches the Service |
| another machine's proxy | `byPort`, `bindAddress` (the link's address if it belongs to the machine), `allowFrom` (the proxy's arrival address) | port on that address, `ufw allow from` the proxy | `NodePort` on the entry point, `externalTrafficPolicy: Local`, a `NetworkPolicy` that accepts only the proxy |

Otherwise, that port in clear HTTP would bypass the proxy's HTTPS. On K3s, the
`NodePort` goes before the machine's firewall — hence the `NetworkPolicy`, and
`Local` so that the pod sees the original address. Since `apply` removes nothing,
the driver deletes the `NetworkPolicy` when it no longer has a reason to exist.

**The central proxy.** A link (`proxy_links`) connects a machine to another
one's proxy, with the address through which the latter reaches it. `checkReach()`
(`packages/core/src/proxy/reach.ts`) tests it for real: an ephemeral listener on
the served machine, in the applications' range, and a connection from the
proxy's machine that must bring back a token from it; it derives the arrival
address (NAT included) and says whether the address belongs to the machine. The
link test and the **preflight** of each deployment with domains on a linked
machine go through it — a blocked path stops the deployment before any build.
`resolveServingProxy()` answers "who serves this target" — its own, otherwise its
link's — and everything else (Domains field, pipeline, probe) goes through it.
For the proxy, nothing changes but the upstream: a port **with an address**
(`{ kind: 'port', host, port }`), and a **scope** (`ProxyRouteSet.scope`) that
puts the origin machine in the objects' names — the same application can run on
two machines served by the same proxy. The file-based Traefik routes there
directly; a cluster's Traefik gets a `Service` without a selector and an
`EndpointSlice` to the other machine, in the `pupitre-routes` namespace —
neither `ExternalName`, which Traefik refuses by default, nor a proxy setting.
The worker opens a session to the proxy's machine for the time needed to set or
probe; the `routes:check` round groups domains by proxy.

**A proxy outside the targets: Nginx Proxy Manager.** It often runs on a separate
machine that Pupitre does not drive: it only reaches it through NPM's API, with
an account of its own. It is the model's `remote` placement, and a second
contract, `RemoteProxyProvider` — `check() apply() probe() reach()` —, without
what assumes a machine (no detection, no installation: you connect to it). The
catalog record says a kind's placement; the worker knows no more:
`openProxy()` (`apps/worker/src/proxy/connect.ts`) returns the same gestures —
set, probe, test, test a link — over SSH or through the API, and everything else
(pipeline, **Apply**, destruction, round) goes through it. The connection lives
in `proxies` without a host machine; its password in `encrypted_secrets`,
encrypted under `MASTER_KEY`, decrypted by the worker alone. It serves machines
**through a link**, always — the upstream is a port with an address, as for the
central proxy. Three things change hands:

- **the probe** goes from the panel to NPM's entrance (`probeDirect()`), the name
  in `Host` and in SNI — and no longer from the proxy's machine;
- **a link test** can no longer run `curl` from the proxy's machine:
  `checkReach()` receives an **origin** (`ReachOrigin`), and a remote proxy's one
  sets up an ephemeral host on NPM to the listener, queries it through its
  entrance, then removes it. NPM does not tell its routing table: the arrival
  address is only recorded by the listener (python3 or perl on the served
  machine), and the test says when it is not;
- **certificates**: NPM requests them itself from Let's Encrypt, in the
  account's name; a certificate already present that covers the domain (a
  wildcard obtained through a DNS challenge) is reused as is.

A domain is an NPM "proxy host", marked in its `meta` (`pupitre`: the
application, the scope, the certificate Pupitre requested for it): only those are
read, changed, removed, and only their domain, upstream and HTTPS are held — what
you set in NPM on those hosts stays. Three NPM behaviors are worked around here,
and nowhere else: it reloads nginx without waiting for it to take (a link test
waits for its default site to stop answering for the name); for a host already in
service, it removes it from nginx for the duration of a certificate request and
runs certbot right away (a new host therefore requests its certificate **before**
existing; a host already there gets a retry); and it refuses a second certbot
during the first (a worker's requests to one instance go one after the other).

**In the pipeline**, domains are decided before rendering — they decide how the
port is published —, and set at the `proxy` step, after `healthcheck`. Then each
one is **tested through the proxy**, from its machine, the name forced to the
loopback (`probe()`): HTTP, HTTPS, redirect, and the certificate presented. A
domain that does not answer does not cancel a healthy deployment — the new
version runs —: the route is marked as failed and the log says why. Only a
configuration the proxy refuses fails the step.

**Afterwards**, the `routes:check` task (every ten minutes, `supervision` queue)
probes each domain the same way. Two consecutive failures bring the route down
and write `route.down` to the audit log — hence a notification —, recovery
writes `route.recovered`. A certificate being issued is read again at 30 seconds
then at 2 minutes, rather than at the next round.

**Before this model**, the K3s driver rendered an `Ingress` itself from the
AppSpec, and the pipeline placed on Docker a file for a Traefik assumed to be
present. Migration `0027` declared those two proxies as they were and turned the
domains in service into routes: nothing breaks on upgrade. The `Ingress` set by
the proxy carries the old one's name and replaces it.

## Languages: one product, two languages

The code, its comments and its documentation are in English. The product speaks
French or English, as set for the instance (**Settings → Regional settings**: a
French locale gives French, any other English).

- **The screens** take their texts from `apps/web/src/i18n/messages/`, a French
  dictionary and its English counterpart per area; `Translated<typeof fr>` makes
  a missing key a compile error. The vocabulary is fixed in
  `apps/web/src/i18n/GLOSSARY.md`.
- **What happens away from the screens** — a deployment log, a driver error, a
  schema complaint, a failed backup, a notification — is translated **when it is
  emitted**, in the instance's language: each area of `@pupitre/core`, the worker
  and `@pupitre/db` has its `messages.ts`, and the contexts carry the language
  (`TargetContext.language`, `ProbeContext.language`…). What is stored in the
  database (a step's log, an error) stays in the language it was written in.
- **Zod complaints** keep a French sentence as their message — the AI correction
  loop reads it — and carry their key and variables (`invalid()` in
  `packages/core/src/validation.ts`); `issueMessage()` and `localizeZodError()`
  say them again in the screen's language.
- **Two test guards** refuse French hard-coded where a user would read it:
  `apps/web/test/i18n.test.mjs` for the panel, `apps/web/test/product-messages.test.mjs`
  for `core`, the worker and the database. Pino logs and programming invariants
  (`new Error()`) are not shown to users and stay out of them.

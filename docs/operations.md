# Operations

- [Target machines](#target-machines)
- [A target's workloads](#a-targets-workloads)
- [Image updates](#image-updates)
- [An application from its repository](#an-application-from-its-repository)
- [Reverse proxy and domains](#reverse-proxy-and-domains)
- [Backups](#backups)
- [Destroy, purge, force](#destroy-purge-force)
- [Instance settings](#instance-settings)
- [Setup guide](#setup-guide)
- [The dashboard](#the-dashboard)

## Target machines

A target is a machine you already own, reachable over SSH, on which the panel
installs nothing it has not announced.

**The credential never leaves the panel.** Encrypted with AES-256-GCM at
creation, and that is all: `getTarget()` and `listTargets()` do not select the
`encrypted_credential` column, so the HTTP response cannot contain it, even if
someone forgets to filter. The only place it is decrypted is the worker, when it
opens the session.

### The SSH layer

`@pupitre/core/ssh`, on top of `node-ssh`: `connect` · `exec` · `execStream` ·
`upload` · `disconnect` · `withSession`. 30 s timeout by default. Three attempts
with exponential backoff on a **network** failure; **none** on an
authentication failure — an invalid key will not become valid by retrying, and
some targets ban the IP.

**The host key is verified**, the way `ssh` does with its `known_hosts`. On first
contact — the preflight at creation, or the first reading — its fingerprint
(`SHA256:…`, the `ssh-keygen -lf` format) is recorded on the target; the
**Configuration** tab shows it. Afterwards, a machine that presents another key
is **refused**, with no retry: no more deployment, preflight or reading. The
target's page says so at the top, with both fingerprints:

- **Accept the new key** — the machine was reinstalled. First check, on the
  machine, that `ssh-keygen -lf` on a key in `/etc/ssh/` gives the fingerprint
  shown;
- **Keep the old one** — this key is not trusted. Connections stay refused; if
  the machine still presents it, the alert comes back.

The **host key changed** event (`security.host_key_changed`) can alert the
notification channels; it is sent once per unexpected key, not on every refused
reading. Changing a target's address or port forgets its key: it is another
machine, and the next connection will record it. A target declared before this
check existed has its key recorded at the next connection.

The module depends on no logger: the caller injects its own, so command output
goes through Pino's `redact`.

The subpath is deliberate: `ssh2` stays out of the Next panel's dependency
graph. You can check it in the image, on the tree Next traced:

```bash
docker compose exec panel sh -lc 'find /app/web -name ssh2'   # nothing
```

(`/app/node_modules` legitimately contains some: it is the same image for the
panel and the worker. It is the `standalone` tree that must be clean, and
`verify-server-supervision.sh` checks it.)

### The preflight

`POST /api/targets/:id/preflight` (`target:update`) enqueues a job and returns
`202`. **Each check is independent**: a missing `kubectl` marks K3s
unavailable, it does not fail the preflight. Only the impossibility of opening
the SSH session is fatal.

| Check | What it measures |
|---|---|
| `ssh` | connection and latency |
| `os` | `uname -a`, `/etc/os-release` |
| `sudo` | `sudo -n true` → nopasswd available or not |
| `tools` | `ufw`, `curl`, `git`, `docker`, `kubectl` |
| `docker` | `docker info` + `docker compose version` |
| `k3s` | `kubectl get nodes -o json` → nodes, ready nodes, version |
| `disk` | `df -Pk /` |
| `memory` | `free -m` |

The structured result goes into `targets.runtimes_available` (versions
included), the full report into `targets.preflight_report`, and the status into
`targets.status`:

- `ok` — at least one usable runtime
- `degraded` — the machine answers, but nothing can be deployed there
- `unreachable` — no SSH session possible

The K3s preflight reads the kubeconfig **without sudo**, in
`/etc/rancher/k3s/k3s.yaml`: on a target where it is 0600 root, the cluster
would be reachable for root and invisible to the deployment account.

### Deleting a target

`DELETE /api/targets/:id` (`target:delete`) is a **pure refusal**: no cascade,
no job, no SSH. If the target carries at least one `pending`, `running` or
`success` deployment, it returns a `409` saying how many. Deployed applications
are **never** torn down by this route; destroy them first, or use the
application cascade.

> **Known trap.** A target that only carries history (`failed`,
> `rolled_back`, `destroyed`) passes this check, then gets rejected by the
> foreign key `deployments.target_id`, `ON DELETE restrict`. The caller gets a
> `500 internal_error` instead of an explanatory `409`. The workaround: purge
> the target's history (`POST /api/deployments/purge` with `targetId`) before
> deleting it. It is the only deletion path in the repository without a domain
> message.

## A target's workloads

`workload:read` to see, `workload:manage` to act, `workload:exec` to run a
command. The panel lives on `/targets/:id`, **Workloads** tab.

The inventory shows **everything running on the machine**, and tells what the
panel deployed (`managed`) from the rest. Each row has a menu: log, console,
start, stop, restart, update, delete. It is **the driver** that says what a
workload accepts in its state (`controls` and `exec` fields): a DaemonSet does
not stop, a bare pod does not restart, nothing is driven in `kube-system`.
Progress is published over SSE on the Redis channel `workload:{targetId}`.

A panel workload can be **restarted** here, but neither stopped nor started: it
is stopping the application (Servers page) that keeps its state in the
database.

The **console** is not a terminal: one command at a time, under `sh -c` in the
workload, two minutes and two thousand lines at most. The command is quoted for
the machine's shell — it only runs in the workload, never on the host. Each
command is recorded in the audit log (`workload.exec`) with its exit code; its
output, never. The output of a command or a log only goes to the session that
asked for it: each run has an identifier (`run`), reserved to that session, and
the target's stream does not relay those lines.

**A panel workload refuses to be deleted through this path** → `409`, with a
message pointing to `deployment:destroy`. The refusal relies on the freshly
re-read inventory, never on what the client claims, and it is **doubled in the
driver**: a driver does not trust its caller.

The screen never writes the word "workload" for a row: it shows the `kind`
field the driver filled in — "container", "deployment", "pod". The vocabulary
comes from the runtime, not from the UI.

### What each driver does behind it

| | Docker | K3s |
|---|---|---|
| list | `docker ps -a` + `docker inspect` (labels are only readable there) | `kubectl get deployments,statefulsets,daemonsets,pods -A -o json` — the **controllers**, plus orphan pods; never the controlled pods, because a row on which the action has no effect is a row that lies |
| delete | `docker rm -f`, **without `-v`** — a third party's anonymous volumes cannot be assessed here | `kubectl delete --wait=true`, PVCs kept, with a guard on system namespaces |
| update | `docker pull` of the current tag, effective config re-read as a diff against the original image, identical re-creation; the old container is **renamed and stopped**, not deleted, and put back if the creation fails | `kubectl rollout restart` + `rollout status`, **without** touching `imagePullPolicy`; explicit refusal for a pod without a controller |
| start / stop | `docker start` / `docker stop -t 20` | replicas to zero, the previous count noted in an annotation (`pupitre.io/replicas-before-stop`) and restored on start; Deployment and StatefulSet only |
| restart | `docker restart -t 20` | `kubectl rollout restart` + `rollout status` |
| log | `docker logs --timestamps --tail N` | `kubectl logs -l <selector> --all-containers --prefix --timestamps` — **all** the controller's pods, put back in time order |
| console | `docker exec <id> sh -c '…'` | `kubectl exec <kind>/<name> -- sh -c '…'` |

## Image updates

Every six hours (BullMQ scheduler `images:check`, `supervision` queue), and on
demand with **Check now** on the application page, the worker compares each
image deployed from a registry with what that registry announces today:

- **what runs**: `driver.runningImages()` — `RepoDigests` on Docker, the pods'
  `imageID` on K3s. Both carry the digest of the multi-architecture **index**,
  the one the registry returns for a tag;
- **what the tag designates**: a `HEAD` on the manifest, with an anonymous
  token obtained through the `WWW-Authenticate` challenge. Nothing is
  downloaded, and Docker Hub does not count these requests in its quota. HTTPS
  only;
- **a newer tag**: the tag list (five pages of a thousand at most), compared
  shape for shape — `16.4-alpine` is only compared with `x.y-alpine`. The same
  series (`16.6`) is announced; a major (`17.2`) is shown, not notified — it is
  a migration.

The finding is stored in `image_updates`, one row per (application, target,
service). What is **new** — tag content or a tag of the series never announced
before — is written to the audit log as `image.update.available`, and it is
that entry that sends the emails and webhooks of the channels subscribed to the
event. A given finding notifies only once (`notified_key`).

Not checked: images built on the target (no registry), images pinned by digest,
and private images (the registry refuses an anonymous read — the finding says
"not verifiable" and why). A stopped application keeps its last finding.

**Update** redeploys the version in service, as is. On Docker,
`docker compose pull` then `up` recreate what changed. On K3s, the driver now
pulls the images before `kubectl apply` (`k3s crictl pull`, under sudo like the
import of built images): without it, `imagePullPolicy: IfNotPresent` would keep
the first content of a tag forever. Since an identical manifest replaces no
pod, the services still running on the old digest are then restarted — and only
them.

Reads go through the `supervision` queue, writes through `ops` — the same
budget as a deployment, `attempts: 1`.

## An application from its repository

Three providers are connected in **Settings → Integrations**, one or several:

- **GitHub**, through a GitHub App that Pupitre creates with you, which you then
  install on the repositories you want;
- **GitLab** — gitlab.com or a self-hosted instance —, through the instance
  address and an access token. Preferably a **project token** (a single
  project) or a **group token** (the projects of the group and its subgroups),
  created in the project's or group's **Settings → Access tokens**, with the
  **`api`** scope — it is the only one that allows writing deployment status on
  commits, and **Test** refuses a token that lacks it —, **Maintainer** role:
  on a protected branch, GitLab only accepts a status from someone who can push
  to it. Developer is enough if developers can push to the followed branch;
  otherwise the code deploys, but the status does not come back to the commit
  ("403" in the worker logs). **Test** also says which account it opens — the
  token's bot — and when it expires: GitLab enforces an expiry, write it down.
  An expired token shows on every link ("GitLab 401"); you replace it without
  unlinking anything. The repositories offered are the projects the token is a
  member of, subgroups included;
- **Gitea, Forgejo or Codeberg**, through the forge's address and an account's
  access token — preferably a service account, member of the repositories or
  organizations to follow. The token is created in the forge's **Settings →
  Applications**, with the `write:repository` (read the code, write deployment
  status on commits) and `read:user` scopes. **Test** says which account it
  opens before anything is saved. The repositories offered are that account's:
  its own, those it collaborates on, those of its organizations.

Then **Applications → New application → From a repository** — each repository
says its forge when there are two:

1. choose the repository and the followed branch;
2. Pupitre looks for the branch's `pupitre.json` files and offers them — a
   repository can carry several, one per application; only changes under the
   file's folder concern the application;
3. the file is read at the head commit and validated as a commit would be: the
   preview shows the application, or what is wrong;
4. choose what a new commit does:
   - **update the application** — it takes the new version, nothing deploys:
     you deploy it where you want, when you want;
   - **redeploy it where it runs** — each commit goes to the targets where it
     is in service at that moment, and nowhere else; infrastructure changes can
     wait for an approval.

The application is created without a target: you then deploy it from its
drawer, like any other. Each deployment builds the code of the commit whose
version the application carries — the page shows it ("application version"),
and the status is sent back to the commit, on GitHub, GitLab and Gitea alike —
on GitLab, in the commit's pipelines tab.

The setting is changed on the page, **Repository → Edit** card, with a third
option: **on chosen targets**, whether it runs there or not. In "update" mode,
the **Update from the repository** button takes the branch's latest commit
right away.

The code is built with the hardening of any "home-made" image: read-only root,
unprivileged user, no capability. An image that writes anywhere but `/tmp` or
listens on a privileged port does not start there — see `examples/bonjour`,
which starts from `nginx-unprivileged`.

## Deploying from CI

A CI builds the image, pushes it to its registry, then asks Pupitre to deploy
it. It authenticates with an **API token**: **My account** → **API tokens** →
**New token**.

- **What it can do.** **Deploy** gives what a CI uses: `deployment:create`,
  `deployment:read`, `deployment:rollback`, `application:read` and
  `application:update` (to change the image). Always within your own
  permissions.
- **On which applications.** Limit it to the ones the CI deploys: a token that
  leaks into a repository's logs will be able to do nothing on the others.
- **The token is shown only once.** Store it as a CI secret (`PUPITRE_TOKEN`).

A deployment, with the image the CI just pushed:

```yaml
# .github/workflows/deploy.yml — after building and pushing the image
- name: Deploy to Pupitre
  env:
    PUPITRE_TOKEN: ${{ secrets.PUPITRE_TOKEN }}
  run: |
    curl --fail-with-body -X POST "$PUPITRE_URL/api/deployments" \
      -H "Authorization: Bearer $PUPITRE_TOKEN" \
      -H "Content-Type: application/json" \
      -d '{"applicationId":"…","targetId":"…","runtime":"docker",
           "images":{"web":"ghcr.io/acme/web:'"$GITHUB_SHA"'"}}'
```

The response (`202`) carries the deployment's identifier. The CI follows its
status with `GET /api/deployments/:id`, or its live logs with
`GET /api/deployments/:id/logs` (SSE), and can roll back with
`POST /api/deployments/:id/rollback`.

`images` replaces the image of the named services **and records it in the
application**: its page says what runs, and the next deployment starts from
there. Only services deployed from an image lend themselves to it. An
application linked to a repository refuses it: its AppSpec comes from
`pupitre.json`, and Pupitre already follows the repository, without CI or
webhook.

The audit log attributes each action to the person who created the token,
"through the token" that carried it.

## The code of an application without a repository

An application created by the form, by AI, from the catalog or by importing a
`compose.yml` has no repository. If one of its services is built from a
Dockerfile, its code arrives as an **archive**: the **Application code** card on
its page (`application:update`) accepts a `.tar.gz`, a `.tar` or a `.zip`, 100
MiB at most.

- **Contexts are relative to the root of the code.** `context: "."` and
  `dockerfile: "Dockerfile"` expect a `Dockerfile` at the root of the archive.
  An archive made of a single folder (`my-app/…`, what most tools produce) loses
  that leading folder — unless the expected Dockerfiles can be found without
  removing it.
- **`.git/` and `__MACOSX/` are dropped**, like what macOS slips into an
  archive: the AppleDouble `._*` files its `tar` adds next to each file, and the
  Finder's `.DS_Store`. A `tar czf code.tar.gz my-app` made on a Mac therefore
  does lose its leading folder. The rest goes as is into the build context.
  Keep `node_modules/` and build artifacts out of the archive, or in a
  `.dockerignore`.
- **Reading takes a few seconds**, in the worker: the card goes from
  "checking…" to "ready" — with, for each built service, the Dockerfile found —
  or to "refused", with the reason.
- **Deploying builds the latest archive.** Without an archive, or with a latest
  archive that was refused, the deployment is refused before it starts. The last
  five are kept: **Redeploy this version** rebuilds the code of that version,
  not today's.

From a CI, with a token limited to the application (`application:update` to
send, `deployment:create` to deploy):

```sh
curl --fail-with-body -X POST "$PUPITRE_URL/api/applications/$APP_ID/archives" \
  -H "Authorization: Bearer $PUPITRE_TOKEN" \
  -H "x-archive-name: build-$GITHUB_SHA.tar.gz" \
  --data-binary @build.tar.gz
```

The response (`202`) carries the archive and its `status`; `GET
/api/applications/:id/archives/:archiveId` follows it until `ready`, then
`POST /api/deployments` builds it.

## Single sign-on with Keycloak

Sign in to the panel through Keycloak — or Authentik, Google, Microsoft Entra:
any OpenID Connect provider. The password stays possible for whoever has one.

**On the Keycloak side**, in the realm you want:

1. an OpenID Connect client `pupitre`, **Client authentication** on
   (confidential client), standard flow only;
2. in **Valid redirect URIs**, the callback URL the settings screen gives:
   `https://your-panel/api/auth/callback/oidc`;
3. for roles, a **Group Membership** mapper on the client (or on a scope it
   receives), field name `groups`, "Full group path" unticked, added to the ID
   token;
4. the secret from the **Credentials** tab.

**On the Pupitre side**, in **Settings → Single sign-on**:

- the issuer, that is the realm's address
  (`https://auth.example.com/realms/my-realm`) — **Test** checks that the
  provider answers and announces itself that way. The panel and the browsers
  must reach it **at the same address**: it is the one that signs the tokens;
- the client's identifier and secret;
- the "group → role" mappings, from the most powerful to the least, and the
  default role — "No access" leaves a newcomer waiting for an administrator to
  choose, and the `security.signup_pending` event reports it;
- "the provider is authoritative": the role follows the groups at each sign-in.
  Unticked, it is only set when the account is created.

Once saved, the sign-in screen offers **Sign in with Keycloak**. Refusals read
plainly there: unknown identity when creation is disabled, an existing account
that cannot be linked (email not verified at the provider), a disabled account.
The details of what Pupitre checks are in
[`security.md`](security.md#openid-connect-single-sign-on).

To try it without a Keycloak of your own: `docker compose --profile test up -d
keycloak` starts a test realm, with its accounts and groups, and
`scripts/verify-sso.sh` walks through it.

## Reverse proxy and domains

The reverse proxy receives visitors on a machine's ports 80 and 443 and leads
them to the right application according to the requested domain. Pupitre
drives it: it takes over the one already running, or installs one; after that,
deploying an application with a domain is enough — the route and the
certificate follow.

Three proxies are driven: **Traefik**, the default, **BunkerWeb**, a reverse
proxy that is also a web application firewall (WAF) — each domain has its own
protection there —, and **Nginx Proxy Manager**, outside the targets, driven
through its API.

It is set on the target's page, **Reverse proxy** tab (`target:update`), or at
the step of the same name in the setup guide. A machine without a proxy stays
usable: its applications are reached through their port, without a domain
name.

### Looking at the machine

**Look at the machine** searches for what is already there, without touching
anything:

| Found | Usable if |
|---|---|
| a Traefik container | its `file` provider watches a folder **mounted from the machine**; Pupitre writes one file per application there |
| a Traefik installed as a binary | same condition, the folder is then a path on the machine |
| the Traefik of a K3s cluster | always: Pupitre hands it `Ingress` objects |
| a BunkerWeb container (all-in-one, or split with its API container) | its API is enabled (`SERVICE_API=yes`) with an `API_TOKEN`, and it receives visitors on 80 and 443 |

The static configuration is read from its three sources — arguments,
`TRAEFIK_*` variables, `traefik.yml` file — to find the entry points (`web`,
`websecure`, or those of ports 80 and 443), the watched folder and the
certificate resolvers. What is missing becomes a warning: no ACME resolver
(HTTPS with the default certificate), a Traefik on a bridge network (it reaches
the applications through the gateway, and their port stays open), a folder not
mounted. **Use this one** links the connection; Pupitre will never uninstall a
proxy it did not set up.

For BunkerWeb, detection only reads the **presence** of the API token, never its
value. Pupitre drives its API from the machine itself, over SSH: on each call,
the token is read in the container and passed to `curl` through a temporary
file readable by that account only — it never leaves the machine, neither
toward the database, nor the browser, nor a log.

### Installing

When nothing is found — or to start from scratch —, Pupitre offers what the
machine allows:

- **Traefik in a container**: `traefik:v3.7`, Compose project
  `pupitre-proxy`, on the host network on 80 and 443. No Docker socket mounted,
  no dashboard: it only reads the routes folder, read-only. Certificates are
  kept in a volume. If `ufw` is active, 80 and 443 are opened. Refused if one of
  these ports is already taken by another server;
- **the K3s Traefik**: it is not replaced, it is configured through a
  `HelmChartConfig` — an ACME resolver and a volume for certificates. If a
  "traefik" `HelmChartConfig` already exists and is not Pupitre's, it is not
  overwritten;
- **BunkerWeb in a container (WAF)**: the all-in-one image
  `bunkerity/bunkerweb-all-in-one:1.6.15` (~2.1 GB, ~650 MB of memory at rest),
  Compose project `pupitre-bunkerweb` in `{root}/bunkerweb`, the machine's ports
  80 and 443 to 8080 and 8443 (it runs without root privileges). Its API is
  enabled, its web interface is not — Pupitre stands in for it. The API token
  is **generated on the machine**, in `api.env` (mode 600). Refused if 80 or 443
  is taken, or if there is not enough room for the image; available memory
  under 800 MB is reported. It installs on a machine that has Docker: for a
  K3s-only machine, link it to the BunkerWeb of a Docker machine
  ([One proxy for several machines](#one-proxy-for-several-machines)). It
  reaches its machine's applications through the Docker gateway: their port is
  published there, not on every interface.

The certificate authority is chosen among those the installation accepts:
**Let's Encrypt**, **Let's Encrypt (staging)** — certificates not recognized by
browsers, with no volume limit, for trying —, **ZeroSSL** (BunkerWeb), or
**another ACME server** (Traefik only: step-ca, Smallstep…, with its URL and, if
it is not public, its authority's certificate). BunkerWeb only accepts Let's
Encrypt and ZeroSSL. Certificates are obtained through the HTTP-01 challenge:
the machine's port 80 must be reachable from the Internet, and the domain must
point to it.

### Testing, removing

**Test** checks that ports 80 and 443 answer, and that the proxy **really
reads** what it is given: in file mode, a test route to a closed port is placed
— read, it gives 502, ignored, 404 — then removed; in a cluster, the Ingress
class, the ready deployment and the resolver; for BunkerWeb, the healthy
container, the API accepting the token, and a test service to a closed port,
applied (502) then removed. The last test is shown point by point.

**Remove** is refused while domains go through the proxy: cutting them without
saying so would leave sites unreachable. A proxy installed by Pupitre can be
uninstalled at the same time — container and folder removed, or K3s
configuration restored and the `pupitre-routes` namespace removed.

### An application's domains

At deployment — in the application's drawer as in **New application** —, the
**Domains** field appears as soon as the target has a proxy: one name per line,
HTTPS ticked by default (HTTP then redirects to HTTPS). Each name is checked
against DNS to warn — "points to this machine", "points elsewhere", "does not
resolve yet" —, never to refuse: behind a CDN or a NAT, the public address is
not the one through which the panel reaches the machine.

On the page, the **Domains** card shows, target by target, each domain, whether
it answers through the proxy and until when its certificate runs. **Edit**
changes the list; if the application is running, it is set on the proxy right
away, without redeploying (`deployment:create`).

A domain is **unique** across the whole panel: claiming it for a second
application is refused, naming the first. An AppSpec's domain (`ingress.host`)
is only a default value, kept at the first deployment on a target; after that,
the target's list is authoritative. Destroying the deployment in service removes
its routes from the proxy and releases its domains.

The port of an application served by a proxy on the same machine is only
published on the loopback: it is then reached only through its domains.

### Protecting a domain (BunkerWeb)

Behind BunkerWeb, each domain has its protection, chosen in the **Domains**
field and editable from the application's page:

| Protection | What BunkerWeb does |
|---|---|
| **Protection** (default) | blocking ModSecurity, OWASP CRS rules; 100 requests per second and 100 simultaneous connections per address; an address that accumulates thirty errors in a minute (400, 401, 403, 404, 405, 444 — not 429) is banned for an hour |
| **Detection only** | the same checks in `detect` mode: everything is logged in BunkerWeb, nothing is blocked. No connection limit, which nginx cannot merely log |
| **No WAF** | neither inspection nor limit: BunkerWeb relays |

All three let through the methods of a web application, REST APIs included
(GET, POST, PUT, PATCH, DELETE, OPTIONS…). **Why not BunkerWeb's settings as
they are?** They are made for a brochure site: 2 requests per second per
address, all URLs together, and 10 simultaneous connections. Measured: twenty
requests at once — a page and its resources — get eighteen 429 refusals, and
two browsers behind the same home router exceed 10 connections. **Detection
only** is there to make sure an application is not hindered before switching to
**Protection**.

Pupitre creates one BunkerWeb service per domain and only sets what it manages:
what an administrator adds by hand in BunkerWeb (headers, limit rules for
`/login`…) stays in place from one deployment to the next. It never touches a
service it did not create — a domain already configured by hand in BunkerWeb is
refused, saying so. Pupitre's probes pass BunkerWeb's whitelist with a **secret
header**, generated on the proxy's machine (`{root}/bunkerweb/probe-header`,
mode 600): they are neither limited nor banned, and therefore do not tell
whether a real visitor is blocked by the WAF. Not by their address: seen from
the container, they arrive from the Docker gateway — like the IPv6 visitors
Docker relays, which an address whitelist would take out of the WAF.

After each change, Pupitre waits until BunkerWeb really serves the domains: if
it refused the new configuration — nginx rejects it, BunkerWeb silently goes
back to the previous one —, the deployment says so, with nginx's message. A
BunkerWeb installed by Pupitre accepts long domains
(`SERVER_NAMES_HASH_BUCKET_SIZE=256`); with nginx's default setting, a name of
about fifty characters is enough to get the whole configuration refused.

### One proxy for several machines

A machine does not need its own proxy: it can go through another one's — the
**central proxy**. Visitors arrive at the proxy's machine, which leads them to
it. On the target's page, **Reverse proxy** tab, without a proxy of its own:
"Or go through another machine's reverse proxy" — choose the proxy, give **this
machine's address as seen from the proxy's**, **Link**.

The address matters: between the two machines, traffic **is not encrypted**. A
private address — the host's private network, VLAN, WireGuard — keeps it at
home; a public address sends it in clear over the Internet, and the card says
so. For the Traefik of a K3s cluster, the address must be IPv4.

**Link** runs a test right away, run again by **Test the link** — and **before
each deployment** of an application with domains on the machine. A route or a
ping proves nothing (a host's security group lets them through and blocks the
rest): we test the visitors' very path.

- from the proxy's machine, the route to the given address;
- on the served machine, an ephemeral listener on a free port **in the
  applications' range** — where the driver will publish. In python3, otherwise
  perl, otherwise `nc` (BusyBox included); if there is none of these, only the
  route is checked and the card says so. If `ufw` is active, this port is opened
  for the duration of the test, then closed;
- from the proxy's machine, a connection to `address:port`, which must bring
  back a token drawn for the occasion — it really is this machine that
  answered. The listener notes the address it arrived from, NAT included: it is
  to that address alone that the application's port will be opened;
- from the served machine, whether the address is really its own. Behind a NAT,
  it is not: the card warns that the applications' port will be published on all
  its addresses.

The result says what blocks: "no answer within 5 s" (a firewall or security
group that drops packets), "refuses the connection" (a firewall in REJECT, or
another machine's address), "it is not this machine" (NAT, another server). At
deployment, a machine the proxy cannot reach **fails the preflight**, before
any build, with this diagnosis and the range to open — rather than a silent
domain at the end of the build.

After that, nothing changes at deployment: the **Domains** field appears as for
a local proxy, the application's **Domains** card says "on «proxy-machine»".
What changes is how the application is published — for the proxy, and for it
alone:

| Runtime | Publication | Restricted to the proxy by |
|---|---|---|
| Docker Compose | a port, on the given address | the publication address, and `ufw` opened to the proxy's arrival address only |
| K3s | a `NodePort` (30000-32767) on the entry point | a `NetworkPolicy` that accepts, from outside, only the proxy's arrival address |

On the proxy's side, a file-based Traefik gets a route to `address:port`; a
cluster's Traefik, a `Service` without a selector and an `EndpointSlice` that
points to the other machine, in the `pupitre-routes` namespace. The name of
these objects carries the origin machine: the same application can run on
several machines served by the same proxy.

A linked machine cannot have its own proxy, and vice versa: unlink before
installing, remove before linking. Unlinking is refused while the machine's
domains go through the proxy; removing the proxy, while domains of the machines
it serves go through it — the proxy's card lists those machines. An application
deployed on K3s before the link has no `NodePort`: redeploy it so the proxy can
reach it.

The domain probe goes through the proxy's machine, as for a local proxy: a
domain that stops answering writes the same `route.down`.

### Nginx Proxy Manager, outside the targets

A Nginx Proxy Manager (NPM, 2.x series) often runs on a separate machine that
serves a whole network. Pupitre does not drive that machine: it talks to
**NPM's API**, with an account of its own, and only touches the hosts it set
up.

**The account.** In NPM, *Users* → an account for Pupitre:

- without two-factor authentication — Pupitre could not answer the challenge;
- *Permissions*: **Manage** on *Proxy Hosts* and *SSL Certificates*, nothing
  else; with **Created Items** visibility, it only sees what it sets up.

**The connection.** On a target's page, **Reverse proxy** tab, without a proxy
of its own: **Connect a Nginx Proxy Manager**:

| Field | What is needed |
|---|---|
| Interface address | that of NPM's administration, which carries its API — often `http://machine:81`. The password goes through it: over HTTP, a private network only (**Test** fails on a public IP address over HTTP) |
| Email, password | those of Pupitre's account. The password is encrypted in the database, and only leaves it toward the worker |
| Where it receives visitors | optional: where the **panel** probes the domains. Empty: the interface's machine, ports 80 and 443 |

**Connect** tests right away: the API, encryption, the account, its rights, and
the visitors' entrance as seen from the panel. A connection that does not get
in is not kept — the reason is given. After that, NPM appears among the proxies
to link, under **Outside the targets**: each machine it serves is linked to it
with **its address as seen from NPM**, as for the central proxy. **Test the
link** has NPM set up an ephemeral host to a listener on the machine, queries
it, then removes it. On a machine with neither python3 nor perl (an Alpine), the
listener does not note where NPM arrives from, and NPM does not say: the link
reports it, and the applications' port is then not restricted to NPM.

**What Pupitre sets up.** One domain, one "proxy host" to the machine's
`address:port`, marked as Pupitre's. It holds the domain, the upstream, HTTPS
and its redirect; what you set in NPM on that host — access list, cache, *Block
Common Exploits*, headers — stays from one deployment to the next. A host set up
by hand is never read or removed; a domain it already carries is refused by NPM,
and the deployment says so.

**Certificates.** NPM requests them itself from Let's Encrypt, through the
HTTP-01 challenge, in the name of the account's email: the domain's DNS must
point to NPM and its port 80 must be open. A certificate **already in NPM** that
covers the domain is reused as is — a `*.example.com` wildcard obtained through
a DNS challenge in NPM thus serves every subdomain, without a new request. A
failed request leaves the domain served over HTTP; the next deployment, or
**Apply** on the Domains card, requests it again. The certificates Pupitre
requested leave with their hosts; the others stay.

**Removing.** **Edit the connection** → *Remove this connection*: refused while
domains go through NPM. Nothing is removed from NPM — its hosts have already
followed the domains.

### What raises an alert

Every ten minutes, each domain is probed through its proxy, from its machine —
or from the panel, for Nginx Proxy Manager. Two consecutive failures write
**`route.down`** — "Domain unreachable", with the reason: proxy off, route
missing, silent application —, recovery writes **`route.recovered`**.

The same probe reads the certificate's expiry. A certificate entering its
**last fourteen days** has missed two weeks of renewals — Let's Encrypt renews
at thirty days: DNS, port 80, the authority's rate limit, something blocks. It
writes **`route.certificate.expiring`**, once per certificate
(`routes.certificate_alert` keeps the reported expiry); the next certificate,
renewed, writes **`route.certificate.renewed`**. Four events the notification
channels can follow.

The **Domains** page (`/domains`, `application:read`) gathers them all: each
one's application and machine, the proxy serving it, its state, the last probe,
and its certificate's expiry with the time left. The "To watch" filter keeps
only those that do not answer or whose certificate drops under fourteen days.
Nothing is edited there: a domain is set on its application's page.

A click on a domain opens its **drawer**. What the database knows shows right
away; a few seconds later the **inspection** arrives, done by the worker on the
spot (`domain:inspect`, supervision queue):

- **DNS** — the name's A, AAAA and CNAME records, their TTL, and whether it
  **leads to the machine of the proxy** serving it (that machine's addresses are
  compared with the name's);
- **addresses** — public or private, and their reverse names;
- **registration**, the "whois" — through **RDAP**, the structured whois:
  registrar, creation, expiry, name servers, EPP statuses. The domain queried is
  the registered domain (`example.com` for `app.example.com`); a local name
  (`.localhost`, `.test`, `.lan`…) has none;
- **zone** — its name servers, its mail (MX), the authorities allowed to issue
  its certificates (CAA);
- **certificate** — as the name presents it, seen from the worker: subject,
  names covered, issuer, validity, recognized chain or not, protocol,
  fingerprint.

The guards are those of monitoring: the RDAP registry is only reached at a
public address, and the TLS handshake goes to the name's address under
`MONITOR_ALLOWED_CIDRS` — a domain that resolves to an internal address is not
probed from the worker unless allowed. Nothing is written, neither on the route
nor in the audit log.

### An existing installation

Migration `0027` takes over what worked: the Traefik shipped with each K3s
target, and the one a domain already in service on Docker assumed (folder
`{root}/proxy/dynamic`, resolver `default`), become "found" connections; the
domains in service become routes. A **Test** on each target then says what
really answers.

### Limits

Pupitre does not install Nginx Proxy Manager: it connects to a running instance.
No wildcard request (`*.example.com`): it needs the DNS-01 challenge — a
wildcard already present in NPM is reused, though. If NPM's "default site" was
changed, a domain it does not know is no longer recognized as such by the
probe: it only says that it does not answer. On Docker, an exposed service with
more than one replica has no published port, hence nothing a proxy can reach.
BunkerWeb installs as a Docker container: neither in a K3s cluster, nor as a
system package; and a BunkerWeb found without an email set by Pupitre does not
get automatic certificates from it.

## Backups

Two things are backed up, and nothing else:

- **the panel database** — applications and versions, targets and their SSH
  keys, secrets, accounts, audit log, monitoring, chat. Everything Pupitre
  knows;
- **each application's data** — what its AppSpec declares under `volumes`. The
  code, the images and the AppSpec itself are not part of it: the AppSpec is in
  the panel database, images are pulled or rebuilt again.

An application without a volume has nothing to back up, and the screen says so.

### The destination

`/admin/settings/backups`, `settings:manage`. A single destination in
service, **off the panel's machine** — a backup that burns with what it
protects is not one:

| Type | What you provide |
|---|---|
| S3 storage | endpoint, region, bucket, prefix; access key and secret key. AWS, Scaleway, OVH, Backblaze B2, Wasabi, R2, or MinIO on a NAS |
| SFTP · NAS | host, port, account, folder; password or private key; the host's SHA256 fingerprint, optional but recommended |
| Mounted folder | an absolute path seen by the worker — the host's `BACKUP_LOCAL_PATH`, mounted at `/backups` |

Secrets are encrypted under `MASTER_KEY` and never come back out: the form shows
which ones are saved, leaving the field empty keeps them. Each save is followed
by a test — write, read back, delete a small file — whose result shows as a
badge, and **Test** runs it again.

**Changing place does not lose the history.** A destination changed in its kind
or configuration becomes a new row; the old one is retired, and the backups on
it stay restorable as long as it is reachable. Retention only applies to the
destination in service: what remains on the old one is deleted by hand.

### An application's backups

The **Backups** card on the application page (`backup:read`, settings
`backup:manage`):

- **Automatic backup** — carried by the "Application backups" task (02:00 by
  default), created when first needed and adjustable in Tasks;
- **Back up before each deployment or update** — the pipeline's `backup` step,
  see [`architecture.md`](architecture.md#deployment-pipeline). If it fails,
  the deployment does not start;
- **Mode** — hot or brief stop, see below;
- **Retention** — the last 3, then the last one of each of the last 7 days, 4
  weeks and 6 months. A failed backup does not count; its history row goes
  after 30 days.

**At the first deployment**, the application's drawer and **New application**
offer to enable the first two options at once, to whoever has `backup:manage`
and for an application that has volumes — boxes ticked by default, greyed out
while no destination is set. It is a starting point, adjustable later on the
page; a redeployment does not touch a policy already set.

### Hot or brief stop

**Hot**, nothing stops. A **recognized** database is exported by its own tool,
run in its container with the credentials the image already received —
consistent by construction. Its volumes are then **not** copied: a copy of the
files of a database that is writing restores, then refuses to start. The other
volumes are archived as they are.

| Image (Docker Hub) | Export | Restore |
|---|---|---|
| `postgres`, `postgis/postgis`, `pgvector/pgvector`, `timescale/timescaledb(-ha)` | `pg_dumpall --clean` — databases, roles, objects | connections cut, databases closed, then `psql` |
| `mysql`, `mariadb` | `mariadb-dump` or `mysqldump`, application databases only | `mariadb` or `mysql` |
| `mongo` | `mongodump --archive` | `mongorestore --archive --drop` |

A database the panel does not recognize — another image, another registry —
has its volumes copied like the others, and the card reports it: a file that
changes during the copy can give an inconsistent archive. A SQLite in a volume
is in that case.

**Brief stop**: the application is stopped, all its volumes are archived —
databases included, consistent then —, then it is started again. A few seconds
to a few minutes of downtime, depending on the size. It is the right mode for an
unrecognized database. An application already stopped is always backed up this
way.

### Restoring an application

**Restore** on a successful backup, from the application's page or from the
settings overview — **`backup:restore`** permission, separate, because it means
replacing data. The dialog asks **on which target** to restore when the
application runs on several, and offers to **back up the current state** (ticked
by default): a restore can then be undone the way it was done. Then, in the
`backups` queue:

1. each chunk is downloaded and **verified** — SHA-256 fingerprint and
   encryption authentication — before anything is touched;
2. the current state is backed up, if requested. This safety backup stays
   **out of the rotation**: retention could otherwise remove the very backup
   being restored. The next ordinary backup sorts it out;
3. if there are volumes: the application is stopped, the volumes emptied and
   filled, the application started again;
4. if there are exports: we wait for each database to answer, replay the export,
   then the application restarts to reconnect.

The deployed code and version do not change: only the data goes back. The
application must be running on the chosen target — not stopped —, and nothing
else must be in progress for it, neither deployment nor backup. The result is
written to the audit log (`backup.restored` or `backup.restore.failed`, with
the end of the task's log), and both the page and the overview show the last
restore.

**The chosen target can be another one** than the backup's, and of another
runtime: a backup only contains AppSpec names, so that the backup of an
application on Docker restores onto the same application deployed on K3s. It is
also the way to move data from one machine to another.

### The overview

In `/admin/settings/backups`, the **Applications** card lists, with
`backup:read`, each application that has a backup or a policy: the last backup
and its outcome, their count and size, the active options. Each one unfolds into
its full history, from which you restore or delete as from the page — enough to
find the backup of the 7th without opening applications one by one.

The backups of a **deleted application** stay there, under its name and marked
as such: they are still on the destination. They can no longer be restored — no
application can receive them —, but `backup decrypt` reads them by hand, and
deleting them frees the space.

### The panel database

In the settings: **Back up now**, and the automatic backup, carried by the
"Panel backup" task (01:30 by default). `pg_dump --format=custom`, encrypted
like the rest; default retention.

**`MASTER_KEY` is not in the backups**, and without it none can be read — neither
the files, nor the encrypted secrets they contain. Store it elsewhere, with
`BETTER_AUTH_SECRET`, in a password manager. A changed `MASTER_KEY` makes every
backup made before unreadable.

### Restoring the panel database

It is not restored from the panel: you do not replace a database under the feet
of whoever writes it. It is the worker's command line, with panel and worker
stopped:

```bash
docker compose stop web worker
docker compose run --rm worker backup list                           # panel/… folders on the destination
docker compose run --rm worker backup restore-panel panel/<folder> --yes
docker compose start web worker                                      # the panel replays the migrations on start
```

**The panel's machine is lost.** On the new one: same `.env` — same
`MASTER_KEY` above all —, `docker compose up -d postgres redis`, then one of two
ways:

- download `panel/<folder>/panel.dump.pupb` from the bucket or the NAS, and pass
  it to `restore-panel`:

  ```bash
  docker compose run --rm -v "$PWD/panel.dump.pupb:/tmp/panel.dump.pupb:ro" \
    worker backup restore-panel /tmp/panel.dump.pupb --yes
  ```

- or start the empty panel, set the same destination in the settings, then
  `backup list` and `restore-panel panel/<folder>` as above.

Applications are then restored from their page: the restored database knows
their backups and the destination where they are.

`backup decrypt <file.pupb> <output>` decrypts any backup file, to inspect it or
replay it by hand — a PostgreSQL export is gzip-compressed, a volume archive is
a `.tar.gz`.

### What counts as a failure

A backup that fails leaves nothing on the destination — its chunks already
uploaded are deleted —, a failed row in the history with the cause, and the
**`backup.failed`** event, which the notification channels can follow. A backup
interrupted by a worker restart is marked as failed at the next start.

## Destroy, purge, force

Three gestures, three scopes, three permissions.

### Destroying a deployment — `deployment:destroy`

`DELETE /api/deployments/:id`. Acts **on the target machine**, over SSH: the
proxy is unregistered, then `driver.destroy()` tears down. BullMQ job,
`attempts: 1`, `202` response. The deployment **stays in the database**, status
`destroyed`, `url` and `publishedPort` set to `null`, port released. `409`
refusal if it is `running` or `pending`, or if it is already `destroyed`.

### Purging history — `deployment:purge`

`DELETE /api/deployments/:id/purge`, or `POST /api/deployments/purge` in bulk.
Acts **in the database only**; the machine is not touched. The row disappears,
and `deployment_steps`, `scan_runs` and `findings` go with it in cascade.

It is **synchronous**, and it is an accepted exception to the "everything
long-running goes through BullMQ" rule: a `DELETE ... WHERE id = ANY(...)` in a
transaction is very far from a long operation in the sense of that rule, which
targets remote work — SSH, build, scan.

Details that matter:

- **At least one criterion is required** (`ids`, `statuses`, `olderThanDays`,
  `applicationId`, `targetId`). An empty filter would target the whole history:
  that is not a purge, it is an accident.
- A cap of 500 rows per call, with `truncated` in the response and sorting by
  ascending date — two calls finish the job.
- `dryRun` takes **exactly the same decision path** as the execution.
- A run in service refuses to be purged (`409`). And "in service" is not
  computed on the *latest* deployment of the (application, target) pair: a
  failed deployment would take the lead and make purgeable the `success` version
  whose containers are still running.
- An orphan port reservation is released if no deployment remains for the pair.
- **The audit log outlives what it describes**: `audit_logs.resource_id` is a
  `text` without a foreign key. Purging a run does not purge its trace.

### Deleting an application

Two paths, deliberately separate.

**`DELETE /api/applications/:id`** (`application:delete`) — the simple gesture.
Synchronous, no job, no SSH. What blocks is not "carrying deployments": a
`destroyed` deployment is a history record, it holds nothing back. It is
carrying one that the panel must not lose sight of. If one remains,
`409 application_has_live_deployments`, with the versions and targets named,
and a pointer to the cascade.

**`POST /api/applications/:id/cascade`** — the cascade. This is where BullMQ
comes in, and it requires **the union** of `deployment:destroy` +
`deployment:purge` + `application:delete`. Their union, not one more
permission.

`GET` on the same route is a **preview that names**: for each live deployment,
the target, the host, the Compose project or namespace, the published port —
plus the number of history entries, the reserved ports, and the permissions you
are missing.

The worker chains three gestures, **in this order**:

1. **destroy on the machines** — bounded SSH (`retries: 1`,
   `readyTimeout: 10 s`): we are not trying to succeed despite a capricious
   machine, we are trying to know;
2. **purge history** — purging *before* destroying would lose the handles that
   are precisely used to destroy;
3. **delete the application**.

**Partial failure without forcing**: we carry on with the next targets, but
**nothing is deleted**. The response says what was destroyed and what resisted.

### What "force" means

```ts
force: z.boolean().default(false),
confirm: z.string().max(200).optional(),
```

`force: true` **requires no additional permission** — the same three. What it
requires on top is an **intention**: `confirm` must be exactly the
application's slug, otherwise `422`, whose message lists each workload that
will be abandoned. *A checkbox gets ticked by reflex; a name gets copied while
looking.*

Forcing **first retries the destruction** — the `abandoned[].error` field proves
the attempt took place. Only then is what resisted abandoned.

When the target is unreachable, the exact effect is this: **the containers keep
running** on the machine, the port stays taken on its side, and the record goes
anyway. The only safety net is the `application.delete.forced` audit entry,
which carries the hosts, the Compose projects, the ports, the errors — and above
all **`manualCleanup`, the commands to run on each machine**, obtained from
`driver.manualCleanup()` and never from an `if` on the runtime.

> The audit entry written here is the ONLY trace that will remain: once the
> transaction has gone through, nothing in the panel can name what is still
> running on those machines.

`verify-force-delete.sh` takes this promise all the way: it unplugs the target,
forces, plugs it back, observes that the containers are still running, **reads
the command in the audit log** and cleans the machine with it. If the log were
not enough, the test would fail.

**An `in_progress` deployment can never be forced**, neither on the route side
nor on the worker side: deleting the row under the worker writing it would leave
the machine in a state nobody could describe anymore.

## Instance settings

`/admin/settings` — `settings:read` to see, `settings:manage` to write. Ten
sections, arranged in **four groups** in the rail — Instance, Security and
access, Integrations, Operations —, each one a tab of its group and a **real
page**, with its own address; `/admin/settings` leads to the first. Field help
reads as a tooltip (the ⓘ icon next to the label).

| Section | URL | What is set there |
|---|---|---|
| **Instance** · Identity | `/admin/settings/identity` | the instance's name and tagline |
| **Instance** · Regional settings | `/admin/settings/regional` | time zone, locale — hence the panel's language —, date and time format |
| **Security and access** · Security scanning | `/admin/settings/security` | active scanners and blocking threshold — see [`security.md`](security.md#the-blocking-policy-lives-in-the-settings) |
| **Security and access** · Single sign-on | `/admin/settings/sso` | the OpenID Connect provider — see [Single sign-on with Keycloak](#single-sign-on-with-keycloak) |
| **Security and access** · Accounts and sessions | `/admin/settings/accounts` | required second factor, session length — see [`security.md`](security.md#required-second-factor) |
| **Integrations** · Notifications | `/admin/settings/notifications` | the four channels — see [`monitoring.md`](monitoring.md#notifications) |
| **Integrations** · Artificial intelligence | `/admin/settings/ai` | provider, model, key — see [`ai.md`](ai.md) |
| **Integrations** · Code repositories | `/admin/settings/integrations` | the GitHub App, the GitLab instance and the Gitea forge of linked repositories — see [`architecture.md`](architecture.md#linked-repositories) |
| **Operations** · Backups | `/admin/settings/backups` | destination, panel database — see [Backups](#backups) |
| **Operations** · Setup guide | `/admin/settings/onboarding` | run the guide again |

A "Read-only" banner shows without `settings:manage`, and the permission is
**checked again in each page**: a layout is not re-executed on client
navigation.

### Storage

**A single row, a single JSONB.** The `app_settings` table is a singleton held by
the database (`check (id = 1)`), and every setting lives in a `value` column.
Reason: adding a setting must not cost a migration. The other side is that the
shape is guaranteed by Zod, not by the database — hence a schema applied on each
read, which fills absent fields with their default. An empty database, a
truncated JSON or a field added afterwards always return a complete object.

The **AI API key is not in it**: it lives in its own encrypted column, and that
is precisely what allows serializing the whole JSONB into a response or an audit
entry without risk.

A Zod trap is avoided everywhere, and it is worth knowing if you touch this
file: `schema.default(x).optional()` returns `x` when the key is **absent**. A
`PATCH { ai: { enabled: false } }` therefore went off with a complete `ai`
object of default values and silently reset the provider, the model and the
temperature. *Patch* schemas are therefore built on fields **without a
default**; defaults only exist on the *read* schema.

Regional settings set the panel's language: a French locale shows it in French,
any other in English, for the whole instance — the statuses written on commits,
the deployment logs, the errors and the notifications follow the same language.
They also set how dates are displayed, server side **and** browser side, and
provide the default time zone for scheduled tasks created afterwards.

### What is not an instance setting

| Setting | Where it really lives |
|---|---|
| Public sign-up | `ALLOW_SIGNUP` variable |
| Probes' SSRF guard | `MONITOR_ALLOWED_CIDRS` variable, panel **and** worker |
| Retention of probe measurements, of release directories | code constants |
| A machine's reverse proxy | the target's page, **Reverse proxy** tab — see [Reverse proxy and domains](#reverse-proxy-and-domains) |
| A machine's port range | the target's columns, `targets.port_range_*` |

## Setup guide

At the first sign-in, the panel takes over. Eight steps:

| # | Step | Permission | Optional |
|---|---|---|---|
| 1 | Welcome | — | no |
| 2 | Identity and regional settings | `settings:manage` | no |
| 3 | First target | `target:create` | yes |
| 4 | Reverse proxy | `target:update` | yes |
| 5 | A role | `role:manage` | yes |
| 6 | A user | `user:manage` | yes |
| 7 | Security and AI | `settings:manage` | yes |
| 8 | End | — | no |

The order goes from the most general to the most specific; `role` then `user`
come after `target` because a role is used to give access to something that
exists.

**A step that cannot be done is absent, not greyed out**: offering a form whose
save will end in a 403 is worse than offering nothing. A viewer is therefore
offered no step — and is never redirected.

**The guide creates nothing by itself.** Each step calls the route the normal
screen already calls (`POST /api/targets`, `POST /api/admin/roles`,
`PATCH /api/settings`). `verify-onboarding.sh` compares **column by column, in
SQL**, a target created by the guide and a target created by `/targets/new`:
same columns, same encrypted credential, same audit entries, same preflight
enqueued. `PATCH /api/onboarding` does only one thing: remember where you are.

### What "locked" means

It is **not** a middleware — that one runs on the Edge and has no access to
`app_settings`. It is the **server layout of the `(app)` group** that redirects
with a 307 to `/onboarding` while the guide is not settled. `pending` and
`in_progress` both bring you back there, from any page; only `completed` and
`dismissed` release you.

`/onboarding` lives in its **own route group**, hence outside the `(app)`
layout: no redirect loop, and **no navigation rail** — offering twelve ways to
get lost in a panel you are discovering helps nobody. The `/api/*`, `/login`,
`/signup` and `/logout` routes stay reachable.

### What "confirmed exits" means

Two gestures can cut the guide short, and both go through a modal.

**Leaving** (**Later**) shows *how many* steps were handled and above all **the
named list of those left** — what you leave behind, named, not counted. If no
target exists yet, an extra warning says so: as long as there is none, the
panel cannot deploy anything.

**Skipping a step** shows its `cost` — what you lose — and specifies that you
stay in the guide.

> A button pressed by reflex is not a choice: a half-configured installation
> rediscovered three weeks later costs more than the time to read two sentences.

### The state

In the `onboarding` key of the settings JSONB. Four statuses and not a boolean:
confusing `dismissed` and `completed` would amount to claiming that an
installation is configured when nobody did anything; confusing `pending` and
`in_progress` would make whoever closes their browser in the middle start over.
`completed` and `skipped` are two distinct and exclusive lists.

Running it again (`/admin/settings/onboarding`, `settings:manage`) resets the
guide and **increments a `runs` counter**: "never run" and "run three times
then abandoned" do not look alike.

There is deliberately **no `onboarding:*` permission** — the RBAC vocabulary is
closed, and each step is already guarded by the permission of what it creates.

## The dashboard

`/` — **Overview**. The order of the blocks is a stance:

1. **What needs attention**, first. Four sources aggregated and
   **deduplicated**: unreachable or degraded targets — which then "absorb"
   their applications, so that a single failure does not count twice —,
   failing applications, failing probes, and **orphan** failed deployments
   only.
2. **Running** and **Latest deployments**, side by side.
3. **The inventory**, last: ready targets, running applications, green probes,
   deployments in flight.

> The inventory closes the screen instead of opening it: those figures
> reassure, they trigger nothing.

Each source is only queried if the matching permission is granted. An anomaly
you are not allowed to see does not enter the count, and the screen says access
is restricted rather than showing a misleading zero.

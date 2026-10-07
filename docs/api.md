# Pages and API

Every route goes through `apiRoute()`, which translates typed errors into HTTP
responses — except `/api/health` and `/api/auth/[...all]`. No route builds a
401/403 by hand, and **every refusal is audited**. A write that a browser sends
from an origin other than `BETTER_AUTH_URL` is refused before anything else
(`403 cross_site_request`) — see
[`security.md`](security.md#a-write-comes-from-the-panel-or-it-is-refused).

"session" means: authenticated **through the browser**, with no particular
permission.

**A CI authenticates with an API token** — `Authorization: Bearer pup_…`,
created from **My account**. It acts in its author's name, with the permissions
given to it among theirs, re-read on each call. It is accepted by every route
guarded by a permission, and refused (`403 token_refused`) by those that only
require a session: account, chat, presence, token management. It does not open
the interface. Limited to applications, it is only accepted by the routes
marked ⓐ below, which check the targeted application; all the others refuse it
(`403 token_scope`). Revoked, expired or unknown: `401 token_revoked`,
`token_expired`, `token_invalid`. See [`security.md`](security.md#api-tokens)
and [`operations.md`](operations.md#deploying-from-ci).

**When the instance requires a second factor** from an account that does not
have it yet (**Accounts and sessions**), every route guarded by a permission —
and chat, presence, tokens — answers it `403 two_factor_required`, to the
account as to its API tokens. Only the account's routes stay open, for the time
it takes to enable it. See [`security.md`](security.md#required-second-factor).

Error messages (`error.message` in a JSON response) are in the instance's
language; the codes (`error.code`) do not change.

## Pages

### Operations

| Route | Role | Access |
|---|---|---|
| `/` | Overview — what needs attention first, inventory last | session; each block filtered by its permission |
| `/targets` | Machine fleet. `?target=<name>` opens the **record in a drawer**: overview and readings, workloads, reverse proxy, ports, preflight, configuration (`&tab=…`); `&edit=1` edits it in place | `target:read` — edit `target:update` |
| `/targets/new` | Declare a target (the add drawer) — credential never prefilled | `target:create` |
| `/targets/:id` · `/targets/:id/edit` | Redirect (307) to `/targets?target=:id` (`&edit=1`) | `target:read` |
| `/applications` | Catalog of declared AppSpecs. `?app=<slug>` opens the **record in a drawer**: overview and deployment, versions, code, domains, secrets, backups (`backup:read`), images (`&tab=…`) | `application:read` |
| `/applications/new` | Two tabs: "From a description" (AI) and "From JSON" | `application:create` |
| `/applications/:id` | Redirects (307) to `/applications?app=:id` | `application:read` |
| `/apps` | **Servers** — one card per machine, foldable | `deployment:read` |
| `/apps/:id` | Redirects (307) to `/apps?app=:id`: a running application — health, live logs, gestures — **in a drawer** of the servers screen | `deployment:read` |
| `/deployments` | Run log, filters, bulk purge | `deployment:read` |
| `/deployments/:id` | Redirects (307) to `/deployments?run=:id`: following a run — pipeline, SSE logs, scans, frozen AppSpec, rollback, destruction — **in a drawer**, even outside the displayed page | `deployment:read` |
| `/domains` | **All domains**: the proxy serving them, their state, their certificate's expiry; "To watch" filter (not answering, or certificate under fourteen days) | `application:read` |
| `/monitors` | HTTP and TLS probes. `?monitor=<id>` opens the **record in a drawer**: overview, measurements and incidents, reference screenshot; `&edit=1` edits it in place | `monitor:read` — edit `monitor:manage` |
| `/monitors/:id` | Redirects (307) to `/monitors?monitor=:id` | `monitor:read` |
| `/status-pages` | Public status pages: the list, and the editor **in a drawer** (`?page=<id>`, `?page=new`) — blocks, drag and drop, preview. **Announcements** section: the outages and maintenance windows of the pages' probes, each in a drawer (`?announce=incident:<id>`, `?announce=maintenance:<id>`) where you publish, correct, remove | `status_page:manage` or `status_page:announce` — each sees their part |
| `/status`, `/status/<address>` | A **published** status page, without sign-in; 404 otherwise | none |
| `/maintenance` | Maintenance windows in progress, upcoming and ended. `?window=<id>` opens the window **in a drawer** (period, subjects, held alerts); `?new=1` the form, with `&target=<id>` or `&monitor=<id>` prefilled | `maintenance:read` — schedule `maintenance:manage` |
| `/jobs` | Scheduled tasks, cron described in words, scrolling history | `job:read` |

The query parameters keep their original names (`nouvelle`, `annonce`,
`fenetre`, `cible`, `sonde`): links already shared keep working.

### Administration

| Route | Role | Access |
|---|---|---|
| `/admin/logs` | **Activity log** — paginated table, colored severity, filters and free search | `audit:read` |
| `/admin/users` | Accounts: creation, status, role, 2FA reset | `user:manage` |
| `/admin/roles` | Permission matrix — one role per column, one permission family per row; `?role=…` opens its drawer | `role:read` — edit `role:manage` |
| `/admin/settings` | Redirects (307) to `/admin/settings/identity` | `settings:read` |
| `/admin/settings/{identity,regional,security,sso,accounts,notifications,ai,integrations,backups,onboarding}` | The ten sections, in four tabbed groups | `settings:read` — write `settings:manage` |

### Outside the navigation

| Route | Role | Access |
|---|---|---|
| `/account` | My account — password, TOTP, API tokens (each one revealed with its `curl` and MCP examples) | session |
| `/docs` · `/docs/:chapter` | The in-panel documentation, from A to Z, in the instance's language; `?q=` searches every chapter. The chapters are Markdown files, `apps/web/src/docs/content/{fr,en}/` | session |
| `/onboarding` | Setup guide, a shell without the rail | session |
| `/login` · `/signup` · `/logout` | | public |
| `/forbidden` | Refusal screen, **names the missing permission** | public |

The navigation rail carries three groups — **Operations** (Overview, Targets,
Applications, Catalog, Servers, Deployments, Domains, Monitoring, Maintenance,
Jobs), **Administration** (**Activity log**, Users, Roles, Status pages,
Settings) and **Help** (Documentation, for every session). Each entry only
appears with the matching permission; an empty group is not shown. **Account** and **Sign out** live at the foot of the rail,
deliberately outside the business navigation.

## API

### Health and authentication

| Route | Methods | Permission |
|---|---|---|
| `/api/health` | GET | **public** — `{ status, db, redis, ai }`, 200 or 503 |
| `/api/me` | GET | session **or** token — who calls: the account, its roles, its permissions (for a token, what it can really do today), the second factor's state, and the token (`applicationIds`, `null` for all) |
| `/api/appspec/schema` | GET | session or token — the AppSpec's JSON Schema (its shape; the cross-field rules are `validate`'s) |
| `/api/appspec/validate` | POST | session or token — the body **is** the AppSpec; `200 { valid, appSpec }` with defaults applied, or `422 invalid_appspec` with **every** problem and its full path (`details.issues`) — what a CI runs on its `pupitre.json` |
| `/api/mcp` | POST | **an API token**, never a session — the MCP server (Model Context Protocol, Streamable HTTP, stateless). See [MCP](#mcp) below |
| `/api/auth/[...all]` | GET POST | public — Better Auth; audits sign-ins and sign-outs. `/api/auth/admin/*` answers 404: Pupitre has its own administration API; `/api/auth/two-factor/*` too, except `verify-totp` and `verify-backup-code` — the second factor is enabled and removed through `/api/account/two-factor/*`. Single sign-on starts from `POST /api/auth/sign-in/social` (`{ provider: "oidc", callbackURL }`, returns the provider's address) and comes back through `GET /api/auth/callback/oidc`; a failed return goes back to `/login?error=…` and writes `auth.sso.login.failed` |

### Account

| Route | Methods | Permission |
|---|---|---|
| `/api/account/password` | POST | session — `currentPassword` required |
| `/api/account/two-factor/setup` | POST | session |
| `/api/account/two-factor/activate` | POST | session |
| `/api/account/two-factor/disable` | POST | session — `409 two_factor_locked` when the instance's policy requires it from this account |
| `/api/account/avatar` | PUT / DELETE | session — the body **is** the image (`content-type: image/…`), 512 KiB at most, cropped by the browser; format and dimensions re-read from the bytes |
| `/api/users/:id/avatar` | GET | session — immutable with `?v=`, the URL `users.image` carries |
| `/api/tokens` | GET / POST | team member¹, from the panel — your tokens; POST `{ name, permissions, applicationIds?, expiresInDays? }` (30, 90 or 365, `null` for no expiry; 90 by default) returns the token **only once**. A permission the author does not have: `403`. 25 tokens in service at most |
| `/api/tokens/:id` | DELETE | your own, or `user:manage` — revokes; the token stays in the database, revoked |

### Users and roles

| Route | Methods | Permission |
|---|---|---|
| `/api/admin/users` | GET / POST | `user:read` / `user:manage` |
| `/api/admin/users/:id` | GET / DELETE | `user:read` / `user:manage` |
| `/api/admin/users/:id/role` | PATCH | `user:manage` |
| `/api/admin/users/:id/status` | PATCH | `user:manage` |
| `/api/admin/users/:id/two-factor` | DELETE | **`user:reset-2fa`** |
| `/api/admin/users/:id/avatar` | DELETE | `user:manage` — moderating a photo, traced in the audit log |
| `/api/admin/roles` | GET / POST | `role:read` / `role:manage` |
| `/api/admin/roles/:key` | GET / PATCH / DELETE | `role:read` / `role:manage` / `role:manage` |
| `/api/admin/tokens` | GET | `user:read`, from the panel — every token of the instance, with its author |

### Targets

| Route | Methods | Permission |
|---|---|---|
| `/api/targets` | GET / POST | `target:read` / `target:create` — credential encrypted before insertion |
| `/api/targets/:id` | GET / PATCH / DELETE | `target:read` / `target:update` / `target:delete` |
| `/api/targets/:id/preflight` | POST | `target:update` — enqueues, returns `202 { jobId }` |
| `/api/targets/:id/host-key` | POST | `target:update` — `{ decision: accept \| dismiss }`: decide on an unexpected host key — accept it (machine reinstalled) or keep the old one; 409 if nothing is pending. Traced with both fingerprints |
| `/api/targets/:id/metrics` | GET | `target:read` — host reading, through the queue |
| `/api/targets/:id/ports` | GET | `target:read` — range, allocated, free, and by whom |
| `/api/targets/:id/workloads` | GET | `workload:read` |
| `/api/targets/:id/workloads/events` | GET | `workload:read` — SSE; `?run=`: the stream of a single run, reserved to whoever opened it |
| `/api/targets/:id/workloads/:ref` | DELETE | `workload:manage` |
| `/api/targets/:id/workloads/:ref/update` | POST | `workload:manage` |
| `/api/targets/:id/workloads/:ref/control` | POST | `workload:manage` — `{ action: start \| stop \| restart }`, `202` |
| `/api/targets/:id/workloads/:ref/logs` | POST | `workload:manage` — `{ run, tail }`, the lines come back through the `?run=` stream |
| `/api/targets/:id/workloads/:ref/exec` | POST | `workload:exec` — `{ run, command }`, 30 per minute; the output comes back through the `?run=` stream |
| `/api/targets/:id/proxy` | GET / PUT / DELETE | `target:read` / `target:update` / `target:update` — GET: the machine's proxy and the machines it serves, or the link to another one's proxy, plus the proxies it can be linked to; PUT links a **found** proxy (`{ kind, config }`), a test starts right away, 409 if the machine is linked to another; DELETE `?uninstall=1` undoes what Pupitre installed, 409 while domains go through it — those of the machines it serves included |
| `/api/targets/:id/proxy/detect` | POST | `target:update` — what the machine carries and what can be installed there, all proxies together: each detection and each option says its kind (`kind`), an option also says its title and the authorities it accepts (`acmeServers`); the route waits for the task (60 s at most) |
| `/api/targets/:id/proxy/install` | POST | `target:update` — `{ kind: traefik \| bunkerweb, option, acme }` (`kind` is `traefik` if missing), `202`; the connection goes `installing` then `ok` or `failed`; an authority the option does not accept fails the installation, saying so |
| `/api/targets/:id/proxy/check` | POST | `target:update` — **Test**, through the queue |
| `/api/targets/:id/proxy/link` | PUT / DELETE | `target:update` — the central proxy: PUT `{ proxyId, address }` links the machine to another one's proxy, reached at `address` (IPv4 for a cluster's Traefik, otherwise 422), and runs the link test; 409 if the machine has its own proxy. DELETE unlinks, 409 while the machine's domains go through it |
| `/api/targets/:id/proxy/link/check` | POST | `target:update` — **Test the link**, through the queue: the proxy's arrival address, whether the address belongs to the machine |
| `/api/proxies` | GET / POST | `target:read` / `target:update` — **remote** proxies, outside the targets (Nginx Proxy Manager), with the number of machines they serve; POST `{ kind, name?, config, secrets }` connects an instance: the password is encrypted right away, the test starts and the route waits for its outcome — a connection that does not get in is not kept (422, with what is wrong) |
| `/api/proxies/:id` | PATCH / DELETE | `target:update` — PATCH changes the address or the account (`secrets` absent: the previous ones stay) and returns the new test; DELETE removes the connection, 409 while domains go through it — the machines it serves without a domain are unlinked from it |
| `/api/proxies/:id/check` | POST | `target:update` — **Test** a remote proxy, through the queue |
| `/api/targets/:id/dns` | GET | `target:read` — `?hostname=`: does the domain point to this machine? A warning, never a refusal |

### Applications

| Route | Methods | Permission |
|---|---|---|
| `/api/applications` | GET / POST | `application:read` / `application:create` |
| `/api/applications/generate` | POST | `application:create` — 501 without a key, 422 invalid spec, 502 silent provider, 429 beyond the quota |
| `/api/applications/from-source` | POST | `application:create` — create an application **from its repository**: `{ provider: github \| gitlab \| gitea, repository, installationId (GitHub), branch, specPath, deployTo: none \| running, mode }` reads `pupitre.json` at the head commit, creates the application and its link without a target; `preview: true` reads and validates without creating anything; 422 file missing or refused, 409 name already taken |
| `/api/applications/:id/sources` | GET / POST | `application:read` / `application:update` — the followed branches; POST links a branch: `provider` (`github` by default, `gitlab` or `gitea`), `repository` (`owner/name`, or a GitLab project's full path: `group/subgroup/project`), `installationId` for GitHub only, `deployTo` (`targets` · `running` · `none`), targets required for `targets`; 409 provider not connected or repository not accessible to it |
| `/api/applications/:id/sources/:sourceId` | PATCH / DELETE | `application:update` — 422 if `deployTo: targets` without a target |
| `/api/integrations/repositories` | GET | `application:update` — the readable repositories, **all providers together**, each with its `provider`; a provider that does not answer is named in `errors` without hiding the others; 409 if none is connected |
| `/api/integrations/specs` | GET | `application:create` — a branch's `pupitre.json` files (`provider`, `repository`, `installationId` for GitHub, optional `branch`), with the commit read |
| `/api/integrations/github` | GET / POST / DELETE | `settings:read` / `settings:manage` — the GitHub App: state and installations; POST connects it by hand (`appId`, private key); DELETE disconnects it, its links along with it. The key is never returned |
| `/api/integrations/github/manifest`, `/callback` | POST / GET | `settings:manage` — creating the App from a manifest, there and back through the browser |
| `/api/integrations/gitea` | GET / PUT / DELETE | `settings:read` / `settings:manage` — the Gitea / Forgejo forge: `{ url, token }` is tried against the forge before being saved (502 if it refuses), the token encrypted, never returned; PUT also replaces the token (409 if the address changes while links go through it); DELETE disconnects it, its links along with it |
| `/api/integrations/gitea/check` | POST | `settings:manage` — **Test**: `{ url, token }` → `{ ok, login, version, baseUrl }` or `{ ok: false, error }`, without saving anything |
| `/api/integrations/gitlab` | GET / PUT / DELETE | `settings:read` / `settings:manage` — the GitLab instance, same rules as the Gitea forge: `{ url, token }` tried before being saved (502 if GitLab refuses, or if the token lacks the `api` scope), encrypted, never returned; PUT also returns `expiresAt`, the token's expiry |
| `/api/integrations/gitlab/check` | POST | `settings:manage` — **Test**: `{ url, token }` → `{ ok, login, version, baseUrl, expiresAt }` or `{ ok: false, error }`, without saving anything |
| `/api/domains` | GET | `application:read` — every domain of the instance: proxy, state, certificate, `certificateDaysLeft`, and `attention` for those that do not answer or whose certificate is near its expiry |
| `/api/domains/:id/inspect` | GET | `application:read` — a domain's inspection, done by the worker on the spot: DNS (A, AAAA, CNAME, TTL), addresses and reverse names, whether it leads to the proxy's machine, RDAP registration (registrar, dates, name servers, statuses), zone (NS, MX, CAA), certificate presented. Nothing is written; 30 inspections per 5 minutes per person |
| `/api/applications/:id` | GET / PATCH / DELETE | `application:read` ⓐ / `application:update` / `application:delete` |
| `/api/applications/:id/cascade` | GET / POST | GET: `application:delete` · POST: **union** `deployment:destroy` + `deployment:purge` + `application:delete` |
| `/api/applications/:id/redeploy` | POST | `deployment:create` ⓐ — a version built from an archive that is no longer kept: 409 `archive_gone` |
| `/api/applications/:id/archives` | GET / POST | `application:read` ⓐ / `application:update` ⓐ — uploaded code. POST: the body **is** the archive (`.tar.gz`, `.tar`, `.zip`, recognized from its bytes, 100 MiB at most), its name in `x-archive-name` (encoded as a URL component); `202` with `{ archive, jobId }`, the worker then reads it (`status`: `pending` → `ready` or `rejected`, with `rejection` and `rejectionDetail`). 413 too large, 415 not an archive, 409 application linked to a repository, 429 beyond 20 uploads in ten minutes |
| `/api/applications/:id/archives/:archiveId` | GET / DELETE | `application:read` ⓐ / `application:update` ⓐ — its state and the reading report (`report`: files, decompressed size, leading folder removed, Dockerfiles found); never its bytes. DELETE: 409 while a deployment in progress builds it |
| `/api/applications/:id/images` | GET | `application:read` — latest image finding, target by target |
| `/api/applications/:id/images/check` | POST | `application:read` — **Check now**, through the queue, 6 per minute |
| `/api/applications/:id/versions` | GET | `application:read` |
| `/api/applications/:id/secrets` | GET | `application:read` — **never a value** |
| `/api/applications/:id/secrets/:name` | PUT / DELETE | `application:update` |
| `/api/applications/:id/routes` | GET / PUT | `application:read` / `deployment:create` — the domains, target by target; PUT `{ targetId, routes }` replaces the list and sets it on the proxy if the application is running — each route `{ hostname, tls, redirectHttps, waf }`, `waf` (`block` \| `detect` \| `off`, `block` by default) only having an effect behind a proxy that is a WAF; 409 if a domain is already taken, or if the proxy is being installed |
| `/api/applications/:id/backups` | GET / POST | `backup:read` / `backup:manage` — POST: **Back up now** `{ targetId }`, `202`; 409 without a destination, without a volume, without a deployment in service or during another backup |
| `/api/applications/:id/backup-policy` | PUT | `backup:manage` — automatic, before deployment, mode, retention; creates or enables again the "Application backups" task |

### Deployments

| Route | Methods | Permission |
|---|---|---|
| `/api/deployments` | GET / POST | `deployment:read` / `deployment:create` ⓐ (+ `scan:configure` if a `scanConfig` is provided; a `backup` is only kept with `backup:manage`, and only if the application has no policy yet; `domains` replaces the application's domains on the target before the deployment; `images` — `{ "web": "ghcr.io/acme/web:4f2c1e9" }` — replaces those services' image and saves the AppSpec, with **`application:update`** on top, refused for an application linked to a repository). Without a linked repository, a service that is built takes the latest uploaded archive; otherwise 409 `source_code_missing`, `archive_pending`, `archive_rejected` or `archive_dockerfile_missing`, before anything leaves. A deployment's details name its archive (`sourceArchiveName`, `sourceArchiveSha256`) like its commit |
| `/api/deployments/:id` | GET / DELETE | `deployment:read` ⓐ / **`deployment:destroy`** |
| `/api/deployments/:id/purge` | DELETE | **`deployment:purge`** |
| `/api/deployments/purge` | POST | `deployment:purge` — in bulk, `dryRun` included |
| `/api/deployments/:id/rollback` | POST | `deployment:rollback` ⓐ |
| `/api/deployments/:id/logs` | GET | `deployment:read` ⓐ — **SSE**, history then live |
| `/api/deployments/:id/logs/export` | GET | `deployment:read` — text or JSONL |
| `/api/deployments/:id/scans` | GET | `scan:read` |

### Monitoring running applications

| Route | Methods | Permission |
|---|---|---|
| `/api/apps` | GET | `deployment:read` |
| `/api/apps/:id/logs` | GET | `deployment:read` — SSE |
| `/api/apps/:id/restart` | POST | `deployment:restart` |

### Security

| Route | Methods | Permission |
|---|---|---|
| `/api/scans/:id` | GET | `scan:read` — paginated findings, `severity` and `view` filters (`all`, `fixable`, `unfixable`, `accepted`); each finding carries its current `acceptance`, and the response `canAccept` |
| `/api/scans/:id/sbom` | GET | `scan:read` — 409 if the scanner does not produce one |
| `/api/findings` | GET | `scan:read` — cross-cutting view, `cveId` `severity` `applicationId` `deploymentId` `scanner` filters |
| `/api/applications/:id/scan-policy` | GET / PUT | `scan:read` / `scan:configure` — `{ "failOn": "CRITICAL" \| "HIGH" \| "NONE" \| null, "onlyFixable": true \| false \| null }`, `null` follows the instance; applies to the following deployments |
| `/api/applications/:id/vulnerability-acceptances` | GET / POST | `scan:read` / `scan:configure` — POST `{ "cveId", "package": "curl" \| null, "reason", "expiresInDays": 90 \| null }`; the same CVE on the same package answers `409` |
| `/api/applications/:id/vulnerability-acceptances/:acceptanceId` | DELETE | `scan:configure` — the vulnerability will count again at the next scan |

### Probes

| Route | Methods | Permission |
|---|---|---|
| `/api/monitors` | GET / POST | `monitor:read` / `monitor:manage` |
| `/api/monitors/:id` | GET / PATCH / DELETE | `monitor:read` / `monitor:manage` / `monitor:manage` |
| `/api/monitors/:id/check` | POST | `monitor:manage` — **Probe now** |

### Forecasts

| Route | Methods | Permission |
|---|---|---|
| `/api/forecasts` | GET | session — the current forecasts, each one only returned to whoever can read its subject (`target:read`, `monitor:read`, `application:read`). "Soon" first, then by due date; see [monitoring](monitoring.md#forecasts) |

### Maintenance windows

| Route | Methods | Permission |
|---|---|---|
| `/api/maintenance-windows` | GET / POST | `maintenance:read` / `maintenance:manage` — in progress and upcoming, then the last twenty ended; each subject is only returned to whoever can read it. Choosing subjects requires being able to read them |
| `/api/maintenance-windows/:id` | GET / PATCH / DELETE | `maintenance:read` / `maintenance:manage` / `maintenance:manage` — GET adds the held alerts. PATCH `{ "endsAt": now }` ends the window; an ended window answers `409`. DELETE refuses a window in progress (`409`): you end it |

### Status pages

| Route | Methods | Permission |
|---|---|---|
| `/api/status-pages` | GET / POST | `status_page:manage` — an address already taken answers `409`; each named probe must exist |
| `/api/status-pages/:id` | GET / PATCH / DELETE | `status_page:manage` |
| `/api/status-pages/preview` | POST | `status_page:manage` — the page as a visitor would read it, computed from unsaved blocks; nothing is written |
| `/api/status-updates` | GET / POST | `status_page:announce` — GET `?subject=incident:<id>` (or `maintenance:<id>`): the subject's announcements; POST `{ "subject": { "type": "incident", "id": … }, "phase": "identified", "message": … }`, a phase specific to the subject (`422` otherwise), nonexistent subject `404` |
| `/api/status-updates/:id` | PATCH / DELETE | `status_page:announce` — PATCH `{ "phase"?, "message"? }` corrects without changing the publication time |

### Tasks and queue

| Route | Methods | Permission |
|---|---|---|
| `/api/jobs` | GET / POST | `job:read` / `job:manage` — **scheduled** tasks |
| `/api/jobs/:id` | GET / PATCH / DELETE | `job:read` / `job:manage` / `job:manage` |
| `/api/jobs/:id/run` | POST | `job:manage` — an occurrence outside the schedule, `202` |
| `/api/queue/jobs/:id` | GET | `job:read` — a **BullMQ** job's state |
| `/api/ping` · `/api/ping/:id` | POST / GET | `job:manage` / `job:read` |

`/api/jobs` designates scheduled tasks, `/api/queue/jobs/:id` a job's state in
the queue. A single route could not answer both "where is job no. 42" and "edit
the scheduled task `<uuid>`": two resources, two paths.

### Backups

| Route | Methods | Permission |
|---|---|---|
| `/api/backups/destination` | GET / PUT / DELETE | `settings:read` / `settings:manage` — **secrets never returned**, only their names; PUT enqueues a test, `202` |
| `/api/backups/destination/check` | POST | `settings:manage` — **Test**, through the queue |
| `/api/backups/panel` | GET / POST | `settings:read` / `settings:manage` — POST: backup of the panel database, `202` |
| `/api/backups/panel/schedule` | PUT | `settings:manage` — `{ enabled }`, the "Panel backup" task |
| `/api/backups/:id` | DELETE | `backup:manage` (+ `settings:manage` for a panel backup) — deletes on the destination then in the index, `202` |
| `/api/backups/:id/restore` | POST | **`backup:restore`** — `{ targetId, safetyBackup }`, `202`; 409 if the application is stopped, absent from the target or busy |

The panel database is not restored through the API: you do not replace the
database of a process using it. It is the command line, with panel and worker
stopped — see
[`operations.md`](operations.md#restoring-the-panel-database).

### Chat

| Route | Methods | Permission |
|---|---|---|
| `/api/chat/messages` | GET / POST | team member¹ — POST as JSON, or as `multipart/form-data` with images (`image` field, four at most, 3 MB each); an image alone is enough |
| `/api/chat/messages/:id` | DELETE | the author, or `user:manage` — also deletes the images |
| `/api/chat/messages/:id/reactions` | POST | team member¹ |
| `/api/chat/attachments/:id` | GET | team member¹ — immutable; 404 if the message was deleted |
| `/api/chat/read` | POST | team member¹ |
| `/api/chat/directory` | GET | team member¹ — what the session can mention |
| `/api/presence` | POST | team member¹ |
| `/api/search` | GET | a session — the ⌘K palette. `q`, and `kinds` (`target,application,running,deployment,monitor,domain,role,template`) to narrow; each family is only read with its read permission (the catalog: `application:create`). Tolerant matching: accents, word starts, letters in order, typos |

¹ A session whose role carries at least one permission (`requireTeamMember()`).
A **No access** account — a public sign-up waiting for its role — gets
`403 no_access`, and the real-time stream carries neither chat nor presence to
it.

### Settings, notifications, audit log

| Route | Methods | Permission |
|---|---|---|
| `/api/settings` | GET / PATCH | `settings:read` / `settings:manage` — **a single route for every section**. `ssoClientSecret` follows `aiApiKey`'s convention (absent: unchanged, `null`: deleted); the read returns `ssoClientSecretConfigured` and `ssoStatus` (`active`, `error`, `callbackUrl`) — never the secret. An unknown role in `sso.roleMappings` or `sso.defaultRole`: 422. `accounts`: `twoFactorPolicy` (`off`, `sensitive`, `all`), `sessionIdleHours` (1, 8, 24, 168, 720), `sessionMaxHours` (24, 168, 720 or `null`); a policy that would require from its author a second factor they do not have: `409 two_factor_self` |
| `/api/settings/sso/check` | POST | `settings:manage`, from the panel — **Test**: `{ issuer }` → `{ ok, issuer, endpoints }` or `{ ok: false, error }`, without saving anything |
| `/api/notifications/channels` | GET / POST | `settings:read` / `settings:manage` |
| `/api/notifications/channels/:id` | GET / PATCH / DELETE | `settings:read` / `settings:manage` / `settings:manage` |
| `/api/notifications/channels/:id/test` | POST | `settings:manage` |
| `/api/audit-logs` | GET | `audit:read` — paginated, filters `q` (free search: action, resource, actor, IP, payload) `severity` (`high,critical`) `actorId` `action` `resourceType` `from` `to`; each entry carries its `severity` |
| `/api/onboarding` | GET / PATCH | session — `restart` requires `settings:manage` |

## MCP

`POST /api/mcp` is a Model Context Protocol server: an AI agent (Claude Code,
Cursor, VS Code, Claude Desktop through `mcp-remote`) connects with an API token
and drives the panel. The user-facing guide is the **MCP server** chapter of
the in-panel documentation (`/docs/mcp`).

- **Transport.** Streamable HTTP, **stateless**: one `POST` carries one JSON-RPC
  message (or a batch), the answer is JSON; a notification gets `202`. `GET` and
  `DELETE` answer `405` — no server-initiated stream, no `Mcp-Session-Id`.
  Revisions `2025-11-25`, `2025-06-18`, `2025-03-26`; an unknown
  `MCP-Protocol-Version` header gets `400`. The envelope is hand-written
  (`apps/web/src/lib/mcp/protocol.ts`) — see
  [`dependencies.md`](dependencies.md#mcp-without-the-sdk).
- **HTTPS only.** Before anything else, `secureTransport()`
  (`lib/secure-transport.ts`) requires HTTPS as the client saw it —
  `X-Forwarded-Proto` / `Forwarded` behind a reverse proxy — or the loopback
  (`localhost`, an SSH tunnel). Otherwise `403 https_required`, and
  `request.insecure.refused` (high severity) is written under the token's
  account: that token travelled in clear. The in-panel MCP chapter says how to
  serve the panel over HTTPS with the machine's Traefik.
- **Authentication.** `requireCaller(request, { apiTokenOnly: true })`: a
  browser session is not enough. A `401` carries `WWW-Authenticate: Bearer`.
  `apiRoute()` still refuses a write a browser sends from another origin — the
  Origin check the specification requires against DNS rebinding.
- **Tools decide nothing.** Each tool builds the request the REST API would
  receive and hands it, **in-process**, to the Route Handler
  (`lib/mcp/dispatch.ts`, through the generated `lib/mcp/route-table.ts`), with
  the MCP request's `authorization`, IP and `user-agent` headers. Permissions,
  the per-application scope, Zod and `logAudit()` are the route's: an agent can
  do through MCP exactly what its token can do through `curl`. The audit log
  names the token, and the client's name as browser.
- **41 tools** (`lib/mcp/tools.ts`): typed tools for the common work — targets,
  applications, secrets, domains, deployments (`deploy`, `deployment_wait`,
  `deployment_logs`, `deployment_rollback`…), running applications, monitors,
  findings, the audit log —, `api_request` for every other route, and `docs`,
  which reads and searches the in-panel documentation. `tools/list` only offers
  what the token holds; a token limited to applications only sees the tools
  whose route accepts it. Live streams (SSE) are refused with a pointer to the
  exported form.
- **Resources.** Each documentation chapter is
  `pupitre://docs/{fr|en}/{chapter}`, in Markdown.
- **Guards.** `apps/web/test/mcp.test.mjs` checks that the route table matches
  `src/app/api` (regenerate it with `pnpm --filter @pupitre/web routes:table`),
  that each typed tool's route exists, exports its method and requires the
  permission the tool declares, and runs a conversation against a fake API.


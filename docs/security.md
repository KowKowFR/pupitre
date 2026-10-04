# Security

- [Authentication and accounts](#authentication-and-accounts)
- [What is public: status pages](#what-is-public-status-pages)
- [What comes from somewhere other than the panel](#what-comes-from-somewhere-other-than-the-panel)
- [RBAC — 38 permissions](#rbac--38-permissions)
- [Audit log](#audit-log)
- [Encryption](#encryption)
- [Application secret store](#application-secret-store)
- [Security scanners](#security-scanners)

## Authentication and accounts

**Better Auth**, email + password, sessions in the database, `admin` and
`twoFactor` plugins. The very first account created gets the `admin` role.

**The middleware checks nothing.** It runs on the Edge, without database access:
it only does optimistic filtering on the *presence* of the session cookie. The
real authorization happens server side, in the routes and in the pages.

**Better Auth's administration routes are closed.** Its `admin` plugin exposes
`/api/auth/admin/*`: list, create, ban, delete accounts, change a password,
**impersonate someone**. Pupitre has its own administration API
(`/api/admin/*`), which goes through `requirePermission()`, holds its safeguards
and writes to the audit log — those routes would do none of that: an
impersonation would leave no trace there, and what the impersonator did next
would be attributed to their victim. They answer 404, and each attempt is
recorded (`auth.admin_route.refused`). The server keeps using the plugin
(`getAuth().api.createUser`…), which does not go through HTTP; the client no
longer loads `adminClient()`.

Same for **the `twoFactor` plugin's routes** (`/api/auth/two-factor/*`) apart
from the two sign-in checks (`verify-totp`, `verify-backup-code`): enabling,
disabling, regenerating codes goes through `/api/account/two-factor/*`, which
writes to the audit log and refuses to remove a second factor the role requires.
Open, they would bypass both: 404, and `auth.two_factor_route.refused` in the
audit log.

### OpenID Connect single sign-on

Keycloak, Authentik, Google, Microsoft Entra: any provider that publishes an
OpenID Connect discovery document, set from **Settings → Single sign-on**
(`settings:manage`). The password stays possible for whoever has one.

- **The ID token is verified** against the keys published by the provider
  (`requireIdTokenVerification`), with PKCE and a `nonce`: groups, hence roles,
  only come from a signed token. The issuer announced by the discovery must be
  the one entered — **Test** checks it before saving, behind the egress guard.
- **The client secret is encrypted** (`app_settings.sso_client_secret_encrypted`,
  under `MASTER_KEY`), like the AI key: it never comes back out of the API, and
  the audit log only keeps a marker.
- **A local account is only linked if the provider declares the email
  verified.** The provider is not marked "trusted": without `email_verified`,
  linking is refused (`account_not_linked`) — otherwise anyone who can create an
  address they do not own at the provider would take the Pupitre account
  carrying it. On Pupitre's side, local verification is not required: an
  account created by an administrator never clicked a link, and it is the right
  one.
- **Roles come from groups**, through an ordered "group → role" list (the first
  match wins) and a default role — "No access" by default. An account is born
  directly with its groups' role. If "the provider is authoritative", the role
  is recomputed at each sign-in; a change is written as `user.role.changed` with
  `source: 'sso'`, hence notified like any role change. **The last
  administrator is never demoted** this way (`auth.sso.role.kept`,
  `reason: 'last_admin'`).
- **An account disabled in Pupitre does not get in** through the provider
  (`BANNED_USER`). Pupitre's second factor does not apply to single sign-on: it
  is up to the provider to require its own.
- **Everything is traced**: `auth.sso.login.succeeded` (with the groups
  received), `auth.sso.login.failed` (with the error code), `user.created` with
  `origin: 'sso'`.

Better Auth freezes its providers when it is built: `getAuth()` rebuilds its
instance when the effective configuration changes (`lib/sso.ts`). Sessions live
in the database and their cookies are signed by `BETTER_AUTH_SECRET`: a rebuild
signs nobody out.

### My account — `/account`

A self-service screen, without an RBAC permission: a session is enough.

**Changing your password** requires the old one. Without that requirement, a
stolen cookie would be enough to take over the account for good. The change
revokes **the other** sessions and keeps the one that made it. Neither the old
password, nor the new one, nor their length appear in the audit log.

**The second factor is TOTP**, `issuer: 'Pupitre'`, with backup codes. Arming is
done in two stages:

1. `POST /api/account/two-factor/setup` generates the secret, **without enabling
   it**, and returns the TOTP URI and the backup codes. It is the only panel
   response that carries them: they go neither through the audit log nor
   through the logs.
2. `POST /api/account/two-factor/activate` verifies a first real code and arms
   the factor.

Without this second stage, a user whose authenticator app is misconfigured would
find themselves locked out at the next sign-in. Disabling the second factor
requires the password there too.

### Resetting someone else's second factor

`DELETE /api/admin/users/:id/two-factor`, permission **`user:reset-2fa`**. It is
distinct from `user:manage`, and the permissions' comment argues why: the
gesture lifts a protection on an account, it is not given together with the
right to change a role.

Exact effect, in a single transaction: the `two_factors` row is deleted,
`users.two_factor_enabled` goes back to `false`, **trusted devices are revoked**
(a trusted device skips 2FA for thirty days — keeping it would make the new
factor useless on the browser that remembered the old one), and **all sessions
are closed**. The request comes when a device was lost or stolen; keeping the
session open on that device alive would empty the operation of its meaning.

An administrator can reset themselves: their own session is then preserved.
They gain no access they did not already have, and they avoid opening an SQL
client. Resetting an account that has no second factor returns a `409`.

The `user.2fa.reset` action also triggers a `security.two_factor_reset`
notification.

### Required second factor

**Settings → Accounts and sessions** (`settings:manage`) sets who must carry
one:

- **no** (the default) — each person enables it, or not, from **My account**;
- **for sensitive permissions** — any role that carries at least one permission
  of `SENSITIVE_PERMISSIONS` (`packages/core/src/permissions.ts`):
  administering accounts and roles, setting up the instance, creating or editing
  a target, driving its workloads, creating an application or deploying it,
  destroying, purging, restoring. The administrator always is; the auditor and
  the viewer, who only read, are not;
- **for every account**.

An account bound to it that does not have it yet **only has access to the screen
that enables it** (`/two-factor-setup`), to which every page sends it back:
each protected route answers `403 two_factor_required` (`permission.denied`,
reason `two_factor_required`), `can()` answers no to everything, chat and
presence are closed to it — and **an API token of that account is worth no
more than the account**. Only the routes of its own account stay open. This
screen lives outside the `(app)` route group, like the setup guide: a redirect
set by the `(app)` layout toward a page it wraps would make Next's client router
loop. Once armed, it can no longer be disabled (`409 two_factor_locked`): a lost
device is handled through the reset above, and the account enables it again at
the next sign-in.

**An account without a password**, which only gets in through single sign-on, is
not bound by it: it could not enable it (Better Auth asks for the password to do
so), and its second factor is the identity provider's business.

The screen says, before saving, which roles the policy would affect and how many
accounts it would keep out. It refuses to require from its author a second
factor they do not have (`409 two_factor_self`): saving would immediately lock
them out of the panel.

### Session length

Same screen: a session closes **after a period without activity** — one hour,
eight hours, one day, seven days (the default) or thirty — and, if you want,
**after an absolute duration**, even when active: one, seven or thirty days,
counted from sign-in.

The first is Better Auth's (`session.expiresIn`), which extends a session in
use; `getAuth()` rebuilds its instance when it changes
(`lib/session-policy.ts`). Shortening it also applies to sessions already open:
their expiry is brought back to "now plus the new duration". The absolute cap is
held by `requireSession()`, which removes the session from the database and
writes `auth.session.expired` (reason `max_age`).

### Sign-in attempts

Better Auth limits requests per address and per path: three sign-ins (or
sign-ups, password or email changes) per ten seconds, three reset requests per
minute, ten reset-token uses per minute (`rateLimit` in `lib/auth.ts`). Beyond
that, `429` and `X-Retry-After`.

The counter lives in **Redis** (`ratelimit:auth:<address>|<path>`, fixed window,
`INCR` and expiry in a single script): several panels behind a load balancer
count together, instead of multiplying the limit by their number. Sessions stay
in the database. If Redis is silent for more than a second, or errors, counting
happens in the process's memory — each panel for itself, never without a limit
— and Redis is only retried after ten seconds, so that no sign-in pays the wait
twice (`lib/auth-rate-limit.ts`).

## RBAC — 38 permissions

`packages/core/src/permissions.ts` is the vocabulary, shared by the panel, the
worker and the seed. A permission is a `resource:action` string.

| Resource | Permissions |
|---|---|
| `user` | `read` `manage` `reset-2fa` |
| `role` | `read` `manage` |
| `target` | `read` `create` `update` `delete` |
| `application` | `read` `create` `update` `delete` |
| `deployment` | `read` `create` `rollback` `restart` `destroy` `purge` |
| `backup` | `read` `manage` `restore` |
| `workload` | `read` `manage` `exec` |
| `scan` | `read` `configure` |
| `job` | `read` `manage` |
| `monitor` | `read` `manage` |
| `maintenance` | `read` `manage` |
| `status_page` | `manage` `announce` |
| `audit` | `read` |
| `settings` | `read` `manage` |

A few distinctions are worth understanding, because they are not cosmetic:

- **`deployment:destroy` vs `deployment:purge`** — destroying removes the
  application from the machine; purging erases the trace in the database. Two
  different gestures.
- **`user:manage` vs `user:reset-2fa`** — managing accounts day to day must not
  give the power to lift someone's second factor.
- **`workload`, not `container`** — on a K3s target they are pods. The Docker
  word has no place in a shared vocabulary.
- **`backup:manage` vs `backup:restore`** — backing up replaces nothing;
  restoring overwrites the data in service. The operator has the first, not the
  second.
- **`maintenance:read` does not give the subjects** — the maintenance screen
  only shows a window's targets and probes that the session can read.
  Conversely, the "in maintenance" mention on a target or a probe follows the
  right to read that subject, not `maintenance:read`. Choosing subjects when
  planning a window also requires being able to read them.
- **`status_page:manage` vs `status_page:announce`** — composing a page decides
  what strangers will see; announcing an outage there is commenting on what it
  already shows. The operator has the second, not the first.

### Roles are data, not code

`SEEDED_ROLES` — `admin`, `operator`, `auditor`, `viewer`, `no-access` — are only
**starting values**. The authority at runtime is the `roles` table, and an
administrator can create other roles from `/admin/roles`. That is why `RoleKey`
is deliberately a `string` and not a fixed union: a union would require
recompiling the panel to create a role.

The screen shows them as a **matrix**: one role per column, one permission
family per row, one dot per permission — filled if the role carries it, a
diamond when it is **sensitive** (those that make a second factor required). The
footer says, role by role, whether the instance requires that second factor
from it. A click on a role opens its drawer, where it is edited.

| Role | Permissions |
|---|---|
| `admin` | all 38 — **locked**, cannot be renamed, emptied or deleted |
| `operator` | deploys and operates: targets (except deletion), applications, deployments, rollback, restart, scans and `scan:configure`, backups without restore, maintenance windows, status page announcements |
| `auditor` | the 13 `:read` permissions — audit log, accounts, roles and settings included |
| `viewer` | the 9 **operations** reads: targets, applications, deployments, backups, workloads, scans, tasks, monitoring, maintenance. Neither `audit:read` (the audit log carries IP addresses and emails), nor `user:read`, nor `role:read`, nor `settings:read` |
| `no-access` | none — the role of a **public sign-up** (`SIGNUP_ROLE`) |

`admin` is the safeguard that prevents locking yourself out of your own panel.
The seed is idempotent and replayed at each start, but **it does not rewrite a
customization** — `verify-roles.sh` checks it explicitly. Migration `0034`
follows the same rule on an existing database: it creates `auditor` and
`no-access` if their key is free, and only narrows `viewer` if it still carries
exactly its original permissions.

A corollary, for any permission added afterwards — `maintenance:read`,
`maintenance:manage`, `status_page:manage` and `status_page:announce` being the
latest: on an **existing** instance, only `admin` gets them automatically. The
other roles get them from the matrix, by an administrator; it is not up to the
code to decide that an operator can silence alerts.

**A public sign-up opens nothing.** It says nothing about who signs up: with
`ALLOW_SIGNUP=true`, giving it the viewer role opened read access to the fleet to
anyone. The account is born `no-access` and the `security.signup_pending` event
warns the administrators. Without any permission, it is not a **team member**
either (`requireTeamMember()`): chat and presence, which require no permission,
answer it `403`, and the real-time stream only carries screen signals to it. A
role given or removed closes the stream at the next session re-read (≈ 100 s).

### A single checkpoint

```ts
const auth = await requirePermission(request, 'deployment:create');
```

→ the context if authorized · `401` without a session · `403` without the
permission · and **an `audit_log` written systematically on refusal**. The
`apiRoute()` wrapper translates these typed errors into HTTP responses; no route
builds a 401/403 by hand. Pages have their counterpart,
`requirePagePermission()`, which redirects to `/forbidden?permission=…` — a
screen that *names* what is missing.

Business safeguards: it is impossible to remove the admin role from the last
active administrator, to disable them, to delete them, or to act on your own
account.

### API tokens

A CI holds no session: it presents an **API token**,
`Authorization: Bearer pup_…`, created from **My account**.
`requirePermission()` accepts it in place of a session; it is still the same
checkpoint, and the same audit.

- **It acts in its author's name, never beyond.** Its permissions are taken
  from the author's at creation (asking for one you do not have is refused, not
  silently reduced), then **intersected on each call** with what the author can
  do today: a removed role reduces it, a disabled account cuts it, a deleted
  account takes it away (`on delete cascade`).
- **It is only kept as a hash.** SHA-256 of the token, nothing else: it carries
  256 bits of randomness, there is nothing to guess, hence nothing to slow down.
  It is shown only once, at creation. Its `pup_` prefix makes it recognizable in
  a repository or a CI log.
- **It opens the API, not the panel.** Pages strip the `Authorization` header
  before reading the session. Routes that only require a session — your
  account, your password, chat, presence, **your tokens** — refuse it
  (`403 token_refused`): a token does not make other tokens.
- **Limited to applications, it fails closed.** It is only accepted by routes
  that declare themselves `applicationScoped` and then check the targeted
  application (`requireApplicationScope()`): deploy, follow a deployment and its
  logs, roll back, read the application, redeploy a version. Any other route
  refuses it, even on its own application. A route that forgot to check cannot
  let it through — it does not accept it. A test
  (`apps/web/test/api-tokens.test.mjs`) freezes the list of these routes and
  checks that each one checks the application.
- **The audit log says which token acted.** `audit_logs.api_token_id` is filled
  from the request context, like the browser: no `logAudit()` call has to think
  about it. The audit log shows "through the token "GitHub CI"". Creating a
  token writes `api_token.created` (its prefix, never the token) and alerts
  through `security.api_token_created`; revoking it writes `api_token.revoked`.
- **Default expiry: 90 days.** 30 days, a year, or no expiry, as you choose. An
  administrator sees all the instance's tokens on **Users** and can revoke one
  (`user:manage`).

A token does not pass the second factor: that is the nature of browserless
access. That is why it is created from a session — which did pass it —, why it
is limited in time by default, and why its creation alerts. And when the
instance requires a second factor from an account that does not have it, its
tokens are refused just like it (`403 two_factor_required`).

## What is public: status pages

The panel is private: without a session, `proxy.ts` sends to sign-in, and each
route requires its permission. A single exception, intended: **published**
status pages, at `/status` and `/status/<address>` (`PUBLIC_PAGES`). What they
expose is bounded by construction:

- **What goes out.** The page is rendered from a model computed on the server
  (`buildStatusPageModel()`, `apps/web/src/lib/status-page.ts`) that only
  carries **chosen labels**, states (operational, degraded, down, in
  maintenance, unknown), rates and dates. Never the probed URL, the error
  message, a machine's name or a maintenance window's title — a public
  maintenance says "in progress until…" and the services it affects, nothing
  more. The component displaying it only receives this model. A single
  exception, intended: the text of **announcements**, written by the team for
  visitors — its phase, its text and its time, never its author. The form
  reminds you of that (no internal address, no machine name), and each
  publication, correction or removal goes to the audit log with the text.
- **What does not exist.** An unpublished page, an unknown address and a deeper
  path all answer **404**, the same response: you do not guess what exists
  behind.
- **What stays closed.** The pages API (`/api/status-pages`) and the editor
  require `status_page:manage`, the announcements one (`/api/status-updates`)
  `status_page:announce`; the public page has no real-time stream —
  `pupitre:realtime` stays reserved to sessions —, it reloads every minute.
- **Search engines.** `noindex, nofollow`: a status page is shared by a link, it
  is not found by a search.

Composing a page is deciding what strangers will see: `status_page:manage` only
goes to `admin` automatically. On the network side, exposing only `/status`
(and `/_next/` for its resources) is enough to serve it.

## What comes from somewhere other than the panel

### A write comes from the panel, or it is refused

The session cookie is `SameSite=Lax`: a browser does not send it with a form
posted from another **site**. But a site is a whole registrable domain —
`blog.example.com` and `pupitre.example.com` are one —, and Pupitre deploys
precisely sites, often on subdomains next to the panel. A booby-trapped page
there, opened by a signed-in administrator, would make them post whatever it
wants: `readJsonBody()` reads a JSON body even when sent as `text/plain`, which
an HTML form can do.

`apiRoute()` therefore refuses, before anything else, a write request
(anything but `GET`, `HEAD`, `OPTIONS`) that a browser would send from elsewhere
(`apps/web/src/lib/same-origin.ts`):

- the `Origin` header must be `BETTER_AUTH_URL`'s — `null` included among the
  refusals;
- without `Origin`, `Sec-Fetch-Site` must be `same-origin`;
- a request that carries neither does not come from a browser (`curl`, a
  script, the worker) and has no cookie to hijack: it goes through.

The refusal is a `403 cross_site_request`, traced
(`request.cross_site.refused`) with the reason. Practical consequence: the panel
must be opened at the `BETTER_AUTH_URL` address, the same one Better Auth already
requires for sign-in.

`Content-Type` is not required on top: every browser sends `Origin` on a write
coming from another site, and a screen call that forgot the JSON header would
break without protecting anything more.

### Protective headers

On every response (`apps/web/next.config.ts`): the panel is displayed in no
iframe (`frame-ancestors 'none'`, `X-Frame-Options: DENY`) — a third-party page
cannot cover it to make someone click unknowingly —, plus `nosniff`,
`Referrer-Policy`, a closed `Permissions-Policy` and HSTS (no effect over HTTP,
without `includeSubDomains`). `X-Powered-By` is no longer sent. The CSP
deliberately stops at these directives: `script-src` would require nonces on
Next's scripts, and `form-action 'self'` would break the creation of the GitHub
App, which posts a real form to github.com.

### The targets' host key

Without host key verification, any machine inserted on the network between the
worker and a target could impersonate it, receive the SSH or sudo password, see
and change the commands. The SSH client (`connect()`,
`packages/core/src/ssh/client.ts`) therefore receives a key policy
(`SshTarget.hostKey`), and the worker always gives it: a single function,
`sshTargetOf()` (`apps/worker/src/deploy/ssh-target.ts`), builds a target's
connection.

- **Trust on first contact**: a target never reached has its key recorded
  (`targets.host_key_fingerprint`, `target.host_key.recorded` in the audit
  log).
- Afterwards, **another key gets the connection refused**, with no retry
  (`SshHostKeyError`): it is not a network incident. The presented key is noted
  as pending (`targets.host_key_pending`), and the audit log says so once per
  key (`target.host_key.mismatch`), which feeds the
  `security.host_key_changed` notification event — not on every refused
  reading.
- **Only a human decides**, on the target's page (`target:update`): accept the
  new key or keep the old one, traced (`target.host_key.accepted` /
  `.dismissed`, with both fingerprints).
- Changing a target's address or port forgets its key: it is another machine.

The test tools (`scripts/test-*.ts`) give no policy: they target throwaway
machines, whose key changes at each re-creation.

### The addresses the worker calls for you

A Nginx Proxy Manager's API, a notification webhook, an S3 storage, a Gitea
forge, a GitLab instance: the worker calls an address entered in the panel.
Monitoring requires a public address; here, it cannot — these destinations
often live on a private network, and that is legitimate. But none of them has a
reason to target a **link-local** address (`169.254.0.0/16`, `fe80::/10`): that
is where clouds serve the machine's metadata, credentials included.
`assertEgressAllowed()` (`packages/core/src/egress.ts`) resolves the name and
refuses any link-local, unspecified or multicast address, before the call.

## Audit log

Written **exclusively** by `logAudit()` (`packages/db/src/audit.ts`), the single
entry point. This function never throws: an unavailable audit degrades
traceability, it does not break the request. The IP is read behind a reverse
proxy (`x-forwarded-for`, first element).

The screen is called **Activity log** (**Logs** in French), at `/admin/logs`
(`audit:read`). It used to be called "Audit", and the RBAC vocabulary kept
`audit:read` — the permission did not follow the screen's renaming, on purpose:
renaming a permission breaks the custom roles in the database.

`logAudit()` also carries the notification layer: a global observer is plugged
into it, and **an event that is not audited cannot be notified**. It is an
accepted constraint, and it is what guarantees that you cannot notify something
that would have left no trace.

### Severity

Each entry carries a severity — `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` — that the
screen colors, filters and counts, that the API returns (`severity`) and that
the export writes on each line. It **is not stored**: it is a reading of the
action, made by a single table (`packages/core/src/audit-severity.ts`) that the
screen applies and that the database translates into `CASE … LIKE` to filter.
Revising the table therefore reclassifies the whole log, past included, and the
trace itself does not change.

| Severity | What it designates | Examples |
|---|---|---|
| `CRITICAL` | to handle now | a target's SSH fingerprint changing, a failed rollback or restore |
| `HIGH` | an outage, a refusal that looks like an attempt, a gesture on access | `monitor.down`, `deployment.failed`, `request.cross_site.refused`, `role.updated`, `user.role.changed`, `api_token.created`, `workload.exec` |
| `MEDIUM` | a change of state or configuration, an ordinary failure or refusal | `settings.updated`, `deployment.created`, `auth.login.failed`, `permission.denied` |
| `LOW` | routine | sign-ins, reads, successes, returns to normal |

The screen's free search (`?q=`) covers the action, the resource, the actor, the
IP and the content of the payloads; its `%` and `_` wildcards are escaped — you
search for what you typed.

## A linked repository does not command the machine

Pushing to a linked repository must not be worth access to the machines. The
`pupitre.json` says **what** to deploy; the targets, the runtime and the moment
stay with the panel, under RBAC. The commit's code is only a build input:

- it is unpacked into the release's `source/`, apart from the control files. At
  the root, a repository's `compose.override.yml` would have been merged by
  Compose — privileged container, machine disk mounted —, a `.env` would have
  renamed the project (a `down -v` aimed at another application), a `k8s/`
  folder would have been applied on the cluster with Pupitre's rights;
- Compose is always called with `-p app-{slug} -f compose.yml`, and the `k8s/`
  folder is emptied before each render;
- a build context does not leave the code sent: no absolute path, no `..` —
  otherwise an image could embed the `.env` files of the machine's other
  applications;
- the built image runs with the hardening of any "home-made" image: read-only
  root, unprivileged user, capabilities dropped.

`pnpm test:source-isolation` checks it on both runtimes with a booby-trapped
repository.

### An uploaded archive

Uploaded code follows the same rules — it ends up in `source/`, by the same path
—, and one more: **the archive sent never goes as is to a machine.** The worker
reads it entry by entry, writing each file itself, and refuses it whole at the
first of these traps:

- an absolute path, or one that climbs up (`..`);
- a symbolic link that points outside the code — including **once the leading
  folder is removed**: in `my-app/`, `link → ../compose.yml` stays in the
  archive but would target the release's control files;
- an entry written through a link of the archive (`cache → …` then
  `cache/trap`);
- a hard link, a device, a named pipe, an encrypted entry;
- two entries at the same path, a file that would serve as a folder;
- more than 50,000 entries, or more than 1 GiB once decompressed — an archive
  that swells stops there, during the read.

Permissions are brought back to `0644` or `0755`: the execute bit survives,
`setuid` and `setgid` do not. Symbolic links are only created once everything
else is written. The returned archive, rebuilt by the worker, is the only one
used afterwards; the bytes received are deleted, refused or not.

The format is read from the bytes (never from the name or the header), the name
is only a label — nothing is written under that name —, the upload is capped at
100 MiB during transfer, and `application:update` is required: uploading code
is changing what will run. The unit tests
(`packages/core/test/source-upload.test.ts`) build these booby-trapped archives
byte by byte; `scripts/verify-source-archive.sh` sends one through the API.

## Encryption

`packages/core/src/crypto.ts` — **AES-256-GCM**, key derived from `MASTER_KEY`
with HKDF-SHA256, format `version:iv:authTag:ciphertext` with the version passed
as **AAD** (no v2 → v1 downgrade). The panel and the worker refuse to start if
`MASTER_KEY` is missing or shorter than 32 bytes.

Ten things are encrypted by the same primitive, each in its column:

| What | Column | Only place it is decrypted |
|---|---|---|
| A target's SSH credential | `targets.encrypted_credential` | the worker, when opening a session |
| An application secret's value | `application_secrets.encrypted_value` | the worker, at render time |
| The AI API key | `app_settings.ai_api_key_encrypted` | the panel, when calling the provider |
| The single sign-on client secret | `app_settings.sso_client_secret_encrypted` | the panel, when talking to the identity provider |
| A notification channel's secrets | `notification_channels.encrypted_secrets` | the worker, when sending |
| A probe's webhook URL | `monitors.webhook_url_encrypted` | the worker, when alerting |
| The GitHub App's private key | `source_connections.private_key_encrypted` | the panel and the worker, when calling the GitHub API |
| The access token of the Gitea / Forgejo forge, or of the GitLab instance | `source_connections.token_encrypted` | the panel and the worker, when calling the forge's API |
| A backup destination's keys | `backup_destinations.encrypted_secrets` | the worker, when opening the destination |
| A remote proxy's password (Nginx Proxy Manager) | `proxies.encrypted_secrets` | the worker, when calling its API |

**Backup files** are encrypted too, but as a stream and under a separate key for
each file: HKDF of `MASTER_KEY` with a random salt, AES-256-GCM, authenticated
header — see
[`architecture.md`](architecture.md#backups-one-place-one-format-two-runtimes).
A compromised destination only yields unreadable bytes; a modified backup is
refused, never restored.

**The credential never leaves the panel**: `getTarget()` and `listTargets()` do
not select the column, so the HTTP response cannot contain it, even if someone
forgets to filter. It is a structural guarantee, not a `delete` at the end of a
handler.

The AI API key is **outside the settings JSONB**, and that is what allows
serializing the whole JSONB into a response or an audit entry without risk. On
read, the API only returns `aiApiKeyConfigured: boolean` and
`aiApiKeyLast4: string | null`.

**Error messages are redacted.** Not only of the exact value: also of
recognizable shapes — `sk-`/`pk-`/`xai-`/`gsk-…`, a Telegram bot token
(`\d{6,12}:[A-Za-z0-9_-]{20,}`), the tail of a Discord webhook URL, a
`Bearer …`. Reason: OpenAI literally returns `Incorrect API key provided:
sk-senti***…***0000`, so the provider itself leaks a fragment of the key.

If `MASTER_KEY` changes, decryption fails silently on display (the key stays
"configured", its `last4` becomes `null`) and explicitly on use. The list does
not break.

### A valid key is not a serious key

The startup guard only checks a **length**. Sixty-four zeros make thirty-two
bytes just like a real key — and it is precisely the value `.env.example` ships.
An instance set up by copying the example starts, encrypts, decrypts, and passes
every test: the defect is invisible by construction, whereas it makes **the SSH
credentials of every target** readable by anyone holding a database backup.

`masterKeyWeakness()` therefore recognizes guessable keys by their **shape** —
one or two distinct characters, or a short repeated pattern — and both the panel
and the worker write it to their logs at startup. No randomly drawn key falls
into this net; it is checked in `packages/core/test/crypto.test.ts`.

The panel judges `BETTER_AUTH_SECRET` the same way (`secretWeakness()`), for
which `.env.example` ships a repeated phrase. Better Auth uses it to sign its
cookies, and to encrypt each account's TOTP secret and backup codes: changing it
signs everyone out and makes an already armed second factor unreadable, which
then has to be reset. There again, we warn.

They **warn** without refusing to start, on purpose: the database already
contains values encrypted under this key, and an instance that no longer starts
is an instance from which you can no longer extract the credentials to
re-encrypt them. Rotation stays the operator's decision, and it is done in this
order:

```bash
openssl rand -hex 32          # the new key
```

1. Write down, **with the old key still in place**, everything that is encrypted
   — the ten columns of the table above.
2. Replace `MASTER_KEY` in `.env`, then restart panel and worker.
3. Enter each value again through the API or the screen that carries it.
   Nothing re-encrypts by itself: the old values become unreadable, not
   invalid.

Swapping 1 and 2 loses the credentials with no recourse — that is the very
guarantee of encryption. And backups made under the old key can only be read
with it: keep it as long as they matter, or make new ones under the new key.

## Application secret store

The problem: a versioned `compose.yml` cannot carry a password, and nobody wants
to type by hand the password of a PostgreSQL that will only exist at the first
deployment.

**The AppSpec only carries names, never values.** A service declares
`secrets: ["POSTGRES_PASSWORD"]`, and that is all. The panel generates the
value, encrypts it, attaches it to the **application** — not to the deployment —
and reuses it as is at each redeployment.

```ts
const secretAliasSchema = z.object({
  name: envNameSchema,
  from: envNameSchema,   // name of the secret whose value is reused
});
const secretDeclarationSchema = z.union([envNameSchema, secretAliasSchema]);
```

Generated value: 24 random bytes in base64url, that is 32 characters over
`A-Za-z0-9-_`. The alphabet is chosen to go through a `.env` file, a command
line, a Kubernetes `stringData` and a `postgres://` URL without escaping.

An **entered** secret (`origin: provided`) is possible for what comes from
outside — a third-party API token. An **empty** value is accepted; an **absent**
value is not, and fails the render with a message naming the missing secret. The
two cases are distinct and the code tests the presence of the key, not its
truthiness.

### Aliases, or two images that want the same password

`mariadb:11` reads `MARIADB_PASSWORD`. `wordpress` reads
`WORDPRESS_DB_PASSWORD`. It is the same password. Without a dedicated mechanism,
the store drew a random value *per name* — two different passwords, guaranteed
outage.

```json
{ "name": "WORDPRESS_DB_PASSWORD", "from": "MARIADB_PASSWORD" }
```

The alias **creates no row in the database**: only roots are stored, and
resolution happens in neutral code (`packages/core/src/drivers/secrets.ts`),
**before** rendering. It has to: Compose can interpolate `${…}` from a `.env`,
Kubernetes cannot — resolving in the drivers would have given two
implementations.

Two validations, at application creation and not at deployment:

- a `from` that designates no declared secret → `422`, naming it;
- an alias cycle → `422`, with the path (`A → B → A`).

Plus the common-sense cases: an alias to itself, two contradictory aliases for
the same name, a name declared bare here and aliased elsewhere.

### Where the values arrive

| Runtime | How |
|---|---|
| Docker | a `.env` file placed with mode **0600** next to `compose.yml`, and `env_file: ['./.env']` on the service. **Never** in `compose.yml`, never interpolated |
| K3s | one Kubernetes `Secret` per service, `${service}-secrets`, as `stringData`, mounted through `envFrom.secretRef`. Manifest written with mode 0600, applied before the Deployments |

The map delivered is **identical on both sides**, aliases resolved included —
`verify-secrets.sh` proves it by comparing the SHA-256 hashes of both maps.

### What the API returns, and what it does not

`GET /api/applications/:id/secrets` (`application:read`) returns `name`,
`origin`, `isSet`, `declared`, `services`, `aliasOf`, `readAs`, `updatedAt`.
**Never the value** — the encrypted column is not even selected.
`PUT /api/applications/:id/secrets/:name` (`application:update`) sets a value or
regenerates one; setting a value on an alias returns a `409` that points to the
root.

There is **no way to read a secret back**, neither through the API nor in the
UI. You can replace it, not consult it. There is no `secret:*` permission either:
the RBAC vocabulary is closed, and reading an application's secrets is reading
the application.

A secret removed from the AppSpec is **never** deleted automatically. A
PostgreSQL volume outlives its deployment and carries the password of its first
start: deleting the row would make the database inaccessible.

## Security scanners

**One interface, three implementations, one factory** — the same rule as for
drivers. Adding a fourth tool means adding a class and an entry in
`getScanner()`.

```ts
interface Scanner {
  readonly key: 'trivy' | 'grype' | 'syft'
  readonly kind: 'vulnerability' | 'sbom'
  ensureInstalled(session): Promise<string>
  run(ctx, onLog): Promise<ScanReport>
}
```

| Tool | `kind` | Command | Pinned version |
|---|---|---|---|
| `TrivyScanner` | `vulnerability` | `trivy image --format json --scanners vuln` | 0.74.0 |
| `GrypeScanner` | `vulnerability` | `grype <image> -o json` | 0.118.0 |
| `SyftSBOM` | `sbom` | `syft scan <image> -o cyclonedx-json` | 1.51.1 |

Versions are **pinned**: a scanner changing version underfoot would make two
deployments incomparable.

**Scanners run on the target machine, over SSH**, like the drivers, and on the
local image. No registry, no image pulled back, no client embedded in the panel.
`ensureInstalled()` detects the binary through its `--version` and only
downloads it if it is missing or outdated; the architecture comes from
`uname -m`. Binaries and caches live in `~/.bootstrap-tp` on the target — this
name is a legacy of the project's first version, and it is frozen in
`packages/core/src/scanners/install.ts`: changing it would leave orphan caches on
every existing target. Ten minutes maximum per scanner. **The first scan on a
new target downloads the vulnerability databases: count a few minutes, once.**

### Where to read the image: the driver says it

A built image exists in no registry: a scanner has to read it where the runtime
stored it. It is not up to the scanner to guess the runtime — that would be one
more `if (runtime === …)`. The driver **declares** it
(`DeploymentDriver.imageStore()`), the worker passes it on without reading it
(`ScanContext.store`), and each scanner translates it:

| Store | Declared by | Trivy | Grype, Syft |
|---|---|---|---|
| `docker` | `DockerComposeDriver` | default detection | default detection |
| `containerd` (`/run/k3s/containerd/containerd.sock`, `k8s.io` namespace, root only) | `K3sDriver` | `CONTAINERD_*`, `--image-src containerd,remote`, full name (`docker.io/…`) | `CONTAINERD_*`, `--from containerd --from registry`, `--platform linux/<arch>` |

On containerd, the built image is read on the machine, and a public image never
pulled yet is read from its registry. Since k3s's socket is reserved to root,
the tool runs under `sudo` (the target's elevation method), **without leaving
the user's `~/.bootstrap-tp`**: the original `HOME` is restored, and the cache
handed back to the user at the end (`asToolOwner()` in `scanners/run.ts`). Before
that, none of the three found an image built on K3s: the step returned
"unknown", without blocking or warning.

### Normalization is the key point

Trivy and Grype describe the same CVE with two vocabularies. Each one maps its
own onto a common scale (`CRITICAL HIGH MEDIUM LOW UNKNOWN`), in its own class,
and nothing downstream knows anymore who spoke:

| | Trivy | Grype | `Finding` |
|---|---|---|---|
| identifier | `VulnerabilityID` | `vulnerability.id` | `cveId` |
| severity | `Severity` | `vulnerability.severity` (`Negligible` → `LOW`) | `severity` |
| package | `PkgName` | `artifact.name` | `package` |
| version | `InstalledVersion` | `artifact.version` | `installedVersion` |
| fix | `FixedVersion` | `fix.versions[0]` | `fixedVersion` |
| advisory | `PrimaryURL` | `dataSource` | `primaryUrl` |

`verify-scanners.sh` compares both outputs **CVE by CVE, package by package,
severity by severity** on a real image. It is the real test of normalization:
two scanners describing the same vulnerability must produce the same `Finding`.

### The blocking policy lives in the settings

It left the deployment screen: *a security policy chosen case by case,
deployment by deployment, is not a policy.* It now lives in
`/admin/settings/securite` (`settings:manage`):

| Field | Effect |
|---|---|
| `scanningEnabled` | main switch — at `false`, no more scans, on any deployment |
| `disabledScanners` | scanners set aside one by one, even when scanning stays on |
| `failOn` | `CRITICAL` · `HIGH` · `NONE` — **default `NONE`** |
| `onlyFixable` | the threshold only applies to **fixable** vulnerabilities (the scanner knows a version that fixes them) — default `false` |

The `NONE` default surprises and it is deliberate. `nginx:1.29-alpine` carries
26 CRITICAL findings, `httpd:2.4-alpine` carries 40. A blocking threshold by
default therefore refuses every public image from the first release, the
operator turns off scanning entirely to move on — and ends up with no scan at
all. **Inform by default, block by decision.**

The API can still provide an explicit `scanConfig` (which requires
`scan:configure`), but the instance policy can only **restrict**:
`applySecuritySettings()` filters out the disabled scanners and forces
`scanners: []`, `failOn: 'NONE'` if the switch is off. A deployment can never
turn a disabled scanner back on. The `disabledBy: 'settings'` field tells
"nobody asked for a scan" from "the instance disabled scanning", and the initial
intention stays recorded in the audit log.

The policy is **frozen on the deployment** at enqueue time: the `scan_config` in
the database describes what will really run, never what was asked for. Accepted
consequence: turning scanning back on does not act retroactively on what is
already queued. A redeployment replays the source version's policy, then applies
the instance's to it again — *disabled scanning must not come back through the
door of a redeployment.*

### An application's setting, and accepted vulnerabilities

An instance threshold fits public images badly: most of their CRITICAL ones have
**no fix**, and blocking on them stops the release without offering anything to
do. Three tools, under `scan:configure`:

- **Only fixable ones** (`onlyFixable`) — for the instance or an application: a
  vulnerability without `fixedVersion` no longer counts for the threshold. It
  stays displayed.
- **An application's setting** (`applications.scan_fail_on`,
  `scan_only_fixable`, **Security** tab of its record,
  `PUT /api/applications/:id/scan-policy`) — its threshold and its fixable rule,
  `null` to follow the instance. It applies to the following deployments,
  **redeployments included**: it is the application that knows what should block
  it, not the version. An explicit API request keeps the upper hand.
- **Accepting a vulnerability** (`vulnerability_acceptances` table, from a
  deployment's **Security** tab) — one CVE, on one package or all, for one
  application, with a mandatory **reason** and an expiry (30, 90, 180 days or
  none). It stays displayed, marked "accepted", but no longer blocks.
  Acceptances apply **at scan time** — they belong to the application, not to
  the frozen version. Accepting goes to the audit log with **high** severity
  (`vulnerability.accepted`, with the reason): it is a deliberate bypass.

The rule is a single function, `findingBlocks()` in
`packages/core/src/scan.ts`: severity above the threshold, fixable if the policy
requires it, not accepted. Each run keeps `fail_on` and `only_fixable`, which
explain its verdict; the screen counts, per run, the fixable vulnerabilities and
those accepted today.

### The verdict

The `scan` step sits between `build` and `deploy`. It runs the selected scanners
**in parallel** (`Promise.allSettled`): a tool that crashes is marked as
errored — `unknown` verdict, neither blocking nor clearing — and does not prevent
the others from concluding.

If a `kind: vulnerability` scanner reports at least one finding of severity
`>= failOn` — fixable if `onlyFixable`, and not accepted —, the step turns
`failed`, the pipeline stops and **the deployment does not happen**. With
`failOn: NONE`, the verdict is informative and findings are recorded anyway.
Without a selected scanner, the step is `skipped`. **An SBOM never blocks**: it
is its `kind` that says so, not its name.

Verdict and findings go through `logAudit()` — `deployment.scan.blocked` or
`deployment.scan.passed`, with the scanners, the threshold, the counts per
severity and the CVEs responsible.

**No `if (scanner === 'trivy')` outside the implementations.** What stays shared
is a data table, `SCANNERS` in `packages/core/src/scan.ts`: label, `kind`, SBOM
format. The UI reads its labels from it, the SBOM route reads its MIME type from
it.

The SBOM has no dedicated column: it *is* the raw output of the tool that
produces it, so it lives in `scan_runs.raw`. An extra column would duplicate it
byte for byte, and you would have to decide which one is authoritative.

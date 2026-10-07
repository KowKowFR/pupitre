# REST API

Everything the screens do goes through a REST API, and a script, a CI or an AI agent can use it too, with an API token tied to your account. This chapter covers authentication, the conventions, the errors, worked examples, and the reference of every route.

## Overview

- **Base address**: `{{origin}}/api` — the panel's own address, `BETTER_AUTH_URL`.
- **JSON** in and out; identifiers are UUIDs.
- **Authentication**: `Authorization: Bearer pup_…`, an API token created from [My account](/account).
- **Long operations answer `202 Accepted`** at once, and run in the background — follow them afterwards.
- **Errors** carry a stable `code` and a `message` in the instance's language.
- **Permissions** are those of the token, cut down every time to what its author can still do.

## Authenticate with a token

### Create a token

[My account](/account) → **API tokens** → **New token**:

1. a **name** saying what it is for — the activity log will show it ("GitHub CI — shop", "Claude agent");
2. an **expiry**: 30 days, 90 days (the default), a year, or none;
3. **what it can do**, among your own permissions;
4. **on which applications**: all, or only some;
5. **Create the token**, then copy it: it is shown **only once**. The database only keeps a fingerprint.

Store it as a secret — `PUPITRE_TOKEN` in a CI, an environment variable on a workstation —, never in a repository.

### Choose what it can do

| Choice | Permissions | For |
|---|---|---|
| Deploy | `deployment:create`, `deployment:read`, `deployment:rollback`, `application:read`, `application:update` | a CI that deploys an image and follows it |
| Read | every `:read` permission you hold | a dashboard, an export, a read-only agent |
| Everything I can do | all your permissions | an AI agent through MCP, an automation script |
| Custom | ticked one by one | anything else |

A permission you do not hold cannot be given: the creation is refused, not silently reduced. Afterwards, the token never does more than you **today**: a role you lose takes from it what it takes from you, and a disabled account disables it.

### Limit it to applications

A token limited to some applications is only accepted by the routes that check the targeted application — read the application, deploy it, follow its deployments and their logs, roll back, redeploy a version, upload its code. Every other route refuses it (`403 token_scope`), even about its own application. A token that leaks into a CI log can then do nothing elsewhere.

### What a token cannot do

- open the interface: it opens the API only;
- manage tokens, your account, your password, the chat: those routes answer `403 token_refused`;
- pass a second factor the instance requires and your account does not have: `403 two_factor_required`.

Revoke a token at any moment from **My account**; an administrator sees every token of the instance on **Users**.

## Check who you are

```bash
export PUPITRE_URL={{origin}}
export PUPITRE_TOKEN=pup_…

curl -s "$PUPITRE_URL/api/me" -H "Authorization: Bearer $PUPITRE_TOKEN"
```

```json
{
  "user": { "id": "4b0c…", "email": "ops@example.com", "name": "Ops", "image": null },
  "roles": ["operator"],
  "permissions": ["application:read", "deployment:create", "deployment:read"],
  "twoFactor": { "enabled": true, "required": false, "mustEnroll": false },
  "token": { "id": "9e1f…", "name": "GitHub CI — shop", "applicationIds": ["2d7a…"] }
}
```

`permissions` is what the token really has now; `applicationIds` is `null` for a token valid on every application.

## Conventions

- **Accepted, then followed.** A deployment, a preflight, a backup, a restore answers `202` with an identifier; poll the resource (`GET /api/deployments/{id}`) or read its log.
- **Live streams.** A few routes stream Server-Sent Events — a deployment's log, an application's logs. A script reads the exported form instead (`/logs/export`).
- **Pagination.** Lists that can grow take `page` and `pageSize` and answer `{ items, total, page, pageSize }`.
- **Partial updates.** A `PATCH` only changes the fields it names; a field absent is kept.
- **Secrets never come back.** No response carries a secret value, an SSH key or a token — only whether it is set.
- **Language.** `error.message` follows the instance's language; `error.code` never changes — test the code.
- **Origin.** A write a browser sends from another site is refused (`403 cross_site_request`); `curl`, scripts and agents send no `Origin` and are not concerned.

## Errors

Every error has the same shape:

```json
{ "error": { "code": "forbidden", "message": "Permission “deployment:create” required", "details": { "permission": "deployment:create" } } }
```

| Status | Code | Meaning |
|---|---|---|
| 400 | `invalid_json` | the body is not JSON |
| 401 | `unauthenticated` | no session and no token |
| 401 | `token_invalid`, `token_revoked`, `token_expired` | the token is unknown, revoked or expired: make another one |
| 403 | `forbidden` | the permission named in `details` is missing |
| 403 | `token_scope` | a token limited to applications, on a route that does not accept it |
| 403 | `token_refused` | a route done from the panel only |
| 403 | `two_factor_required` | the instance requires a second factor the account does not have |
| 403 | `cross_site_request` | a browser write from another site |
| 404 | `not_found` | the resource does not exist, or the route is unknown |
| 409 | `conflict` and others | the state forbids it — a deployment in progress, a domain already taken, a name in use |
| 422 | `validation_failed` | the body does not match the schema — `details` says which fields |
| 422 | `invalid_appspec` | an AppSpec refused — `details.issues` lists every problem with its path |
| 429 | `rate_limited` | too many requests: wait the given seconds |
| 501 | `not_implemented` | a feature not set up, such as the AI without a provider |

## Examples

### Find the identifiers

```bash
curl -s "$PUPITRE_URL/api/targets" -H "Authorization: Bearer $PUPITRE_TOKEN" \
  | jq -r '.items[] | "\(.id)  \(.name)  \(.status)"'

curl -s "$PUPITRE_URL/api/applications" -H "Authorization: Bearer $PUPITRE_TOKEN" \
  | jq -r '.items[] | "\(.id)  \(.slug)"'
```

### Create an application, then deploy it

```bash
APP_ID=$(jq -n --slurpfile spec pupitre.json '{appSpec: $spec[0]}' \
  | curl -s --fail-with-body -X POST "$PUPITRE_URL/api/applications" \
      -H "Authorization: Bearer $PUPITRE_TOKEN" -H "Content-Type: application/json" --data @- \
  | jq -r .id)

DEPLOYMENT_ID=$(curl -s --fail-with-body -X POST "$PUPITRE_URL/api/deployments" \
  -H "Authorization: Bearer $PUPITRE_TOKEN" -H "Content-Type: application/json" \
  -d '{"applicationId":"'"$APP_ID"'","targetId":"'"$TARGET_ID"'","runtime":"docker"}' \
  | jq -r .id)
```

### Follow a deployment to its end

```bash
while :; do
  STATUS=$(curl -s "$PUPITRE_URL/api/deployments/$DEPLOYMENT_ID" \
    -H "Authorization: Bearer $PUPITRE_TOKEN" | jq -r .status)
  case "$STATUS" in
    pending|running) sleep 5 ;;
    success) echo "deployed"; break ;;
    *) echo "deployment ended: $STATUS"
       curl -s "$PUPITRE_URL/api/deployments/$DEPLOYMENT_ID/logs/export?format=text" \
         -H "Authorization: Bearer $PUPITRE_TOKEN" | tail -40
       exit 1 ;;
  esac
done
```

### Change an image and deploy

```bash
curl -s --fail-with-body -X POST "$PUPITRE_URL/api/deployments" \
  -H "Authorization: Bearer $PUPITRE_TOKEN" -H "Content-Type: application/json" \
  -d '{"applicationId":"'"$APP_ID"'","targetId":"'"$TARGET_ID"'","runtime":"docker",
       "images":{"web":"ghcr.io/acme/shop:'"$GIT_SHA"'"}}'
```

### Put a target in maintenance

```bash
curl -s --fail-with-body -X POST "$PUPITRE_URL/api/maintenance-windows" \
  -H "Authorization: Bearer $PUPITRE_TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Kernel upgrade","startsAt":"2026-10-08T22:00:00Z","endsAt":"2026-10-08T23:00:00Z",
       "targetIds":["'"$TARGET_ID"'"],"monitorIds":[]}'
```

### Read the activity log

```bash
curl -s "$PUPITRE_URL/api/audit-logs?action=deployment.failed&pageSize=20" \
  -H "Authorization: Bearer $PUPITRE_TOKEN" | jq '.items[] | {createdAt, resourceId, after}'
```

## Route reference

ⓐ marks the routes that also accept a token limited to applications. "Any caller" means a session or a token, without a particular permission.

### Identity, AppSpec and agents

| Method | Path | Permission | What it does |
|---|---|---|---|
| GET | `/api/me` | any caller | who calls, their roles and permissions, the token |
| GET | `/api/appspec/schema` | any caller | the AppSpec's JSON Schema |
| POST | `/api/appspec/validate` | any caller | validates an AppSpec — the body — without creating anything |
| POST | `/api/mcp` | an API token | the MCP server — see [MCP](/docs/mcp) |
| GET | `/api/health` | public | `{ status, db, redis, ai }`, 200 or 503 |

### Targets

| Method | Path | Permission | What it does |
|---|---|---|---|
| GET, POST | `/api/targets` | `target:read`, `target:create` | list; declare — the credential is encrypted at once |
| GET, PATCH, DELETE | `/api/targets/{id}` | `target:read`, `target:update`, `target:delete` | read, change, delete — 409 while deployments remain |
| POST | `/api/targets/{id}/preflight` | `target:update` | checks the machine again, `202` |
| POST | `/api/targets/{id}/host-key` | `target:update` | `{ "decision": "accept" }` or `"dismiss"` an unexpected host key |
| GET | `/api/targets/{id}/metrics` | `target:read` | a reading now; `/metrics/history` the last days |
| GET | `/api/targets/{id}/ports` | `target:read` | the range, the allocated ports and by whom |
| GET | `/api/targets/{id}/dns` | `target:read` | `?hostname=` — does the name point to this machine? |
| GET | `/api/targets/{id}/workloads` | `workload:read` | everything running on the machine |
| POST | `/api/targets/{id}/workloads/{ref}/control` | `workload:manage` | `{ "action": "start" }`, `"stop"` or `"restart"` |
| POST | `/api/targets/{id}/workloads/{ref}/update` | `workload:manage` | pulls the image again and recreates |
| DELETE | `/api/targets/{id}/workloads/{ref}` | `workload:manage` | removes a workload Pupitre did not deploy |
| POST | `/api/targets/{id}/workloads/{ref}/exec` | `workload:exec` | one console command; the output comes on the stream |
| GET, PUT, DELETE | `/api/supervision/thresholds` | `target:read`, `target:update` | the alert thresholds, per machine or for all |

### Reverse proxies

| Method | Path | Permission | What it does |
|---|---|---|---|
| GET, PUT, DELETE | `/api/targets/{id}/proxy` | `target:read`, `target:update` | the machine's proxy; link a found one; remove (`?uninstall=1`) |
| POST | `/api/targets/{id}/proxy/detect` | `target:update` | what the machine carries, what it can install |
| POST | `/api/targets/{id}/proxy/install` | `target:update` | `{ kind, option, acme }`, `202` |
| POST | `/api/targets/{id}/proxy/check` | `target:update` | **Test** |
| PUT, DELETE | `/api/targets/{id}/proxy/link` | `target:update` | go through another machine's proxy: `{ proxyId, address }` |
| POST | `/api/targets/{id}/proxy/link/check` | `target:update` | **Test the link** |
| GET, POST | `/api/proxies` | `target:read`, `target:update` | remote proxies (Nginx Proxy Manager); connect one |
| PATCH, DELETE | `/api/proxies/{id}` | `target:update` | change, remove |
| POST | `/api/proxies/{id}/check` | `target:update` | **Test** a remote proxy |

### Applications

| Method | Path | Permission | What it does |
|---|---|---|---|
| GET, POST | `/api/applications` | `application:read`, `application:create` | list; create from `{ appSpec, description?, secrets? }` |
| GET, PATCH, DELETE | `/api/applications/{id}` | `application:read` ⓐ, `application:update`, `application:delete` | read, change, delete — 409 while it runs |
| GET, POST | `/api/applications/{id}/cascade` | `application:delete`; the union of destroy, purge and delete | preview; destroy everything then delete |
| POST | `/api/applications/generate` | `application:create` | an AppSpec drafted by the AI from `{ prompt }` — nothing saved |
| POST | `/api/applications/import-compose` | `application:create` | an AppSpec proposed from a `docker-compose.yml` |
| POST | `/api/catalog/{id}` | `application:create` | install a catalog template |
| GET | `/api/applications/{id}/versions` | `application:read` | the versions, each replayable |
| GET | `/api/applications/{id}/secrets` | `application:read` | names and state — never a value |
| PUT, DELETE | `/api/applications/{id}/secrets/{name}` | `application:update` | `{ "value" }` or `{ "generate": true }`; delete |
| GET, PUT | `/api/applications/{id}/routes` | `application:read`, `deployment:create` | the domains per target; replace them |
| GET | `/api/applications/{id}/images` | `application:read` | image updates found; `POST …/images/check` checks now |
| POST | `/api/applications/{id}/redeploy` | `deployment:create` ⓐ | replay `{ versionId, targetId }` |

### Code and repositories

| Method | Path | Permission | What it does |
|---|---|---|---|
| GET, POST | `/api/applications/{id}/archives` | `application:read` ⓐ, `application:update` ⓐ | the archives; upload one — the body is the archive |
| GET, DELETE | `/api/applications/{id}/archives/{archiveId}` | `application:read` ⓐ, `application:update` ⓐ | its state and report; delete |
| POST | `/api/applications/from-source` | `application:create` | create from a repository's `pupitre.json` |
| GET, POST | `/api/applications/{id}/sources` | `application:read`, `application:update` | the linked branches; link one |
| PATCH, DELETE | `/api/applications/{id}/sources/{sourceId}` | `application:update` | change, unlink |
| POST | `/api/applications/{id}/sources/{sourceId}/deploy` | `deployment:create` | deploy a commit now |
| POST | `/api/source-proposals/{id}/approve` | `deployment:create` | deploy a commit waiting for approval; `/dismiss` leaves it |
| GET | `/api/integrations/repositories` | `application:update` | the repositories every forge offers |
| GET, PUT, DELETE | `/api/integrations/gitlab`, `/api/integrations/gitea` | `settings:read`, `settings:manage` | the forge's connection |
| GET, POST, DELETE | `/api/integrations/github` | `settings:read`, `settings:manage` | the GitHub App |

### Deployments

| Method | Path | Permission | What it does |
|---|---|---|---|
| GET, POST | `/api/deployments` | `deployment:read`, `deployment:create` ⓐ | list with filters; deploy, `202` |
| GET, DELETE | `/api/deployments/{id}` | `deployment:read` ⓐ, `deployment:destroy` | status and steps; destroy on the machine |
| POST | `/api/deployments/{id}/rollback` | `deployment:rollback` ⓐ | put the previous version back |
| GET | `/api/deployments/{id}/logs` | `deployment:read` ⓐ | the log, live (SSE) |
| GET | `/api/deployments/{id}/logs/export` | `deployment:read` | the log, `?format=text` or `jsonl` |
| GET | `/api/deployments/{id}/scans` | `scan:read` | the scans of the run |
| DELETE | `/api/deployments/{id}/purge` | `deployment:purge` | erase the run from the database |
| POST | `/api/deployments/purge` | `deployment:purge` | purge in bulk, `dryRun` included |
| GET | `/api/deployments/stuck` | `deployment:read` | runs believed in progress with nothing behind |
| POST | `/api/deployments/{id}/unblock` | `deployment:purge` | mark such a run failed |

### Running applications and domains

| Method | Path | Permission | What it does |
|---|---|---|---|
| GET | `/api/apps` | `deployment:read` | what is in service, machine by machine |
| GET | `/api/apps/{id}/state` | `deployment:read` | a running application's services and health |
| POST | `/api/apps/{id}/restart`, `/stop`, `/start` | `deployment:restart` | restart, stop, start again |
| GET | `/api/apps/{id}/logs` | `deployment:read` | live logs (SSE) |
| GET | `/api/domains` | `application:read` | every domain, its proxy, its state, its certificate |
| GET | `/api/domains/{id}/inspect` | `application:read` | DNS, registration, zone and certificate, read now |

### Security

| Method | Path | Permission | What it does |
|---|---|---|---|
| GET | `/api/scans/{id}` | `scan:read` | a scan's findings, with filters |
| GET | `/api/scans/{id}/sbom` | `scan:read` | the SBOM |
| GET | `/api/findings` | `scan:read` | vulnerabilities across deployments |
| GET, PUT | `/api/applications/{id}/scan-policy` | `scan:read`, `scan:configure` | the application's threshold and fixable rule |
| GET, POST | `/api/applications/{id}/vulnerability-acceptances` | `scan:read`, `scan:configure` | accepted vulnerabilities; accept one |
| DELETE | `/api/applications/{id}/vulnerability-acceptances/{acceptanceId}` | `scan:configure` | withdraw an acceptance |

### Monitoring, maintenance and status pages

| Method | Path | Permission | What it does |
|---|---|---|---|
| GET, POST | `/api/monitors` | `monitor:read`, `monitor:manage` | probes; create one |
| GET, PATCH, DELETE | `/api/monitors/{id}` | `monitor:read`, `monitor:manage` | read, change, delete |
| POST | `/api/monitors/{id}/check` | `monitor:manage` | probe now |
| GET, POST | `/api/maintenance-windows` | `maintenance:read`, `maintenance:manage` | windows; schedule one |
| GET, PATCH, DELETE | `/api/maintenance-windows/{id}` | `maintenance:read`, `maintenance:manage` | read, change or end (`endsAt`), delete |
| GET, POST | `/api/status-pages` | `status_page:manage` | status pages; create one |
| GET, PATCH, DELETE | `/api/status-pages/{id}` | `status_page:manage` | read, change, delete |
| GET, POST | `/api/status-updates` | `status_page:announce` | announcements; publish one |
| PATCH, DELETE | `/api/status-updates/{id}` | `status_page:announce` | correct, remove |

### Jobs and backups

| Method | Path | Permission | What it does |
|---|---|---|---|
| GET, POST | `/api/jobs` | `job:read`, `job:manage` | scheduled tasks; create one |
| GET, PATCH, DELETE | `/api/jobs/{id}` | `job:read`, `job:manage` | read, change, delete |
| POST | `/api/jobs/{id}/run` | `job:manage` | an occurrence now, `202` |
| GET | `/api/queue/jobs/{id}` | `job:read` | the state of a job in the queue |
| GET, POST | `/api/applications/{id}/backups` | `backup:read`, `backup:manage` | an application's backups; back up now `{ targetId }` |
| PUT | `/api/applications/{id}/backup-policy` | `backup:manage` | automatic, before deployment, mode, retention |
| POST | `/api/backups/{id}/restore` | `backup:restore` | `{ targetId, safetyBackup }`, `202` |
| DELETE | `/api/backups/{id}` | `backup:manage` | delete a backup |
| GET, PUT, DELETE | `/api/backups/destination` | `settings:read`, `settings:manage` | the destination — secrets never returned |
| GET, POST | `/api/backups/panel` | `settings:read`, `settings:manage` | the panel's backups; back up now |

### Users, roles, settings and activity log

| Method | Path | Permission | What it does |
|---|---|---|---|
| GET, POST | `/api/admin/users` | `user:read`, `user:manage` | accounts; create one |
| GET, DELETE | `/api/admin/users/{id}` | `user:read`, `user:manage` | read, delete |
| PATCH | `/api/admin/users/{id}/role`, `/status` | `user:manage` | change the role; disable or enable |
| POST, DELETE | `/api/admin/users/{id}/invitation` | `user:manage` | send or cancel an invitation |
| DELETE | `/api/admin/users/{id}/two-factor` | `user:reset-2fa` | reset someone's second factor |
| GET, POST | `/api/admin/roles` | `role:read`, `role:manage` | roles; create one |
| GET, PATCH, DELETE | `/api/admin/roles/{key}` | `role:read`, `role:manage` | read, change, delete |
| GET, PATCH | `/api/settings` | `settings:read`, `settings:manage` | every settings section, in one route |
| GET, POST | `/api/notifications/channels` | `settings:read`, `settings:manage` | channels; create one |
| GET, PATCH, DELETE | `/api/notifications/channels/{id}` | `settings:read`, `settings:manage` | read, change, delete; `POST …/test` sends a test |
| GET | `/api/audit-logs` | `audit:read` | the activity log, with filters |
| GET | `/api/audit-logs/export` | `audit:read` | the activity log as JSONL |

### From the panel only

These routes require a browser session and refuse a token (`403 token_refused`): `/api/account/*` (password, second factor, sessions, picture), `/api/tokens` and `/api/admin/tokens`, `/api/chat/*`, `/api/presence`, `/api/realtime`, `/api/search`, `/api/forecasts`, `/api/onboarding`, and the single sign-on test.

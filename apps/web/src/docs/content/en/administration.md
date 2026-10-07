# Administration

Accounts, roles and permissions, single sign-on, the second factor, the activity log, the instance settings and the master key. Most of this chapter requires an administrator's permissions.

## Users

**Users** (`user:manage`, reading `user:read`):

- **Create** an account, or **invite** someone — they choose their own password from the invitation link;
- choose its **role**; disable or enable it — a disabled account cannot sign in, and its API tokens stop working at once;
- **Reset the second factor** of someone who lost their device (`user:reset-2fa`, a permission of its own): their factor, their trusted devices and all their sessions go;
- see and revoke the instance's API tokens, with their author.

Safeguards: you cannot act on your own account from here, and the last active administrator can be neither demoted, disabled nor deleted.

A public sign-up (`ALLOW_SIGNUP=true`) is born with the **No access** role: it sees nothing until an administrator chooses its role, and the `security.signup_pending` event warns.

## Roles and permissions

**Roles** shows a matrix: a column per role, a row per permission family. There are 38 permissions, written `resource:action`:

| Resource | Actions |
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

The starting roles are data, editable — except `admin`:

| Role | What it can do |
|---|---|
| `admin` | everything — locked: it cannot be renamed, emptied nor deleted |
| `operator` | deploy and operate: targets (not deleting them), applications, deployments, rollback, restart, scans, backups without restoring, maintenance windows, status page announcements |
| `auditor` | every `:read` permission, the activity log, accounts, roles and settings included |
| `viewer` | the operations reads: targets, applications, deployments, backups, workloads, scans, tasks, monitoring, maintenance |
| `no-access` | nothing — the role of a public sign-up |

A few distinctions matter: **destroy** removes from the machine, **purge** erases from the database; **backup** replaces nothing, **restore** overwrites; **manage** accounts does not give the power to lift someone's second factor. Create your own roles from the matrix: a new permission added by an update goes to `admin` only — the other roles get it from you.

## Single sign-on

**Settings → Single sign-on** (`settings:manage`): sign in through any OpenID Connect provider — Keycloak, Authentik, Google, Microsoft Entra. With Keycloak:

1. in the realm, an OpenID Connect client `pupitre`, **Client authentication** on, standard flow;
2. **Valid redirect URIs**: the callback URL the settings screen gives, `{{origin}}/api/auth/callback/oidc`;
3. a **Group Membership** mapper, field name `groups`, "Full group path" unticked, added to the ID token;
4. in Pupitre: the issuer (`https://auth.example.com/realms/my-realm`) — **Test** checks it —, the client's id and secret;
5. the **group → role** mappings, from the most powerful to the least, and the default role;
6. whether **the provider is authoritative**: ticked, the role follows the groups at each sign-in.

The sign-in screen then offers to sign in with the provider. A local account is only linked when the provider declares the email verified.

> [!NOTE]
> Keycloak puts its roles in the access token, not the ID token: map **groups**, or tick "Add to ID token" on the roles mapper.

## Second factor and sessions

**Settings → Accounts and sessions** (`settings:manage`):

- **Required second factor** — nobody (the default), roles carrying a **sensitive** permission (administering, creating or editing targets, driving workloads, deploying, destroying, purging, restoring), or every account. An account bound to it that has none only reaches the screen that enables it, and its API tokens are refused as it is;
- **Session length** — closed after one hour, eight hours, one day, seven days (the default) or thirty days without activity, and optionally after an absolute duration.

Each person enables their own factor in [My account](/account) — TOTP, with backup codes —, and changes their password there.

## The activity log

**Activity log** (`audit:read`): every action and every refusal — who, when, from which address, with which browser, and **through which API token**. Each entry carries a severity:

| Severity | What it designates |
|---|---|
| `CRITICAL` | to handle now: a host key changing, a failed rollback or restore |
| `HIGH` | an outage, a refusal that looks like an attempt, a gesture on access: a role changed, a token created, a console command |
| `MEDIUM` | a change of state or configuration, an ordinary failure or refusal |
| `LOW` | routine: sign-ins, successes, returns to normal |

Filter by severity, action, resource, actor, period, or search freely; export as JSONL (`GET /api/audit-logs/export`), one entry per line. Through the API:

```bash
curl -s "{{origin}}/api/audit-logs?severity=high,critical&from=2026-10-01" \
  -H "Authorization: Bearer $PUPITRE_TOKEN" | jq '.items[] | {createdAt, action, severity}'
```

## Instance settings

**Settings** (`settings:read`, writing `settings:manage`), in four groups:

| Section | What is set there |
|---|---|
| Identity | the instance's name and tagline |
| Regional settings | time zone, locale — hence the panel's language —, date format |
| Security scanning | scanners and blocking threshold — see [Security scans](/docs/security-scans) |
| Single sign-on | the OpenID Connect provider |
| Accounts and sessions | required second factor, session length |
| Notifications | the channels — see [Operations](/docs/operations#notifications) |
| Artificial intelligence | provider, model and key for AppSpec generation |
| Code repositories | GitHub, GitLab, Gitea — see [Repositories and code](/docs/repositories) |
| Backups | destination, the panel's database |
| Setup guide | run the guide again |

Some settings are environment variables, not screens: `ALLOW_SIGNUP` (public sign-up), `MONITOR_ALLOWED_CIDRS` (probes' private addresses), `BETTER_AUTH_URL` (the panel's address).

## MASTER_KEY and its rotation

`MASTER_KEY` encrypts the SSH credentials, the application secrets, the AI and single sign-on keys, the channels', forges' and backup destinations' secrets — and every backup. The panel warns at startup if it looks guessable. Rotating it requires no secret to be typed again:

1. generate a new key: `openssl rand -hex 32`;
2. in `.env`, move the current key to `MASTER_KEY_PREVIOUS` (comma-separated if several) and put the new one in `MASTER_KEY`; restart panel and worker — everything stays readable, everything written from now on uses the new key;
3. re-encrypt what remains:

   ```bash
   docker compose run --rm worker crypto rotate --yes
   docker compose run --rm worker crypto status
   ```

4. `crypto status` says when `MASTER_KEY_PREVIOUS` can go: backups made before the rotation stay readable only while their key is listed there.

> [!CAUTION]
> Losing a key that a value or a kept backup still needs is losing that value. Keep `MASTER_KEY` and `BETTER_AUTH_SECRET` in a password manager, off the panel's machine.

## The setup guide

At the first sign-in of an empty instance, the setup guide walks through eight steps — welcome, identity and language, first target, reverse proxy, a role, a user, security and AI, end. A step your role cannot do is absent; the guide creates nothing by itself — each step calls the same routes as the normal screens. Run it again from **Settings → Setup guide**.

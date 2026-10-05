# Database

PostgreSQL 16, Drizzle, versioned SQL migrations in `packages/db/migrations/`.
**An applied migration is never changed** — you create a new one.

`packages/db` is the single source of the model: neither `apps/web` nor
`apps/worker` writes SQL, and the drivers are not allowed to know a table.

## The 59 tables

| Area | Tables |
|---|---|
| Authentication | `users` `sessions` `accounts` `verifications` `two_factors` `user_avatars` |
| RBAC | `roles` `permissions` `role_permissions` `user_roles` `api_tokens` |
| Infrastructure | `targets` `applications` `application_secrets` |
| Linked repositories and uploaded code | `source_connections` `application_sources` `application_source_targets` `source_proposals` `source_archives` `source_archive_chunks` |
| Deployment | `deployments` `deployment_steps` `port_allocations` `image_updates` |
| Security | `scan_runs` `findings` `vulnerability_acceptances` |
| Monitoring | `monitors` `monitor_checks` `monitor_incidents` `monitor_captures` `target_metric_samples` `target_metric_thresholds` `target_metric_breaches` `forecasts` |
| Maintenance and status pages | `maintenance_windows` `maintenance_window_targets` `maintenance_window_monitors` `maintenance_held_alerts` `status_pages` `status_updates` |
| Automation | `scheduled_jobs` `scheduled_job_runs` |
| Notifications | `notification_channels` `notification_policy` `notification_digest_groups` `notification_digest_items` |
| Chat | `chat_messages` `chat_reactions` `chat_reads` `chat_attachments` |
| Backups | `backup_destinations` `backup_policies` `backups` |
| Reverse proxies | `proxies` `routes` `proxy_links` |
| Other | `audit_logs` `app_settings` |

Seventeen of them were created in the very first migration — including those
that would only be used much later — so as to have no structural migration in
the middle of the project. The `users` / `sessions` / `accounts` /
`verifications` schema already matched field for field what Better Auth expects,
`admin` plugin included: **the arrival of authentication required no
migration**.

All statuses are **Postgres enums**, never free `text`.

### Bytes in the database

Four tables carry bytes as `bytea`: `monitor_captures` (what the probe saw),
`user_avatars` (one profile photo per person), `chat_attachments` (chat images)
and `source_archive_chunks` (uploaded code, in one-megabyte chunks). No file
volume next to it: the database is **the only thing to back up**, and a cascading
delete takes the bytes along with the row.

Each one is bounded on input: a screenshot is a capped JPEG purged after 90 days,
a profile photo a 256 px square (512 KiB at most), a chat image 3 MB at most,
four per message, re-encoded by the browser, an archive 100 MiB at most, the last
five per application. Image format and dimensions are **re-read from the bytes**
by the server (`sniffImage()`), never taken from the request header — and SVG is
not accepted. No screen reads a `bytea` column in a list: only the route serving
the bytes loads them.

## Invariants held by the database, not by TypeScript

**`port_allocations (target_id, port)` is unique.** It is port collision
avoidance. Two workers aiming at the same port produce a `23505` violation, and
the loser tries again. There is no `if` to find in the code.

**`routes.hostname` is unique.** Two applications cannot claim the same domain:
the loser of the race gets a `23505`, translated into "already routed to…". And
**`proxies_host_target_unique`**, a partial unique index, holds a single reverse
proxy per machine. **`proxy_links.target_id`** is the primary key: a machine
goes through another one's proxy at most — and the API refuses that it has both
its own and a link.

**`targets_port_range_check`** forbids an inverted range, on top of Zod.

**`monitor_incidents_open_idx`**, a partial unique index on `(monitor_id) where
resolved_at is null`, structurally forbids two open incidents on the same probe.
The opening logic can be wrong; the database cannot. `forecasts` and
`target_metric_breaches` hold their open episodes the same way.

**A forecast dies with its subject.** `forecasts` has one generated column per
kind of subject (`target_id`, `monitor_id`, `route_id`, `application_id`), each
a foreign key `ON DELETE CASCADE`.

And **`app_settings` is a singleton**, held by `check (id = 1)`.

## What deliberately has no table

**There is no "versions" table.** The deployment *is* the version, and its frozen
`app_spec` is what makes a redeployment possible months later, even if the
application has changed since.

**Settings fit in a single JSONB**, so that adding a setting does not cost a
migration. Notification channels, on the other hand, earned their table: they
are multiple, named, and each carries an execution state.

**The SBOM has no dedicated column**: it *is* the raw output of the tool that
produces it, so it lives in `scan_runs.raw`. A column would duplicate it byte for
byte, and you would have to decide which one is authoritative.

**`scheduled_job_runs` is a table and not rows of `audit_logs`**, because they
are not the same questions. The audit log answers "who did what": append-only,
read by a human investigating. The run history answers "did the 4 am scan run,
how long did it take, and what did it find": framed by a foreign key, purged with
its task.

**`audit_logs.resource_id` is a `text` without a foreign key** — the audit log
outlives what it describes, and that is intended. Purging a deployment does not
purge its trace.

**Backups are not in the database, only their index.** `backups` says where each
one was placed (`destination_id`, `location`) and what it contains (`manifest`);
the bytes are on the destination, with an encrypted manifest that is enough to
read them without the panel. A backup **outlives its application**
(`application_id` becomes `null`, `application_slug` keeps the name): deleting an
application does not erase its data from the destination. And a destination that
moved is not changed but replaced, so that `destination_id` always designates
where the files really are.

## Migrations

Forty-seven of them, `0000` to `0046`, readable in `packages/db/migrations/`. The
first thirteen laid the foundations:

| Migration | Content |
|---|---|
| `0000_rainy_prodigy` | the 17 initial tables |
| `0001_ambitious_mordo` | `targets.sudo_method`, `targets.labels`, `target_status` becomes `unknown \| ok \| degraded \| unreachable`, `runtimes_available` becomes a structured object |
| `0002_awesome_next_avengers` | `deployment_steps.log`, `deployments.app_spec` (frozen AppSpec), `published_port`, `failed_step` |
| `0003_omniscient_redwing` | `deployments.scan_config` — scanners kept and threshold, frozen at deployment |
| `0004_sparkling_skin` | `targets.port_range_start` / `port_range_end` (default 30000-32767) with `targets_port_range_check`, and `deployments.auto_rollback` |
| `0005_sad_gorgon` | AI provenance on `applications`, observed health on `deployments` (`health_status` + its enum), and the `scheduled_job_runs` table |
| `0006_legal_slayback` | `roles.locked` and `roles.updated_at` — roles become editable data, with `admin` locked |
| `0007_odd_earthquake` | the `app_settings` table: singleton, JSONB, and `ai_api_key_encrypted` in its own column |
| `0008_real_wendell_rand` | the `two_factors` table and `users.two_factor_enabled` |
| `0009_public_deathbird` | `scheduled_jobs.timezone` — see below |
| `0010_cheerful_red_skull` | the `secret_origin` enum and the `application_secrets` table, with the unique index `(application_id, name)` |
| `0011_mushy_firelord` | the three website monitoring tables, including the partial unique index on the open incident |
| `0012_bent_may_parker` | the `notification_channel_kind` enum and the `notification_channels` table |

Since then, the names say the content: `0027_reverse_proxy` (connections and
routes, taking over what was routed before), `0028_central_proxy`,
`0029_route_waf`, `0030_source_deploy_to`, `0031_proxy_npm`,
`0032_target_host_key`, `0033_drop_deployment_proxy`,
`0034_roles_auditor_no_access`, `0035_api_tokens`, `0036_alerts`, `0037_sso`,
`0038_source_archives`, `0039_source_gitea`, `0040_forecasts`,
`0041_forecasts_cascade`, `0042_maintenance`, `0043_status_pages`,
`0044_status_updates`, `0045_vulnerability_acceptances`, `0046_source_gitlab`.

### Two trade-offs that read in the SQL

**`0009` sets `UTC` on existing tasks, not the instance's time zone.** Those tasks
were created when `upsertJobScheduler` was called without a `tz` option;
cron-parser fell back on the process's time zone, and the containers have no
`TZ`: they therefore run in UTC. Retroactively setting `Europe/Paris` would move a
`0 3 * * *` from 03:00 to 01:00 UTC — we would have **moved the execution of a
task nobody asked to change**, without trace or warning. The instance's time zone
therefore only applies to tasks created afterwards, and it is applied on the
application side, not in the migration.

**The `scheduled_job_type` enum keeps short names.** It is
`scan | healthcheck | preflight | cleanup | backup | panel_backup`, where the
BullMQ tasks are called `scan:periodic`, `health:periodic`, `target:preflight`,
`cleanup:versions`, `backup:schedule`, `backup:schedule-panel`. Migrating a
Postgres enum for a cosmetic rename, on an already applied table, would have
cost a delicate migration for nothing. The BullMQ name lives in
`scheduled_jobs.key`, which *is* the scheduler's identifier on the BullMQ side —
that is its reason for being. The type → task mapping is a data table,
`SCHEDULED_JOB_TYPES`; there is no `if (type === 'scan')` anywhere.

Two names also differ between `findings` and the normalized report
(`findings.version` = `installedVersion`, `findings.reference` = `primaryUrl`);
the translation lives in `packages/db/src/scans.ts`, not in a migration.

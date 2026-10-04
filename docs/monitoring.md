# Monitoring and automation

Four things carry neighboring names and do not do the same thing. Better to
separate them right away:

| Screen | What it is | Direction of the look |
|---|---|---|
| **`/apps` — Servers** | what runs on your machines, grouped by server, with host metrics | the panel reads the machines, over SSH |
| **`/monitors` — Monitoring** | URLs and certificates probed from the worker | the worker goes out on the network |
| **Notifications** | four channels that relay the audit log's events | the panel goes out to your tools |
| **`/jobs` — Jobs** | what triggers by itself, at a set time | BullMQ, internally |

- [Monitoring by server](#monitoring-by-server)
- [Website probes](#website-probes)
- [Forecasts](#forecasts)
- [Maintenance windows](#maintenance-windows)
- [Status pages](#status-pages)
- [Notifications](#notifications)
- [Scheduled tasks](#scheduled-tasks)

## Monitoring by server

`/apps` — **Servers**. Page permission `deployment:read`; the full fleet is only
listed with `target:read`.

One card per machine, each with its identity, its gauges, and a fold-out
containing its applications. **Two sources that never mix**: an unreachable
server shows "unreachable" in place of its gauges, and **keeps its applications
on screen** — they come from the database, not from the machine.

### Host metrics

Six readings, run **in parallel over a single SSH session**, each capped at 5 s:

| Reading | Command | What comes out |
|---|---|---|
| `load` | `cat /proc/loadavg` | load over 1, 5, 15 min |
| `cpu` | `nproc` | cores, hence the load per core |
| `memory` | `cat /proc/meminfo` | total and **`MemAvailable`** — never `MemFree` |
| `disk` | `df -Pk` on the first existing ancestor of `DRIVER_ROOT_PATH` | size, used, available, mount point |
| `uptime` | `cat /proc/uptime` | seconds |
| `os` | `uname -r` + `/etc/os-release` | kernel, distribution |

No `docker`, no `kubectl`: that is exactly why this reading is not a driver
method. It talks to a machine, not to a runtime.

**Each reading is independent.** A missing `nproc` leaves the load readable, and
the value returned is `null` — never `0`. "I don't know" and "zero" are not the
same information, and a gauge at 0% would lie.

**The worker reads each machine every five minutes** (task
`target:metrics_sweep`) and keeps the readings thirty days
(`target_metric_samples`, with their reason when the machine did not answer).
It is the worker, not the screen, that reads: a forgotten tab does not become a
permanent probe. The screen shows the last reading and its age; a button asks
for a new one.

**Thresholds.** Disk and memory at 90%, load per core at 100%, adjustable per
machine, with hysteresis: several readings above are needed to open a breach
(one for disk, two for memory, three for load), and as many below to close it.
Opening writes `target.threshold.breached`, closing `target.threshold.cleared` —
one entry per episode, not per reading.

**Unreachable machine.** A machine that is off crosses no threshold: its
readings simply fail. **Two consecutive missed readings** therefore open an
episode (`targets.unreachable_since`, dated from the first) and write
`target.unreachable`, with the reason — connection refused, timeout, host key
refused; the first successful reading closes it and writes `target.reachable`,
with the length of the interruption. A reboot wakes nobody up; two missed sweeps
do.

Technical path: `GET /api/targets/:id/metrics` (`target:read`) enqueues a job on
the **`supervision`** queue and waits 20 s for its result — the panel never
opens an SSH session itself. An unreachable target returns a `200` with
`reachable: false`, not an error.

### Running applications

`/apps/:id` shows an application's details: the state of its services and **live
logs over SSE**, read on the machine. `deployment:restart` allows restarting it
— through the queue, with its life cycle published in the stream.

An application whose **last update failed** stays listed, with a state that says
so: it still runs, in its previous version. It is the case
`verify-supervision.sh` specifically isolates.

## Website probes

`/monitors` — **Monitoring**. `monitor:read` to read, `monitor:manage` to write.
Here the worker **goes out on the network** to a URL provided by a user. It is a
potential SSRF, and that explains half of the design.

### Two types

| Type | Configuration | Minimum interval |
|---|---|---|
| `http` | `url`, `method` (GET/HEAD/POST), `expectedStatus`, optional `keyword`, `timeoutMs` | 30 s (default 60 s) |
| `tls` | `host`, `port`, `servername` (SNI), **`warnDays`** (default 21), `timeoutMs` | 1 h (default 6 h) |

The expected keyword is an **option of the HTTP probe**, not a separate type.

Worth knowing: the TLS notice **fails the probe**, it does not merely warn. A
certificate 20 days from expiry with `warnDays: 21` returns `unhealthy`. It is
deliberate — a warning you can ignore is not one — but it surprises the first
time.

### The confirmation threshold

Two counters in the database, `consecutive_failures` and
`consecutive_successes`, updated **in the same transaction** as the insertion of
the measurement and the opening/closing of the incident.

- An incident opens after `failure_threshold` consecutive failures (default
  **3**).
- It closes after `recovery_threshold` consecutive successes (default **2**).
- A partial unique index on `(monitor_id) where resolved_at is null`
  structurally forbids a second open incident.
- From the `unknown` state, a single healthy measurement is enough to show
  "healthy" — unless an incident is open (see below).
- Already down and the nature changes (`unhealthy` → `unreachable`): the status
  is updated, but **no new incident, no alert**.

**Changing the target during an outage.** Changing what a probe watches (its
URL, its host) resets its state to `unknown`: the verdict was about something
else. The open incident **stays open** — it was announced. The state machine
knows it (`incidentOpen`, read from the database by `applyCheck`): the new
healthy target closes it at the recovery threshold, **return to normal
announced**; failing, it is the same outage continuing, without a second alert.
Before, the incident stayed open forever and the unique index swallowed every
following outage; a probe left in that state repairs itself at the first
success.

`monitors.status` carries the **confirmed** state, `monitors.last_outcome` the
last raw verdict. That is what lets the screen say "1 failure out of 3 — not
confirmed" rather than cry wolf.

An isolated blip therefore creates no incident, and that is point 3 of
`verify-monitors.sh`.

### The SSRF guard

`packages/core/src/monitors/ssrf.ts`. The setting is the
**`MONITOR_ALLOWED_CIDRS`** environment variable, empty by default: **only
public addresses can be probed**.

It is lifted **there and nowhere else** — neither from a screen, nor behind a
permission. The reason is simple: `monitor:manage` is precisely what anyone
creating a probe holds. A guard lifted with the permission it is supposed to
frame guards nothing.

Four categories stay refused **even if a CIDR lists them**: link-local
(`169.254.0.0/16`, `fe80::/10` — metadata services), multicast, reserved
(`192.0.2.0/24`, `198.18/15`, TEST-NET, `240/4`, Teredo…) and the unspecified
address. Can be allowed: loopback, private, unique-local, CGNAT.

The hardening goes further than the list: octal refused (`0177.0.0.1`),
IPv4-in-IPv6 unwrapped (`::ffff:`, NAT64, `::a.b.c.d`), zone suffix ignored, the
`localhost` name and `*.localhost` refused, schemes other than http/https
refused, URLs carrying `user:pass@` refused.

It applies **three times**:

1. at creation and edit, on the panel side — on the config **and** on the
   webhook URL, with the faulty field named in the `422`;
2. **at each redirect hop** on the worker side, five at most, with the
   "redirect refused:" prefix;
3. against **DNS rebinding**: `resolveGuarded()` checks *all* the addresses
   returned, then the probe connects to the **literal address** passing the
   original name as `Host` and SNI. No second resolution.

The alert webhook is subject to the same policy. The response is capped at 256
KiB, with `accept-encoding: identity`, socket cut on truncation.

> **`MONITOR_ALLOWED_CIDRS` must have the same value on the panel and on the
> worker**, and both cache it at module level: a change requires restarting both
> services.

### Scheduling

A **single** BullMQ scheduler, `monitor-sweep`, every 30 s on the `supervision`
queue. It does not probe: it **sweeps**. `claimDueMonitors(200)` claims the due
probes in raw SQL, with `for update skip locked`, and **moves `next_check_at`
forward before probing**. Each probe's interval therefore lives in
`monitors.interval_seconds`, not in BullMQ — a thousand probes do not make a
thousand schedulers.

Sweep guards: Redis lock, 22 s budget, concurrency 10, batches of 200. A probe
in error does not bring the sweep down. The sweep also pauses the probes whose
application was destroyed, and purges measurements older than 30 days — at most
once an hour. **Incidents are never purged.**

**Probe now** (`POST /api/monitors/:id/check`) marks the probe due and enqueues
the same job in forced mode: it bypasses the lock, and purges nothing.

### The alert

One **webhook per probe**, whose URL is encrypted in the database and never
returned by the API (only a `hasWebhook: boolean` comes out). It fires on the
transition, **only once**, and on recovery. The result is recorded on the
incident (`alert_sent_at`, `alert_error`) and an unreachable webhook **does not
fail the sweep**. The audit (`monitor.down` / `monitor.recovered`) is written no
matter what, even without a webhook configured.

**Two outputs, and it is deliberate.** Since `monitor.down` and
`monitor.recovered` are in the catalog of notifiable events, a transition *also*
goes to the instance channels (email, Telegram, Discord, webhook), with burst
grouping and named summaries. The connection goes through no call from
monitoring: probes already wrote to `audit_logs`, and the audit log is the source
of notifications.

The per-probe webhook was not removed for all that. A channel is subscribed to
an **event**, hence to every probe; this webhook is attached to **one** probe.
Someone watching thirty sites for twenty clients wants each client's room in its
own probe. Filling in both therefore sends two messages for the same outage —
two subscriptions, two gestures; the probes screen says so when the URL is
entered.

End-to-end check: `scripts/verify-monitor-notifications.sh`.

## Forecasts

What will break if nothing changes. Every 30 minutes, the worker reads the
series the database already keeps and derives **forecasts** from them — without
AI: a least-squares slope, a median, a count. The computation is pure and tested
on fabricated series (`packages/core/src/forecast.ts`); the sweep
(`apps/worker/src/forecast/sweep.ts`) only reads, calls and reconciles.

| Forecast | Subject | What triggers it |
|---|---|---|
| Disk filling up | target | 95% reached in less than 14 days, at the slope of the last 7 days (hourly averages; slope ≥ 0.3 pt/day, r² ≥ 0.6, at least two days of readings) |
| Memory that does not come down | target | 95% in less than 7 days, at the slope of the last 3 days (≥ 2 pts/day, r² ≥ 0.8: a leak climbs straight) |
| Rising load | target | the target's load threshold in less than 7 days, at the slope of the **daily** averages — load breathes every day, the trend reads from one day to the next |
| Slower probe | probe | the median of healthy responses over the last 24 hours is 1.5× that of the six days before, and at least 100 ms more (20 recent measurements, 50 older ones) |
| Unstable probe | probe | 6 flips in 24 h between "up" and "down" — hysteresis avoids the alert, not the fragility |
| Certificate not renewed | domain | less than 20 days of validity: renewal should have happened at 30 |
| Late backup | application | 48 h without a successful backup while the backup is active |
| Failing deployments | target | the week's last three deployments all failed |

Thresholds are chosen to **stay quiet** on an ordinary fleet: a slope without
regularity (low r²) or drawn from too few days says nothing. A forecast is
**"soon"** when its due date is three days or less away; without a due date,
when the gap is clear — latency tripled, 12 flips, 96 h without a backup.
**"To watch"** otherwise.

**Episodes, like thresholds.** The `forecasts` table holds one open episode per
`(nature, subject)` — partial unique index, like `target_metric_breaches`. A new
finding opens it, a lasting finding updates it (due date, figures), an episode
without a finding closes. Only opening and closing are written to the audit log
(`forecast.raised`, `forecast.cleared`); only opening is notifiable, **once** per
episode.

**A forecast does not outlive its subject.** The subject is polymorphic
(`subject_type`, `subject_id`), but each type has its column generated by
Postgres (`target_id`, `monitor_id`, `route_id`, `application_id`), foreign key
`ON DELETE CASCADE`. Deleting a target, a probe or an application takes its
forecasts along in the same transaction, whatever the path — the API, or the
cascade of an application taking its domains along. No waiting for the next
sweep, and no `forecast.cleared`: deleting the subject is itself in the audit
log. A subject deleted during a sweep gets its opening refused by the key; the
sweep ignores it and carries on.

**Where they are read.**
- The overview: an **Upcoming** card, under the attention block. Nothing when
  there is nothing.
- The overview tab of their subject's drawer: target, probe, application.
- `GET /api/forecasts`, as sentences in the instance's language.

Each one is only shown to whoever can read its subject (`target:read`,
`monitor:read`, `application:read`).

## Maintenance windows

"prod-1 in maintenance from 10 pm to 11 pm": during a window, the monitoring
alerts of its subjects are **held**; the audit log keeps everything. The screen
is `/maintenance` (`maintenance:read`, scheduling: `maintenance:manage`),
everything happens there in drawers. **Put in maintenance** also starts from the
footer of a target's or a probe's record, with that subject already ticked.

**What a window covers.** The targets and probes it names; and, on its targets,
the probes of the applications running there (`listLiveDeployments`, the single
definition of "what runs") and their domains. Stopping prod-1 brings down its
applications' probes: they are covered without having to name them.

**What is held.** Monitoring alerts and nothing else: probe down and recovered,
machine unreachable and reached again, thresholds crossed and back, domain no
longer answering and reachable again. Security, deployments, backups,
certificates and forecasts always go through — a maintenance does not excuse a
changed role or a failed backup. It is the catalog that says so (`maintenance`
on an event's descriptor), not an `if` in the dispatch.

**Where it is decided.** In `notification:dispatch`, before grouping: if an
active window covers the alert's subject, the dispatch task is copied as is into
`maintenance_held_alerts` instead of leaving. The emitters (probes, readings,
routes) know nothing about it. Muting depends on no sweep: it compares the time
with the window's bounds, on each alert.

**Nothing is lost.** An alert only fires on a state change: an outage that
appeared during the window and is still there at its end would stay silent. At
the end, for each subject, the **last** held alert fires if it reports a problem
(`alertsToRelease()` in `packages/core/src/maintenance.ts`) — an outage repaired
during the window (down then recovered) wakes nobody up. It goes through
dispatch again, on its own event's channels; if another window still covers its
subject, that one holds it.

**The sweep** `maintenance:sweep`, every minute (BullMQ scheduler), does what
must happen only once: announce the start (`maintenance.started`), and at the
end release what must go out then announce the end (`maintenance.ended`, with
what went out). Its two claims are `UPDATE … RETURNING`: two sweeps that cross
do not handle the same window twice.

**A window's rules.** An end after the start, a month at most, at least one
subject. A window **in progress** cannot be deleted — its held alerts would
disappear —: you end it (**End now**, `PATCH endsAt`), and its end releases what
must go out within the minute. An **ended** window can no longer be edited;
upcoming or ended, it can be deleted. Times are entered in the instance's time
zone, the one used for all display.

**On screen.** A **Maintenance in progress** band (and those planned during the
day) comes before the overview's attention block; in that block, a covered
subject stays listed — you need to see it come back — but as a warning, with
the mention. The records of a covered target and probe say so at the top of
their overview.

## Status pages

**Public** pages, without sign-in, at `/status` (empty address) or
`/status/<address>`, which the administrator composes block by block in
`/status-pages` (`status_page:manage`), and where
[announcements](#announcements) are published during an outage
(`status_page:announce`). The editor is a two-column drawer: settings and blocks
on the left, reorderable by drag and drop (handle) or with the keyboard (arrows),
and on the right a **preview** computed exactly like the public page, on the
unsaved blocks.

| Block | What it shows |
|---|---|
| Overall status | "All services are operational", degraded, partial outage, major outage (more than half down), maintenance — and below, the latest [announcement](#announcements) of each outage or maintenance in progress |
| Title, Text | What the administrator writes; plain text, no HTML interpreted |
| Services | Probes, under a **public name** of your choice; their state, and on request one bar per day over 30 days (the measurement retention) and the availability rate |
| Maintenance | The [windows](#maintenance-windows) in progress and upcoming (7 days) that affect these services — directly, or through the target where their application runs — with their announcements; an ended window stays one day if it carries one |
| Recent incidents | The outages of these services over 7, 14 or 30 days, with their duration and their announcements |

A service's public state is read from its probe: healthy, degraded (answers
badly), down (unreachable), unknown (paused or never measured) — and **in
maintenance** as soon as a window covers it, which wins. What a page lets out is
described in [security](security.md#what-is-public-status-pages).

An unpublished page answers 404; the public page reloads itself every minute.

### Announcements

During an outage or a maintenance, a human tells visitors what is happening:
dated messages, each with its **phase** — "Investigating", "Identified",
"Monitoring", "Resolved" for an outage; "Scheduled", "In progress", "Completed"
for a maintenance. An announcement is **attached** to a probe incident or to a
window (`status_updates` table, one subject and only one, deleted with it): it
appears on every page that shows an affected probe, under the incident or the
window, most recent first, and the latest one of an ongoing subject rises under
the overall status.

They are published in `/status-pages`, **Announcements** section
(`status_page:announce`, distinct from `status_page:manage`: saying "we are
investigating" is an operations gesture, and the operator gets it on a fresh
installation). The section lists the outages of your pages' probes, ongoing or
closed less than 7 days ago, and the maintenance windows affecting them; each one
opens in a drawer (`?annonce=incident:<id>`, `?annonce=maintenance:<id>`) where
you publish, correct or remove. A probe's record and a window's lead there
directly — even for a probe no page shows, with the warning that the
announcement will appear nowhere.

"Resolved" is a word for visitors, not a state: it does not close the incident,
which only the probe closes when it sees the target healthy. An announcement
carries neither author nor identifier on the public page — only its phase, its
text and its time.

## Notifications

Four channels, twenty-four events, behind a catalog and a factory. The same
pattern as `getDriver()`, `getScanner()` and `getAiProviderFactory()` — and the
code claims it.

```ts
interface NotificationChannel {
  readonly kind: NotificationChannelKind;
  test(resolved: ResolvedChannelConfig): Promise<NotificationTestResult>;
  send(resolved: ResolvedChannelConfig, message: NotificationMessage): Promise<void>;
}
```

The pattern is even **stricter** than for drivers: the catalog is *data*, each
field carries its own Zod schema and UI type there. The form is generated from
`presentNotificationChannels()`, validation from `channelConfigSchema()`. Neither
the UI nor the routes hard-code a channel's or a field's name. Adding a fifth
channel = an entry in the catalog, a class, a line in the registry. The
`Record<NotificationChannelKind, …>` typing makes a channel declared without a
factory fail to compile.

Messages are written in the instance's language at the time they are sent.

### The four channels

| Channel | Fields | Secrets |
|---|---|---|
| `smtp` | `host`, `port` (587), `security`, `user`, `password`, `from`, `to`, `rejectUnauthorized` | `password` |
| `telegram` | `botToken`, `chatId`, `apiBaseUrl` | `botToken` |
| `discord` | `webhookUrl` (must contain `/api/webhooks/`), `username` | `webhookUrl` |
| `webhook` | `url`, `token` (sent as `Authorization: Bearer`) | `token` |

**SMTP and SMTPS are a single channel**, with the `security` field: `starttls`
(STARTTLS **required**, fails if absent), `implicit` (SMTPS, session already
encrypted) or `none`. Letting nodemailer choose opportunistically would amount to
silently accepting a clear-text session on a misconfigured server.

It is **the instance's only email path**: there is no global SMTP setting
anywhere else.

### The twenty-four events

All derived from the audit log:

| Key | Severity | Audit action |
|---|---|---|
| `deployment.failed` | critical | `deployment.failed`, except scan failures |
| `deployment.scan_blocked` | critical | `deployment.failed` with `failedStep === 'scan'` |
| `deployment.rolled_back` | warning | `deployment.rolled_back.automatic` |
| `deployment.succeeded` | info | `deployment.succeeded` — a version online: the application, its version, the machine, the URL. To pick for the team's room, not for on-call |
| `security.two_factor_reset` | warning | `user.2fa.reset` |
| `security.role_changed` | warning | `user.role.changed` |
| `security.api_token_created` | info | `api_token.created` — an API token created: its name, its prefix, what it covers, never the token |
| `security.signup_pending` | info | `user.created` with the `no-access` role — a public sign-up waits for someone to choose its role |
| `security.host_key_changed` | critical | `target.host_key.mismatch` — a target presents another host key, once per key |
| `monitor.down` | critical | `monitor.down` |
| `monitor.recovered` | info | `monitor.recovered` |
| `target.threshold.breached` | warning | `target.threshold.breached` |
| `target.threshold.cleared` | info | `target.threshold.cleared` |
| `target.unreachable` | critical | `target.unreachable` — two consecutive missed readings, with the reason |
| `target.reachable` | info | `target.reachable` — reachable again, with the length of the interruption |
| `image.update.available` | warning | `image.update.available` — a deployed image republished, or a newer tag of the same series; see [operations](operations.md#image-updates) |
| `backup.failed` | critical | `backup.failed` — an application or panel backup, automatic, manual or before deployment; see [operations](operations.md#backups) |
| `route.down` | warning | `route.down` — a domain no longer answers through its reverse proxy, two probes in a row; see [operations](operations.md#what-raises-an-alert) |
| `route.recovered` | info | `route.recovered` — that domain answers again |
| `route.certificate_expiring` | warning | `route.certificate.expiring` — a domain's certificate expires in under fourteen days: its renewal did not succeed. Once per certificate |
| `route.certificate_renewed` | info | `route.certificate.renewed` — that certificate was renewed |
| `maintenance.started` | info | `maintenance.started` — a [maintenance window](#maintenance-windows) starts: what it covers, until when |
| `maintenance.ended` | info | `maintenance.ended` — it ends: how many alerts were held, and what, still down, goes out now |
| `forecast.raised` | warning | `forecast.raised` — a [forecast](#forecasts) opens: a problem ahead, announced once. Its closing (`forecast.cleared`) is not notifiable |

**A single `monitor.down`**, not one per kind of outage. Separating "answers
badly" from "unreachable" would give two keys, hence two grouping buckets, hence
two summaries for an infrastructure outage that produces a mix of 503s and
refused connections. The nature is in the message's content and in the summary
line, never in the key.

**Recovery is `info`**: it requires no gesture, it closes an alert already
received. Painting it red would teach people to ignore red.

Hysteresis is not redone here: `nextMonitorState()` only announces a transition
at the threshold, so a probe that oscillates writes nothing in `audit_logs`,
hence notifies nothing.

The entry point is `logAudit()`, and an observer is set on it **on both sides**
(panel and worker both write to `audit_logs`). Accepted corollary: **an event
that is not audited cannot be notified**.

Duplicate prevention through native BullMQ deduplication, key
`(event, resource)`, TTL 5 min — BullMQ replays, and a replay wrote three
`deployment.failed`. `attempts: 1`: replaying a partial dispatch would notify
again the channels already served. `notification.delivery.failed` is
deliberately **not** notifiable, for the obvious reason.

An unreachable channel never breaks the notified action: the `PATCH` that
changed a role returns `200`, and the failure reads on the channel
(`consecutive_failures`, `last_error`) and in the audit log.

### The test button

**Send a test** → `POST /api/notifications/channels/:id/test`, permission
**`settings:manage`** and not `settings:read`: a test sends a message to a third
party, it is a write to the outside.

The panel cannot send by itself — `nodemailer` is out of its graph. It enqueues a
job and waits 35 s. The worker reports **two steps separately**:

1. the **probe**, which delivers nothing: `transporter.verify()` for SMTP,
   `getMe` for Telegram, a `GET` on the URL for Discord. The generic webhook
   channel has no probe and **says so** rather than pretending to have checked;
2. the **real send**.

## Scheduled tasks

BullMQ repeatable jobs. **No Linux cron** — a `CLAUDE.md` decision, never
reopened. Screen `/jobs`, `job:read` to read, `job:manage` to act.

| Type | BullMQ task | What it does | What it does **not** do |
|---|---|---|---|
| `scan` | `scan:periodic` | runs the scanners again on current deployments | redeploys nothing, blocks nothing — a CRITICAL **alerts** |
| `healthcheck` | `health:periodic` | probes current deployments, writes `deployments.health_status` | **triggers no rollback** |
| `cleanup` | `cleanup:versions` | `driver.pruneReleases()` — the last 5 versions, plus the current one | never touches the version in service |
| `preflight` | `target:preflight:all` | enqueues one `target:preflight` per target | changes no target |
| `backup` | `backup:schedule` | enqueues a backup per application with automatic backup, on each target where it runs | restores nothing; only deletes what retention no longer keeps |
| `panel_backup` | `backup:schedule-panel` | backs up the panel database to the destination | restores nothing — a panel restore is done on the command line |

The two backup tasks do not have to be created by hand: enabling an automatic
backup, on an application or for the panel, creates the task if it does not
exist — or enables it again if it had been disabled.

### Nothing automatic and destructive

That is the rule, and it is **visible in the UI**: each task shows what it does
not do, next to what it does. A periodic scan that finds a CRITICAL records the
finding, marks the verdict and writes an audit line. The deployment stays in
place, the URL still answers.

`deployments.health_status` is distinct from `deployments.status`,
deliberately: a `success` deployment can become `unreachable` three hours later
without ceasing to have succeeded. The health status informs the operator; it is
the operator who decides what comes next.

### Simple input and time zone

The screen offers a **simple input** ("every day at 3 am") that writes a real
cron expression to the database, and switches to **expert mode** as soon as you
enter an expression the simple mode cannot represent. Reading a simple task back
shows it in simple mode.

Each task carries **its own time zone**. Without one, it takes the instance
settings' zone at the time of its creation. "Every day at 3 am" in
`Europe/Paris` falls at 01:00 or 02:00 UTC depending on the season — never at
03:00 — and changing an existing task's time zone **reschedules its next
occurrence in BullMQ**. Tasks older than migration `0009` stayed in UTC, and
their next occurrence did not move.

### Database ↔ BullMQ reconciliation

**The database is the source of truth, Redis is only the executor.** At worker
startup, `reconcileSchedulers()` brings the two into agreement: an active task
missing from Redis is installed again, a changed cron is applied again, a
disabled or deleted task is removed, and any orphan scheduler disappears.

Without this step, a restarted worker would inherit Redis's state, which can be
anything.

The panel also writes to both, **database first**: if the Redis write fails, the
database stays right and the worker will catch up. The reverse would leave
running a task nobody can see anymore. An active task missing from BullMQ is
**shown as such** in `/jobs` rather than hidden — it is operational information.

The handler reads the row from the database again at each occurrence: a
scheduler left in Redis while the task was just disabled executes nothing.

### Periodic ≠ pipeline

`runSecurityScan()` deletes the deployment's previous runs — a retry replays the
step and must start from a clean slate. The periodic scan passes
`clearPrevious: false`: its whole point is to **stack** reports over time on a
deployment that has not moved. A single named flag, rather than two functions
that would drift apart.

`scheduled_job_runs` is a dedicated table and not rows of `audit_logs`, because
they are not the same questions. The audit log answers "who did what":
append-only, read by a human investigating. The run history answers "did the 4
am scan run, how long did it take, and what did it find": framed by a foreign
key, purged with its task, shown next to the cron. Each run **also** goes
through `logAudit()`.

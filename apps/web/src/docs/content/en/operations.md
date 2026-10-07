# Operations

Everything that happens once applications run: watching them, probing their URLs, foreseeing trouble, silencing alerts during a maintenance, telling visitors, notifying the team, scheduled tasks and backups.

## Servers: what runs

**Servers** (`deployment:read`) shows one card per machine, with its gauges — load, memory, disk — and, folded under it, the applications running there. An unreachable machine shows "unreachable" instead of its gauges and keeps its applications on screen: they come from the database, not from the machine.

A running application opens in a drawer: the state of each service, its health, and its **live logs**, read on the machine. With `deployment:restart`:

- **Restart** — the services restart, without redeploying;
- **Stop** — the processes stop; volumes, port and domain stay, and the health probe is suspended. The application stays listed, "stopped for…";
- **Start** — the same version comes back, as it was.

An application whose last update failed stays listed, with a state that says so: it still runs, in its previous version.

## Website probes

**Monitoring** (`monitor:read`, writing `monitor:manage`): the worker checks URLs and certificates from the outside.

| Type | Settings | Interval |
|---|---|---|
| `http` | URL, method (GET, HEAD, POST), expected status, optional keyword, timeout | 30 s minimum, 60 s by default |
| `tls` | host, port, SNI name, warning days (21 by default), timeout | 1 h minimum, 6 h by default |

- **No crying wolf**: an incident opens after 3 consecutive failures (adjustable) and closes after 2 successes. The record says "1 failure out of 3 — not confirmed" meanwhile.
- **The TLS warning fails the probe**: a certificate 20 days from expiry with a 21-day warning is unhealthy.
- **Public addresses only**, unless `MONITOR_ALLOWED_CIDRS` (on the panel **and** the worker) allows private ones — it is lifted there and nowhere else. Link-local addresses (cloud metadata) always stay refused.
- **Two ways to alert**: the instance's notification channels follow `monitor.down` and `monitor.recovered`; a probe can also carry its own webhook, for a client's room.

```bash
curl --fail-with-body -X POST {{origin}}/api/monitors \
  -H "Authorization: Bearer $PUPITRE_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Shop","type":"http","config":{"url":"https://shop.example.com/","expectedStatus":200,"keyword":"Add to cart"}}'
```

**Probe now** on a probe's record checks it right away.

## Forecasts

Every thirty minutes, the worker reads the series the database already keeps and says what will break if nothing changes — without AI: a slope, a median, a count.

| Forecast | When it rises |
|---|---|
| Disk filling up | 95 % reached in under 14 days at the slope of the last week |
| Memory that does not come down | 95 % in under 7 days, a regular climb |
| Rising load | the load threshold in under 7 days, day after day |
| Slower probe | today's median response time 1.5 times that of the week before |
| Unstable probe | 6 flips between up and down in 24 hours |
| Certificate not renewed | under 20 days of validity |
| Late backup | 48 hours without a successful backup while it is active |
| Failing deployments | the week's last three deployments on a machine all failed |

They show in an **Upcoming** card on the overview and on their subject's record; `GET /api/forecasts` returns them as sentences. Each one notifies once (`forecast.raised`).

## Maintenance windows

"prod-1 in maintenance from 10 pm to 11 pm": during a window, the **monitoring alerts** of its subjects are held — probes, readings, thresholds, domains. Security, deployments, backups and forecasts always go through. **Maintenance** (`maintenance:read`, scheduling `maintenance:manage`):

1. **Schedule** — or **Put in maintenance** from a target's or a probe's record;
2. the period, in the instance's time zone — a month at most;
3. the subjects: targets and probes. A target covers the probes of the applications running on it and their domains;
4. save: `maintenance.started` is announced at the start.

At the end, what is **still** down goes out — an outage repaired during the window wakes nobody —, then `maintenance.ended` says what was held. A window in progress is ended with **End now**, never deleted.

## Status pages and announcements

**Status pages** composes public pages, without sign-in, at `/status` or `/status/{address}` (`status_page:manage`):

| Block | What it shows |
|---|---|
| Overall status | operational, degraded, partial or major outage, maintenance — and the latest announcement |
| Title, Text | what you write, as plain text |
| Services | probes under a public name, with a bar per day over 30 days and the availability rate |
| Maintenance | windows in progress and upcoming that affect these services |
| Recent incidents | the outages of these services over 7, 14 or 30 days, with their announcements |

A page shows **chosen labels** and states — never a URL, an error message or a machine's name. An unpublished page answers 404.

During an outage, **Announcements** (`status_page:announce`) tells visitors what is happening, phase by phase — *Investigating*, *Identified*, *Monitoring*, *Resolved* for an incident; *Scheduled*, *In progress*, *Completed* for a maintenance.

## Notifications

**Settings → Notifications** (`settings:manage`): channels that relay the activity log's events.

| Channel | What it needs |
|---|---|
| Email (SMTP) | host, port, security (`starttls`, `implicit` or `none`), account, sender, recipients |
| Telegram | a bot token and a chat id |
| Discord | a webhook URL |
| Webhook | a URL, and an optional token sent as `Authorization: Bearer` |

Each channel subscribes to the events it wants — 24 of them: failed or blocked deployments, rollbacks, successes; security (role changed, API token created, second factor reset, host key changed, pending sign-up); probes down and recovered; machine thresholds and reachability; image updates; failed backups; domains down, certificates expiring and renewed; maintenance start and end; forecasts. **Send a test** checks the channel, then really sends. Messages are written in the instance's language; bursts are grouped.

> [!NOTE]
> An event that is not in the activity log cannot be notified: notifications are built from it. A channel that fails never breaks the action it reports — its failures show on the channel.

## Scheduled tasks

**Jobs** (`job:read`, acting `job:manage`): what triggers by itself, through the queue — never a Linux cron.

| Type | What it does | What it never does |
|---|---|---|
| `scan` | scans again what is in service | redeploy, block |
| `healthcheck` | probes what is in service, records its health | roll back |
| `cleanup` | removes old releases, keeping five and the current one | touch the version in service |
| `preflight` | checks every target again | change a target |
| `backup` | backs up the applications with automatic backup | restore |
| `panel_backup` | backs up the panel's database | restore |

A cadence is entered simply ("every day at 3 am") or as a cron expression, with its own time zone. **Run** triggers an occurrence now, even on a disabled task — to try it before enabling it.

## Backups

Two things are backed up: **the panel's database** — everything Pupitre knows — and **each application's volumes**. Code, images and AppSpecs are not: the AppSpec is in the database, images are pulled or rebuilt.

### The destination

**Settings → Backups** (`settings:manage`), one destination, **off the panel's machine**:

| Type | What to give |
|---|---|
| S3 storage | endpoint, region, bucket, prefix, access and secret keys — AWS, Scaleway, OVH, Backblaze B2, Wasabi, R2, MinIO |
| SFTP | host, port, account, folder, password or private key, the host's fingerprint |
| Mounted folder | a folder of the worker's machine, mounted at `/backups` |

Each save is followed by a test — write, read back, delete. Every backup is encrypted, file by file, under a key derived from `MASTER_KEY`.

### An application's backups

On the application's **Backups** tab (`backup:read`, settings `backup:manage`):

- **Automatic backup** — every night at 02:00 by default, adjustable in **Jobs**;
- **Before each deployment or update** — the pipeline's `backup` step; if it fails, the deployment does not start;
- **Mode** — hot or brief stop;
- **Retention** — the last 3, then one per day for 7 days, per week for 4 weeks, per month for 6 months.

### Hot or brief stop

**Hot**, nothing stops: PostgreSQL (and PostGIS, pgvector, TimescaleDB), MySQL, MariaDB and MongoDB are exported with their own tool — consistent by construction —, the other volumes are archived as they are. **Brief stop**: the application stops, every volume is archived, it starts again — the right mode for a database Pupitre does not recognize, such as SQLite.

### Restore an application

**Restore** on a backup (`backup:restore`):

1. choose the target to restore on — another one, even of the other runtime, is possible;
2. keep **back up the current state** ticked: the restore can then be undone;
3. confirm: every chunk is downloaded and verified before anything is touched; volumes are replaced, exports replayed, the application restarts.

The deployed code and version do not change: only the data goes back.

### The panel's database

**Back up now**, and an automatic backup at 01:30 by default. It is restored from the command line, panel and worker stopped:

```bash
docker compose stop panel worker
docker compose run --rm worker backup list
docker compose run --rm worker backup restore-panel panel/<folder> --yes
docker compose start panel worker
```

> [!CAUTION]
> `MASTER_KEY` is not in the backups, and without it none can be read. Keep it — with `BETTER_AUTH_SECRET` — somewhere else than the panel's machine.

### If the panel's machine is lost

On a new machine: the same `.env` — the same `MASTER_KEY` above all —, `docker compose up -d postgres redis`, then `backup restore-panel` from the destination (configure it on an empty panel first, or download the `panel.dump.pupb` file and pass it). The restored database knows the applications' backups: restore them from their pages.

# Troubleshooting

From the symptom to the cause. Each section says what you see, why it happens, and what to do. When nothing here matches, the last section says where to look.

## A target is unreachable

**Seen**: the target is **unreachable**, its preflight fails at `ssh`, `target.unreachable` in the activity log.

| Cause | What to do |
|---|---|
| The machine is off, or the address changed | start it; correct the host on the record — the host key is then recorded again |
| A firewall drops the worker's SSH | allow the panel's machine on the SSH port |
| Authentication refused | check the account and the key on the machine (`authorized_keys`, permissions 600); edit the target to paste the key again |
| The host key changed | see below |

Pupitre does not retry an authentication failure: an invalid key will not become valid, and some machines ban the address.

## The host key changed

**Seen**: a banner on the target's record, with two fingerprints; every connection refused.

Check on the machine itself — `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` — that the new fingerprint is the one shown. Reinstalled machine and matching fingerprint: **Accept the new key**. Anything else: **Keep the old one**, and find out who answers at that address. See [Targets](/docs/targets#the-host-key).

## A deployment fails

Open the run's drawer: the failed step is red, and its log ends with the reason.

| Step | Common causes | What to do |
|---|---|---|
| `preflight` | the runtime is unavailable; the disk is full; the central proxy cannot reach the machine | run the target's preflight; free space; **Test the link** on the **Reverse proxy** tab |
| `allocate_port` | the target's range is exhausted | widen the range on the target, or destroy what no longer serves |
| `upload` | no space left, or `sudo` refused | free space; check the sudo method of the target |
| `build` | the Dockerfile fails; no code — no archive, an archive refused, a missing Dockerfile | read the build log; upload an archive; check the contexts against the code |
| `scan` | a vulnerability above the threshold | fix the image, accept the vulnerability with a reason, or adjust the policy — see [Security scans](/docs/security-scans) |
| `backup` | the destination does not answer | **Test** the destination in **Settings → Backups** |
| `deploy` | the image cannot be pulled (private, wrong tag); a port already taken on the machine | `docker login` on the machine for a private registry; check the tag |
| `healthcheck` | the application does not answer on its port or path | see below |
| `proxy` | the proxy refuses the configuration | read the message — BunkerWeb gives nginx's; **Test** the proxy |

## The healthcheck fails

**Seen**: `healthcheck` failed, the deployment is `rolled_back` (or `failed` at a first deployment). The log holds the containers' or pods' state and their last lines, captured before the rollback.

- **unreachable** — nothing answers: the process crashed at start (read its log lines), or it listens on another port than the AppSpec's `port`;
- **unhealthy** — it answers, outside 2xx and 3xx: wrong `healthcheck.path`, a missing variable or secret, the database not ready yet;
- **too slow** — raise `retries` and `intervalSec`; an application that migrates its database at start needs time.

A built image runs with a read-only root, as an unprivileged user: it must listen above 1024 and write only to `/tmp` and its volumes.

## The domain does not answer

| Seen on the Domains card | Cause | What to do |
|---|---|---|
| does not resolve | no DNS record yet | create the A or AAAA record toward the proxy's machine |
| points elsewhere | the DNS leads to another machine | fix the record — or ignore it behind a CDN |
| certificate pending | the HTTP-01 challenge does not succeed | port 80 open from the Internet, DNS pointing to the proxy, the authority's limits — try **staging** |
| route down | the proxy is off, the route missing, or the application silent | **Test** the proxy; **Apply** the domains; check the application on **Servers** |

## A token is refused

| Answer | Cause | What to do |
|---|---|---|
| `401 token_invalid` | the header is malformed, or the token unknown | send `Authorization: Bearer pup_…`, the whole token |
| `401 token_revoked`, `token_expired` | revoked, or past its expiry | create a new token |
| `403 forbidden` | the permission named in `details` is missing — from the token, or from you now | give it to the token, or ask for it |
| `403 token_scope` | a token limited to applications, on a route that does not accept it | use a token valid on every application for that route |
| `403 token_refused` | a route done from the panel only | do it from the panel |
| `403 two_factor_required` | the instance requires a second factor your account does not have | enable it in [My account](/account) |

`GET /api/me` with the token says what it really holds.

## Notifications do not arrive

1. **Send a test** on the channel: the probe and the real send are reported separately;
2. check that the channel is subscribed to the event;
3. a maintenance window may be holding monitoring alerts on that subject;
4. the channel's last error shows on its row — a refused SMTP login, a revoked Telegram bot.

## A page or an action is refused

The refusal screen names the missing permission. A screen you do not see in the navigation is one your role cannot open. Ask an administrator for the permission — **Roles** shows which role carries it.

## Where to look

- **The run's log** — every step, every command that changed the machine, the scan verdicts.
- **The activity log** — who did what, every refusal and its reason, the failures of the panel's own tasks.
- **The containers' logs** of the panel itself:

  ```bash
  docker compose logs --tail=200 panel worker
  curl -s {{origin}}/api/health
  ```

- **The machine** — what Pupitre placed lives in the deployment account's folder, under `apps/{name}/`, one release per deployment.

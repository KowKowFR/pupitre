# Targets

A target is a machine Pupitre deploys to, reached over SSH. This chapter covers declaring one, what the panel checks on it, its host key, its readings, its ports, what runs on it, and how to remove it.

## What a target needs

| Requirement | Detail |
|---|---|
| Linux, reachable over SSH from the worker | key or password authentication; port 22 or another |
| An account that can use `sudo` | without a password (`NOPASSWD`), or with the account's password |
| A runtime | Docker Engine with its `compose` plugin, or K3s (with `kubectl` reading `/etc/rancher/k3s/k3s.yaml`) |
| Common tools | `curl`; `ufw` is used if present and active, never enabled by Pupitre |
| Disk space | images, builds and the scanners' databases (several GiB the first time) |

> [!NOTE]
> The credential you enter is encrypted at once (AES-256-GCM, under `MASTER_KEY`) and never comes back out of the API — not even to the screen that edits the target. Only the worker decrypts it, to open a session.

## Declare a target

From the screen, **Targets → New target** (`target:create`):

1. **Name** — how the panel and the logs will call it (`prod-1`);
2. **Host** and **port** — an address the worker can reach;
3. **Account** and **method** — `key` with the content of the private key, or `password`;
4. **Sudo method** — `nopasswd` or `password`;
5. **Port range** — where Docker applications may be published; the default 30000-32767 is unused on a standard machine;
6. **Labels** — optional `key=value` pairs to sort your fleet;
7. **Create the target**: a preflight starts right away.

The same through the API, the key read from a file:

```bash
jq -n --arg key "$(cat pupitre-target)" '{
  name: "prod-1", host: "203.0.113.10", port: 22,
  sshUser: "deploy", authMethod: "key", credential: $key,
  sudoMethod: "nopasswd"
}' | curl --fail-with-body -X POST {{origin}}/api/targets \
  -H "Authorization: Bearer $PUPITRE_TOKEN" \
  -H "Content-Type: application/json" --data @-
```

## The preflight

The preflight checks the machine, one check at a time, and none blocks the others: a missing `kubectl` only marks K3s unavailable. Only an impossible SSH session is fatal. Run it again from the record (**Preflight** tab) or with `POST /api/targets/{id}/preflight` (`target:update`).

| Check | What it reads |
|---|---|
| `ssh` | the connection and its latency |
| `os` | `uname -a` and `/etc/os-release` |
| `sudo` | whether `sudo -n true` works |
| `tools` | `ufw`, `curl`, `git`, `docker`, `kubectl` |
| `docker` | `docker info` and `docker compose version` |
| `k3s` | the cluster's nodes, those ready, the version |
| `disk` | free space on `/` |
| `memory` | `free -m` |

The outcome sets the target's status:

- **ok** — at least one runtime is usable;
- **degraded** — the machine answers, but nothing can be deployed there;
- **unreachable** — no SSH session could be opened.

## The host key

Pupitre checks the machine's SSH host key the way `ssh` does with its `known_hosts`. At the first contact, its fingerprint (`SHA256:…`) is recorded — the **Configuration** tab shows it. From then on, a machine that presents another key is **refused**: no deployment, no preflight, no reading, until a human decides.

When it happens, the record says so at the top, with both fingerprints:

1. check on the machine itself that the new fingerprint is right:

   ```bash
   for key in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf "$key"; done
   ```

2. the machine was reinstalled and the fingerprint matches? **Accept the new key**;
3. you do not recognize it? **Keep the old one**: connections stay refused, and the alert comes back if the machine keeps presenting it.

The `security.host_key_changed` event can alert your notification channels. Changing a target's host or port forgets its key: it is another machine.

## Readings and thresholds

Every five minutes, the worker reads each machine — load, CPU count, memory available, disk, uptime, system — and keeps thirty days of readings. The record shows the last one; a button asks for a new one (`GET /api/targets/{id}/metrics`).

| Threshold | Default | Readings needed to open |
|---|---|---|
| Disk used | 85 % | 1 |
| Memory used | 90 % | 2 |
| Load per core | 100 % | 3 |

Thresholds are adjustable per machine and work with hysteresis: as many readings below are needed to close the episode. Opening writes `target.threshold.breached`, closing `target.threshold.cleared` — one entry per episode, not per reading. Two missed readings in a row mark the machine **unreachable** (`target.unreachable`, with the reason); the first reading that succeeds closes it (`target.reachable`).

## Ports

The **Ports** tab (`GET /api/targets/{id}/ports`) says, for the target's range, which ports are allocated, to which application, and how many are left. A port is drawn at deployment, checked free on the machine, and released when no version of the application runs there anymore. On K3s, no port is reserved.

## Workloads

The **Workloads** tab lists **everything** running on the machine — what Pupitre deployed, marked as such, and the rest (`workload:read`). Each row offers what its driver allows in its state:

| Action | Docker | K3s | Permission |
|---|---|---|---|
| Log | `docker logs` | `kubectl logs` of every pod of the controller | `workload:manage` |
| Start, stop | `docker start` / `stop` | replicas to zero, then restored | `workload:manage` |
| Restart | `docker restart` | `kubectl rollout restart` | `workload:manage` |
| Update | `docker pull`, identical re-creation | `kubectl rollout restart` | `workload:manage` |
| Delete | `docker rm -f`, volumes kept | `kubectl delete`, PVCs kept | `workload:manage` |
| Console | `docker exec … sh -c` | `kubectl exec … sh -c` | `workload:exec` |

The **console** runs one command at a time in the workload — never on the host —, two minutes and two thousand lines at most, thirty commands a minute. Each command is recorded in the activity log with its exit code; its output, never.

> [!IMPORTANT]
> A workload Pupitre deployed cannot be deleted from here: destroy its deployment instead (`deployment:destroy`), so that the panel releases its port, its domain and its record. Stopping and starting it is done from **Servers**, which keeps its state.

## Firewall

If `ufw` is active, the Docker driver opens the application's port when it is needed — restricted to the proxy's address when another machine's proxy serves it — and closes it on destruction. Each rule carries the comment `pupitre:{application}`, so it can be recognized and removed by name. If `ufw` is absent or inactive, the log says so and nothing is filtered: Pupitre never enables a firewall on a machine it drives over SSH — the surest way to lose it.

## Delete a target

`DELETE /api/targets/{id}` (`target:delete`), or **Delete** on the record. It is a refusal, never a cascade: a target that still carries a deployment pending, in progress or in service answers `409`, with how many. Destroy those deployments first.

A target that only carries history (failed, rolled back, destroyed) may still be held by it. Purge that history first:

```bash
curl --fail-with-body -X POST {{origin}}/api/deployments/purge \
  -H "Authorization: Bearer $PUPITRE_TOKEN" -H "Content-Type: application/json" \
  -d '{"targetId":"<target id>","dryRun":true}'
```

Run it again with `"dryRun": false` once the preview is right (`deployment:purge`).

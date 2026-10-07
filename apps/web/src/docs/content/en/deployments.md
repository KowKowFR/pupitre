# Deployments

A deployment is one run of the pipeline: an application, a target, a runtime, a version. This chapter covers starting one, each step of the pipeline, following it, the healthcheck, rolling back, versions, and the three ways to get rid of a deployment.

## Start a deployment

From the application's record, **Deploy** (`deployment:create`):

1. choose the **target** and the **runtime** it offers;
2. the **Domains** field appears if the target has a proxy — the AppSpec's domain is proposed;
3. **automatic rollback** is ticked by default — keep it;
4. at a first deployment, with `backup:manage` and volumes, two boxes offer to enable automatic backups;
5. **Deploy**: the drawer switches to the run.

Through the API — the answer comes at once, `202`, with the deployment's id:

```bash
curl --fail-with-body -X POST {{origin}}/api/deployments \
  -H "Authorization: Bearer $PUPITRE_TOKEN" -H "Content-Type: application/json" \
  -d '{"applicationId":"'"$APP_ID"'","targetId":"'"$TARGET_ID"'","runtime":"docker"}'
```

| Body field | Meaning |
|---|---|
| `applicationId`, `targetId`, `runtime` | what, where, with which runtime — required |
| `autoRollback` | go back to the previous version if the healthcheck fails — `true` by default |
| `images` | `{ "web": "ghcr.io/acme/web:4f2c1e9" }` — replaces those services' image and saves it in the AppSpec; requires `application:update` too |
| `domains` | the application's whole domain list on this target, replacing the current one |
| `backup` | `{ "enabled": true, "beforeDeploy": true }` at a first deployment, with `backup:manage` |
| `scanConfig` | an explicit scan policy — requires `scan:configure`; the instance can only make it stricter |

## The pipeline, step by step

All eleven steps exist from the start, `pending`; each one goes `running`, then `success`, `failed` or `skipped`. A failure stops the pipeline and marks the rest `skipped`.

| Step | What it does | Skipped when |
|---|---|---|
| `preflight` | checks the target again — runtime, disk, the path from the central proxy if one serves it | never |
| `allocate_port` | reserves a port in the target's range, checked free on the machine | on K3s |
| `render` | writes `compose.yml` and its `.env`, or the Kubernetes manifests | never |
| `upload` | places the release on the machine, with the code to build | never |
| `build` | builds the services that have a Dockerfile, on the machine | no service to build |
| `scan` | runs the scanners on the images; may block | no scanner selected |
| `backup` | backs up the volumes before touching what runs | no "before each deployment" policy, or first deployment |
| `deploy` | starts the new version | never |
| `healthcheck` | probes each service until healthy, or gives up | never |
| `proxy` | sets the domains on the reverse proxy, then probes them | no domain, or no proxy |
| `rollback` | puts the previous version back | the deployment succeeded |

A domain that does not answer at the `proxy` step does not cancel a healthy deployment: the new version runs, the route is marked failed, and the log says why.

## Follow a deployment

The run's drawer has three tabs: **Pipeline** — the steps and the live log —, **Security** — the scan results —, and **Frozen AppSpec** — exactly what was deployed. **Deployments** lists every run, with filters by application, target, status and runtime.

| Status | Meaning |
|---|---|
| `pending` | recorded, waiting for the worker |
| `running` | the pipeline is running |
| `success` | the new version is in service |
| `failed` | a step failed; the previous version, if any, still runs |
| `rolled_back` | the new version failed its healthcheck and the previous one was put back |
| `destroyed` | removed from the machine; the record stays in the history |

From a script, poll the status, then read the log:

```bash
curl -s {{origin}}/api/deployments/$DEPLOYMENT_ID \
  -H "Authorization: Bearer $PUPITRE_TOKEN" | jq '{status, steps: [.steps[] | {key, status}]}'

curl -s "{{origin}}/api/deployments/$DEPLOYMENT_ID/logs/export?format=text" \
  -H "Authorization: Bearer $PUPITRE_TOKEN" | tail -50
```

`GET /api/deployments/{id}/logs` streams the same log live (Server-Sent Events): the history first, then each new line.

## Healthcheck outcomes

| Outcome | What it means |
|---|---|
| `healthy` | the service answers, and answers well (2xx or 3xx over HTTP, an open port over TCP) |
| `unhealthy` | it answers, but badly: it runs and it is broken |
| `unreachable` | nothing answers: container missing, port closed, pod not ready |

Before it gives up, the step captures the scene — the containers' or pods' state and their last log lines — and writes it in the log: the rollback that follows would erase it.

## Automatic rollback

Three conditions, all of them data: the failure is at `healthcheck` (or at `deploy` with a version that never became healthy), `autoRollback` is on, and a previous version exists. The previous release is restarted, then **its** health is checked with **its own** AppSpec. The deployment ends `rolled_back`, painted amber: something went wrong, and the safety net worked.

A failure elsewhere — a blocking scan, a build that fails — rolls nothing back: the previous version never stopped. If the rollback fails in turn, the deployment ends `failed` and names both failures; there is never a second attempt.

## Roll back by hand, or redeploy a version

| | Roll back | Redeploy a version |
|---|---|---|
| Gesture | **Go back to the previous version** on a run | **Redeploy this version** on the **Versions** tab |
| Permission | `deployment:rollback` | `deployment:create` |
| What it does | restarts the previous release still on the machine | runs the whole pipeline again from that version's frozen AppSpec |
| Rebuilds, rescans | no | yes |
| Where | the same target | any target |

```bash
# Roll back
curl --fail-with-body -X POST {{origin}}/api/deployments/$DEPLOYMENT_ID/rollback \
  -H "Authorization: Bearer $PUPITRE_TOKEN"

# Redeploy version <versionId> on another target
curl --fail-with-body -X POST {{origin}}/api/applications/$APP_ID/redeploy \
  -H "Authorization: Bearer $PUPITRE_TOKEN" -H "Content-Type: application/json" \
  -d '{"versionId":"<deployment id>","targetId":"<target id>"}'
```

## Versions and releases

Each deployment is a **version**: its AppSpec is frozen in it. On the machine, it places a **release** in `apps/{name}/{version}-r{number}`, and the images it builds carry the same tag. The last five releases are kept, plus the one in service; the images of a removed release go with it. A version built from an uploaded archive can only be redeployed while its archive is among the last five kept.

## Scans in the pipeline

The `scan` step runs the selected scanners in parallel on the images about to start. With a blocking threshold, a vulnerability at or above it — fixable if the policy says so, and not accepted — fails the step: the deployment does not happen, and the previous version keeps running. See [Security scans](/docs/security-scans).

## Destroy, purge, unblock

| Gesture | Acts on | Permission | Effect |
|---|---|---|---|
| **Destroy** | the machine | `deployment:destroy` | containers or namespace, volumes, release files, port and domains removed; the run stays, `destroyed` |
| **Purge** | the database | `deployment:purge` | the run, its steps and its scans erased; the machine is not touched; the activity log keeps the trace |
| **Unblock** | the database | `deployment:purge` | a run stuck `pending` or `running` with no job behind it becomes `failed`, naming what to check on the machine |

Destroying is refused for a run in progress or already destroyed; purging, for a run in service. A bulk purge takes criteria and a `dryRun`:

```bash
curl --fail-with-body -X POST {{origin}}/api/deployments/purge \
  -H "Authorization: Bearer $PUPITRE_TOKEN" -H "Content-Type: application/json" \
  -d '{"statuses":["failed","rolled_back"],"olderThanDays":30,"dryRun":true}'
```

`GET /api/deployments/stuck` lists the runs the database believes in progress while the queue knows nothing of them — after a worker crash, for instance.

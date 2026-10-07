# Concepts

The ideas Pupitre is built on, and the consequences you meet every day. Read it once: the guides that follow rely on these words without explaining them again.

## The panel and the targets

The **panel** is Pupitre: a web interface, a worker, a PostgreSQL database and a Redis. It holds the descriptions of your applications, the encrypted credentials of your machines, the history, the permissions. It hosts none of your applications.

A **target** is a machine you already own — a VM, a bare-metal server, a cloud instance — that the worker reaches over SSH. The panel installs nothing there without saying so: the deployment logs list every command that changes the machine. Applications run on targets and keep running if the panel is off.

## Runtimes: Docker Compose and K3s

A target offers one or two **runtimes**, detected by its preflight:

| | `docker` | `k3s` |
|---|---|---|
| An application is | a Compose project `app-{name}` | a namespace `app-{name}` |
| A service is | a container (or several replicas) | a Deployment and its pods, behind a Service |
| The proxy reaches it through | a port published on the machine | the cluster Service |
| Images are built with | `docker build`, on the machine | BuildKit in a pod, imported into containerd |
| Data lives in | named volumes | PersistentVolumeClaims |

The same application deploys on both without changing a line: only the target — and its runtime — changes. Everything that differs between the two lives in the **drivers**, never elsewhere.

## The AppSpec

The **AppSpec** is the JSON description of an application: its services, where their image comes from (a registry, or a Dockerfile to build), their port, environment, secrets, volumes, healthcheck, resources, dependencies, and a default domain. It knows neither Docker nor Kubernetes: no restart policy, no namespace, no command. What it does not say, the driver decides.

It is validated by Pupitre — a schema plus cross-field rules: exactly one exposed service, unique names, no dependency cycle, secret aliases that resolve. The [AppSpec reference](/docs/appspec) details every field.

## Applications, deployments, versions

- An **application** is an AppSpec stored in the panel, with what belongs to it in the long run: its secrets, its domains per target, its backup and scan policies, its linked repository if any.
- A **deployment** is one run of the pipeline for an application on a target, with a runtime. It **freezes the AppSpec** it deployed: months later, you still know exactly what ran.
- A **version** is a deployment that can be replayed: redeploying it re-runs the pipeline from its frozen AppSpec, on any target.
- A **release** is the folder a deployment places on the machine, `apps/{name}/{version}-r{number}`. The last five are kept; rolling back restarts the previous one without rebuilding.

## The reverse proxy, domains and upstreams

Three separate notions:

- the **proxy** receives visitors on ports 80 and 443 of a machine and leads them to the right application by domain. Pupitre drives Traefik, BunkerWeb and Nginx Proxy Manager;
- a **domain** (a *route*) is a name served toward an application on a target. It is **unique across the instance**: two applications never claim the same name;
- the **upstream** is how the proxy reaches the application — a port on the machine for Docker, a Service for K3s. The driver announces it; the proxy does not know which runtime it routes to.

A machine without its own proxy can go through another machine's — the **central proxy** — or through a Nginx Proxy Manager outside the targets. See [Reverse proxy and domains](/docs/proxy-and-domains).

## Ports

On Docker, a service the proxy must reach is published on a port of the machine, drawn from the target's range (30000-32767 by default). Two applications never get the same port: the database holds a unique constraint on (target, port). Behind a proxy on the same machine, the port only listens on the loopback — the application is then reachable only through its domains. On K3s, no port is reserved: the cluster's proxy reaches the Service.

## Secrets

An AppSpec only carries secret **names** (`"secrets": ["DATABASE_PASSWORD"]`). Values live in the panel, encrypted, attached to the application: generated at random on the first deployment, or entered by you. They are never readable again — you replace them, you do not read them. An **alias** (`{ "name": "POSTGRES_PASSWORD", "from": "DATABASE_PASSWORD" }`) gives one value two names, for an application and its database that expect the same password differently.

## The queue and the worker

Every long operation — a deployment, a preflight, a backup, a scan, a metrics reading — goes through a **queue** (BullMQ, in Redis). The HTTP route that asks for it records it, puts a job in the queue and answers `202 Accepted` at once; the **worker** executes it over SSH. Consequences:

- a script or an agent must **follow** the operation afterwards: `GET /api/deployments/{id}` until a final status;
- the panel can restart while a deployment runs elsewhere;
- logs travel live: each line is published, then kept with its step.

## Live screens

Screens update themselves: when something changes — a deployment ends, a probe goes down — the panel sends the open screens a signal, and they read themselves again with your permissions. No data travels through this channel, only "this has changed".

## Permissions, roles and the activity log

Every gesture requires a **permission**, written `resource:action` — `deployment:create`, `target:delete`, `audit:read`. A **role** is a set of permissions; an account has one role. The starting roles are *admin*, *operator*, *auditor*, *viewer* and *no-access*, and an administrator can create others. A screen your role cannot open does not appear in your navigation; a refused call answers `403` and names the missing permission.

Everything is recorded in the **activity log**: who did what, when, from which address — refusals included, and API tokens named. See [Administration](/docs/administration).

## API tokens

An **API token** (`pup_…`) lets a script, a CI or an AI agent act **in your name**, without a browser. It carries the permissions you choose among yours, is cut down every time to what you can still do, can be limited to some applications, expires, and can be revoked at any moment. It opens the API, never the interface, and cannot create other tokens. See [API](/docs/api) and [MCP](/docs/mcp).

## Languages

The product speaks French or English, as set for the instance in **Settings → Regional settings**: screens, deployment logs, errors, notifications. Error **codes** in API responses never change with the language; only the human message does.

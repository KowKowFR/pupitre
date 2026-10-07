# Introduction

Pupitre is a self-hosted control plane: from this panel, you deploy web applications to machines you own, over SSH, with Docker Compose or K3s — from one single description. This documentation covers it from A to Z: the concepts, step-by-step procedures, examples to copy, the REST API and the MCP server for AI agents.

## What Pupitre does

- **Deploys your applications** to your machines (the *targets*), over SSH. Images are pulled or built on the machine itself, without a registry.
- **Speaks two runtimes** with the same description: a Docker Compose project or a K3s namespace. Moving an application to the other runtime means choosing another target, not rewriting it.
- **Publishes them under a domain**, through a reverse proxy it drives — Traefik, BunkerWeb (a web application firewall) or Nginx Proxy Manager — with Let's Encrypt certificates.
- **Checks before it deploys**: vulnerability scans (Trivy, Grype) and an SBOM (Syft), with a blocking policy you choose.
- **Rolls back by itself** when the new version does not pass its healthcheck.
- **Watches what runs**: host metrics, HTTP and TLS probes, forecasts, maintenance windows, public status pages, notifications by email, Telegram, Discord or webhook.
- **Backs up** the data of your applications and the panel itself, encrypted, to S3, SFTP or a folder.
- **Keeps track of everything**: roles and permissions, an activity log of every action and every refusal.
- **Lets itself be automated**: a REST API, API tokens tied to your account, CI pipelines, and an MCP server so that an AI agent can drive it.

## The panel orchestrates, it hosts nothing

The most common confusion, cleared up right away: your applications never run inside the panel. They run on the target machines, and keep running if the panel stops.

| | The panel | The target machines |
|---|---|---|
| What it is | four containers: the web interface, a worker, PostgreSQL, Redis | servers or VMs you already own |
| What runs there | Pupitre itself | your applications |
| What to install | Docker | an SSH access — the panel installs what it needs and says so |
| If it stops | you can no longer deploy nor watch | the applications keep answering |

## How a deployment travels

1. You ask for a deployment — from the screen, the API, a CI or an AI agent through MCP.
2. The panel records it with its steps, puts a job in the queue (Redis, BullMQ) and answers at once: `202 Accepted`. It never waits for a machine.
3. The **worker** takes the job, opens an SSH session to the target and runs the pipeline: preflight, port, rendering, upload, build, scan, backup, start, healthcheck, proxy.
4. Each line of the log is published live: the screen follows it, and the activity log keeps the outcome.

```text
 screen · API · CI · MCP
          │  POST /api/deployments
          ▼
       panel ──── 202 ────► queue (Redis / BullMQ)
                                   │
                                worker
                                   │ SSH
                     ┌─────────────┴─────────────┐
               Docker target                K3s target
          Compose project app-blog     namespace app-blog
```

## The vocabulary in one page

| Word | What it means |
|---|---|
| Target | a machine reachable over SSH, where applications are deployed |
| Runtime | how a target runs applications: `docker` (Docker Compose) or `k3s` |
| AppSpec | the neutral JSON description of an application — knows neither Docker nor Kubernetes |
| Application | an AppSpec stored in the panel, with its secrets, domains and history |
| Deployment | one run of the pipeline: an application, a target, a runtime, a version |
| Reverse proxy | the server that receives visitors on ports 80 and 443 and routes them by domain |
| Domain | a name served by the proxy toward an application — unique across the instance |
| Workload | anything running on a target: a container, a pod, a deployment |
| Probe | an HTTP or TLS check of a URL, from the worker |
| API token | a key `pup_…` that acts in your name, without a browser |
| Activity log | the trace of every action and every refusal, with who, when and from where |

The [Concepts](/docs/concepts) chapter explains each of them in depth.

## How this documentation is organized

- **Getting started** — this introduction, the [Quick start](/docs/quick-start) from installation to the first URL, and the [Concepts](/docs/concepts).
- **Guides** — one chapter per area: [Targets](/docs/targets), [Reverse proxy and domains](/docs/proxy-and-domains), [Applications](/docs/applications), [AppSpec reference](/docs/appspec), [Deployments](/docs/deployments), [Repositories and code](/docs/repositories), [Security scans](/docs/security-scans), [Operations](/docs/operations), [Administration](/docs/administration).
- **Automation** — the [REST API](/docs/api), [CI/CD](/docs/ci-cd) and the [MCP server](/docs/mcp).
- **Reference** — [Troubleshooting](/docs/troubleshooting) and the error codes.

## Where to start

- **A new instance?** Follow the [Quick start](/docs/quick-start): in about fifteen minutes, a first application answers under its domain.
- **You want to automate?** Create an API token from [My account](/account), then read [API](/docs/api), [CI/CD](/docs/ci-cd) or [MCP](/docs/mcp).
- **Something fails?** [Troubleshooting](/docs/troubleshooting) goes from the symptom to the cause.

> [!TIP]
> The search field above the chapters looks into every chapter at once, accents ignored: try `rollback`, `token` or `pupitre.json`.

> [!NOTE]
> What you can do depends on your role. This documentation describes every screen; those your role cannot open do not appear in your navigation — ask an administrator for the permission named in the chapter.

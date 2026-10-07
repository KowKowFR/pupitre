# AppSpec reference

The AppSpec is the JSON description of an application. It says *what* the application is — services, images, ports, data, secrets, domain — and never *how* a runtime runs it. This chapter documents every field, the rules Pupitre checks, and complete examples.

## The shape

```json
{
  "name": "blog",
  "version": "1.4.2",
  "services": [ { "name": "web", "...": "..." } ],
  "ingress": { "host": "blog.example.com", "tls": true, "targetService": "web" }
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `name` | string | yes | the application's name: kebab-case, 2 to 48 characters (`blog`, `shop-api`). It becomes `app-{name}` on the machines |
| `version` | string | yes | a semver version (`1.4.2`, `2.0.0-rc.1`) — yours, shown in the history |
| `services` | array | yes | at least one service |
| `ingress` | object | no | the default domain, and the service it leads to |

## A service

| Field | Type | Default | Meaning |
|---|---|---|---|
| `name` | string | — | kebab-case, unique in the application; also its hostname for the other services |
| `source` | object | — | where the image comes from: a registry, or a Dockerfile to build |
| `port` | integer | — | the port the service listens on inside its container |
| `exposed` | boolean | `false` | the service visitors reach — **exactly one** per application |
| `replicas` | integer | `1` | how many copies run (1 to 50) |
| `env` | object | `{}` | plain variables, `NAME_IN_CAPITALS: "value"` |
| `secrets` | array | `[]` | secret names, or aliases `{ "name", "from" }` |
| `resources` | object | 500 m CPU, 512 Mi | `cpuMilli` (10 to 64000) and `memoryMi` (16 to 262144) |
| `healthcheck` | object | path `/`, every 10 s | how to know the service is healthy |
| `volumes` | array | `[]` | persistent data: `{ "name", "mountPath", "size" }` |
| `dependsOn` | array | `[]` | the services to start before this one |

## Source: an image or a Dockerfile

An image from a registry, by its tag:

```json
{ "type": "image", "ref": "postgres:16-alpine" }
```

Or a Dockerfile, built **on the target machine** from the code — a linked repository's commit, or an uploaded archive:

```json
{ "type": "dockerfile", "context": "services/api", "dockerfile": "Dockerfile" }
```

`context` is relative to the root of the code, `dockerfile` relative to `context` (default `Dockerfile`). Neither may be absolute nor contain `..`: a build never leaves the code it was sent.

> [!IMPORTANT]
> An image built by Pupitre runs hardened: a read-only root filesystem, an unprivileged user, no Linux capability. It must therefore listen on a port above 1024 and only write to `/tmp` and its volumes. For nginx, start from `nginxinc/nginx-unprivileged`, which listens on 8080.

## Ports and exposure

`port` is the port **inside** the container. Pupitre decides the rest: on Docker, the exposed service is published on a port drawn from the target's range — on the loopback when a proxy on the machine serves it —; on K3s, it gets a Service. The other services are only reachable by their name, from the application's own services.

Exactly one service is `exposed`: the one the domain and the published port lead to.

## Environment and secrets

```json
"env": { "DATABASE_HOST": "db", "DATABASE_NAME": "blog" },
"secrets": ["DATABASE_PASSWORD", "SESSION_KEY"]
```

- `env` carries **plain** values. Names are in capitals, digits and underscores (`[A-Z_][A-Z0-9_]*`).
- `secrets` carries **names only**. Values live in the panel, encrypted: generated at the first deployment, or entered on the application's **Secrets** tab. They reach the service as environment variables — a `.env` file with mode 0600 on Docker, a Kubernetes `Secret` on K3s.
- A name is in `env` or in `secrets`, never both.

An **alias** gives one secret a second name. An application and its database often expect the same password under two names:

```json
"secrets": [{ "name": "POSTGRES_PASSWORD", "from": "DATABASE_PASSWORD" }]
```

There is still one value: `POSTGRES_PASSWORD` reads `DATABASE_PASSWORD`'s. The `from` must be declared by a service of the application.

## Volumes

```json
"volumes": [{ "name": "data", "mountPath": "/var/lib/postgresql/data", "size": "10Gi" }]
```

- `name` — kebab-case, unique in the service;
- `mountPath` — an absolute path in the container;
- `size` — optional, in Kubernetes units (`500Mi`, `10Gi`): the PersistentVolumeClaim's size on K3s, informative on Docker.

Volumes outlive deployments: redeploying keeps them, destroying the deployment removes them. They are what the application's backups save.

## Healthcheck

```json
"healthcheck": { "path": "/healthz", "port": 8080, "intervalSec": 5, "timeoutSec": 3, "retries": 10 }
```

| Field | Default | Meaning |
|---|---|---|
| `path` | `/` | the HTTP path probed on the exposed service |
| `port` | the service's `port` | another port to probe |
| `intervalSec` | 10 | seconds between two attempts (1 to 300) |
| `timeoutSec` | 5 | seconds before an attempt fails (1 to 120) |
| `retries` | 3 | attempts before declaring the service unhealthy (1 to 50) |

The exposed service is probed over HTTP — a 2xx or 3xx answer is healthy; the others over TCP, since a database image ships no HTTP client. The wait between attempts grows, capped at 30 seconds. Give a slow application enough `retries`: a failed healthcheck rolls the deployment back.

## Resources and replicas

`resources` sets what the service may use — `cpuMilli` (1000 = one core) and `memoryMi`. `replicas` runs several copies.

> [!NOTE]
> On Docker, an exposed service with more than one replica cannot be published on a port — Compose cannot spread a published port over several containers —, so a proxy cannot reach it. On K3s, the Service spreads the traffic. Keep exposed services at one replica on Docker.

## Dependencies

`dependsOn` lists the services to start first. The names must exist, a service cannot depend on itself, and the graph cannot loop (`a → b → a` is refused, with the cycle named).

## Ingress

```json
"ingress": { "host": "blog.example.com", "tls": true, "targetService": "web" }
```

`host` is the **default** domain, used at the first deployment on a target; afterwards the domains are set per target on the application's **Domains** tab. `tls` asks for HTTPS (default `false` here; the deployment screen proposes HTTPS). `targetService` names the service the domain leads to. Without `ingress`, the application is reached through its published port.

## The rules checked

Beyond the types, Pupitre refuses an AppSpec when:

- two services share a name;
- no service, or more than one, is `exposed`;
- a `dependsOn` names an unknown service, the service itself, or makes a cycle;
- two volumes of a service share a name;
- a name is both in `env` and in `secrets`, or a secret is declared twice;
- an alias points to itself, to an undeclared secret, contradicts another alias, makes a cycle, or a name is declared both bare and as an alias;
- `ingress.targetService` names no service.

Each refusal names the field and its path (`services.1.dependsOn.0`).

## Examples

### A static site built from a Dockerfile

```json
{
  "name": "bonjour",
  "version": "1.0.0",
  "services": [
    {
      "name": "web",
      "source": { "type": "dockerfile", "context": "examples/bonjour" },
      "port": 8080,
      "exposed": true,
      "healthcheck": { "path": "/", "intervalSec": 5, "timeoutSec": 3, "retries": 10 },
      "resources": { "cpuMilli": 250, "memoryMi": 64 }
    }
  ]
}
```

With its Dockerfile, in `examples/bonjour/`:

```dockerfile
FROM nginxinc/nginx-unprivileged:1.29-alpine
COPY index.html /usr/share/nginx/html/index.html
```

### An API with PostgreSQL

```json
{
  "name": "blog",
  "version": "1.4.2",
  "services": [
    {
      "name": "web",
      "source": { "type": "image", "ref": "ghcr.io/example/blog:1.4.2" },
      "port": 8080,
      "exposed": true,
      "env": { "DATABASE_HOST": "db", "DATABASE_NAME": "blog" },
      "secrets": ["DATABASE_PASSWORD"],
      "healthcheck": { "path": "/healthz", "retries": 5 },
      "resources": { "cpuMilli": 500, "memoryMi": 512 },
      "dependsOn": ["db"]
    },
    {
      "name": "db",
      "source": { "type": "image", "ref": "postgres:16-alpine" },
      "port": 5432,
      "env": { "POSTGRES_DB": "blog", "POSTGRES_USER": "blog" },
      "secrets": [{ "name": "POSTGRES_PASSWORD", "from": "DATABASE_PASSWORD" }],
      "volumes": [{ "name": "data", "mountPath": "/var/lib/postgresql/data", "size": "10Gi" }]
    }
  ],
  "ingress": { "host": "blog.example.com", "tls": true, "targetService": "web" }
}
```

### WordPress and MariaDB, one password

```json
{
  "name": "site",
  "version": "1.0.0",
  "services": [
    {
      "name": "wordpress",
      "source": { "type": "image", "ref": "wordpress:6-apache" },
      "port": 80,
      "exposed": true,
      "env": { "WORDPRESS_DB_HOST": "mariadb", "WORDPRESS_DB_USER": "wp", "WORDPRESS_DB_NAME": "wp" },
      "secrets": [{ "name": "WORDPRESS_DB_PASSWORD", "from": "MARIADB_PASSWORD" }],
      "volumes": [{ "name": "content", "mountPath": "/var/www/html", "size": "5Gi" }],
      "healthcheck": { "path": "/wp-login.php", "retries": 10 },
      "dependsOn": ["mariadb"]
    },
    {
      "name": "mariadb",
      "source": { "type": "image", "ref": "mariadb:11" },
      "port": 3306,
      "env": { "MARIADB_USER": "wp", "MARIADB_DATABASE": "wp" },
      "secrets": ["MARIADB_PASSWORD", "MARIADB_ROOT_PASSWORD"],
      "volumes": [{ "name": "data", "mountPath": "/var/lib/mysql", "size": "5Gi" }]
    }
  ],
  "ingress": { "host": "www.example.com", "tls": true, "targetService": "wordpress" }
}
```

The `wordpress` image comes from a registry: it keeps the user its image chooses and a writable root — Pupitre only drops the Linux capabilities it does not need and forbids privilege escalation —, so it may listen on port 80 inside its container.

### A monorepo

Two applications in one repository, each with its `pupitre.json` in its folder and a build context relative to the repository's root:

```text
repository/
├── apps/shop/pupitre.json      → "context": "apps/shop"
├── apps/shop/Dockerfile
├── apps/admin/pupitre.json     → "context": "apps/admin"
└── apps/admin/Dockerfile
```

Only the changes under a file's folder concern its application.

## Validate before deploying

The editor validates as you type. From a terminal or a CI, without creating anything — the body **is** the AppSpec:

```bash
curl --fail-with-body -X POST {{origin}}/api/appspec/validate \
  -H "Authorization: Bearer $PUPITRE_TOKEN" -H "Content-Type: application/json" \
  --data @pupitre.json
```

`200` returns the AppSpec as Pupitre will store it, defaults applied; `422 invalid_appspec` lists every problem with its path. `GET /api/appspec/schema` returns the JSON Schema — for an editor's autocompletion, or for an agent.

## What the AppSpec does not say

No restart policy, no network, no namespace, no command, no entrypoint, no privileged mode, no host path: the driver decides what can be decided, and what touches isolation is never offered. An image that needs a start command or the Docker socket does not fit an AppSpec — build an image that starts on its own instead.

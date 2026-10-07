# Quick start

From an empty machine to a first application answering under its domain, in eight steps. Each step says what to do, what you should see, and where to look if it does not happen.

## Before you start

| You need | Why |
|---|---|
| A machine for the panel, with Docker and its `compose` plugin | the panel runs as four containers |
| A **target** machine: Linux, reachable over SSH from the panel | it is where applications run |
| On the target, Docker Engine (with `compose`) or K3s | the runtime Pupitre deploys with |
| An account on the target that can use `sudo` | Pupitre installs what it needs and reads the system |
| Optional: a domain whose DNS you control | to serve the application under a name, with HTTPS |

> [!TIP]
> No spare machine? The panel and a target can be the same server — useful to try. The repository also ships throwaway targets in containers: `./scripts/setup-test-target.sh`.

## 1. Install the panel

On the panel's machine, in the repository folder:

```bash
cp .env.example .env
openssl rand -hex 32      # copy into MASTER_KEY
openssl rand -base64 48   # copy into BETTER_AUTH_SECRET
docker compose up -d --build
```

Set `BETTER_AUTH_URL` in `.env` to the address you will open the panel at — for example `https://pupitre.example.com`. The panel refuses writes coming from another address.

Check that everything is up:

```bash
docker compose ps                          # postgres, redis, panel, worker
curl -s {{origin}}/api/health              # {"status":"ok","db":"ok","redis":"ok",...}
```

> [!WARNING]
> `MASTER_KEY` encrypts every SSH key and secret the panel stores. Keep a copy of it, with `BETTER_AUTH_SECRET`, in a password manager: a lost key takes everything it protects with it. It can be rotated later — see [Administration](/docs/administration#master-key-and-its-rotation).

## 2. Create the first account

Open the panel. While no account exists, sign-up is open: **the first account created becomes an administrator**. Afterwards, sign-up depends on `ALLOW_SIGNUP` (off by default), and a newcomer gets the **No access** role until an administrator chooses one.

At the first sign-in, the **setup guide** takes over: identity and language of the instance, first target, reverse proxy, a role, a user, security and AI. Each step is optional except the first; you can follow this chapter instead and run the guide again later from **Settings → Setup guide**.

## 3. Prepare the target machine

On the target, create an account for Pupitre and give it the public key of an SSH key pair you generate for it:

```bash
# On your workstation: a key pair dedicated to Pupitre
ssh-keygen -t ed25519 -f pupitre-target -C pupitre -N ""

# On the target, as root
adduser --disabled-password --gecos "" deploy
usermod -aG docker deploy                                  # Docker targets
echo "deploy ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
cat pupitre-target.pub >> /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
```

`sudo` without a password is the simplest; a `sudo` that asks for the account's password works too — choose **password** as the sudo method when declaring the target.

## 4. Declare the target

**Targets → New target** (permission `target:create`):

1. a name (`prod-1`), the host and SSH port;
2. the account (`deploy`), the method **key**, and the content of the **private** key `pupitre-target`;
3. the sudo method, and the range of ports applications may be published on (30000-32767 by default);
4. **Create the target**.

The panel encrypts the key at once, then runs a **preflight**: SSH, system, sudo, tools, Docker, K3s, disk, memory. The target turns **ok** when at least one runtime is usable. Its host key fingerprint is recorded at this first contact — see [Targets](/docs/targets#the-host-key).

## 5. Give it a reverse proxy

To serve applications under a domain, the target needs a reverse proxy. On its record, tab **Reverse proxy**:

1. **Look at the machine**: Pupitre lists what is already there — a Traefik container, the Traefik of a K3s cluster, a BunkerWeb — without touching anything;
2. found one? **Use this one**. Nothing? Install **Traefik in a container** (the default) or **BunkerWeb** for a web application firewall;
3. choose the certificate authority — **Let’s Encrypt**, or **Let’s Encrypt (staging)** to try without limits;
4. **Test**: ports 80 and 443 answer, and the proxy really reads the routes it is given.

No domain at hand? Skip this step: applications are then reached through their published port.

## 6. Create an application

**Applications → New application** (`application:create`), tab **From JSON**, paste this AppSpec — a single nginx service:

```json
{
  "name": "hello",
  "version": "1.0.0",
  "services": [
    {
      "name": "web",
      "source": { "type": "image", "ref": "nginxinc/nginx-unprivileged:1.29-alpine" },
      "port": 8080,
      "exposed": true,
      "healthcheck": { "path": "/", "retries": 5 }
    }
  ],
  "ingress": { "host": "hello.example.com", "tls": true, "targetService": "web" }
}
```

Replace `hello.example.com` with a name whose DNS points to the target (or remove `ingress`), then **Save**. Nothing is deployed yet: the application exists in the panel.

> [!TIP]
> The **Catalog** offers ready-made applications — Uptime Kuma, Grafana, WordPress, Vaultwarden… — and the tab **From a description** has the instance AI write the AppSpec for you.

## 7. Deploy

Open the application's record and click **Deploy** (`deployment:create`):

1. choose the target and the runtime it offers;
2. check the **Domains** — the AppSpec’s domain is proposed, with HTTPS;
3. leave **automatic rollback** ticked;
4. **Deploy**.

The drawer follows the pipeline step by step, with the live log. A first deployment takes from a few seconds (an image to pull) to a few minutes (a build, a first scan that downloads its databases). At the end, the deployment is **success** and its URL answers.

## 8. Check, then go further

- **Servers** shows the application running on its machine, its state and its logs.
- **Domains** shows the domain, whether it answers through the proxy, and its certificate's expiry.
- **Monitoring** — add an HTTP probe on the URL to be alerted if it stops answering.

Then, depending on what you need:

- deploy from your code: [Repositories and code](/docs/repositories);
- write a richer application: [AppSpec reference](/docs/appspec);
- deploy from a CI: [CI/CD](/docs/ci-cd);
- let an AI agent drive the panel: [MCP](/docs/mcp).

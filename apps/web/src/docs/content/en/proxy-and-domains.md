# Reverse proxy and domains

How visitors reach your applications by name: the reverse proxy of each machine, the domains, the certificates, the web application firewall, a proxy shared by several machines, and Nginx Proxy Manager.

## Why a reverse proxy

A machine has one port 80 and one port 443, and several applications. The **reverse proxy** listens there and leads each visitor to the right application according to the domain they asked for. Pupitre drives it: once a machine has a proxy, deploying an application with a domain is enough — the route and the certificate follow.

A machine without a proxy stays usable: its applications are reached through their published port, without a domain name.

## The three proxies

| Proxy | Where it runs | What it brings |
|---|---|---|
| **Traefik** — the default | a container on a Docker machine, a binary, or the one a K3s cluster ships | routes and certificates; Pupitre writes one file per application, or `Ingress` objects in a cluster |
| **BunkerWeb** | a container on a Docker machine, driven through its API | everything Traefik does, plus a web application firewall, per domain |
| **Nginx Proxy Manager** | outside the targets, on a machine Pupitre does not drive | its API is enough: Pupitre creates its "proxy hosts" and their certificates |

## Take over or install a proxy

On the target's record, tab **Reverse proxy** (`target:update`):

1. **Look at the machine** — Pupitre lists what is there, without touching anything: a Traefik container whose `file` provider watches a folder mounted from the machine, a Traefik binary, the Traefik of a K3s cluster, a BunkerWeb whose API is enabled;
2. a usable proxy is found? **Use this one**. Its settings (entry points, watched folder, certificate resolver) are read; what is missing becomes a warning. Pupitre will never uninstall a proxy it did not set up;
3. nothing usable? Choose an installation:
   - **Traefik in a container** — `traefik:v3.7`, host network, ports 80 and 443, no Docker socket, no dashboard, certificates in a volume;
   - **the K3s Traefik** — not replaced: configured with an ACME resolver and a volume for its certificates;
   - **BunkerWeb in a container** — the all-in-one image (about 2.1 GB, 650 MB of memory at rest), its API enabled, its web interface not;
4. choose the certificate authority: **Let’s Encrypt**, **Let’s Encrypt (staging)** to try without rate limits, **ZeroSSL** (BunkerWeb), or **another ACME server** (Traefik: step-ca, Smallstep…);
5. wait for the connection to turn **ok**, then **Test**.

An installation is refused if ports 80 or 443 are already taken by another server, or if the disk cannot hold the image.

## Test and remove

**Test** checks that ports 80 and 443 answer, and that the proxy really reads what it is given: a test route toward a closed port is placed — read, it gives 502; ignored, 404 — then removed. The last test stays visible, point by point.

**Remove** is refused while domains go through the proxy. A proxy Pupitre installed can be uninstalled at the same time: container and folder removed, or the K3s configuration restored.

## Set an application's domains

At deployment — in the application's drawer as in **New application** —, a **Domains** field appears as soon as the target has a proxy: one name per line, HTTPS ticked by default (HTTP then redirects to HTTPS).

- Each name is checked against DNS — "points to this machine", "points elsewhere", "does not resolve yet" — to **warn, never to refuse**: behind a CDN or a NAT, the public address is not the one the panel uses.
- A domain is **unique across the instance**: claiming it for a second application is refused, naming the first.
- The AppSpec's `ingress.host` is only a default, used at the first deployment on a target; afterwards, the target's list is authoritative.

Later, the **Domains** card of the application shows, target by target, each domain, whether it answers through the proxy, and until when its certificate runs. **Edit** changes the list; if the application is running, it is applied to the proxy right away, without redeploying (`deployment:create`).

Through the API, the whole list for one target:

```bash
curl --fail-with-body -X PUT {{origin}}/api/applications/$APP_ID/routes \
  -H "Authorization: Bearer $PUPITRE_TOKEN" -H "Content-Type: application/json" \
  -d '{"targetId":"'"$TARGET_ID"'","routes":[
        {"hostname":"shop.example.com","tls":true,"redirectHttps":true},
        {"hostname":"www.shop.example.com","tls":true,"redirectHttps":true}]}'
```

## Certificates

Certificates are obtained by the proxy through the **HTTP-01** challenge. For it to succeed:

- the domain's DNS points to the machine that receives visitors (the proxy's);
- port 80 of that machine is reachable from the Internet;
- the authority's rate limits are not exhausted — use **staging** to try.

While waiting, the proxy serves its default certificate and the Domains card says **pending**. Let’s Encrypt renews at thirty days from expiry; a certificate entering its last fourteen days writes `route.certificate.expiring`, once per certificate, and its renewal `route.certificate.renewed`.

> [!NOTE]
> Wildcard certificates (`*.example.com`) need the DNS-01 challenge, which Pupitre does not set up. A wildcard already present in a Nginx Proxy Manager is reused as is.

## Protect a domain with BunkerWeb

Behind BunkerWeb, each domain has its own protection, chosen in the **Domains** field and editable from the application's page:

| Protection | What BunkerWeb does |
|---|---|
| **Protection** (default) | blocking ModSecurity with the OWASP CRS rules; 100 requests per second and 100 connections per address; an address piling up thirty errors in a minute is banned for an hour |
| **Detection only** | the same checks, logged in BunkerWeb, nothing blocked — to check an application is not hindered before switching to Protection |
| **No WAF** | no inspection, no limit: BunkerWeb relays |

What you add by hand in BunkerWeb on Pupitre's services stays from one deployment to the next; a domain BunkerWeb already serves by hand is refused, saying so. Pupitre's probes pass the WAF with a secret header generated on the machine.

## One proxy for several machines

A machine does not need its own proxy: it can go through another machine's — the **central proxy**. On its record, tab **Reverse proxy**, without a proxy of its own:

1. **Or go through another machine's reverse proxy** — choose the proxy;
2. give **this machine's address as seen from the proxy's machine** — a private address (LAN, VLAN, WireGuard) keeps the traffic at home; a public one sends it in clear over the Internet, and the card says so;
3. **Link**: Pupitre tests the real path right away — an ephemeral listener on this machine, in the applications' port range, that the proxy's machine must reach and that must answer with a token drawn for the occasion.

The result names what blocks: "no answer within 5 s" (a firewall that drops), "refuses the connection" (a firewall that rejects, or another machine), "it is not this machine" (a NAT). The same test runs **before each deployment** with domains on the machine: a blocked path fails the preflight, before any build.

| Runtime | How the application is published | Restricted to the proxy by |
|---|---|---|
| Docker Compose | a port, on the given address | the publication address, and `ufw` opened to the proxy's address only |
| K3s | a `NodePort` (30000-32767) | a `NetworkPolicy` that only accepts the proxy's address |

## Nginx Proxy Manager

A Nginx Proxy Manager (2.x) often runs on a separate machine that serves a whole network. Pupitre talks to its **API** with an account of its own, and only touches the hosts it created.

1. In NPM, *Users* → an account for Pupitre, **without two-factor authentication**, with **Manage** on *Proxy Hosts* and *SSL Certificates*, and **Created Items** visibility;
2. on a target's record, tab **Reverse proxy**: **Connect a Nginx Proxy Manager**:

| Field | What to give |
|---|---|
| Interface address | NPM's administration, which carries its API — often `http://machine:81`; over HTTP, a private network only |
| Email, password | those of Pupitre's account; the password is encrypted at once |
| Where it receives visitors | optional: where the panel probes the domains; empty, the interface's machine on 80 and 443 |

3. **Connect** tests the API, the account and its rights; a connection that does not get in is not kept;
4. link each machine NPM serves to it, with **its address as seen from NPM**, as for the central proxy.

NPM requests its certificates itself from Let’s Encrypt; a certificate it already holds for the domain is reused.

## The Domains page and inspection

**Domains** (`application:read`) gathers every domain of the instance: its application and machine, the proxy serving it, its state, the last probe, and its certificate with the days left. **To watch** keeps those that do not answer or whose certificate is under fourteen days. Nothing is edited there: a domain is set on its application.

A click opens its drawer; a few seconds later the **inspection** arrives, made on the spot by the worker: DNS records and whether they lead to the proxy's machine, addresses and reverse names, the registration (RDAP), the zone (NS, MX, CAA) and the certificate presented.

## What raises an alert

Every ten minutes, each domain is probed through its proxy. Two failures in a row write `route.down` — with the reason: proxy off, route missing, silent application —; recovery writes `route.recovered`. With the two certificate events, these are the four domain events your notification channels can follow — see [Operations](/docs/operations#notifications).

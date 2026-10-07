# MCP server

Pupitre is an MCP server: an AI agent — Claude Code, Claude Desktop, Cursor, VS Code, or any client of the Model Context Protocol — connects to it with an API token and drives the panel in plain language: "deploy shop on prod-1 and tell me if it worked". It acts with the token's permissions, and every action lands in the activity log.

## What MCP brings

- **Everything the API does, an agent does**: typed tools for the common work — targets, applications, deployments, logs, rollback, domains, secrets — and a generic tool for every other route.
- **The same rights as you, or fewer**: the agent uses an API token tied to your account, cut down to what you can still do, possibly limited to some applications.
- **The same safeguards**: each tool goes through the REST route that does the same thing — permissions, validation, refusals, activity log. The MCP layer decides nothing.
- **The documentation built in**: the agent can read this documentation — chapters and search — to know how Pupitre works before acting.

## The endpoint

| | |
|---|---|
| Address | `{{origin}}/api/mcp` |
| Transport | Streamable HTTP, stateless — one `POST` per message, a JSON answer |
| Authentication | `Authorization: Bearer pup_…` — an API token, never a browser session |
| HTTPS | required — plain HTTP gets `403 https_required`, except from the machine itself (`localhost`, an SSH tunnel) |
| Protocol revisions | `2025-11-25`, `2025-06-18`, `2025-03-26` |
| Capabilities | tools, resources |

The agent's machine must reach the panel's address — over the private network, a VPN or a tunnel if the panel is not public.

Check it from a terminal — macOS, Linux, or Windows with WSL or Git Bash:

```bash
curl -s {{origin}}/api/mcp \
  -H "Authorization: Bearer $PUPITRE_TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq -r '.result.tools[].name'
```

On Windows, in PowerShell — without `curl` nor `jq`:

```powershell
$headers = @{ Authorization = "Bearer $env:PUPITRE_TOKEN"; Accept = "application/json, text/event-stream" }
$body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
(Invoke-RestMethod -Method Post -Uri "{{origin}}/api/mcp" -Headers $headers `
  -ContentType "application/json" -Body $body).result.tools.name
```

Both list the 41 tools.

## Serve the panel over HTTPS

The MCP server only answers over **HTTPS**: an agent's token usually carries all its author's permissions, and over plain HTTP anyone on the path reads it at every call. A request in clear gets `403 https_required`, and the refusal is written to the activity log under the token's account — that token travelled in clear: revoke it. Only the machine itself is exempt: `localhost`, hence an SSH tunnel.

### With the machine's Traefik

When the panel runs on a machine where Pupitre installed Traefik — the reverse proxy of a target —, that Traefik can serve the panel too, with a Let’s Encrypt certificate.

1. Point a domain to the machine: an `A` record, `pupitre.example.com` → its public address.
2. Find the folder Traefik watches, on the machine:

   ```bash
   docker inspect pupitre-traefik | grep -B1 '"Destination": "/etc/traefik/dynamic"'
   ```

3. In that folder, write `_panel.yml` — a name no application can take, so Pupitre never touches it:

   ```yaml
   http:
     routers:
       pupitre-panel:
         rule: Host(`pupitre.example.com`)
         entryPoints: [websecure]
         service: pupitre-panel
         tls:
           certResolver: pupitre
       pupitre-panel-http:
         rule: Host(`pupitre.example.com`)
         entryPoints: [web]
         middlewares: [pupitre-panel-https]
         service: pupitre-panel
     middlewares:
       pupitre-panel-https:
         redirectScheme:
           scheme: https
           permanent: true
     services:
       pupitre-panel:
         loadBalancer:
           servers:
             - url: http://127.0.0.1:3000
   ```

4. In the panel's `.env`: the panel's new address, and its port on the loopback only — Traefik reaches it there, the Internet no longer does:

   ```bash
   BETTER_AUTH_URL=https://pupitre.example.com
   WEB_PORT=127.0.0.1:3000
   ```

5. Restart, then check:

   ```bash
   docker compose up -d
   curl -s https://pupitre.example.com/api/health
   ```

The certificate is requested at the first HTTPS visit; port 80 must be reachable from the Internet for the challenge. Open the panel at its new address from then on: sign-in and writes are tied to `BETTER_AUTH_URL`. Any other reverse proxy does the job — a cluster's Traefik, Caddy, nginx — as long as it terminates TLS and passes `X-Forwarded-Proto: https` to port 3000.

### Without a domain: an SSH tunnel

The tunnel encrypts everything between your workstation and the machine, and the panel sees a `localhost` request:

```bash
ssh -N -L 3000:localhost:3000 account@machine
```

The command is the same in PowerShell. Leave it running, and use `http://localhost:3000` as the panel's address in the client.

## Create a token for an agent

[My account](/account) → **API tokens** → **New token**:

1. a name — "Claude Code — laptop": the activity log will say "through the token *Claude Code — laptop*";
2. what it can do — **Everything I can do** for an agent that operates the whole panel, **Read** for an agent that only looks, **Custom** for anything in between;
3. optionally **only these applications**: the agent can then deploy them, follow and roll them back, and nothing else;
4. an expiry — 30 or 90 days for an agent;
5. **Create the token**: the drawer shows it once, with the commands below ready to paste.

> [!WARNING]
> The agent can do everything the token allows, including destroying deployments if the token holds `deployment:destroy`. Give it what it needs, keep your MCP client's confirmation on for actions, and revoke the token when the agent no longer needs it.

## Connect a client

In each example, the token is in the `PUPITRE_TOKEN` environment variable. On macOS and Linux: `export PUPITRE_TOKEN=pup_…`. On Windows, in PowerShell:

```powershell
$env:PUPITRE_TOKEN = "pup_…"                                                  # this window only
[Environment]::SetEnvironmentVariable("PUPITRE_TOKEN", "pup_…", "User")        # for good, for the clients
```

A client launched from the Start menu — Cursor, VS Code, Claude Desktop — only sees a variable set "for good", and only once reopened.

> [!TIP]
> The **New token** drawer shows a `claude mcp add` command with the token already written in it, on one line: it pastes as it is into bash, zsh, PowerShell and cmd.

### Claude Code

```bash
claude mcp add --transport http pupitre {{origin}}/api/mcp \
  --header "Authorization: Bearer $PUPITRE_TOKEN"
```

Or, shared in a project's `.mcp.json` — the token stays in each person's environment:

```json
{
  "mcpServers": {
    "pupitre": {
      "type": "http",
      "url": "{{origin}}/api/mcp",
      "headers": { "Authorization": "Bearer ${PUPITRE_TOKEN}" }
    }
  }
}
```

On Windows, in PowerShell:

```powershell
claude mcp add --transport http pupitre {{origin}}/api/mcp --header "Authorization: Bearer $env:PUPITRE_TOKEN"
```

`/mcp` in Claude Code shows the server connected and its tools; `claude mcp list` says whether it answers.

### Claude Desktop

Claude Desktop starts local servers: the `mcp-remote` bridge relays to the panel. It needs Node.js on the machine. In `claude_desktop_config.json` — `~/Library/Application Support/Claude/` on macOS, `%APPDATA%\Claude\` on Windows (**Settings → Developer → Edit Config**):

```json
{
  "mcpServers": {
    "pupitre": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "{{origin}}/api/mcp", "--header", "Authorization:${PUPITRE_AUTH}"],
      "env": { "PUPITRE_AUTH": "Bearer pup_…" }
    }
  }
}
```

Through an SSH tunnel, the address is `http://localhost:3000/api/mcp`: add `"--allow-http"` to `args`. `Authorization:${PUPITRE_AUTH}` has no space on purpose: on Windows, some clients pass arguments containing a space badly. If Windows answers that `npx` is not recognized, give its full path: `"command": "C:\\Program Files\\nodejs\\npx.cmd"`. Restart Claude Desktop after each change.

### Cursor

`~/.cursor/mcp.json` — `%USERPROFILE%\.cursor\mcp.json` on Windows —, or `.cursor/mcp.json` in a project:

```json
{
  "mcpServers": {
    "pupitre": {
      "url": "{{origin}}/api/mcp",
      "headers": { "Authorization": "Bearer ${env:PUPITRE_TOKEN}" }
    }
  }
}
```

### VS Code

`.vscode/mcp.json` — VS Code asks for the token once and keeps it in its secret storage:

```json
{
  "inputs": [
    { "type": "promptString", "id": "pupitre-token", "description": "Pupitre API token", "password": true }
  ],
  "servers": {
    "pupitre": {
      "type": "http",
      "url": "{{origin}}/api/mcp",
      "headers": { "Authorization": "Bearer ${input:pupitre-token}" }
    }
  }
}
```

### Any other client

A client that speaks Streamable HTTP needs the address and one header, `Authorization: Bearer pup_…`. A client that only starts local processes goes through `mcp-remote`, as for Claude Desktop.

> [!NOTE]
> Clients that require OAuth to add a remote server cannot use a token header: use them through `mcp-remote`, or use a client that accepts headers.

## The tools

The agent only sees the tools its token can use; a token limited to applications only sees those that accept it.

| Tool | What it does | Permission |
|---|---|---|
| `whoami` | the account, roles and the token's real permissions | — |
| `docs` | this documentation: contents, search, a whole chapter | — |
| `api_request` | any REST route — method, path, query, body | the route's |
| `appspec_schema` | the AppSpec's JSON Schema | — |
| `appspec_validate` | validates an AppSpec without creating anything | — |
| `targets_list` | the machines and their runtimes | `target:read` |
| `target_get` | one machine: preflight, ports, proxy | `target:read` |
| `target_preflight` | checks a machine again | `target:update` |
| `target_metrics` | load, memory, disk, now | `target:read` |
| `target_ports` | allocated and free ports | `target:read` |
| `target_workloads` | everything running on a machine | `workload:read` |
| `workload_control` | start, stop, restart a workload | `workload:manage` |
| `applications_list` | the applications | `application:read` |
| `application_get` | one application, its AppSpec, where it runs | `application:read` |
| `application_create` | creates an application from an AppSpec | `application:create` |
| `application_update` | replaces an AppSpec or a description | `application:update` |
| `application_generate` | drafts an AppSpec with the instance's AI | `application:create` |
| `application_versions` | the versions, each replayable | `application:read` |
| `application_secrets` | secret names and state, never a value | `application:read` |
| `application_secret_set` | sets or regenerates a secret | `application:update` |
| `application_secret_delete` | deletes a secret's value | `application:update` |
| `application_domains` | the domains per target | `application:read` |
| `application_domains_set` | replaces the domains on a target | `deployment:create` |
| `deployments_list` | runs, with filters | `deployment:read` |
| `deploy` | deploys an application, in the background | `deployment:create` |
| `deployment_get` | a run's status and steps | `deployment:read` |
| `deployment_wait` | waits until a run ends, up to two minutes per call | `deployment:read` |
| `deployment_logs` | a run's log, its last lines | `deployment:read` |
| `deployment_rollback` | puts the previous version back | `deployment:rollback` |
| `deployment_redeploy` | replays a version, on any target | `deployment:create` |
| `deployment_destroy` | removes a deployment from its machine | `deployment:destroy` |
| `deployment_scans` | a run's scans | `scan:read` |
| `running_apps` | what is in service, machine by machine | `deployment:read` |
| `running_app_state` | a running application's services and health | `deployment:read` |
| `running_app_restart` | restarts a running application | `deployment:restart` |
| `running_app_stop` | stops it, keeping volumes, port and domain | `deployment:restart` |
| `running_app_start` | starts it again | `deployment:restart` |
| `domains_list` | every domain, its state and certificate | `application:read` |
| `monitors_list` | the probes and their state | `monitor:read` |
| `findings_list` | vulnerabilities across deployments | `scan:read` |
| `audit_search` | the activity log | `audit:read` |

Tools carry hints for the client — read-only, destructive, idempotent — so it can ask you before an action that changes something.

## Resources

Each chapter of this documentation is a resource, `pupitre://docs/{language}/{chapter}` — `pupitre://docs/en/deployments`, for instance —, in Markdown, that a client can attach to a conversation.

## What to ask an agent

- "What is running on prod-1, and is anything unhealthy?"
- "Deploy the latest version of shop on staging, wait for it, and if it fails show me why."
- "Roll shop back on prod-1."
- "Create an application from this docker-compose.yml, validate it, and deploy it on staging with the domain shop-staging.example.com."
- "Which certificates expire in the next two weeks?"
- "Which deployments failed this week, and what do their logs say?"
- "Put prod-1 in maintenance tonight from 10 pm to 11 pm." — through `api_request`.

The agent chains the tools itself: `whoami`, then `targets_list` and `applications_list` to find the identifiers, `deploy`, `deployment_wait`, `deployment_logs` if it failed.

## Security

- **The token is the limit.** An agent never does more than its token: permissions chosen among yours, cut down to what you hold today, possibly limited to some applications.
- **No privilege escalation.** A token cannot create tokens, change your password or open the interface; the routes that would allow it refuse tokens.
- **Everything is traced.** Each action is in the activity log under your account, "through the token" that carried it, with the client's name as browser.
- **HTTPS only.** A request in clear is refused before anything else, and traced under the token's account — see [Serve the panel over HTTPS](#serve-the-panel-over-https).
- **Writes from browsers are checked.** A request sent by a web page from another site is refused, as the protocol requires against DNS rebinding.
- **Revoke at once.** From [My account](/account): the next call is refused.

## When it does not work

| Symptom | Cause | What to do |
|---|---|---|
| `401` at connection | no token, or token unknown, revoked or expired | check the header, create a new token |
| `403 https_required` | the panel is reached over plain HTTP | serve it over HTTPS, or go through an SSH tunnel — and revoke the token |
| `403 cross_site_request` | a client running in a browser sends its own `Origin` | use a desktop client, or `mcp-remote` |
| a tool is missing | the token lacks its permission, or is limited to applications | `whoami` says what it holds; adjust the token |
| a tool answers `HTTP 403 forbidden` | the route requires a permission the token lost | the message names it |
| a tool answers `HTTP 409` | the state forbids it: a deployment in progress, a domain taken | read the message, then act |
| `deployment_wait` returns "still running" | the deployment takes longer than one call | call it again, or read `deployment_logs` |
| `400 Unsupported MCP-Protocol-Version` | the client speaks a revision not listed above | update the client |
| Windows: `npx` is not recognized | Node.js is missing, or not on the client's path | install Node.js, or give the full path to `npx.cmd` |
| Windows: `curl -H` refused by PowerShell | in Windows PowerShell 5.1, `curl` is `Invoke-WebRequest` | use the PowerShell example above, or `curl.exe` |
| Windows: the client does not see the token | the variable was set in a window, not for good | `SetEnvironmentVariable(…, "User")`, then reopen the client |

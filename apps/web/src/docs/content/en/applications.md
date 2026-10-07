# Applications

An application is an AppSpec stored in the panel, with everything that belongs to it over time: its secrets, its domains, its versions, its code, its backups. This chapter covers the five ways to create one, its record, its secrets, changing it and deleting it.

## Five ways to create an application

| Way | Where | When to choose it |
|---|---|---|
| The catalog | **Catalog** | a known application — Grafana, WordPress, Vaultwarden… — in a few clicks |
| A JSON AppSpec | **New application → From JSON** | you write the AppSpec, or it comes from elsewhere |
| A description | **New application → From a description** | the instance AI writes a first AppSpec for you |
| A `docker-compose.yml` | **New application → From docker-compose** | you already have a Compose file |
| A repository | **New application → From a repository** | the code and its `pupitre.json` live in GitHub, GitLab or Gitea |

All of them require `application:create`, and none deploys anything: creating and deploying are two gestures. The application is created without a target; you deploy it afterwards, where you want.

## From the catalog

**Catalog** offers twenty-eight ready-made applications — Uptime Kuma, Grafana, Gotify, Metabase, Matomo, WordPress, Directus, Wiki.js, n8n, Open WebUI, Gitea, code-server, pgAdmin, Adminer, IT Tools, Nextcloud, Paperless-ngx, linkding, Memos, Actual, Stirling-PDF, Excalidraw, draw.io, FreshRSS, Jellyfin, Navidrome, Vaultwarden, and a hello world.

1. choose a template;
2. give a name, optionally a domain and HTTPS, and the email of whoever installs it;
3. fill in the **secrets used to sign in** it asks for — an administration password, for instance; the others are generated;
4. **Install**: the application is created; deploy it from its record.

Each template is an AppSpec like any other: it deploys on Docker and on K3s, and its AppSpec can be changed afterwards.

## From JSON

**New application → From JSON**: paste an AppSpec in the editor. It is validated as you type; **Save** is offered once it passes. The [AppSpec reference](/docs/appspec) describes every field, with complete examples.

Through the API, with values for some of the declared secrets:

```bash
curl --fail-with-body -X POST {{origin}}/api/applications \
  -H "Authorization: Bearer $PUPITRE_TOKEN" -H "Content-Type: application/json" \
  -d @- <<'JSON'
{
  "description": "Our blog",
  "appSpec": {
    "name": "blog",
    "version": "1.0.0",
    "services": [
      {
        "name": "web",
        "source": { "type": "image", "ref": "ghcr.io/acme/blog:1.0.0" },
        "port": 8080,
        "exposed": true,
        "secrets": ["SMTP_PASSWORD"]
      }
    ]
  },
  "secrets": { "SMTP_PASSWORD": "the-value-from-your-mail-provider" }
}
JSON
```

## From a description, with AI

**New application → From a description**: describe the application in a sentence or a paragraph — what it is, what it needs ("a Node API with PostgreSQL and Redis, served on api.example.com"). The instance's AI provider (OpenRouter, OpenAI or Anthropic, set in **Settings → Artificial intelligence**) writes an AppSpec; Pupitre validates it and, if the model got something wrong, asks it again with the complaints.

The result is a **proposal**: nothing is saved before you read it, correct it in the editor and **Save**. The AI produces JSON, never a command: it is Pupitre that executes, and only what passed validation.

Without a configured provider, the tab says so and the API answers `501`.

## From a docker-compose.yml

**New application → From docker-compose**: paste a `docker-compose.yml`. Pupitre translates it into a proposed AppSpec and names, key by key, what it did with it:

- **blocking** — what needs a human decision: `command` or `entrypoint`, the Docker socket, a mounted host file, `privileged`, `network_mode`;
- **approximation** — a host folder becomes an empty named volume, an undeclared port is guessed, a `${…}` variable takes its default;
- **ignored** — `restart`, `container_name`, networks: Pupitre decides them.

Variables that look like secrets become generated secrets, never values in clear.

## From a repository

The application follows a branch: its `pupitre.json` describes it, each commit updates or redeploys it. The procedure, the forges and the options are in [Repositories and code](/docs/repositories).

## The application's record

**Applications**, then a row: the record opens in a drawer, with its tabs.

| Tab | What it holds |
|---|---|
| Overview | where it runs, the last deployment, its URL, the **Deploy** button |
| Versions | the versions deployed, newest first, each replayable |
| Code | the linked repository, or the uploaded archives |
| Domains | the domains per target, their state and their certificate |
| Secrets | the secret names, their origin, when they changed — never a value |
| Backups | the backup policy, the history, restore (`backup:read`) |
| Images | the image updates found per target |
| Security | the application's scan policy and accepted vulnerabilities |

## Secrets

The AppSpec declares secret **names**; values live in the panel, encrypted.

- **Generated** — 32 random characters, drawn at the first deployment, reused as is afterwards;
- **Provided** — a value you enter: a third-party API key, a password already used elsewhere;
- **Alias** — a name that reads another one's value, for an application and its database that expect the same password under two names.

On the **Secrets** tab, **Replace** a value or **Regenerate** one (`application:update`). There is no way to read a secret back, neither through the API nor on screen: you replace it. A changed secret applies at the next deployment.

```bash
# Set a value
curl --fail-with-body -X PUT {{origin}}/api/applications/$APP_ID/secrets/SMTP_PASSWORD \
  -H "Authorization: Bearer $PUPITRE_TOKEN" -H "Content-Type: application/json" \
  -d '{"value":"new-value"}'

# Draw a new random one
curl --fail-with-body -X PUT {{origin}}/api/applications/$APP_ID/secrets/SESSION_KEY \
  -H "Authorization: Bearer $PUPITRE_TOKEN" -H "Content-Type: application/json" \
  -d '{"generate":true}'
```

> [!CAUTION]
> A secret removed from the AppSpec is never deleted by itself: a database volume keeps the password of its first start, and deleting the value would lock you out of it.

## Change an application

Edit the AppSpec from the record (**Edit**, `application:update`), or with `PATCH /api/applications/{id}`. Running deployments are not touched: deploy again to apply the change.

- An application linked to a repository refuses edits of its AppSpec: change `pupitre.json` in the repository.
- An application's `name` is its name on the machines (`app-{name}`). Renaming it is refused while a deployment holds it: destroy its deployments first, or keep the name.

## Image updates

Every six hours — and on demand with **Check now** on the **Images** tab — the worker compares each image deployed from a registry with what the registry announces today: the same tag republished, or a newer tag of the same series (`16.4-alpine` is only compared with `x.y-alpine`). A new finding writes `image.update.available`, which your notification channels can follow. **Update** redeploys the version in service with the new image content.

Images built on the target, pinned by digest, or private are not checked — the tab says why.

## Delete an application

Two paths, on purpose:

- **Delete** (`application:delete`) — refused with `409` while a deployment still runs it, naming the deployments and targets;
- **Destroy and delete** (the cascade) — destroys its deployments on the machines, purges its history, then deletes it. It requires the union of `deployment:destroy`, `deployment:purge` and `application:delete`, and starts with a preview that names each deployment, host, project or namespace and port.

If a machine does not answer, nothing is deleted unless you **force** it, by typing the application's name: the containers left on that machine keep running, and the activity log keeps the commands to clean it by hand.

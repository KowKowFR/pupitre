# Repositories and code

The code of an application arrives by one of two paths: a **linked repository** that Pupitre follows — GitHub, GitLab, Gitea, Forgejo or Codeberg —, or an **archive** you upload. This chapter covers both, and the rules that keep the code from commanding the machine.

## Two ways for code to arrive

| | A linked repository | An uploaded archive |
|---|---|---|
| The AppSpec comes from | the repository's `pupitre.json` | the panel |
| The code comes from | the archive of the exact commit | the latest archive uploaded |
| A new version is | a new commit, found by polling every minute | a new archive, sent by a human or a CI |
| Deploys by itself | if you choose so | never |
| Status sent back | on the commit, at the forge | — |

## Connect a forge

**Settings → Code repositories** (`settings:manage`). One connection per forge and per instance.

**GitHub**, through a GitHub App:

1. **Create the GitHub App**: Pupitre prepares it, you confirm on github.com, and you come back to the panel;
2. **install** the App on the repositories or the organization to follow;
3. the installations appear; their repositories are offered when linking.

**GitLab** — gitlab.com or self-hosted —, through a token:

1. in the project or group, **Settings → Access tokens**: a project or group token, scope **`api`**, role **Maintainer** (a protected branch only accepts a status from someone who can push);
2. in Pupitre, the instance's address and the token, then **Test**: it says which account the token opens and when it expires.

**Gitea, Forgejo or Codeberg**, through a token:

1. on the forge, **Settings → Applications**: a token of an account — a service account is best —, scopes `write:repository` and `read:user`;
2. in Pupitre, the forge's address and the token, then **Test**.

Tokens and the App's private key are encrypted at once and never come back out.

## The pupitre.json file

The repository carries an AppSpec, and nothing else: no target, no runtime, no script. The repository says *what*; the panel says *where* and *when*, under its permissions — write access to the repository never becomes rights on the machines.

- At the root, or in the application's folder for a monorepo — a repository can carry several, one per application;
- only the changes under the file's folder concern its application;
- build contexts are relative to the **repository's** root.

```text
repository/
├── pupitre.json            ← "context": "."
├── Dockerfile
└── src/
```

## Create an application from a repository

**Applications → New application → From a repository** (`application:create`):

1. choose the repository — each one names its forge — and the followed branch;
2. Pupitre looks for the branch's `pupitre.json` files and offers them;
3. the chosen file is read at the head commit and validated: the preview shows the application, or what is wrong;
4. choose what a new commit does (below);
5. **Create**: the application exists, without a target — deploy it from its record. Each deployment builds the code of the commit whose version the application carries.

The file's `name` names the application **at its creation**; afterwards, a rename in the repository is ignored — that name is its project on the machines.

## What a new commit does

| Choice | Effect |
|---|---|
| **Update the application** (`none`) | the application takes the commit's AppSpec; nothing deploys — you deploy it where and when you want |
| **Redeploy it where it runs** (`running`) | the commit goes to the targets where a version is in service at that moment, and nowhere else |
| **Deploy it to chosen targets** (`targets`) | the commit goes to the link's targets, whether the application runs there or not |

For the last two, a mode decides whether it happens alone:

- **automatic** — every commit deploys;
- **automatic unless infrastructure changes** — the default: a commit that changes a port, the exposure, a domain, volumes, secrets, variables, resources, or adds or removes a service waits for an approval;
- **always approved** — every commit waits.

The first check of a new link records the head commit without deploying: linking a repository never redeploys what runs. In "update" mode, **Update from the repository** takes the branch's latest commit right away.

## Approve a commit

A commit waiting for approval shows on the application's record, with what it changes. **Deploy** sends it (`deployment:create`); **Dismiss** leaves it aside — the next commit makes a new proposal. Through the API: `POST /api/source-proposals/{id}/approve` or `/dismiss`.

## The status on the commit

Each deployment sends its state back to the commit — pending, success, failure —, named `pupitre/{target}`: on GitHub and Gitea in the commit's checks, on GitLab in its pipelines tab. A deployment keeps the repository, the branch, the commit and its link: the history always says which code ran.

## Upload an archive

For an application **without a repository** — created from JSON, the catalog, a description or a Compose file — with a service built from a Dockerfile, the code arrives as an archive. On the record, **Code** tab, the **Application code** card (`application:update`):

- a `.tar.gz`, `.tar` or `.zip`, 100 MiB at most (1 GiB once decompressed);
- contexts are relative to the archive's root; a single leading folder (`my-app/…`) is removed if the Dockerfiles are not found otherwise;
- `.git/`, `__MACOSX/`, `.DS_Store` and macOS's `._*` files are dropped — keep `node_modules/` and build outputs out;
- the worker reads it in a few seconds: **ready**, with the Dockerfile found for each built service, or **refused**, with the reason.

Deploying builds the latest archive; the last five are kept, so a recent version can be redeployed with **its** code. From a CI:

```bash
curl --fail-with-body -X POST {{origin}}/api/applications/$APP_ID/archives \
  -H "Authorization: Bearer $PUPITRE_TOKEN" \
  -H "x-archive-name: build-$GIT_SHA.tar.gz" \
  --data-binary @build.tar.gz
```

The answer (`202`) carries the archive and its `status`; poll `GET /api/applications/{id}/archives/{archiveId}` until `ready`, then deploy.

## The safeguards

A commit's code — or an archive's — is only a build input:

- it is unpacked into the release's `source/` folder, apart from the files Pupitre writes: a repository's `compose.override.yml`, `.env` or `k8s/` folder is never read;
- Compose is always called with its project and its file named, and the Kubernetes folder is emptied before each render;
- a build context never leaves the code: no absolute path, no `..`;
- an archive is read entry by entry and rebuilt: absolute paths, `..`, links leaving the code, devices, duplicate entries refuse it whole;
- the built image runs hardened: read-only root, unprivileged user, no capability.

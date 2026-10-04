# Security policy

Pupitre holds the SSH keys of your machines, encrypts your applications' secrets
and runs privileged commands remotely. A vulnerability here does not compromise a
website: it compromises an infrastructure. Reports are taken seriously.

## Reporting a vulnerability

**Do not open a public issue.**

Use GitHub's private reporting:
[Security → Report a vulnerability](https://github.com/KowKowFR/pupitre/security/advisories/new)
on the repository. It creates a private thread between you and the maintainer,
and allows publishing an advisory once the fix is available.

If that channel is not available to you, write to the maintainer,
[@KowKowFR](https://github.com/KowKowFR), at the address shown on their profile.

What helps, in order of usefulness:

1. the version — commit, or the output of `git rev-parse HEAD`;
2. the attack path, step by step, and the starting privilege (anonymous?
   `viewer`? `operator`?);
3. the concrete impact: reading a secret, execution on a target, privilege
   escalation, denial of service;
4. a reproducible proof — a `curl` request, a script, a fixture.

Reports in English or in French are both welcome.

**Only test your own machines.** The repository provides what you need to set up
a throwaway target in a container (`./scripts/setup-test-target.sh`).

## Timelines

The project is maintained by one person, on their own time. What is promised:

| Step | Target delay |
|---|---|
| Acknowledgment | 7 days |
| First assessment (confirmed / rejected / need info) | 14 days |
| Fix or fix plan announced | 90 days |

No bounty is offered. Credit goes to you in the published advisory, unless you
prefer anonymity.

## Supported versions

There is **no published version**: no tag, no release, no distributed image. The
only thing maintained is the `main` branch. A fix is applied there and nothing is
backported anywhere.

It also means that if you run Pupitre, you run a commit: write down which one.

## In scope

- Bypassing RBAC: getting an effect without holding the corresponding
  permission, on any of the routes in [`docs/api.md`](docs/api.md).
- Leaking an encrypted value — SSH credential, application secret, AI API key,
  notification channel secret, probe webhook URL, forge token, backup
  destination key — through the API, the rendered HTML, the activity log, the
  logs, or the Redis keys.
- Command injection on a target machine: making the driver or the worker run a
  command that was not intended, through an AppSpec field, an application name,
  a secret name, an uploaded archive or a route parameter.
- Escaping the isolation between deployed applications: reaching, from
  application `a`, the network, volumes or secrets of application `b`.
- Bypassing the SSRF protections of monitoring probes — cloud metadata
  services, `localhost`, `file://`, non-routable ranges, credentials in the URL,
  webhook URLs.
- Authentication flaws: session takeover, TOTP bypass, reusing a backup code, an
  invitation token valid twice, an observable difference between a known address
  and an unknown one.
- Cross-site scripting, CSRF, or session fixation in the panel.
- Privilege escalation to `admin` by any path.
- A secret committed to the repository, or published in an image.

## Out of scope

- **The applications you deploy.** Pupitre orchestrates them; their content and
  their vulnerabilities are yours. The built-in scanners (Trivy, Grype, Syft) are
  a safeguard, not a guarantee.
- **The security of your target machines.** The panel connects to them with the
  credentials you give it and runs commands with `sudo`. A compromised target was
  compromised before Pupitre, or became so through what you deployed on it.
- **An instance exposed without a reverse proxy or TLS.** The compose stack
  publishes on `127.0.0.1` by default; exposing it publicly in clear is an
  operations decision.
- **Limits already documented.** They are not discoveries: the "Known limits"
  section of the [README](README.md) and [`docs/roadmap.md`](docs/roadmap.md)
  describe them, with what it would take to lift them. In particular,
  `MASTER_KEY` rotation is not implemented.
- **The BuildKit builder pod on K3s is privileged**, and that is written down.
  It is not a vulnerability report; a way to build without that privilege would
  be a good contribution.
- Automated scanner reports without a demonstrated exploitation path.
- Missing hardening headers, weak TLS suites, dependency versions flagged by a
  tool but without exploitability here.
- Attacks requiring physical access, prior `root` access to the panel, or
  possession of `MASTER_KEY`.

## What the project already guarantees

These properties are checked on each run of the scripts in
[`docs/verification.md`](docs/verification.md). A contribution that breaks them
is a security bug, even without a demonstrated exploit.

- No credential leaves the API, at whatever depth of the JSON.
- No secret appears in the activity log, the logs, the HTML or Redis's BullMQ
  keys — including API key **prefixes**, which some providers send back in their
  error messages.
- A permission refusal is traced, with the actor and the real IP behind the
  reverse proxy.
- Two CI guards: no secret in the repository, and applied migrations are
  immutable.

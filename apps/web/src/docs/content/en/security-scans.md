# Security scans

Pupitre scans the images it is about to start for known vulnerabilities, and can refuse to deploy when it finds what you decided must block. This chapter covers the scanners, where they run, the blocking policy — for the instance and per application —, accepted vulnerabilities, and reading the results.

## The three scanners

| Scanner | Produces | Pinned version |
|---|---|---|
| **Trivy** | vulnerabilities | 0.74.0 |
| **Grype** | vulnerabilities | 0.118.0 |
| **Syft** | an SBOM (CycloneDX) — the list of packages; never blocks | 1.51.1 |

Trivy and Grype describe the same vulnerability with two vocabularies; Pupitre maps both onto one scale — `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`, `UNKNOWN` — and one shape: identifier, package, installed version, fixed version, advisory. Versions are pinned: a scanner changing under your feet would make two deployments incomparable.

## Where scans run

On the **target machine**, over SSH, on the local image — built there or pulled there. Nothing goes to a registry, nothing comes back to the panel but the report. The scanner is installed on first use, in the deploying account's home, for the machine's architecture.

> [!NOTE]
> The first scan on a new machine downloads the vulnerability databases — about 1.4 GiB for Trivy, 3 GiB for Grype: count a few minutes, once. Before scanning, Pupitre keeps 15 % of the disk free (2 GiB at least); a scanner that does not fit is not run, and the log says how much space was missing.

## The blocking policy

**Settings → Security scanning** (`settings:manage`) sets the instance's policy:

| Setting | Effect |
|---|---|
| Scanning enabled | the main switch: off, no scan on any deployment |
| Scanners | each scanner can be set aside, even with scanning on |
| Threshold | `CRITICAL`, `HIGH` or `NONE` — **`NONE` by default**: findings are recorded, nothing blocks |
| Only fixable | the threshold only counts vulnerabilities a fixed version exists for |

`NONE` by default is deliberate: most public images carry `CRITICAL` findings with no fix, and a blocking default would stop every first deployment — until someone switches scanning off entirely. Inform by default, block by decision.

The policy is frozen on each deployment when it is queued. An explicit `scanConfig` in an API call (`scan:configure`) can only be stricter: the instance's switch and disabled scanners always win.

## An application's own policy

An application can set its own threshold and fixable rule — on its record, **Security** tab, or through the API (`scan:configure`). `null` follows the instance. It applies to the following deployments, redeployments included.

```bash
curl --fail-with-body -X PUT {{origin}}/api/applications/$APP_ID/scan-policy \
  -H "Authorization: Bearer $PUPITRE_TOKEN" -H "Content-Type: application/json" \
  -d '{"failOn":"HIGH","onlyFixable":true}'
```

## Accept a vulnerability

A vulnerability you have assessed — not exploitable in your use, a fix not yet published — can be **accepted** for an application: it stays visible, marked accepted, and no longer blocks. From a deployment's **Security** tab, or through the API (`scan:configure`):

1. the CVE, and optionally the package it concerns;
2. a **reason** — mandatory;
3. an expiry: 30, 90, 180 days, or none.

```bash
curl --fail-with-body -X POST {{origin}}/api/applications/$APP_ID/vulnerability-acceptances \
  -H "Authorization: Bearer $PUPITRE_TOKEN" -H "Content-Type: application/json" \
  -d '{"cveId":"CVE-2026-12345","package":"curl","reason":"curl is never called with user input","expiresInDays":90}'
```

Acceptances apply at scan time and belong to the application, not to a version. Each one is written to the activity log with high severity: it is a deliberate bypass.

## Reading the results

- A deployment's **Security** tab: each scanner's run, its verdict, the counts by severity, the findings with filters — all, fixable, unfixable, accepted —, and the **SBOM** to download.
- `GET /api/findings` searches across deployments: by CVE, severity, application, deployment, scanner.
- The activity log records each verdict: `deployment.scan.blocked` or `deployment.scan.passed`, with the scanners, the threshold, the counts and the CVEs responsible.

A scanner that crashes is marked in error — verdict unknown, neither blocking nor clearing — and does not prevent the others from concluding.

## Periodic scans

New vulnerabilities are published every day for images that have not changed. A **scheduled task** of type `scan` runs the scanners again on what is in service: it records the findings and alerts, and **never** stops or redeploys anything. See [Operations](/docs/operations#scheduled-tasks).

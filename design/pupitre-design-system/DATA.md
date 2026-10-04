# Sample data (consistent across all boards)

The boards show this data as the French panel words it; the names and slugs are kept as they appear there.

## Instance

"Atelier Nord", tagline "production". Reference date: Wednesday 30 September 2026, 14:32 (Europe/Paris).

## Users

| Name | Role | Detail |
|---|---|---|
| Camille Roux | admin | |
| Julien Marchand | operator | |
| Sarah Benali | operator | 2FA being set up |
| Inès Haddad | viewer | |
| Théo Lambert | operator | invited |

## Targets

| Target | Address | Runtime | State |
|---|---|---|---|
| prod-1 | 10.0.0.11 | Docker 27.1 | operational |
| prod-2 | 10.0.0.12 | Docker 27.1 | operational |
| k3s-1 | 10.0.0.20 | K3s v1.33.1 | degraded (disk at 91 %) |
| edge-1 | 10.0.0.31:2222 | Docker 26.1 | unreachable since 13:52 |
| staging-1 | 10.0.0.40 | none | never tested |

## Applications (8)

blog, api-facturation, portail-client, glpi, grafana, n8n, umami, docs.

## Deployments

Runs #122 to #129 (129 in total):

- #129 docs: in progress;
- #127 api-facturation: failed at the healthcheck step;
- #125 n8n: rolled back, blocked by the scan.

## Probes

| Probe | State |
|---|---|
| Public blog | healthy |
| Billing API | incident open for 12 min |
| Portal certificate | notice, expires in 18 days |
| GLPI | healthy |
| Main domain | healthy |

## Jobs

nightly-scan, health-5min, preflight-hourly, cleanup-weekly.

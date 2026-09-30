# Données d'exemple (cohérentes sur toutes les planches)

## Instance

« Atelier Nord », sous-titre « production ». Date de référence : mercredi 30 septembre 2026, 14:32 (Europe/Paris).

## Utilisateurs

| Nom | Rôle | Particularité |
|---|---|---|
| Camille Roux | admin | |
| Julien Marchand | operator | |
| Sarah Benali | operator | 2FA en cours de configuration |
| Inès Haddad | viewer | |
| Théo Lambert | operator | invité |

## Cibles

| Cible | Adresse | Runtime | État |
|---|---|---|---|
| prod-1 | 10.0.0.11 | Docker 27.1 | opérationnelle |
| prod-2 | 10.0.0.12 | Docker 27.1 | opérationnelle |
| k3s-1 | 10.0.0.20 | K3s v1.33.1 | dégradée (disque à 91 %) |
| edge-1 | 10.0.0.31:2222 | Docker 26.1 | injoignable depuis 13:52 |
| staging-1 | 10.0.0.40 | aucun | jamais testée |

## Applications (8)

blog, api-facturation, portail-client, glpi, grafana, n8n, umami, docs.

## Déploiements

Runs #122 à #129 (129 au total) :

- #129 docs : en cours ;
- #127 api-facturation : échoué à l'étape healthcheck ;
- #125 n8n : replié, bloqué par le scan.

## Sondes

| Sonde | État |
|---|---|
| Blog public | saine |
| API facturation | incident ouvert depuis 12 min |
| Certificat portail | préavis, expire dans 18 jours |
| GLPI | saine |
| Domaine principal | sain |

## Tâches

nightly-scan, health-5min, preflight-hourly, cleanup-weekly.

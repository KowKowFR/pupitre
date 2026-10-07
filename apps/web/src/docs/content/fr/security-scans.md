# Analyses de sécurité

Pupitre analyse les images qu’il s’apprête à démarrer à la recherche de vulnérabilités connues, et peut refuser de déployer quand il trouve ce que vous avez décidé de bloquer. Ce chapitre couvre les analyseurs, où ils tournent, la politique de blocage — pour l’instance et par application —, les vulnérabilités acceptées, et la lecture des résultats.

## Les trois analyseurs

| Analyseur | Produit | Version épinglée |
|---|---|---|
| **Trivy** | des vulnérabilités | 0.74.0 |
| **Grype** | des vulnérabilités | 0.118.0 |
| **Syft** | un SBOM (CycloneDX) — la liste des paquets ; ne bloque jamais | 1.51.1 |

Trivy et Grype décrivent la même vulnérabilité avec deux vocabulaires ; Pupitre ramène les deux sur une seule échelle — `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`, `UNKNOWN` — et une seule forme : identifiant, paquet, version installée, version corrigée, avis. Les versions sont épinglées : un analyseur qui change sous vos pieds rendrait deux déploiements incomparables.

## Où tournent les analyses

Sur la **machine cible**, par SSH, sur l’image locale — construite là ou tirée là. Rien ne part vers un registre, rien ne revient au panel que le rapport. L’analyseur est installé à la première utilisation, dans le dossier personnel du compte de déploiement, pour l’architecture de la machine.

> [!NOTE]
> La première analyse sur une machine neuve télécharge les bases de vulnérabilités — environ 1,4 Gio pour Trivy, 3 Gio pour Grype : comptez quelques minutes, une fois. Avant d’analyser, Pupitre garde 15 % du disque libre (2 Gio au moins) ; un analyseur qui ne tient pas n’est pas lancé, et le journal dit combien d’espace manquait.

## La politique de blocage

**Paramètres → Analyse de sécurité** (`settings:manage`) fixe la politique de l’instance :

| Réglage | Effet |
|---|---|
| Analyse activée | l’interrupteur général : coupé, aucune analyse sur aucun déploiement |
| Analyseurs | chaque analyseur peut être écarté, même avec l’analyse activée |
| Seuil | `CRITICAL`, `HIGH` ou `NONE` — **`NONE` par défaut** : les trouvailles sont enregistrées, rien ne bloque |
| Corrigeables seulement | le seuil ne compte que les vulnérabilités pour lesquelles une version corrigée existe |

`NONE` par défaut est volontaire : la plupart des images publiques portent des trouvailles `CRITICAL` sans correctif, et un blocage par défaut arrêterait chaque premier déploiement — jusqu’à ce que quelqu’un coupe l’analyse entièrement. Informer par défaut, bloquer par décision.

La politique est figée sur chaque déploiement au moment où il est mis en file. Un `scanConfig` explicite dans un appel d’API (`scan:configure`) ne peut qu’être plus strict : l’interrupteur de l’instance et les analyseurs écartés l’emportent toujours.

## La politique propre d’une application

Une application peut fixer son propre seuil et sa règle des corrigeables — sur sa fiche, onglet **Sécurité**, ou par l’API (`scan:configure`). `null` suit l’instance. Elle s’applique aux déploiements suivants, redéploiements compris.

```bash
curl --fail-with-body -X PUT {{origin}}/api/applications/$APP_ID/scan-policy \
  -H "Authorization: Bearer $PUPITRE_TOKEN" -H "Content-Type: application/json" \
  -d '{"failOn":"HIGH","onlyFixable":true}'
```

## Accepter une vulnérabilité

Une vulnérabilité que vous avez évaluée — inexploitable dans votre usage, un correctif pas encore publié — peut être **acceptée** pour une application : elle reste visible, marquée acceptée, et ne bloque plus. Depuis l’onglet **Sécurité** d’un déploiement, ou par l’API (`scan:configure`) :

1. le CVE, et éventuellement le paquet qu’il concerne ;
2. une **raison** — obligatoire ;
3. une échéance : 30, 90, 180 jours, ou aucune.

```bash
curl --fail-with-body -X POST {{origin}}/api/applications/$APP_ID/vulnerability-acceptances \
  -H "Authorization: Bearer $PUPITRE_TOKEN" -H "Content-Type: application/json" \
  -d '{"cveId":"CVE-2026-12345","package":"curl","reason":"curl n’est jamais appelé avec une entrée utilisateur","expiresInDays":90}'
```

Les acceptations s’appliquent au moment de l’analyse et appartiennent à l’application, pas à une version. Chacune est écrite au journal d’activité avec une sévérité haute : c’est un contournement délibéré.

## Lire les résultats

- L’onglet **Sécurité** d’un déploiement : le passage de chaque analyseur, son verdict, les comptes par sévérité, les trouvailles avec des filtres — toutes, corrigeables, sans correctif, acceptées —, et le **SBOM** à télécharger.
- `GET /api/findings` cherche à travers les déploiements : par CVE, sévérité, application, déploiement, analyseur.
- Le journal d’activité consigne chaque verdict : `deployment.scan.blocked` ou `deployment.scan.passed`, avec les analyseurs, le seuil, les comptes et les CVE en cause.

Un analyseur qui plante est marqué en erreur — verdict inconnu, ni bloquant ni rassurant — et n’empêche pas les autres de conclure.

## Les analyses périodiques

De nouvelles vulnérabilités sont publiées chaque jour pour des images qui n’ont pas changé. Une **tâche planifiée** de type `scan` relance les analyseurs sur ce qui est en service : elle enregistre les trouvailles et alerte, et **jamais** n’arrête ni ne redéploie quoi que ce soit. Voyez [Exploitation](/docs/operations#les-taches-planifiees).

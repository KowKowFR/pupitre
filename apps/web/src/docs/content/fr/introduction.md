# Introduction

Pupitre est un plan de contrôle auto-hébergé : depuis ce panel, vous déployez des applications web sur vos propres machines, par SSH, avec Docker Compose ou K3s — à partir d’une seule et même description. Cette documentation le couvre de A à Z : les concepts, les procédures pas à pas, des exemples à copier, l’API REST et le serveur MCP pour les agents IA.

## Ce que fait Pupitre

- **Déploie vos applications** sur vos machines (les *cibles*), par SSH. Les images sont tirées ou construites sur la machine elle-même, sans registre.
- **Parle deux runtimes** avec la même description : un projet Docker Compose ou un namespace K3s. Passer une application sur l’autre runtime, c’est choisir une autre cible, pas la réécrire.
- **Les publie sous un domaine**, par un reverse proxy qu’il pilote — Traefik, BunkerWeb (un pare-feu applicatif) ou Nginx Proxy Manager — avec des certificats Let’s Encrypt.
- **Vérifie avant de déployer** : analyses de vulnérabilités (Trivy, Grype) et SBOM (Syft), avec une politique de blocage que vous choisissez.
- **Revient en arrière tout seul** quand la nouvelle version ne passe pas sa vérification de santé.
- **Surveille ce qui tourne** : métriques des machines, sondes HTTP et TLS, prévisions, fenêtres de maintenance, pages de statut publiques, notifications par e-mail, Telegram, Discord ou webhook.
- **Sauvegarde** les données de vos applications et le panel lui-même, chiffrées, vers S3, SFTP ou un dossier.
- **Garde la trace de tout** : rôles et permissions, un journal d’activité de chaque action et de chaque refus.
- **Se laisse automatiser** : une API REST, des jetons d’API liés à votre compte, des pipelines de CI, et un serveur MCP pour qu’un agent IA le pilote.

## Le panel orchestre, il n’héberge rien

La confusion la plus fréquente, levée tout de suite : vos applications ne tournent jamais dans le panel. Elles tournent sur les machines cibles, et continuent de tourner si le panel s’arrête.

| | Le panel | Les machines cibles |
|---|---|---|
| Ce que c’est | quatre conteneurs : l’interface web, un worker, PostgreSQL, Redis | des serveurs ou des VM que vous possédez déjà |
| Ce qui y tourne | Pupitre lui-même | vos applications |
| Ce qu’il faut y installer | Docker | un accès SSH — le panel installe ce dont il a besoin, et le dit |
| S’il s’arrête | vous ne pouvez plus déployer ni surveiller | les applications continuent de répondre |

## Le trajet d’un déploiement

1. Vous demandez un déploiement — depuis l’écran, l’API, une CI ou un agent IA par MCP.
2. Le panel l’enregistre avec ses étapes, met une tâche en file (Redis, BullMQ) et répond aussitôt : `202 Accepted`. Il n’attend jamais une machine.
3. Le **worker** prend la tâche, ouvre une session SSH vers la cible et déroule le pipeline : préflight, port, rendu, dépôt, construction, analyse, sauvegarde, démarrage, vérification de santé, proxy.
4. Chaque ligne du journal est publiée en direct : l’écran la suit, et le journal d’activité garde l’issue.

```text
 écran · API · CI · MCP
          │  POST /api/deployments
          ▼
       panel ──── 202 ────► file (Redis / BullMQ)
                                   │
                                worker
                                   │ SSH
                     ┌─────────────┴─────────────┐
               cible Docker                  cible K3s
          projet Compose app-blog      namespace app-blog
```

## Le vocabulaire en une page

| Mot | Ce qu’il désigne |
|---|---|
| Cible | une machine joignable par SSH, où l’on déploie des applications |
| Runtime | la façon dont une cible fait tourner les applications : `docker` (Docker Compose) ou `k3s` |
| AppSpec | la description JSON neutre d’une application — elle ne connaît ni Docker ni Kubernetes |
| Application | une AppSpec enregistrée dans le panel, avec ses secrets, ses domaines et son historique |
| Déploiement | une exécution du pipeline : une application, une cible, un runtime, une version |
| Reverse proxy | le serveur qui reçoit les visiteurs sur les ports 80 et 443 et les aiguille selon le domaine |
| Domaine | un nom servi par le proxy vers une application — unique sur toute l’instance |
| Workload | tout ce qui tourne sur une cible : un conteneur, un pod, un déploiement |
| Sonde | une vérification HTTP ou TLS d’une URL, depuis le worker |
| Jeton d’API | une clé `pup_…` qui agit en votre nom, sans navigateur |
| Journal d’activité | la trace de chaque action et de chaque refus, avec qui, quand et d’où |

Le chapitre [Concepts](/docs/concepts) explique chacun d’eux en profondeur.

## Comment cette documentation est organisée

- **Prise en main** — cette introduction, le [Démarrage rapide](/docs/quick-start) de l’installation à la première URL, et les [Concepts](/docs/concepts).
- **Guides** — un chapitre par domaine : [Cibles](/docs/targets), [Reverse proxy et domaines](/docs/proxy-and-domains), [Applications](/docs/applications), [Référence de l’AppSpec](/docs/appspec), [Déploiements](/docs/deployments), [Dépôts et code](/docs/repositories), [Analyses de sécurité](/docs/security-scans), [Exploitation](/docs/operations), [Administration](/docs/administration).
- **Automatiser** — l’[API REST](/docs/api), la [CI/CD](/docs/ci-cd) et le [serveur MCP](/docs/mcp).
- **Référence** — le [Dépannage](/docs/troubleshooting) et les codes d’erreur.

## Par où commencer

- **Une instance neuve ?** Suivez le [Démarrage rapide](/docs/quick-start) : en un quart d’heure environ, une première application répond sous son domaine.
- **Vous voulez automatiser ?** Créez un jeton d’API depuis [Mon compte](/account), puis lisez [API](/docs/api), [CI/CD](/docs/ci-cd) ou [MCP](/docs/mcp).
- **Quelque chose échoue ?** Le [Dépannage](/docs/troubleshooting) va du symptôme à la cause.

> [!TIP]
> Le champ de recherche au-dessus des chapitres cherche dans tous les chapitres à la fois, sans tenir compte des accents : essayez `rollback`, `jeton` ou `pupitre.json`.

> [!NOTE]
> Ce que vous pouvez faire dépend de votre rôle. Cette documentation décrit tous les écrans ; ceux que votre rôle n’ouvre pas n’apparaissent pas dans votre navigation — demandez à un administrateur la permission que le chapitre nomme.

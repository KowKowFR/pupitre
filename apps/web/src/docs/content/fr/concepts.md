# Concepts

Les idées sur lesquelles Pupitre est construit, et leurs conséquences au quotidien. Lisez-le une fois : les guides qui suivent emploient ces mots sans les réexpliquer.

## Le panel et les cibles

Le **panel**, c’est Pupitre : une interface web, un worker, une base PostgreSQL et un Redis. Il garde les descriptions de vos applications, les accès chiffrés de vos machines, l’historique, les permissions. Il n’héberge aucune de vos applications.

Une **cible** est une machine que vous possédez déjà — une VM, un serveur physique, une instance cloud — que le worker joint par SSH. Le panel n’y installe rien sans le dire : les journaux de déploiement listent chaque commande qui modifie la machine. Les applications tournent sur les cibles, et continuent si le panel est éteint.

## Les runtimes : Docker Compose et K3s

Une cible offre un ou deux **runtimes**, détectés par son préflight :

| | `docker` | `k3s` |
|---|---|---|
| Une application est | un projet Compose `app-{nom}` | un namespace `app-{nom}` |
| Un service est | un conteneur (ou plusieurs réplicas) | un Deployment et ses pods, derrière un Service |
| Le proxy le joint par | un port publié sur la machine | le Service du cluster |
| Les images se construisent avec | `docker build`, sur la machine | BuildKit dans un pod, importé dans containerd |
| Les données vivent dans | des volumes nommés | des PersistentVolumeClaims |

La même application se déploie sur les deux sans changer une ligne : seule la cible — et son runtime — change. Tout ce qui diffère entre les deux vit dans les **drivers**, jamais ailleurs.

## L’AppSpec

L’**AppSpec** est la description JSON d’une application : ses services, d’où vient leur image (un registre, ou un Dockerfile à construire), leur port, leur environnement, leurs secrets, leurs volumes, leur vérification de santé, leurs ressources, leurs dépendances, et un domaine par défaut. Elle ne connaît ni Docker ni Kubernetes : pas de politique de redémarrage, pas de namespace, pas de commande. Ce qu’elle ne dit pas, le driver le décide.

Pupitre la valide — un schéma plus des règles croisées : exactement un service exposé, des noms uniques, pas de cycle de dépendances, des alias de secrets qui se résolvent. La [Référence de l’AppSpec](/docs/appspec) détaille chaque champ.

## Applications, déploiements, versions

- Une **application** est une AppSpec enregistrée dans le panel, avec ce qui lui appartient dans la durée : ses secrets, ses domaines par cible, ses politiques de sauvegarde et d’analyse, son dépôt lié s’il y en a un.
- Un **déploiement** est une exécution du pipeline pour une application sur une cible, avec un runtime. Il **fige l’AppSpec** qu’il a déployée : des mois plus tard, on sait encore exactement ce qui a tourné.
- Une **version** est un déploiement qu’on peut rejouer : la redéployer relance le pipeline depuis son AppSpec figée, sur n’importe quelle cible.
- Une **release** est le dossier qu’un déploiement dépose sur la machine, `apps/{nom}/{version}-r{numéro}`. Les cinq dernières sont gardées ; revenir en arrière redémarre la précédente sans reconstruire.

## Le reverse proxy, les domaines et les upstreams

Trois notions distinctes :

- le **proxy** reçoit les visiteurs sur les ports 80 et 443 d’une machine et les mène à la bonne application selon le domaine. Pupitre pilote Traefik, BunkerWeb et Nginx Proxy Manager ;
- un **domaine** (une *route*) est un nom servi vers une application sur une cible. Il est **unique sur toute l’instance** : deux applications ne revendiquent jamais le même nom ;
- l’**upstream** est la façon dont le proxy joint l’application — un port sur la machine pour Docker, un Service pour K3s. Le driver l’annonce ; le proxy ignore vers quel runtime il route.

Une machine sans proxy à elle peut passer par celui d’une autre — le **proxy central** — ou par un Nginx Proxy Manager hors des cibles. Voyez [Reverse proxy et domaines](/docs/proxy-and-domains).

## Les ports

Sur Docker, un service que le proxy doit joindre est publié sur un port de la machine, tiré dans la plage de la cible (30000-32767 par défaut). Deux applications n’obtiennent jamais le même port : la base tient une contrainte d’unicité sur (cible, port). Derrière un proxy sur la même machine, le port n’écoute que sur la boucle locale — l’application ne se joint alors que par ses domaines. Sur K3s, aucun port n’est réservé : le proxy du cluster joint le Service.

## Les secrets

Une AppSpec ne porte que des **noms** de secrets (`"secrets": ["DATABASE_PASSWORD"]`). Les valeurs vivent dans le panel, chiffrées, rattachées à l’application : tirées au hasard au premier déploiement, ou saisies par vous. Elles ne se relisent jamais — on les remplace, on ne les lit pas. Un **alias** (`{ "name": "POSTGRES_PASSWORD", "from": "DATABASE_PASSWORD" }`) donne deux noms à une même valeur, pour une application et sa base qui attendent le même mot de passe sous deux noms.

## La file et le worker

Toute opération longue — un déploiement, un préflight, une sauvegarde, une analyse, une lecture de métriques — passe par une **file** (BullMQ, dans Redis). La route HTTP qui la demande l’enregistre, met une tâche en file et répond `202 Accepted` aussitôt ; le **worker** l’exécute par SSH. Conséquences :

- un script ou un agent doit **suivre** l’opération ensuite : `GET /api/deployments/{id}` jusqu’à un statut final ;
- le panel peut redémarrer pendant qu’un déploiement se déroule ailleurs ;
- les journaux voyagent en direct : chaque ligne est publiée, puis gardée avec son étape.

## Des écrans vivants

Les écrans se mettent à jour seuls : quand quelque chose change — un déploiement se termine, une sonde tombe —, le panel envoie un signal aux écrans ouverts, qui se relisent avec vos permissions. Aucune donnée ne passe par ce canal, seulement « ceci a changé ».

## Permissions, rôles et journal d’activité

Chaque geste demande une **permission**, écrite `ressource:action` — `deployment:create`, `target:delete`, `audit:read`. Un **rôle** est un ensemble de permissions ; un compte a un rôle. Les rôles de départ sont *admin*, *operator*, *auditor*, *viewer* et *no-access*, et un administrateur peut en créer d’autres. Un écran que votre rôle n’ouvre pas n’apparaît pas dans votre navigation ; un appel refusé répond `403` et nomme la permission manquante.

Tout est consigné dans le **journal d’activité** : qui a fait quoi, quand, depuis quelle adresse — refus compris, et jetons d’API nommés. Voyez [Administration](/docs/administration).

## Les jetons d’API

Un **jeton d’API** (`pup_…`) permet à un script, une CI ou un agent IA d’agir **en votre nom**, sans navigateur. Il porte les permissions que vous choisissez parmi les vôtres, est ramené à chaque appel à ce que vous pouvez encore faire, peut être limité à certaines applications, échoit, et se révoque à tout instant. Il ouvre l’API, jamais l’interface, et ne peut pas créer d’autres jetons. Voyez [API](/docs/api) et [MCP](/docs/mcp).

## Les langues

Le produit parle français ou anglais, selon le réglage de l’instance dans **Paramètres → Régionalisation** : écrans, journaux de déploiement, erreurs, notifications. Les **codes** d’erreur des réponses de l’API ne changent jamais avec la langue ; seul le message destiné à un humain change.

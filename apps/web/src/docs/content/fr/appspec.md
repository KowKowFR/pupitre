# Référence de l’AppSpec

L’AppSpec est la description JSON d’une application. Elle dit *ce qu’est* l’application — services, images, ports, données, secrets, domaine — et jamais *comment* un runtime la fait tourner. Ce chapitre documente chaque champ, les règles que Pupitre vérifie, et des exemples complets.

## La forme

```json
{
  "name": "blog",
  "version": "1.4.2",
  "services": [ { "name": "web", "...": "..." } ],
  "ingress": { "host": "blog.example.com", "tls": true, "targetService": "web" }
}
```

| Champ | Type | Requis | Sens |
|---|---|---|---|
| `name` | chaîne | oui | le nom de l’application : en kebab-case, de 2 à 48 caractères (`blog`, `shop-api`). Il devient `app-{name}` sur les machines |
| `version` | chaîne | oui | une version semver (`1.4.2`, `2.0.0-rc.1`) — la vôtre, affichée dans l’historique |
| `services` | tableau | oui | au moins un service |
| `ingress` | objet | non | le domaine par défaut, et le service vers lequel il mène |

## Un service

| Champ | Type | Par défaut | Sens |
|---|---|---|---|
| `name` | chaîne | — | en kebab-case, unique dans l’application ; c’est aussi son nom d’hôte pour les autres services |
| `source` | objet | — | d’où vient l’image : un registre, ou un Dockerfile à construire |
| `port` | entier | — | le port sur lequel le service écoute dans son conteneur |
| `exposed` | booléen | `false` | le service que les visiteurs atteignent — **exactement un** par application |
| `replicas` | entier | `1` | combien de copies tournent (de 1 à 50) |
| `env` | objet | `{}` | des variables en clair, `NOM_EN_MAJUSCULES: "valeur"` |
| `secrets` | tableau | `[]` | des noms de secrets, ou des alias `{ "name", "from" }` |
| `resources` | objet | 500 m CPU, 512 Mi | `cpuMilli` (de 10 à 64000) et `memoryMi` (de 16 à 262144) |
| `healthcheck` | objet | chemin `/`, toutes les 10 s | comment savoir que le service est sain |
| `volumes` | tableau | `[]` | des données persistantes : `{ "name", "mountPath", "size" }` |
| `dependsOn` | tableau | `[]` | les services à démarrer avant celui-ci |

## La source : une image ou un Dockerfile

Une image d’un registre, par son tag :

```json
{ "type": "image", "ref": "postgres:16-alpine" }
```

Ou un Dockerfile, construit **sur la machine cible** à partir du code — le commit d’un dépôt lié, ou une archive téléversée :

```json
{ "type": "dockerfile", "context": "services/api", "dockerfile": "Dockerfile" }
```

`context` est relatif à la racine du code, `dockerfile` relatif à `context` (`Dockerfile` par défaut). Aucun des deux ne peut être absolu ni contenir `..` : une construction ne sort jamais du code qu’on lui a envoyé.

> [!IMPORTANT]
> Une image construite par Pupitre tourne durcie : un système de fichiers racine en lecture seule, un utilisateur sans privilège, aucune capacité Linux. Elle doit donc écouter sur un port au-dessus de 1024 et n’écrire que dans `/tmp` et ses volumes. Pour nginx, partez de `nginxinc/nginx-unprivileged`, qui écoute sur 8080.

## Ports et exposition

`port` est le port **dans** le conteneur. Pupitre décide du reste : sur Docker, le service exposé est publié sur un port tiré dans la plage de la cible — sur la boucle locale quand un proxy de la machine le sert — ; sur K3s, il reçoit un Service. Les autres services ne se joignent que par leur nom, depuis les services de l’application elle-même.

Exactement un service est `exposed` : celui vers lequel mènent le domaine et le port publié.

## Environnement et secrets

```json
"env": { "DATABASE_HOST": "db", "DATABASE_NAME": "blog" },
"secrets": ["DATABASE_PASSWORD", "SESSION_KEY"]
```

- `env` porte des valeurs **en clair**. Les noms sont en majuscules, chiffres et soulignés (`[A-Z_][A-Z0-9_]*`).
- `secrets` ne porte **que des noms**. Les valeurs vivent dans le panel, chiffrées : générées au premier déploiement, ou saisies dans l’onglet **Secrets** de l’application. Elles arrivent au service en variables d’environnement — un fichier `.env` en mode 0600 sur Docker, un `Secret` Kubernetes sur K3s.
- Un nom est dans `env` ou dans `secrets`, jamais les deux.

Un **alias** donne un second nom à un secret. Une application et sa base attendent souvent le même mot de passe sous deux noms :

```json
"secrets": [{ "name": "POSTGRES_PASSWORD", "from": "DATABASE_PASSWORD" }]
```

Il n’y a toujours qu’une valeur : `POSTGRES_PASSWORD` lit celle de `DATABASE_PASSWORD`. Le `from` doit être déclaré par un service de l’application.

## Les volumes

```json
"volumes": [{ "name": "data", "mountPath": "/var/lib/postgresql/data", "size": "10Gi" }]
```

- `name` — en kebab-case, unique dans le service ;
- `mountPath` — un chemin absolu dans le conteneur ;
- `size` — facultatif, en unités Kubernetes (`500Mi`, `10Gi`) : la taille du PersistentVolumeClaim sur K3s, indicative sur Docker.

Les volumes survivent aux déploiements : redéployer les garde, détruire le déploiement les supprime. Ce sont eux que sauvegardent les sauvegardes de l’application.

## La vérification de santé

```json
"healthcheck": { "path": "/healthz", "port": 8080, "intervalSec": 5, "timeoutSec": 3, "retries": 10 }
```

| Champ | Par défaut | Sens |
|---|---|---|
| `path` | `/` | le chemin HTTP sondé sur le service exposé |
| `port` | le `port` du service | un autre port à sonder |
| `intervalSec` | 10 | secondes entre deux tentatives (de 1 à 300) |
| `timeoutSec` | 5 | secondes avant qu’une tentative échoue (de 1 à 120) |
| `retries` | 3 | tentatives avant de déclarer le service malade (de 1 à 50) |

Le service exposé est sondé en HTTP — une réponse 2xx ou 3xx est saine ; les autres en TCP, car une image de base de données n’embarque pas de client HTTP. L’attente entre deux tentatives grandit, plafonnée à 30 secondes. Donnez assez de `retries` à une application lente : une vérification de santé ratée fait revenir le déploiement en arrière.

## Ressources et réplicas

`resources` fixe ce que le service peut utiliser — `cpuMilli` (1000 = un cœur) et `memoryMi`. `replicas` fait tourner plusieurs copies.

> [!NOTE]
> Sur Docker, un service exposé avec plus d’un réplica ne peut pas être publié sur un port — Compose ne sait pas répartir un port publié sur plusieurs conteneurs —, donc un proxy ne peut pas le joindre. Sur K3s, le Service répartit le trafic. Gardez les services exposés à un réplica sur Docker.

## Les dépendances

`dependsOn` liste les services à démarrer d’abord. Les noms doivent exister, un service ne peut pas dépendre de lui-même, et le graphe ne peut pas boucler (`a → b → a` est refusé, avec le cycle nommé).

## L’ingress

```json
"ingress": { "host": "blog.example.com", "tls": true, "targetService": "web" }
```

`host` est le domaine **par défaut**, retenu au premier déploiement sur une cible ; ensuite, les domaines se règlent par cible dans l’onglet **Domaines** de l’application. `tls` demande HTTPS (`false` par défaut ici ; l’écran de déploiement propose HTTPS). `targetService` nomme le service vers lequel mène le domaine. Sans `ingress`, l’application se joint par son port publié.

## Les règles vérifiées

Au-delà des types, Pupitre refuse une AppSpec quand :

- deux services portent le même nom ;
- aucun service, ou plus d’un, n’est `exposed` ;
- un `dependsOn` nomme un service inconnu, le service lui-même, ou forme un cycle ;
- deux volumes d’un service portent le même nom ;
- un nom est à la fois dans `env` et dans `secrets`, ou un secret est déclaré deux fois ;
- un alias pointe vers lui-même, vers un secret non déclaré, contredit un autre alias, forme un cycle, ou un nom est déclaré à la fois nu et en alias ;
- `ingress.targetService` ne nomme aucun service.

Chaque refus nomme le champ et son chemin (`services.1.dependsOn.0`).

## Exemples

### Un site statique construit depuis un Dockerfile

```json
{
  "name": "bonjour",
  "version": "1.0.0",
  "services": [
    {
      "name": "web",
      "source": { "type": "dockerfile", "context": "examples/bonjour" },
      "port": 8080,
      "exposed": true,
      "healthcheck": { "path": "/", "intervalSec": 5, "timeoutSec": 3, "retries": 10 },
      "resources": { "cpuMilli": 250, "memoryMi": 64 }
    }
  ]
}
```

Avec son Dockerfile, dans `examples/bonjour/` :

```dockerfile
FROM nginxinc/nginx-unprivileged:1.29-alpine
COPY index.html /usr/share/nginx/html/index.html
```

### Une API avec PostgreSQL

```json
{
  "name": "blog",
  "version": "1.4.2",
  "services": [
    {
      "name": "web",
      "source": { "type": "image", "ref": "ghcr.io/example/blog:1.4.2" },
      "port": 8080,
      "exposed": true,
      "env": { "DATABASE_HOST": "db", "DATABASE_NAME": "blog" },
      "secrets": ["DATABASE_PASSWORD"],
      "healthcheck": { "path": "/healthz", "retries": 5 },
      "resources": { "cpuMilli": 500, "memoryMi": 512 },
      "dependsOn": ["db"]
    },
    {
      "name": "db",
      "source": { "type": "image", "ref": "postgres:16-alpine" },
      "port": 5432,
      "env": { "POSTGRES_DB": "blog", "POSTGRES_USER": "blog" },
      "secrets": [{ "name": "POSTGRES_PASSWORD", "from": "DATABASE_PASSWORD" }],
      "volumes": [{ "name": "data", "mountPath": "/var/lib/postgresql/data", "size": "10Gi" }]
    }
  ],
  "ingress": { "host": "blog.example.com", "tls": true, "targetService": "web" }
}
```

### WordPress et MariaDB, un seul mot de passe

```json
{
  "name": "site",
  "version": "1.0.0",
  "services": [
    {
      "name": "wordpress",
      "source": { "type": "image", "ref": "wordpress:6-apache" },
      "port": 80,
      "exposed": true,
      "env": { "WORDPRESS_DB_HOST": "mariadb", "WORDPRESS_DB_USER": "wp", "WORDPRESS_DB_NAME": "wp" },
      "secrets": [{ "name": "WORDPRESS_DB_PASSWORD", "from": "MARIADB_PASSWORD" }],
      "volumes": [{ "name": "content", "mountPath": "/var/www/html", "size": "5Gi" }],
      "healthcheck": { "path": "/wp-login.php", "retries": 10 },
      "dependsOn": ["mariadb"]
    },
    {
      "name": "mariadb",
      "source": { "type": "image", "ref": "mariadb:11" },
      "port": 3306,
      "env": { "MARIADB_USER": "wp", "MARIADB_DATABASE": "wp" },
      "secrets": ["MARIADB_PASSWORD", "MARIADB_ROOT_PASSWORD"],
      "volumes": [{ "name": "data", "mountPath": "/var/lib/mysql", "size": "5Gi" }]
    }
  ],
  "ingress": { "host": "www.example.com", "tls": true, "targetService": "wordpress" }
}
```

L’image `wordpress` vient d’un registre : elle garde l’utilisateur que son image choisit et une racine en écriture — Pupitre retire seulement les capacités Linux dont elle n’a pas besoin et interdit l’élévation de privilèges —, elle peut donc écouter sur le port 80 dans son conteneur.

### Un monorepo

Deux applications dans un même dépôt, chacune avec son `pupitre.json` dans son dossier et un contexte de construction relatif à la racine du dépôt :

```text
dépôt/
├── apps/shop/pupitre.json      → "context": "apps/shop"
├── apps/shop/Dockerfile
├── apps/admin/pupitre.json     → "context": "apps/admin"
└── apps/admin/Dockerfile
```

Seuls les changements sous le dossier d’un fichier concernent son application.

## Valider avant de déployer

L’éditeur valide à la frappe. Depuis un terminal ou une CI, sans rien créer — le corps **est** l’AppSpec :

```bash
curl --fail-with-body -X POST {{origin}}/api/appspec/validate \
  -H "Authorization: Bearer $PUPITRE_TOKEN" -H "Content-Type: application/json" \
  --data @pupitre.json
```

`200` renvoie l’AppSpec telle que Pupitre la gardera, valeurs par défaut appliquées ; `422 invalid_appspec` liste chaque problème avec son chemin. `GET /api/appspec/schema` renvoie le JSON Schema — pour l’autocomplétion d’un éditeur, ou pour un agent.

## Ce que l’AppSpec ne dit pas

Pas de politique de redémarrage, pas de réseau, pas de namespace, pas de commande, pas de point d’entrée, pas de mode privilégié, pas de chemin de l’hôte : le driver décide ce qui peut être décidé, et ce qui touche à l’isolation n’est jamais proposé. Une image qui a besoin d’une commande de démarrage ou du socket Docker n’entre pas dans une AppSpec — construisez plutôt une image qui démarre seule.

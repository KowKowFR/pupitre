import type { Translated } from '@pupitre/core';

/**
 * L'aide sur l'AppSpec — la documentation d'un format JSON, servie dans une
 * modale.
 *
 * ── Ce qui se traduit, et ce qui ne peut pas ────────────────────────────────
 * Les **noms de champs** (`services`, `env`, `ingress`, `targetService`…) sont
 * les clés du format : traduits, ils décriraient une spec que Zod refuserait.
 * Ils restent donc en anglais dans les deux langues, exactement comme les
 * valeurs (`ClusterIP`, `imagePullPolicy: IfNotPresent`) et les identifiants
 * d'outils. Ce qui les **explique**, lui, se traduit intégralement.
 *
 * ── Pourquoi des accents graves dans les valeurs ────────────────────────────
 * Une phrase de cette page alterne prose et identifiants : « slug en
 * kebab-case, 2 à 48 caractères (`demo-api`) ». Découper chaque phrase en trois
 * clés autour de son `<code>` aurait produit un dictionnaire illisible et une
 * traduction impossible à relire. Les `` ` `` marquent donc le code et `**` le
 * passage appuyé ; `<Rich>` les rend. Le balisage ne sort jamais du
 * dictionnaire, et le traducteur voit la phrase entière.
 *
 * Exception : les six garde-fous. Leurs énoncés portaient **déjà** des accents
 * graves affichés tels quels — c'est leur ponctuation, pas du balisage. Ils
 * sont rendus en texte brut.
 */
const fr = {
  'trigger': "Qu'est-ce qu'une AppSpec ?",
  // L'espace avant le « ? » est insécable (U+00A0), comme dans le JSX d'origine.
  'dialog.title': "Qu'est-ce qu'une AppSpec ?",
  'dialog.description':
    "La description neutre d'une application. Elle dit ce que l'application *est*, jamais comment on la déploie.",

  'section.idea': 'L’idée directrice',
  'idea.p1':
    'Une AppSpec est un JSON. Elle décrit des services, leurs ports, leurs variables, leurs volumes. Elle ne connaît ni Docker ni Kubernetes : aucun champ ne peut être rattaché à un runtime. Pas de `restart_policy`, pas d’`image_pull_policy`, pas de `namespace`.',
  'idea.p2':
    'La traduction vers un `compose.yml` ou vers des manifests Kubernetes a lieu au moment du déploiement, dans le driver. Conséquence recherchée : la même AppSpec se déploie sur Docker Compose ou sur K3s en changeant un seul champ — **le runtime de la cible, qui n’est pas dans la spec**.',

  'section.fields': 'Les champs',
  'fields.column.name': 'Champ',
  'fields.column.role': 'À quoi il sert',
  'fields.column.constraint': 'Contraintes',
  'fields.note':
    'Les champs sans valeur explicite prennent leur défaut à la validation. Une spec minimale tient donc en quelques lignes.',

  'field.name.role': "Identifie l'application. Sert de préfixe partout.",
  'field.name.constraint':
    'slug en kebab-case, 2 à 48 caractères : minuscules, chiffres et tirets (`demo-api`).',
  'field.version.role': "Version de l'application, figée dans chaque déploiement.",
  'field.version.constraint': 'semver 2.0.0 — `1.4.2`, pré-version et build acceptés.',
  'field.services.role': 'Les processus qui composent l’application.',
  'field.services.constraint': 'au moins un.',
  'field.serviceName.role': 'Nom du service. C’est aussi son nom sur le réseau interne.',
  'field.serviceName.constraint': 'même slug que `name`, unique dans la spec.',
  'field.source.role':
    'D’où vient le code : une image déjà publiée, ou des sources à construire.',
  'field.source.constraint':
    'union discriminée sur `type`. `image` → `ref` (le tag, 1 à 512 caractères). `dockerfile` → `context` (répertoire relatif au bundle envoyé sur la cible) et `dockerfile` (relatif au contexte, défaut `Dockerfile`).',
  'field.port.role': 'Le port sur lequel le service écoute, dans son conteneur.',
  'field.port.constraint': 'entier, 1 à 65535.',
  'field.exposed.role': 'Désigne la porte d’entrée de l’application.',
  'field.exposed.constraint':
    'booléen, défaut `false`. Exactement un service à `true`.',
  'field.replicas.role': 'Nombre d’instances souhaitées.',
  'field.replicas.constraint': 'entier, 1 à 50, défaut `1`.',
  'field.env.role': 'Variables d’environnement, valeurs littérales. Rien de sensible.',
  'field.env.constraint':
    'objet. Clés en `MAJUSCULES_AVEC_UNDERSCORES`, valeurs de 4096 caractères au plus. Défaut `{}`.',
  'field.secrets.role': 'Noms des valeurs sensibles. Les valeurs vivent ailleurs, chiffrées.',
  'field.secrets.constraint':
    'tableau de noms, même forme que les clés d’`env`. Défaut `[]`. Jamais de valeur ici. Une entrée peut aussi s’écrire `{ "name": "GLPI_DB_PASSWORD", "from": "MARIADB_PASSWORD" }` : le nom reprend alors la valeur d’un autre secret de la spec — une seule valeur, lue sous deux noms, pour une application et sa base qui n’attendent pas la même variable.',
  'field.resources.role': 'Ce que le service demande à la machine.',
  'field.resources.constraint':
    '`cpuMilli` 10 à 64000 (défaut 500), `memoryMi` 16 à 262144 (défaut 512).',
  'field.healthcheck.role': 'Comment savoir que le service est vivant.',
  'field.healthcheck.constraint':
    '`path` commence par `/` (défaut `/`), `port` facultatif (défaut : le `port` du service), `intervalSec` 1 à 300 (défaut 10), `timeoutSec` 1 à 120 (défaut 5), `retries` 1 à 50 (défaut 3).',
  'field.volumes.role': 'Ce qui doit survivre au redémarrage du service.',
  'field.volumes.constraint':
    '`name` slug, unique dans le service ; `mountPath` absolu ; `size` facultative, au format `10Gi` / `500Mi`.',
  'field.dependsOn.role': 'Ce qui doit être prêt avant ce service.',
  'field.dependsOn.constraint':
    'tableau de noms de services. Défaut `[]`. Pas d’auto-référence, pas de cycle.',
  'field.ingress.role':
    'Le nom de domaine par lequel on joint l’application. Bloc facultatif.',
  'field.ingress.constraint':
    '`host` facultatif, 1 à 253 caractères — absent, le panel expose sur un port alloué, sans domaine. `tls` booléen, défaut `false`. `targetService` obligatoire : le slug d’un service de la spec.',

  'section.guards': 'Les six garde-fous',
  'guards.intro':
    'Ce ne sont pas des types, mais des règles croisées vérifiées par Zod avant tout enregistrement. Une spec qui en viole une est refusée, et l’erreur nomme le champ fautif.',
  'guard.exposed.rule': 'Exactement un service porte `exposed: true`',
  'guard.exposed.why':
    'Zéro service exposé : personne ne peut joindre l’application. Deux : le panel ne sait plus lequel publier, ni lequel sonder.',
  'guard.uniqueNames.rule': 'Les noms de services sont uniques',
  'guard.uniqueNames.why':
    'Le nom est aussi l’adresse réseau interne. Deux services homonymes rendraient `API_URL=http://api:8080` ambigu.',
  'guard.dependsOn.rule': 'Chaque `dependsOn` désigne un service existant',
  'guard.dependsOn.why':
    'Une dépendance vers un service absent bloquerait le démarrage sans jamais aboutir. Un service ne peut pas non plus dépendre de lui-même.',
  'guard.cycle.rule': 'Le graphe `dependsOn` n’a pas de cycle',
  'guard.cycle.why':
    'Parcours en profondeur du graphe. `api → db → api` n’a pas d’ordre de démarrage : le message d’erreur nomme le cycle trouvé.',
  'guard.ingress.rule': '`ingress.targetService` désigne un service existant',
  'guard.ingress.why':
    'Sinon la route publique pointerait dans le vide, et l’erreur n’apparaîtrait qu’au déploiement.',
  'guard.envSecret.rule': 'Une clé n’est jamais à la fois dans `env` et dans `secrets`',
  'guard.envSecret.why':
    'Deux origines pour une même variable, dont une en clair dans la spec. On refuse plutôt que de choisir à votre place.',

  'section.mapping': 'Ce qu’elle devient, selon le runtime',
  'mapping.column.spec': 'AppSpec',
  'mapping.column.docker': 'Docker Compose',
  'mapping.column.k3s': 'Kubernetes (K3s)',

  'mapping.name.field': '`name`',
  'mapping.name.docker': 'projet Compose `app-{slug}`, réseau `app-{slug}-net`',
  'mapping.name.k3s': 'namespace `app-{slug}`',
  'mapping.version.field': '`version`',
  'mapping.version.docker': 'tag de l’image construite, label `pupitre.version`',
  'mapping.version.k3s': 'tag de l’image, label `app.kubernetes.io/version`',
  'mapping.services.field': '`services[]`',
  'mapping.services.docker': 'une entrée sous `services:`',
  'mapping.services.k3s': 'un `Deployment` et un `Service` de type `ClusterIP`',
  'mapping.sourceImage.field': '`source` = `image`',
  'mapping.sourceImage.docker': '`image:`',
  'mapping.sourceImage.k3s': '`image:`',
  'mapping.sourceDockerfile.field': '`source` = `dockerfile`',
  'mapping.sourceDockerfile.docker':
    '`build: { context, dockerfile }`, image bâtie sur la cible',
  'mapping.sourceDockerfile.k3s':
    'image bâtie sur le node, `imagePullPolicy: IfNotPresent`',
  'mapping.port.field': '`port`',
  'mapping.port.docker': '`expose:`',
  'mapping.port.k3s': '`containerPort` et port du `Service`',
  'mapping.exposed.field': '`exposed`',
  'mapping.exposed.docker': '`ports: "<port alloué>:<port>"`, plus une règle UFW',
  'mapping.exposed.k3s': 'aucun port hôte — l’entrée passe par l’Ingress',
  'mapping.replicas.field': '`replicas`',
  'mapping.replicas.docker': '`deploy.replicas` (au-delà de 1)',
  'mapping.replicas.k3s': '`spec.replicas`',
  'mapping.env.field': '`env`',
  'mapping.env.docker': '`environment:`',
  'mapping.env.k3s': '`ConfigMap` `{service}-env`, injectée par `envFrom`',
  'mapping.secrets.field': '`secrets[]`',
  'mapping.secrets.docker': 'fichier `.env` déposé en `0600` — jamais dans le `compose.yml`',
  'mapping.secrets.k3s': '`Secret` `{service}-secrets`, manifest écrit en `0600`',
  'mapping.resources.field': '`resources`',
  'mapping.resources.docker': '`deploy.resources.limits` (`cpus`, `memory`)',
  'mapping.resources.k3s': '`requests` et `limits` du conteneur',
  'mapping.healthcheck.field': '`healthcheck`',
  'mapping.healthcheck.docker':
    '`healthcheck:` — sonde HTTP pour le service exposé, test TCP pour les autres',
  'mapping.healthcheck.k3s':
    '`readinessProbe` et `livenessProbe` — `httpGet` ou `tcpSocket`, même règle',
  'mapping.volumes.field': '`volumes[]`',
  'mapping.volumes.docker': 'volume nommé `app-{slug}-{service}-{volume}`',
  'mapping.volumes.k3s':
    '`PersistentVolumeClaim` sur la classe `local-path` ; `size` devient la demande de stockage (défaut `1Gi`)',
  'mapping.dependsOn.field': '`dependsOn`',
  'mapping.dependsOn.docker': '`depends_on` avec `condition: service_healthy`',
  'mapping.dependsOn.k3s': 'ordre d’application des manifests ; la readiness fait le reste',
  'mapping.ingress.field': '`ingress.host` / `tls`',
  'mapping.ingress.docker': 'route Traefik posée par le ProxyProvider, hors du compose',
  'mapping.ingress.k3s': '`Ingress` de classe `traefik`, bloc `tls` si demandé',

  'mapping.note':
    'Le point le plus parlant est ce qui n’a **aucun** champ dans la spec. La politique de redémarrage (`restart: unless-stopped` côté Compose) et le contexte de sécurité (`runAsNonRoot`, UID 1000, `capabilities: drop ALL` côté Kubernetes) sont décidés par le driver. C’est délibéré : ce sont des décisions de runtime, et les exprimer dans la spec la rattacherait à un moteur d’exécution.',

  'section.simple': 'Un exemple minimal',
  'simple.intro':
    'Une image publiée, un seul service, pas d’ingress. Le panel expose alors sur un port alloué sur la cible. Les `//` sont des commentaires d’explication : JSON ne les accepte pas, retirez-les avant de coller.',
  'section.full': 'Un exemple complet',
  'full.intro':
    'Trois services, des sources à construire, des secrets, un volume persistant, des dépendances et un nom de domaine. Extrait, les valeurs par défaut en moins.',
  'full.note':
    '`front` dépend d’`api`, qui dépend de `postgres` : le graphe est acyclique, un seul service est exposé, et `DATABASE_PASSWORD` n’apparaît que dans `secrets`. Les six garde-fous passent.',
  /**
   * Les deux exemples, entiers.
   *
   * Les **clés** et les **valeurs** JSON ne bougent pas d'une langue à l'autre :
   * ce sont celles que Zod attend, et un exemple recopié doit valider. Seuls
   * les commentaires `//` changent — ils expliquent, et une explication se
   * traduit. L'alignement des colonnes tient parce que seul le texte après
   * `//` est remplacé, jamais le remplissage qui le précède.
   */
  'example.simple': `{
  "name": "demo-api",              // slug : minuscules, chiffres, tirets
  "version": "1.0.0",              // semver
  "services": [
    {
      "name": "api",
      "source": {                  // union sur "type" : image | dockerfile
        "type": "image",
        "ref": "docker.io/library/nginx:1.29-alpine"
      },
      "port": 80,                  // port d'écoute dans le conteneur
      "exposed": true,             // exactement un service à true
      "env": { "NODE_ENV": "production" },
      "healthcheck": {             // sondé sur "/" toutes les 5 s, 10 essais
        "path": "/",
        "intervalSec": 5,
        "timeoutSec": 3,
        "retries": 10
      },
      "resources": { "cpuMilli": 500, "memoryMi": 256 }
    }
  ]
}`,
  'example.full': `{
  "name": "boutique",
  "version": "2.3.1",
  "services": [
    {
      "name": "front",
      "source": {                            // sources bâties sur la cible
        "type": "dockerfile",
        "context": "./front",
        "dockerfile": "Dockerfile"
      },
      "port": 3000,
      "exposed": true,                       // la porte d'entrée
      "replicas": 2,
      "env": { "API_URL": "http://api:8080" }, // le nom du service EST l'hôte
      "dependsOn": ["api"]
    },
    {
      "name": "api",
      "source": { "type": "dockerfile", "context": "./api",
                  "dockerfile": "docker/Dockerfile" },
      "port": 8080,
      "env": { "DATABASE_HOST": "postgres" },
      "secrets": ["DATABASE_PASSWORD", "JWT_SECRET"], // noms seuls, pas de valeurs
      "volumes": [
        { "name": "uploads", "mountPath": "/var/lib/app/uploads", "size": "5Gi" }
      ],
      "dependsOn": ["postgres"]
    },
    {
      "name": "postgres",
      "source": { "type": "image", "ref": "postgres:16-alpine" },
      "port": 5432,
      "secrets": ["POSTGRES_PASSWORD"],
      "healthcheck": { "port": 5432, "intervalSec": 5, "retries": 10 },
      "volumes": [
        { "name": "data", "mountPath": "/var/lib/postgresql/data", "size": "20Gi" }
      ]
    }
  ],
  "ingress": {                               // facultatif
    "host": "boutique.example.com",
    "tls": true,
    "targetService": "front"                 // doit exister dans services[]
  }
}`,
} as const;

const en: Translated<typeof fr> = {
  'trigger': 'What is an AppSpec?',
  'dialog.title': 'What is an AppSpec?',
  'dialog.description':
    'The neutral description of an application. It says what the application *is*, never how it gets deployed.',

  'section.idea': 'The guiding idea',
  'idea.p1':
    'An AppSpec is JSON. It describes services, their ports, their variables, their volumes. It knows neither Docker nor Kubernetes: no field can be tied to a runtime. No `restart_policy`, no `image_pull_policy`, no `namespace`.',
  'idea.p2':
    'The translation into a `compose.yml` or into Kubernetes manifests happens at deploy time, in the driver. That is the point: the same AppSpec deploys on Docker Compose or on K3s by changing one field — **the target’s runtime, which is not in the spec**.',

  'section.fields': 'The fields',
  'fields.column.name': 'Field',
  'fields.column.role': 'What it is for',
  'fields.column.constraint': 'Constraints',
  'fields.note':
    'Fields left out take their default at validation. A minimal spec therefore fits in a few lines.',

  'field.name.role': 'Identifies the application. Used as a prefix everywhere.',
  'field.name.constraint':
    'kebab-case slug, 2 to 48 characters: lowercase letters, digits and hyphens (`demo-api`).',
  'field.version.role': 'The application version, frozen into every deployment.',
  'field.version.constraint': 'semver 2.0.0 — `1.4.2`, pre-release and build accepted.',
  'field.services.role': 'The processes the application is made of.',
  'field.services.constraint': 'at least one.',
  'field.serviceName.role': 'The service name. It is also its name on the internal network.',
  'field.serviceName.constraint': 'same slug rules as `name`, unique within the spec.',
  'field.source.role': 'Where the code comes from: a published image, or sources to build.',
  'field.source.constraint':
    'discriminated union on `type`. `image` → `ref` (the tag, 1 to 512 characters). `dockerfile` → `context` (directory relative to the bundle sent to the target) and `dockerfile` (relative to the context, default `Dockerfile`).',
  'field.port.role': 'The port the service listens on, inside its container.',
  'field.port.constraint': 'integer, 1 to 65535.',
  'field.exposed.role': 'Marks the application’s front door.',
  'field.exposed.constraint': 'boolean, default `false`. Exactly one service at `true`.',
  'field.replicas.role': 'How many instances you want.',
  'field.replicas.constraint': 'integer, 1 to 50, default `1`.',
  'field.env.role': 'Environment variables, literal values. Nothing sensitive.',
  'field.env.constraint':
    'object. Keys in `UPPERCASE_WITH_UNDERSCORES`, values of 4096 characters at most. Default `{}`.',
  'field.secrets.role': 'Names of the sensitive values. The values live elsewhere, encrypted.',
  'field.secrets.constraint':
    'array of names, same shape as `env` keys. Default `[]`. Never a value here. An entry can also be written `{ "name": "GLPI_DB_PASSWORD", "from": "MARIADB_PASSWORD" }`: the name then takes the value of another secret in the spec — one value, read under two names, for an application and its database that do not expect the same variable.',
  'field.resources.role': 'What the service asks of the machine.',
  'field.resources.constraint':
    '`cpuMilli` 10 to 64000 (default 500), `memoryMi` 16 to 262144 (default 512).',
  'field.healthcheck.role': 'How to tell the service is alive.',
  'field.healthcheck.constraint':
    '`path` starts with `/` (default `/`), `port` optional (default: the service `port`), `intervalSec` 1 to 300 (default 10), `timeoutSec` 1 to 120 (default 5), `retries` 1 to 50 (default 3).',
  'field.volumes.role': 'What must survive a restart of the service.',
  'field.volumes.constraint':
    '`name` slug, unique within the service; `mountPath` absolute; `size` optional, in the form `10Gi` / `500Mi`.',
  'field.dependsOn.role': 'What must be ready before this service.',
  'field.dependsOn.constraint':
    'array of service names. Default `[]`. No self-reference, no cycle.',
  'field.ingress.role': 'The domain name the application answers on. Optional block.',
  'field.ingress.constraint':
    '`host` optional, 1 to 253 characters — absent, the panel exposes on an allocated port, with no domain. `tls` boolean, default `false`. `targetService` required: the slug of a service in the spec.',

  'section.guards': 'The six guardrails',
  'guards.intro':
    'These are not types but cross-field rules Zod checks before anything is saved. A spec that breaks one is refused, and the error names the offending field.',
  'guard.exposed.rule': 'Exactly one service carries `exposed: true`',
  'guard.exposed.why':
    'No exposed service: nobody can reach the application. Two: the panel no longer knows which one to publish, nor which one to probe.',
  'guard.uniqueNames.rule': 'Service names are unique',
  'guard.uniqueNames.why':
    'The name is also the internal network address. Two services sharing one name would make `API_URL=http://api:8080` ambiguous.',
  'guard.dependsOn.rule': 'Every `dependsOn` names an existing service',
  'guard.dependsOn.why':
    'A dependency on a missing service would block startup for good. A service cannot depend on itself either.',
  'guard.cycle.rule': 'The `dependsOn` graph has no cycle',
  'guard.cycle.why':
    'Depth-first walk of the graph. `api → db → api` has no start order: the error message names the cycle it found.',
  'guard.ingress.rule': '`ingress.targetService` names an existing service',
  'guard.ingress.why':
    'Otherwise the public route would point nowhere, and the error would only surface at deploy time.',
  'guard.envSecret.rule': 'A key is never in both `env` and `secrets`',
  'guard.envSecret.why':
    'Two sources for one variable, one of them in the clear in the spec. We refuse rather than choose for you.',

  'section.mapping': 'What it becomes, by runtime',
  'mapping.column.spec': 'AppSpec',
  'mapping.column.docker': 'Docker Compose',
  'mapping.column.k3s': 'Kubernetes (K3s)',

  'mapping.name.field': '`name`',
  'mapping.name.docker': 'Compose project `app-{slug}`, network `app-{slug}-net`',
  'mapping.name.k3s': 'namespace `app-{slug}`',
  'mapping.version.field': '`version`',
  'mapping.version.docker': 'tag of the built image, label `pupitre.version`',
  'mapping.version.k3s': 'image tag, label `app.kubernetes.io/version`',
  'mapping.services.field': '`services[]`',
  'mapping.services.docker': 'one entry under `services:`',
  'mapping.services.k3s': 'a `Deployment` and a `Service` of type `ClusterIP`',
  'mapping.sourceImage.field': '`source` = `image`',
  'mapping.sourceImage.docker': '`image:`',
  'mapping.sourceImage.k3s': '`image:`',
  'mapping.sourceDockerfile.field': '`source` = `dockerfile`',
  'mapping.sourceDockerfile.docker': '`build: { context, dockerfile }`, image built on the target',
  'mapping.sourceDockerfile.k3s': 'image built on the node, `imagePullPolicy: IfNotPresent`',
  'mapping.port.field': '`port`',
  'mapping.port.docker': '`expose:`',
  'mapping.port.k3s': '`containerPort` and the `Service` port',
  'mapping.exposed.field': '`exposed`',
  'mapping.exposed.docker': '`ports: "<allocated port>:<port>"`, plus a UFW rule',
  'mapping.exposed.k3s': 'no host port — traffic comes in through the Ingress',
  'mapping.replicas.field': '`replicas`',
  'mapping.replicas.docker': '`deploy.replicas` (above 1)',
  'mapping.replicas.k3s': '`spec.replicas`',
  'mapping.env.field': '`env`',
  'mapping.env.docker': '`environment:`',
  'mapping.env.k3s': '`ConfigMap` `{service}-env`, injected through `envFrom`',
  'mapping.secrets.field': '`secrets[]`',
  'mapping.secrets.docker': '`.env` file dropped as `0600` — never inside `compose.yml`',
  'mapping.secrets.k3s': '`Secret` `{service}-secrets`, manifest written as `0600`',
  'mapping.resources.field': '`resources`',
  'mapping.resources.docker': '`deploy.resources.limits` (`cpus`, `memory`)',
  'mapping.resources.k3s': 'container `requests` and `limits`',
  'mapping.healthcheck.field': '`healthcheck`',
  'mapping.healthcheck.docker':
    '`healthcheck:` — HTTP probe for the exposed service, TCP test for the others',
  'mapping.healthcheck.k3s':
    '`readinessProbe` and `livenessProbe` — `httpGet` or `tcpSocket`, same rule',
  'mapping.volumes.field': '`volumes[]`',
  'mapping.volumes.docker': 'named volume `app-{slug}-{service}-{volume}`',
  'mapping.volumes.k3s':
    '`PersistentVolumeClaim` on the `local-path` class; `size` becomes the storage request (default `1Gi`)',
  'mapping.dependsOn.field': '`dependsOn`',
  'mapping.dependsOn.docker': '`depends_on` with `condition: service_healthy`',
  'mapping.dependsOn.k3s': 'the order manifests are applied; readiness does the rest',
  'mapping.ingress.field': '`ingress.host` / `tls`',
  'mapping.ingress.docker': 'Traefik route set by the ProxyProvider, outside the compose file',
  'mapping.ingress.k3s': '`Ingress` of class `traefik`, `tls` block if asked for',

  'mapping.note':
    'The most telling point is what has **no** field in the spec at all. The restart policy (`restart: unless-stopped` on the Compose side) and the security context (`runAsNonRoot`, UID 1000, `capabilities: drop ALL` on the Kubernetes side) are decided by the driver. That is deliberate: they are runtime decisions, and stating them in the spec would tie it to one engine.',

  'section.simple': 'A minimal example',
  'simple.intro':
    'A published image, one service, no ingress. The panel then exposes on a port allocated on the target. The `//` are explanatory comments: JSON does not accept them, strip them before pasting.',
  'section.full': 'A full example',
  'full.intro':
    'Three services, sources to build, secrets, a persistent volume, dependencies and a domain name. An excerpt, defaults left out.',
  'full.note':
    '`front` depends on `api`, which depends on `postgres`: the graph is acyclic, one service is exposed, and `DATABASE_PASSWORD` appears only under `secrets`. All six guardrails pass.',
  'example.simple': `{
  "name": "demo-api",              // slug: lowercase, digits, hyphens
  "version": "1.0.0",              // semver
  "services": [
    {
      "name": "api",
      "source": {                  // union on "type": image | dockerfile
        "type": "image",
        "ref": "docker.io/library/nginx:1.29-alpine"
      },
      "port": 80,                  // port it listens on in the container
      "exposed": true,             // exactly one service at true
      "env": { "NODE_ENV": "production" },
      "healthcheck": {             // probed on "/" every 5 s, 10 tries
        "path": "/",
        "intervalSec": 5,
        "timeoutSec": 3,
        "retries": 10
      },
      "resources": { "cpuMilli": 500, "memoryMi": 256 }
    }
  ]
}`,
  'example.full': `{
  "name": "boutique",
  "version": "2.3.1",
  "services": [
    {
      "name": "front",
      "source": {                            // sources built on the target
        "type": "dockerfile",
        "context": "./front",
        "dockerfile": "Dockerfile"
      },
      "port": 3000,
      "exposed": true,                       // the front door
      "replicas": 2,
      "env": { "API_URL": "http://api:8080" }, // the service name IS the host
      "dependsOn": ["api"]
    },
    {
      "name": "api",
      "source": { "type": "dockerfile", "context": "./api",
                  "dockerfile": "docker/Dockerfile" },
      "port": 8080,
      "env": { "DATABASE_HOST": "postgres" },
      "secrets": ["DATABASE_PASSWORD", "JWT_SECRET"], // names only, no values
      "volumes": [
        { "name": "uploads", "mountPath": "/var/lib/app/uploads", "size": "5Gi" }
      ],
      "dependsOn": ["postgres"]
    },
    {
      "name": "postgres",
      "source": { "type": "image", "ref": "postgres:16-alpine" },
      "port": 5432,
      "secrets": ["POSTGRES_PASSWORD"],
      "healthcheck": { "port": 5432, "intervalSec": 5, "retries": 10 },
      "volumes": [
        { "name": "data", "mountPath": "/var/lib/postgresql/data", "size": "20Gi" }
      ]
    }
  ],
  "ingress": {                               // optional
    "host": "boutique.example.com",
    "tls": true,
    "targetService": "front"                 // must exist in services[]
  }
}`,
};

export const appspecHelp = { fr, en };

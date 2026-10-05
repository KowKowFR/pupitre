import { defineMessages } from '../i18n.js';

/**
 * What importing a `docker-compose.yml` says about what it did.
 *
 * One message per code: the code is stable (the tests and the screen hold on to
 * it), the sentence can change. Each sentence says what was done **and** what
 * the person must conclude from it — "ignored" alone is not enough.
 */
export const composeImportMessages = defineMessages({
  fr: {
    'yaml.invalid': 'Le fichier n’est pas un YAML lisible : {message}',
    'yaml.notCompose': 'Le fichier ne décrit aucun service (clé « services » absente ou vide).',
    'app.name':
      'Nom de l’application : « {name} ». Il se change dans l’AppSpec avant l’enregistrement.',
    'service.renamed':
      'Service « {from} » renommé « {to} » : un nom de service est en minuscules, chiffres et tirets.',
    'service.noSource':
      'Ni « image » ni « build » : impossible de savoir quoi lancer. Ajoutez une image dans l’AppSpec.',
    'service.dropped': 'Service « {name} » écarté : {reason}',
    'build.context':
      'Construit depuis « {context} » : le code doit arriver sur la cible — reliez l’application à son dépôt GitHub.',
    'build.args': 'Arguments de build non repris ({names}) : l’AppSpec ne les porte pas.',
    'image.untagged': 'Image « {image} » sans étiquette : c’est « latest » qui partira, et il change sans prévenir.',
    'port.guessed': 'Aucun port déclaré : {port} retenu d’après l’image. Vérifiez-le.',
    'port.default': 'Aucun port déclaré, et l’image ne permet pas de le deviner : 80 par défaut. Vérifiez-le.',
    'port.multiple': 'Plusieurs ports : {kept} retenu, {dropped} non repris. Une AppSpec expose un port par service.',
    'port.udp': 'Port {port} en UDP non repris : seuls les ports TCP se publient.',
    'port.range': 'Plage de ports « {range} » non reprise : seul un port par service.',
    'port.hostIgnored':
      'Port hôte {host} ignoré : la cible choisit le port publié dans sa plage, ou l’ingress expose l’application.',
    'exposed.chosen': 'Service exposé : « {service} » — c’est lui qui recevra le trafic.',
    'exposed.guessed':
      'Aucun port publié : « {service} » est exposé faute de mieux. Vérifiez que c’est bien la porte d’entrée.',
    'exposed.others':
      '« {service} » publiait aussi un port : il devient interne. Une AppSpec n’expose qu’un service.',
    'replicas.exposed':
      '{count} répliques sur le service exposé : sur Docker Compose, un seul conteneur peut publier le port.',
    'env.interpolated':
      '« {name} » dépend d’une variable du shell ({expression}) : {outcome}',
    'env.interpolated.default': 'sa valeur par défaut « {value} » a été reprise.',
    'env.interpolated.empty': 'elle est vide dans l’AppSpec, à renseigner.',
    'env.invalidName':
      'Variable « {name} » non reprise : un nom de variable est en MAJUSCULES_AVEC_UNDERSCORES.',
    'env.secret':
      '« {name} » ressemble à un secret : sa valeur n’est pas reprise. Pupitre en génère une, chiffrée — ou saisissez-la sur la fiche.',
    'env.secretAlias':
      '« {name} » partage la valeur de « {from} » : un seul secret, lu sous deux noms.',
    'env.secretConflict':
      '« {name} » a des valeurs différentes selon les services : un seul secret est créé, vérifiez qu’ils peuvent la partager.',
    'env_file': 'Fichier d’environnement « {file} » non lu : ses variables sont à reporter dans l’AppSpec.',
    'volume.bind':
      'Dossier de l’hôte « {source} » remplacé par un volume nommé « {name} » sur {target} : son contenu n’est pas copié.',
    'volume.file':
      'Fichier de l’hôte « {source} » monté sur {target} : non traduisible. Intégrez-le à l’image (Dockerfile) ou à une variable.',
    'volume.socket':
      'Socket Docker montée ({target}) : jamais transmise à une application — elle donnerait la main sur toute la machine.',
    'volume.anonymous': 'Volume anonyme sur {target} remplacé par un volume nommé « {name} ».',
    'volume.readonly': 'Montage en lecture seule sur {target} : l’AppSpec monte en lecture-écriture.',
    'volume.tmpfs': 'tmpfs sur {target} non repris : le driver prépare lui-même /tmp.',
    'command':
      '« {key} » non repris : l’AppSpec ne porte pas de commande de démarrage. L’image doit démarrer seule — sinon, construisez-la depuis un Dockerfile.',
    'healthcheck.http': 'Sonde de santé reprise : HTTP sur {path}{portNote}.',
    'healthcheck.unparsed':
      'Sonde de santé « {test} » non traduite : le service sera sondé sur « / » s’il est exposé, au niveau TCP sinon.',
    'healthcheck.disabled': 'Sonde désactivée dans le compose : Pupitre sonde quand même, c’est ce qui décide du rollback.',
    'dependsOn.unknown': 'Dépendance vers « {name} », service inconnu : non reprise.',
    'dependsOn.condition': 'Conditions de « depends_on » ignorées : Pupitre attend toujours que la dépendance soit saine.',
    'resources': 'Ressources reprises : {cpu} milli-CPU, {memory} Mio.',
    'resources.unreadable': 'Limite « {value} » illisible : la valeur par défaut est gardée.',
    'ingress.traefik': 'Domaine « {host} » repris des labels Traefik{tlsNote}.',
    'ignored': '« {key} » ignoré : {reason}',
    'unsupported': '« {key} » non traduisible : {reason}',
    'unknown': 'Clé « {key} » inconnue, ignorée.',
    'topLevel': 'Section « {key} » au premier niveau ignorée : {reason}',
    'schema': 'L’AppSpec obtenue n’est pas encore valable : {message}',
  },
  en: {
    'yaml.invalid': 'The file is not readable YAML: {message}',
    'yaml.notCompose': 'The file describes no service (“services” key missing or empty).',
    'app.name': 'Application name: “{name}”. Change it in the AppSpec before saving.',
    'service.renamed':
      'Service “{from}” renamed “{to}”: a service name is lowercase letters, digits and dashes.',
    'service.noSource':
      'Neither “image” nor “build”: no way to tell what to run. Add an image in the AppSpec.',
    'service.dropped': 'Service “{name}” left out: {reason}',
    'build.context':
      'Built from “{context}”: the code must reach the target — link the application to its GitHub repository.',
    'build.args': 'Build arguments not carried over ({names}): the AppSpec does not hold them.',
    'image.untagged': 'Image “{image}” has no tag: “latest” will be pulled, and it changes without notice.',
    'port.guessed': 'No port declared: {port} chosen from the image. Check it.',
    'port.default': 'No port declared, and the image does not tell: 80 by default. Check it.',
    'port.multiple': 'Several ports: {kept} kept, {dropped} not carried over. An AppSpec exposes one port per service.',
    'port.udp': 'UDP port {port} not carried over: only TCP ports are published.',
    'port.range': 'Port range “{range}” not carried over: one port per service only.',
    'port.hostIgnored':
      'Host port {host} ignored: the target picks the published port from its range, or the ingress exposes the application.',
    'exposed.chosen': 'Exposed service: “{service}” — it receives the traffic.',
    'exposed.guessed':
      'No published port: “{service}” is exposed for lack of a better choice. Check it is the entry point.',
    'exposed.others':
      '“{service}” also published a port: it becomes internal. An AppSpec exposes a single service.',
    'replicas.exposed':
      '{count} replicas on the exposed service: on Docker Compose, a single container can publish the port.',
    'env.interpolated': '“{name}” depends on a shell variable ({expression}): {outcome}',
    'env.interpolated.default': 'its default value “{value}” was kept.',
    'env.interpolated.empty': 'it is empty in the AppSpec, to be filled in.',
    'env.invalidName':
      'Variable “{name}” not carried over: a variable name is UPPERCASE_WITH_UNDERSCORES.',
    'env.secret':
      '“{name}” looks like a secret: its value is not carried over. Pupitre generates one, encrypted — or enter it on the application page.',
    'env.secretAlias': '“{name}” shares the value of “{from}”: one secret, read under two names.',
    'env.secretConflict':
      '“{name}” has different values across services: a single secret is created, check they can share it.',
    'env_file': 'Environment file “{file}” not read: its variables must be added to the AppSpec.',
    'volume.bind':
      'Host directory “{source}” replaced by a named volume “{name}” on {target}: its content is not copied.',
    'volume.file':
      'Host file “{source}” mounted on {target}: cannot be translated. Bake it into the image (Dockerfile) or a variable.',
    'volume.socket':
      'Docker socket mounted ({target}): never handed to an application — it would give control of the whole machine.',
    'volume.anonymous': 'Anonymous volume on {target} replaced by a named volume “{name}”.',
    'volume.readonly': 'Read-only mount on {target}: the AppSpec mounts read-write.',
    'volume.tmpfs': 'tmpfs on {target} not carried over: the driver prepares /tmp itself.',
    'command':
      '“{key}” not carried over: the AppSpec holds no start command. The image must start on its own — otherwise, build it from a Dockerfile.',
    'healthcheck.http': 'Health probe carried over: HTTP on {path}{portNote}.',
    'healthcheck.unparsed':
      'Health probe “{test}” not translated: the service is probed on “/” if exposed, at TCP level otherwise.',
    'healthcheck.disabled': 'Probe disabled in the compose file: Pupitre probes anyway, it is what drives rollback.',
    'dependsOn.unknown': 'Dependency on “{name}”, an unknown service: not carried over.',
    'dependsOn.condition': '“depends_on” conditions ignored: Pupitre always waits for the dependency to be healthy.',
    'resources': 'Resources carried over: {cpu} milli-CPU, {memory} MiB.',
    'resources.unreadable': 'Limit “{value}” unreadable: the default value is kept.',
    'ingress.traefik': 'Domain “{host}” taken from the Traefik labels{tlsNote}.',
    'ignored': '“{key}” ignored: {reason}',
    'unsupported': '“{key}” cannot be translated: {reason}',
    'unknown': 'Unknown key “{key}”, ignored.',
    'topLevel': 'Top-level “{key}” section ignored: {reason}',
    'schema': 'The resulting AppSpec is not valid yet: {message}',
  },
});

export type ComposeIssueCode = keyof typeof composeImportMessages.fr;

/**
 * The reasons of the ignored or untranslatable keys. Apart from the codes: the
 * same "ignored: {reason}" sentence serves twenty keys, each with its reason.
 */
export const composeReasons = defineMessages({
  fr: {
    restart: 'le driver décide de la politique de redémarrage.',
    container_name: 'le nom des conteneurs suit le projet de l’application, app-<nom>.',
    hostname: 'chaque service se joint par son nom de service.',
    networks: 'une application a son réseau à elle, partagé par ses services.',
    labels: 'les labels sont posés par le driver.',
    logging: 'les logs passent par Pupitre.',
    stop_grace_period: 'le driver arrête les services lui-même.',
    init: 'sans effet sur l’AppSpec.',
    profiles: 'tous les services de l’import sont repris.',
    pull_policy: 'le driver tire les images à chaque déploiement.',
    links: 'les services se joignent par leur nom ; repris comme dépendance.',
    deploy: 'seuls « replicas » et « resources.limits » se traduisent.',
    tty: 'sans effet pour un service.',
    stdin_open: 'sans effet pour un service.',
    domainname: 'chaque service se joint par son nom de service.',
    privileged: 'un conteneur privilégié a la main sur la machine ; jamais accordé.',
    network_mode: 'le réseau de l’hôte ou d’un autre conteneur sort de l’isolation de l’application.',
    pid: 'partager l’espace des processus sort de l’isolation.',
    ipc: 'partager la mémoire sort de l’isolation.',
    devices: 'aucun périphérique de la machine n’est transmis.',
    cap_add: 'les capacités sont fixées par le driver.',
    cap_drop: 'les capacités sont fixées par le driver.',
    security_opt: 'le profil de sécurité est fixé par le driver.',
    sysctls: 'les réglages noyau restent ceux de la cible.',
    ulimits: 'les limites système restent celles de la cible.',
    user: 'l’identité du processus est celle de l’image (ou fixée par le driver).',
    working_dir: 'le répertoire de travail est celui de l’image.',
    extra_hosts: 'pas de résolution de noms sur mesure.',
    dns: 'pas de résolution de noms sur mesure.',
    platform: 'l’architecture est celle de la cible.',
    secrets: 'les secrets passent par le magasin chiffré de Pupitre.',
    configs: 'les fichiers de configuration sont à intégrer à l’image.',
    volumes: 'les volumes sont déclarés par service dans l’AppSpec.',
    version: 'obsolète dans Compose.',
    extension: 'extension « x- » réservée aux fichiers Compose.',
    unknownTop: 'inconnue de Compose et de l’AppSpec.',
  },
  en: {
    restart: 'the driver decides the restart policy.',
    container_name: 'container names follow the application project, app-<name>.',
    hostname: 'each service is reached by its service name.',
    networks: 'an application has its own network, shared by its services.',
    labels: 'labels are set by the driver.',
    logging: 'logs go through Pupitre.',
    stop_grace_period: 'the driver stops services itself.',
    init: 'no effect on the AppSpec.',
    profiles: 'every service of the import is carried over.',
    pull_policy: 'the driver pulls images on every deployment.',
    links: 'services reach each other by name; kept as a dependency.',
    deploy: 'only “replicas” and “resources.limits” translate.',
    tty: 'no effect for a service.',
    stdin_open: 'no effect for a service.',
    domainname: 'each service is reached by its service name.',
    privileged: 'a privileged container controls the machine; never granted.',
    network_mode: 'the host network, or another container’s, leaves the application’s isolation.',
    pid: 'sharing the process namespace leaves isolation.',
    ipc: 'sharing memory leaves isolation.',
    devices: 'no device of the machine is handed over.',
    cap_add: 'capabilities are set by the driver.',
    cap_drop: 'capabilities are set by the driver.',
    security_opt: 'the security profile is set by the driver.',
    sysctls: 'kernel settings stay those of the target.',
    ulimits: 'system limits stay those of the target.',
    user: 'the process identity is the image’s (or set by the driver).',
    working_dir: 'the working directory is the image’s.',
    extra_hosts: 'no custom name resolution.',
    dns: 'no custom name resolution.',
    platform: 'the architecture is the target’s.',
    secrets: 'secrets go through Pupitre’s encrypted store.',
    configs: 'configuration files must be baked into the image.',
    volumes: 'volumes are declared per service in the AppSpec.',
    version: 'obsolete in Compose.',
    extension: '“x-” extension reserved to Compose files.',
    unknownTop: 'unknown to Compose and to the AppSpec.',
  },
});

export type ComposeReason = keyof typeof composeReasons.fr;

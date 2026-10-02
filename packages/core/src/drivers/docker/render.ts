import { buildContextPath } from '../source-archive.js';
import { stringify } from 'yaml';
import { WORKSPACE_PREFIX } from '../../naming.js';
import {
  exposedService,
  topologicalOrder,
  type AppSpec,
  type Service,
} from '../../spec/index.js';
import { isHttpProbed, probePort } from '../probe.js';
import { completeSecretValues } from '../secrets.js';
import type { RenderedFile } from '../types.js';
import {
  seconds,
  type ComposeFile,
  type ComposeService,
  type ComposeHealthcheck,
} from './compose-model.js';

/**
 * Traduction AppSpec → Compose.
 *
 * C'est le seul endroit du projet qui a le droit de connaître Docker. Tout ce
 * que la spec neutre ne sait pas dire — politique de redémarrage, réseau,
 * nommage des images — est décidé ici, parce que c'est une affaire de runtime.
 */

/** Dérivé de la convention partagée : une seule définition de `app-`. */
export const PROJECT_PREFIX = WORKSPACE_PREFIX;

export function projectName(appSlug: string): string {
  return `${PROJECT_PREFIX}${appSlug}`;
}

export function networkName(appSlug: string): string {
  return `${projectName(appSlug)}-net`;
}

/** Nom d'un volume, préfixé pour rester unique sur une cible partagée. */
export function volumeName(appSlug: string, service: string, volume: string): string {
  return `${projectName(appSlug)}-${service}-${volume}`;
}

/** Image construite localement pour un service à bâtir. */
export function buildImageTag(appSlug: string, service: string, version: string): string {
  return `${projectName(appSlug)}/${service}:${version}`;
}

/**
 * UID/GID du compte non privilégié. La spec ne le dit pas : c'est une décision
 * de runtime, comme la politique de redémarrage.
 *
 * Le rendu K3s pose la même valeur, mais elle y sert **deux** usages : imposer
 * l'identité du processus, et donner son groupe au volume monté (`fsGroup`).
 * Compose n'a pas de second usage à offrir — voir `pinsRunAsUser()`.
 */
export const RUN_AS_UID = 1000;

/**
 * Pendant de `allowPrivilegeEscalation: false`.
 *
 * Ce n'est **pas** une redondance avec `cap_drop`. Mesuré sur la cible, un
 * conteneur Docker sans option démarre avec `NoNewPrivs: 0` — un binaire setuid
 * présent dans l'image peut donc encore regagner ce qu'on vient de retirer.
 * L'option pose le bit à 1 :
 *
 *     docker run --rm nginx:1.27-alpine grep NoNewPrivs /proc/1/status
 *     NoNewPrivs:  0
 *     docker run --rm --security-opt no-new-privileges:true … → NoNewPrivs: 1
 *
 * Vérifiée sans dégât sur `nginx`, `postgres`, `redis`, `httpd`, `mariadb`,
 * `wordpress` et `adminer` : leurs points d'entrée abandonnent leurs privilèges
 * avec `gosu`/`su-exec`, qui appellent `setuid()` en tant que root et ne sont
 * pas des binaires setuid — le drapeau ne les gêne pas. Une image qui passerait
 * par `su` ou `sudo`, eux setuid, serait la seule à en souffrir.
 */
const NO_NEW_PRIVILEGES = 'no-new-privileges:true';

/**
 * Capacités rendues à un conteneur qui garde l'identité choisie par son image.
 *
 * Même liste que le rendu K3s, et pour la même raison — vérifiée ici aussi,
 * `cap_drop: ALL` seul casse les images officielles les plus banales :
 *
 *     nginx    : chown("/var/cache/nginx/client_temp", 101) failed (1: Operation not permitted)
 *     postgres : chmod: /var/run/postgresql: Operation not permitted
 *                error: failed switching to 'postgres': operation not permitted
 *
 * Le schéma est toujours le même : démarrer root, préparer ses répertoires,
 * puis abandonner ses privilèges. Il réclame ces cinq capacités et pas une de
 * plus — `CapEff` tombe de `a80425fb` (les quatorze de Docker) à `cb`.
 *
 * `NET_BIND_SERVICE` en est volontairement absente, comme côté K3s : Docker
 * pose `net.ipv4.ip_unprivileged_port_start=0` dans le conteneur, et un `nginx`
 * écoutant sur 80 démarre sans elle — vérifié sur la cible.
 */
const RETAINED_CAPABILITIES = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID'];

/**
 * Scratch imposé par la racine en lecture seule.
 *
 * `exec` est explicite et ce n'est pas un oubli de durcissement : le tmpfs de
 * Docker est `noexec` par défaut, alors que l'`emptyDir` que le rendu K3s monte
 * au même endroit ne l'est pas. Laisser le défaut ferait qu'une application qui
 * exécute quelque chose depuis `/tmp` tournerait en K3s et échouerait en
 * Docker : ce serait exactement la divergence de comportement entre runtimes
 * que le projet interdit. Le durcissement marginal ne vaut pas ce prix.
 *
 * `mode=1777` reprend le défaut de Docker, écrit pour qu'il cesse d'être un
 * défaut implicite.
 */
const TMP_SCRATCH = `/tmp:exec,mode=1777`;

/**
 * Le durcissement n'est légitime que sur ce qu'on connaît.
 *
 * Sur une image que **nous** construisons depuis un Dockerfile, on sait ce
 * qu'elle écrit et sous quel compte elle tourne. Sur une image tierce tirée
 * d'un registry, on ne sait rien de tout cela, et chaque contrainte imposée à
 * l'aveugle devient une panne au démarrage.
 */
function isOwnImage(service: Service): boolean {
  return service.source.type === 'dockerfile';
}

/**
 * Imposons-nous l'identité du processus, ou laissons-nous l'image choisir ?
 *
 * C'est **la** question que Compose pose différemment de Kubernetes, et la
 * seule divergence assumée entre les deux rendus.
 *
 * Côté K3s, `fsGroup` fait qu'un volume fraîchement provisionné devient
 * inscriptible par un conteneur tournant sous son propre uid : le kubelet
 * chown le point de montage. **Compose n'a aucun équivalent.** Mesuré sur la
 * cible, un volume nommé neuf est `root:root 0755` et le reste :
 *
 *     docker run -u 1000:1000 -v neuf:/data nginx:1.27-alpine touch /data/x
 *     touch: /data/x: Permission denied
 *
 * `group_add: 0` n'y change rien — le répertoire est en `0755`, le groupe n'a
 * pas le bit d'écriture. Le seul chemin qui marche est que l'image ait
 * elle-même préparé le point de montage : Docker recopie alors la propriété de
 * ce répertoire dans le volume neuf. Or le Dockerfile vient de l'utilisateur,
 * on ne peut pas en faire une hypothèse.
 *
 * D'où la règle : on n'impose l'uid qu'aux images que l'on bâtit **et** qui ne
 * déclarent aucun volume. Ailleurs, l'image garde son identité — et reçoit donc
 * les cinq capacités, qui sont précisément ce dont son point d'entrée a besoin
 * pour faire à la main ce que `fsGroup` ferait pour lui.
 *
 * Imposer l'uid partout produirait un conteneur qui démarre puis échoue à la
 * première écriture : une régression, pas un durcissement.
 */
function pinsRunAsUser(service: Service): boolean {
  return isOwnImage(service) && service.volumes.length === 0;
}

/**
 * Racine en lecture seule : tenable seulement sur une image que l'on bâtit.
 * Vérifié sur la cible, `--read-only` sur une image tierce échoue tout de
 * suite — `nginx` : `mkdir() "/var/cache/nginx/client_temp" failed (30:
 * Read-only file system)`. Le critère est donc `isOwnImage()`, exactement comme
 * côté K3s, et non `pinsRunAsUser()` : un volume monté reste inscriptible quoi
 * qu'il arrive à la racine.
 */
function allowsReadOnlyRoot(service: Service): boolean {
  return isOwnImage(service);
}

/**
 * Pose le contexte de sécurité sur un service.
 *
 * Ce qui **n'est pas** écrit ici l'est tout autant par décision :
 *
 * - **Profil seccomp.** Aucun à déclarer. Docker en applique déjà un
 *   (`docker info` → `name=seccomp,profile=builtin`), et il est actif sans
 *   qu'on demande rien : `grep Seccomp /proc/1/status` rend `2` (mode filtre)
 *   dans un conteneur lancé sans option. C'est le `RuntimeDefault` du rendu
 *   K3s, sous un autre nom. Compose ne sait de toute façon dire que
 *   `seccomp:unconfined` ou un chemin de profil JSON : la seule déclaration
 *   possible affaiblirait ce qui est déjà en place.
 * - **`privileged: false`.** C'est le défaut de Docker. L'écrire n'ajouterait
 *   rien qu'un champ de plus à relire.
 * - **`fsGroup`.** Sans équivalent — voir `pinsRunAsUser()`.
 */
function applySecurityContext(composeService: ComposeService, service: Service): void {
  composeService.security_opt = [NO_NEW_PRIVILEGES];

  // On part de zéro dans tous les cas, puis on rend ce qui a été mesuré comme
  // nécessaire. Une image dont on fixe l'uid n'a besoin de rien : elle ne
  // démarre jamais root, donc elle n'a rien à préparer avant de se dégrader.
  composeService.cap_drop = ['ALL'];
  if (!pinsRunAsUser(service)) {
    composeService.cap_add = [...RETAINED_CAPABILITIES];
  }

  if (pinsRunAsUser(service)) {
    composeService.user = `${RUN_AS_UID}:${RUN_AS_UID}`;
  }

  if (allowsReadOnlyRoot(service)) {
    composeService.read_only = true;
    // Sans `/tmp` inscriptible, presque aucun runtime applicatif ne démarre.
    // Sauf si la spec y monte déjà un volume — même réserve que le rendu K3s.
    if (!service.volumes.some((volume) => volume.mountPath === '/tmp')) {
      composeService.tmpfs = [TMP_SCRATCH];
    }
  }
}

/**
 * Sonde exécutée *dans* le conteneur.
 *
 * Qui est sondé en HTTP et qui l'est en TCP n'est pas décidé ici : c'est
 * `isHttpProbed()`, partagé avec le rendu K3s. Ne reste à ce rendu que le
 * *comment*, qui dépend de ce que l'image embarque.
 *
 * HTTP : `wget`, sinon `curl`, présents dans busybox comme dans la plupart des
 * bases Debian. Une image qui n'a **ni l'un ni l'autre** existe pourtant —
 * `freshrss/freshrss`, vu sur une vraie cible : sa sonde rendait 127 à vie, le
 * conteneur restait `unhealthy` et `up --wait` faisait échouer le déploiement
 * d'une application qui répondait très bien. Faute d'outil HTTP, la sonde
 * retombe alors sur le test TCP ci-dessous. Elle ne retombe **que** dans ce
 * cas : un `wget` présent qui reçoit une 500 reste un échec, il ne se rattrape
 * pas sur un port ouvert. Le statut HTTP, lui, est vérifié de l'extérieur par
 * `healthcheck()` à chaque déploiement.
 *
 * TCP : `nc` puis la redirection `/dev/tcp` de bash. Les deux sont nécessaires
 * et aucun ne suffit — `postgres:16-alpine` a `nc` mais pas `bash`,
 * `postgres:16` et `mariadb:11` (Debian) ont `bash` mais **ni `nc`, ni `wget`,
 * ni `curl`. L'ancienne chaîne `nc || wget || curl` ne trouvait donc aucune de
 * ses trois commandes sur une base Debian : le shell rendait 127, le conteneur
 * restait `unhealthy` à vie, et le `depends_on: service_healthy` du service
 * applicatif bloquait avec lui. Un repli HTTP sur un service qui ne parle pas
 * HTTP n'aurait de toute façon jamais abouti : il est retiré.
 */
function renderHealthcheck(spec: AppSpec, service: Service): ComposeHealthcheck {
  const port = probePort(service);
  const timeout = Math.max(1, service.healthcheck.timeoutSec);

  const tcp =
    `nc -z -w ${timeout} 127.0.0.1 ${port} 2>/dev/null ` +
    `|| bash -c 'exec 3<>/dev/tcp/127.0.0.1/${port}' 2>/dev/null`;
  const url = `http://127.0.0.1:${port}${service.healthcheck.path}`;

  const probe = isHttpProbed(spec, service)
    ? `if command -v wget >/dev/null 2>&1; then wget --spider -q -T ${timeout} ${url}; ` +
      `elif command -v curl >/dev/null 2>&1; then curl -fsS -m ${timeout} ${url} >/dev/null; ` +
      `else ${tcp}; fi`
    : tcp;

  return {
    test: ['CMD-SHELL', probe],
    interval: seconds(service.healthcheck.intervalSec),
    timeout: seconds(timeout),
    retries: service.healthcheck.retries,
    start_period: seconds(service.healthcheck.intervalSec * 2),
  };
}

export type RenderInput = {
  spec: AppSpec;
  appSlug: string;
  /** Port publié sur l'hôte pour le service exposé. `null` = pas de publication. */
  publishedPort: number | null;
  /** Adresse de publication — voir `DriverExposure.bindAddress`. Absente : toutes. */
  publishAddress?: string;
  /** Noms des secrets dont la valeur sera fournie par le fichier `.env`. */
  secretNames?: readonly string[];
  /** Le code d'un dépôt est sous `source/` : voir `DriverContext.sourceInRelease`. */
  sourceInRelease?: boolean;
  /** L'étiquette des images construites : la release (`releaseName()`). Défaut : la version. */
  imageTag?: string;
};

/** Le fichier Compose de Pupitre, toujours désigné par son nom (`-f`). */
export const COMPOSE_FILE = 'compose.yml';

export function renderComposeFile(input: RenderInput): ComposeFile {
  const { spec, appSlug, publishedPort } = input;
  const project = projectName(appSlug);
  const network = 'appnet';
  const exposed = exposedService(spec);

  const services: Record<string, ComposeService> = {};
  const volumes: Record<string, Record<string, never>> = {};

  // L'ordre topologique rend le fichier lisible : une dépendance apparaît
  // toujours avant le service qui la déclare.
  for (const service of topologicalOrder(spec)) {
    const isExposed = service.name === exposed.name;

    const image =
      service.source.type === 'image'
        ? service.source.ref
        : buildImageTag(appSlug, service.name, input.imageTag ?? spec.version);

    const composeService: ComposeService = {
      image,
      // La politique de redémarrage est une décision du runtime, pas de la
      // spec : c'est pour ça qu'aucun champ `restart` n'existe dans l'AppSpec.
      restart: 'unless-stopped',
      networks: [network],
      expose: [String(service.port)],
      // Préfixe `pupitre.` depuis le renommage. Le driver continue de lire les
      // anciens `tp.*` : un conteneur posé avant garde son empreinte, et le
      // panel doit continuer de le reconnaître comme sien.
      labels: {
        'pupitre.app': appSlug,
        'pupitre.service': service.name,
        'pupitre.version': spec.version,
        'pupitre.managed-by': 'pupitre',
      },
    };

    if (service.source.type === 'dockerfile') {
      composeService.build = {
        context: buildContextPath(service.source.context, input.sourceInRelease),
        dockerfile: service.source.dockerfile,
      };
    }

    if (Object.keys(service.env).length > 0) {
      composeService.environment = { ...service.env };
    }

    // Les secrets ne sont jamais inscrits dans le compose.yml : ils arrivent
    // par un fichier `.env` déposé à côté, en mode 0600.
    if (service.secrets.length > 0) {
      composeService.env_file = ['./.env'];
    }

    if (isExposed && publishedPort !== null) {
      composeService.ports = [
        input.publishAddress
          ? `${input.publishAddress}:${publishedPort}:${service.port}`
          : `${publishedPort}:${service.port}`,
      ];
    }

    if (service.volumes.length > 0) {
      composeService.volumes = service.volumes.map((volume) => {
        const name = volumeName(appSlug, service.name, volume.name);
        volumes[name] = {};
        return `${name}:${volume.mountPath}`;
      });
    }

    if (service.dependsOn.length > 0) {
      composeService.depends_on = Object.fromEntries(
        service.dependsOn.map((dependency) => [dependency, { condition: 'service_healthy' }]),
      );
    }

    composeService.healthcheck = renderHealthcheck(spec, service);

    // Après les volumes : la présence d'un volume décide de l'identité imposée,
    // et un volume monté sur `/tmp` rend le tmpfs de scratch inutile.
    applySecurityContext(composeService, service);

    const deploy: ComposeDeployDraft = {};
    if (service.replicas > 1) deploy.replicas = service.replicas;
    deploy.resources = {
      limits: {
        cpus: (service.resources.cpuMilli / 1000).toFixed(3),
        memory: `${service.resources.memoryMi}M`,
      },
    };
    composeService.deploy = deploy;

    services[service.name] = composeService;
  }

  const file: ComposeFile = {
    name: project,
    services,
    networks: {
      [network]: { name: networkName(appSlug), driver: 'bridge' },
    },
  };

  if (Object.keys(volumes).length > 0) {
    file.volumes = volumes;
  }

  return file;
}

type ComposeDeployDraft = NonNullable<ComposeService['deploy']>;

/** Sérialise le modèle. `lineWidth: 0` évite les replis de ligne inattendus. */
export function serializeComposeFile(file: ComposeFile): string {
  const header = [
    '# Généré par Pupitre — ne pas éditer à la main.',
    `# Projet : ${file.name}`,
    '',
  ].join('\n');
  return `${header}${stringify(file, { lineWidth: 0, singleQuote: false })}`;
}

/** Fichier `.env` des secrets. Déposé en 0600, jamais journalisé. */
export function serializeEnvFile(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([key, value]) => `${key}=${escapeEnvValue(value)}`)
    .join('\n')
    .concat('\n');
}

function escapeEnvValue(value: string): string {
  if (/^[A-Za-z0-9_.\-/:@]*$/.test(value)) return value;
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')}"`;
}

/** Ensemble complet des fichiers à déposer sur la cible. */
export function renderFiles(
  input: RenderInput & { secretValues?: Record<string, string> },
): RenderedFile[] {
  const files: RenderedFile[] = [
    {
      path: COMPOSE_FILE,
      content: serializeComposeFile(renderComposeFile(input)),
      mode: 0o644,
    },
  ];

  // Échoue si un secret déclaré n'a pas de valeur résolue — voir
  // `completeSecretValues()`. Le rendu est le dernier endroit où l'on peut
  // encore nommer le coupable.
  const complete = completeSecretValues(input.spec, input.secretValues ?? {});

  if (Object.keys(complete).length > 0) {
    files.push({
      path: '.env',
      content: serializeEnvFile(complete),
      mode: 0o600,
    });
  }

  return files;
}

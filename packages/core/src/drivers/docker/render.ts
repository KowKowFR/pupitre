import { stringify } from 'yaml';
import {
  exposedService,
  topologicalOrder,
  type AppSpec,
  type Service,
} from '../../spec/index.js';
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

export const PROJECT_PREFIX = 'app-';

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
 * Sonde exécutée *dans* le conteneur.
 *
 * La spec neutre dit « ce service est vivant quand ce chemin répond ». Comment
 * le vérifier dépend de l'image : on tente `wget` puis `curl`, présents dans
 * busybox comme dans les bases Debian. Les services non exposés sont sondés au
 * niveau TCP : tous ne parlent pas HTTP, et la spec n'a pas à le savoir.
 */
function renderHealthcheck(service: Service, isExposed: boolean): ComposeHealthcheck {
  const port = service.healthcheck.port ?? service.port;
  const timeout = Math.max(1, service.healthcheck.timeoutSec);

  const probe = isExposed
    ? `wget --spider -q -T ${timeout} http://127.0.0.1:${port}${service.healthcheck.path} ` +
      `|| curl -fsS -m ${timeout} http://127.0.0.1:${port}${service.healthcheck.path} >/dev/null`
    : `nc -z 127.0.0.1 ${port} ` +
      `|| wget --spider -q -T ${timeout} http://127.0.0.1:${port}/ ` +
      `|| curl -fsS -m ${timeout} http://127.0.0.1:${port}/ >/dev/null`;

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
  /** Noms des secrets dont la valeur sera fournie par le fichier `.env`. */
  secretNames?: readonly string[];
};

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
        : buildImageTag(appSlug, service.name, spec.version);

    const composeService: ComposeService = {
      image,
      // La politique de redémarrage est une décision du runtime, pas de la
      // spec : c'est pour ça qu'aucun champ `restart` n'existe dans l'AppSpec.
      restart: 'unless-stopped',
      networks: [network],
      expose: [String(service.port)],
      labels: {
        'tp.app': appSlug,
        'tp.service': service.name,
        'tp.version': spec.version,
        'tp.managed-by': 'bootstrap-tp-v2',
      },
    };

    if (service.source.type === 'dockerfile') {
      composeService.build = {
        context: service.source.context,
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
      composeService.ports = [`${publishedPort}:${service.port}`];
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

    composeService.healthcheck = renderHealthcheck(service, isExposed);

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
    '# Généré par bootstrap-tp-v2 — ne pas éditer à la main.',
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
      path: 'compose.yml',
      content: serializeComposeFile(renderComposeFile(input)),
      mode: 0o644,
    },
  ];

  const secretValues = input.secretValues ?? {};
  const declared = input.spec.services.flatMap((service) => service.secrets);

  if (declared.length > 0) {
    const complete: Record<string, string> = {};
    for (const name of new Set(declared)) {
      complete[name] = secretValues[name] ?? '';
    }
    files.push({
      path: '.env',
      content: serializeEnvFile(complete),
      mode: 0o600,
    });
  }

  return files;
}

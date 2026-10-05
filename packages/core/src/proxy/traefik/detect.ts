import { parse as parseYaml } from 'yaml';
import type { UiLanguage } from '../../i18n.js';
import type { TraefikFileConfig, TraefikKubernetesConfig } from './config.js';
import { traefikSay } from './messages.js';

/**
 * Reading a Traefik already in place, without touching anything.
 *
 * Its static configuration comes from three sources Traefik merges: the
 * arguments (`--entrypoints.web.address=:80`), the environment
 * (`TRAEFIK_ENTRYPOINTS_WEB_ADDRESS`) and a YAML file. We flatten them into
 * dotted keys, lowercase — Traefik is case-insensitive on keys —, and draw from
 * them what is needed to hand it routes: its entry points, its watched folder,
 * its certificate resolvers.
 *
 * Everything here is pure: the collection (SSH) is in the provider. What cannot
 * be read becomes a warning, never a silent assumption.
 */

export type StaticConfig = Map<string, string>;

function flatten(value: unknown, prefix: string, into: StaticConfig): void {
  if (value === null || value === undefined) {
    // `--providers.file` without a value, or `file: {}`: the key exists.
    if (prefix) into.set(prefix, '');
    return;
  }
  if (typeof value !== 'object') {
    into.set(prefix, String(value));
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => flatten(item, `${prefix}[${index}]`, into));
    return;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0 && prefix) into.set(prefix, '');
  for (const [key, child] of entries) {
    flatten(child, prefix ? `${prefix}.${key.toLowerCase()}` : key.toLowerCase(), into);
  }
}

export function staticConfigFromArgs(args: string[], into: StaticConfig = new Map()): StaticConfig {
  for (const arg of args) {
    const match = /^--([^=\s]+)(?:=(.*))?$/.exec(arg.trim());
    if (match) into.set(match[1]!.toLowerCase(), match[2] ?? '');
  }
  return into;
}

export function staticConfigFromEnv(env: string[], into: StaticConfig = new Map()): StaticConfig {
  for (const entry of env) {
    const match = /^TRAEFIK_([A-Z0-9_]+)=(.*)$/.exec(entry);
    if (match) into.set(match[1]!.toLowerCase().replaceAll('_', '.'), match[2]!);
  }
  return into;
}

export function staticConfigFromYaml(text: string, into: StaticConfig = new Map()): StaticConfig {
  const document: unknown = parseYaml(text);
  if (document && typeof document === 'object') flatten(document, '', into);
  return into;
}

/** The static configuration file's path, if it is given as an argument. */
export function configFileArgument(args: string[]): string | null {
  for (const arg of args) {
    const match = /^--configfile=(.+)$/i.exec(arg.trim());
    if (match) return match[1]!;
  }
  return null;
}

export const DEFAULT_STATIC_FILES = [
  '/etc/traefik/traefik.yml',
  '/etc/traefik/traefik.yaml',
  '/traefik.yml',
  '/traefik.yaml',
];

function portOf(address: string): number | null {
  const match = /:(\d+)(?:\/(?:tcp|udp))?$/.exec(address.trim());
  return match ? Number(match[1]) : null;
}

export type ReadTraefik = {
  entryPoints: { http: string | null; https: string | null };
  /** All the entry points found, with their address. */
  addresses: Record<string, string>;
  resolvers: string[];
  /** The folder watched by the `file` provider, as Traefik sees it. */
  fileDirectory: string | null;
  /** `providers.file.filename`: a single file, to which nothing can be added. */
  fileName: string | null;
  kubernetesIngress: boolean;
};

export function readTraefik(config: StaticConfig): ReadTraefik {
  const addresses: Record<string, string> = {};
  const resolvers = new Set<string>();
  for (const [key, value] of config) {
    const entry = /^entrypoints\.([^.]+)\.address$/.exec(key);
    if (entry) addresses[entry[1]!] = value;
    const resolver = /^certificatesresolvers\.([^.]+)\.acme\b/.exec(key);
    if (resolver) resolvers.add(resolver[1]!);
  }
  const names = Object.keys(addresses);
  // The usual names first — Traefik's Helm chart listens on 8000/8443 in the pod
  // and publishes 80/443 through its Service: the port says nothing there.
  const byName = (wanted: string) => names.find((name) => name.toLowerCase() === wanted) ?? null;
  const byPort = (port: number) =>
    names.find((name) => portOf(addresses[name] ?? '') === port) ?? null;
  return {
    entryPoints: {
      http: byName('web') ?? byPort(80),
      https: byName('websecure') ?? byPort(443),
    },
    addresses,
    resolvers: [...resolvers].sort(),
    fileDirectory: config.get('providers.file.directory') || null,
    fileName: config.get('providers.file.filename') || null,
    kubernetesIngress: [...config.keys()].some((key) =>
      key.startsWith('providers.kubernetesingress'),
    ),
  };
}

// ─── a Traefik in a container ────────────────────────────────────────────────

export type InspectedContainer = {
  Name?: string;
  Args?: string[];
  Config?: { Image?: string; Env?: string[]; Cmd?: string[] | null };
  Mounts?: Array<{ Source?: string; Destination?: string }>;
  HostConfig?: { NetworkMode?: string };
  NetworkSettings?: { Networks?: Record<string, { Gateway?: string }> };
};

/** The machine path matching a container path, if it is mounted. */
export function hostPathOf(container: InspectedContainer, inside: string): string | null {
  const mounts = (container.Mounts ?? [])
    .filter((mount) => mount.Source && mount.Destination)
    .sort((a, b) => (b.Destination?.length ?? 0) - (a.Destination?.length ?? 0));
  for (const mount of mounts) {
    const destination = mount.Destination!.replace(/\/+$/, '');
    if (inside === destination || inside.startsWith(`${destination}/`)) {
      return `${mount.Source!.replace(/\/+$/, '')}${inside.slice(destination.length)}`;
    }
  }
  return null;
}

export type ContainerFinding = {
  config: TraefikFileConfig | null;
  summary: string;
  warnings: string[];
};

/**
 * What a Traefik container allows. `staticFile`: the content of its static
 * configuration file, read in the container, if it has one.
 */
export function interpretTraefikContainer(
  container: InspectedContainer,
  staticFile: string | null,
  language: UiLanguage,
): ContainerFinding {
  const say = traefikSay(language);
  const name = (container.Name ?? '').replace(/^\//, '') || 'traefik';
  const args = container.Args ?? [];
  const config = new Map<string, string>();
  if (staticFile) {
    try {
      staticConfigFromYaml(staticFile, config);
    } catch {
      // An unreadable TOML or YAML: the arguments and the environment remain.
    }
  }
  staticConfigFromEnv(container.Config?.Env ?? [], config);
  staticConfigFromArgs(args, config);
  const read = readTraefik(config);
  const warnings: string[] = [];

  const hostMode = container.HostConfig?.NetworkMode === 'host';
  const gateway = Object.values(container.NetworkSettings?.Networks ?? {}).find(
    (network) => network.Gateway,
  )?.Gateway;
  const upstreamHost = hostMode ? '127.0.0.1' : (gateway ?? null);

  if (!read.fileDirectory) {
    return {
      config: null,
      summary: say('finding.noDirectory', { name }),
      warnings: [
        read.fileName
          ? say('finding.singleFile', { file: read.fileName })
          : say('finding.noFileProvider'),
      ],
    };
  }
  const directory = hostPathOf(container, read.fileDirectory);
  if (!directory) {
    warnings.push(say('finding.notMounted', { directory: read.fileDirectory }));
  }
  if (!read.entryPoints.http) warnings.push(say('finding.noHttp'));
  if (!read.entryPoints.https) warnings.push(say('finding.noHttps'));
  if (read.resolvers.length === 0) warnings.push(say('finding.noResolver'));
  if (!hostMode) {
    warnings.push(
      upstreamHost
        ? say('finding.bridge', {
            network: container.HostConfig?.NetworkMode ?? 'bridge',
            gateway: upstreamHost,
          })
        : say('finding.networkUnreadable'),
    );
  }

  return {
    config:
      directory && read.entryPoints.http
        ? {
            mode: 'file',
            directory,
            upstreamHost: upstreamHost ?? '127.0.0.1',
            container: name,
            image: null,
            entryPoints: { http: read.entryPoints.http, https: read.entryPoints.https },
            certResolver: read.resolvers[0] ?? null,
            acme: null,
          }
        : null,
    summary: say('finding.summary', {
      name,
      image: container.Config?.Image ?? say('finding.unknownImage'),
      directory: directory ?? read.fileDirectory,
    }),
    warnings,
  };
}

// ─── a cluster's Traefik ─────────────────────────────────────────────────────

export type ClusterFinding = {
  config: TraefikKubernetesConfig | null;
  summary: string;
  warnings: string[];
};

/**
 * `ingressClasses`: the classes whose controller is Traefik.
 * `args`: the arguments of the Traefik deployment's container, if it was found.
 */
export function interpretTraefikCluster(
  ingressClasses: string[],
  deployment: { namespace: string; args: string[] } | null,
  language: UiLanguage,
): ClusterFinding {
  const say = traefikSay(language);
  if (ingressClasses.length === 0) {
    return { config: null, summary: say('finding.noIngressClass'), warnings: [] };
  }
  const read = readTraefik(staticConfigFromArgs(deployment?.args ?? []));
  const warnings: string[] = [];
  if (!deployment) warnings.push(say('finding.noDeployment'));
  if (read.resolvers.length === 0) warnings.push(say('finding.noResolver'));
  const ingressClass = ingressClasses.includes('traefik') ? 'traefik' : ingressClasses[0]!;
  return {
    config: {
      mode: 'kubernetes',
      ingressClass,
      namespace: deployment?.namespace ?? 'kube-system',
      entryPoints: {
        http: read.entryPoints.http ?? 'web',
        https: read.entryPoints.https ?? 'websecure',
      },
      certResolver: read.resolvers[0] ?? null,
      acme: null,
    },
    summary: say('finding.cluster', { ingressClass }),
    warnings,
  };
}

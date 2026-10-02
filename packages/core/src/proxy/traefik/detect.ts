import { parse as parseYaml } from 'yaml';
import type { TraefikFileConfig, TraefikKubernetesConfig } from './config.js';

/**
 * Lire un Traefik déjà en place, sans rien y toucher.
 *
 * Sa configuration statique vient de trois sources que Traefik fusionne : les
 * arguments (`--entrypoints.web.address=:80`), l'environnement
 * (`TRAEFIK_ENTRYPOINTS_WEB_ADDRESS`) et un fichier YAML. On les aplatit en
 * clés pointées, en minuscules — Traefik ne distingue pas la casse des clés —,
 * et on en tire ce qu'il faut pour lui confier des routes : ses points
 * d'entrée, son dossier surveillé, ses résolveurs de certificats.
 *
 * Tout ici est pur : la collecte (SSH) est dans le provider. Ce qui ne se lit
 * pas devient un avertissement, jamais une supposition silencieuse.
 */

export type StaticConfig = Map<string, string>;

function flatten(value: unknown, prefix: string, into: StaticConfig): void {
  if (value === null || value === undefined) {
    // `--providers.file` sans valeur, ou `file: {}` : la clé existe.
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

/** Le chemin du fichier de configuration statique, s'il est donné en argument. */
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
  /** Tous les points d'entrée trouvés, avec leur adresse. */
  addresses: Record<string, string>;
  resolvers: string[];
  /** Le dossier surveillé par le fournisseur `file`, tel que Traefik le voit. */
  fileDirectory: string | null;
  /** `providers.file.filename` : un fichier unique, dans lequel on ne peut pas ajouter. */
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
  // Les noms d'usage d'abord — le chart Helm de Traefik écoute sur 8000/8443
  // dans le pod et publie 80/443 par son Service : le port n'y dit rien.
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

// ─── un Traefik en conteneur ─────────────────────────────────────────────────

export type InspectedContainer = {
  Name?: string;
  Args?: string[];
  Config?: { Image?: string; Env?: string[]; Cmd?: string[] | null };
  Mounts?: Array<{ Source?: string; Destination?: string }>;
  HostConfig?: { NetworkMode?: string };
  NetworkSettings?: { Networks?: Record<string, { Gateway?: string }> };
};

/** Le chemin sur la machine qui correspond à un chemin du conteneur, s'il est monté. */
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
 * Ce qu'un conteneur Traefik permet. `staticFile` : le contenu de son fichier
 * de configuration statique, lu dans le conteneur, s'il en a un.
 */
export function interpretTraefikContainer(
  container: InspectedContainer,
  staticFile: string | null,
): ContainerFinding {
  const name = (container.Name ?? '').replace(/^\//, '') || 'traefik';
  const args = container.Args ?? [];
  const config = new Map<string, string>();
  if (staticFile) {
    try {
      staticConfigFromYaml(staticFile, config);
    } catch {
      // Un TOML ou un YAML illisible : les arguments et l'environnement restent.
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
      summary: `Traefik « ${name} » sans dossier surveillé`,
      warnings: [
        read.fileName
          ? `il lit un fichier unique (${read.fileName}) : Pupitre a besoin d'un dossier — ajoutez --providers.file.directory`
          : "le fournisseur « file » n'est pas activé : ajoutez --providers.file.directory et montez ce dossier depuis la machine",
      ],
    };
  }
  const directory = hostPathOf(container, read.fileDirectory);
  if (!directory) {
    warnings.push(
      `le dossier ${read.fileDirectory} n'est pas monté depuis la machine : Pupitre ne peut pas y écrire`,
    );
  }
  if (!read.entryPoints.http) warnings.push("aucun point d'entrée sur le port 80");
  if (!read.entryPoints.https) warnings.push("aucun point d'entrée sur le port 443 : pas de HTTPS");
  if (read.resolvers.length === 0) {
    warnings.push(
      'aucun résolveur ACME : les domaines seront servis avec le certificat par défaut',
    );
  }
  if (!hostMode) {
    warnings.push(
      upstreamHost
        ? `Traefik est en réseau « ${container.HostConfig?.NetworkMode ?? 'bridge'} » : il joindra les applications par la passerelle ${upstreamHost}, et leur port restera ouvert sur la machine`
        : 'réseau du conteneur illisible : indiquez à quelle adresse Traefik joint la machine',
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
    summary: `Traefik « ${name} » (${container.Config?.Image ?? 'image inconnue'}) — dossier ${directory ?? read.fileDirectory}`,
    warnings,
  };
}

// ─── le Traefik d'un cluster ─────────────────────────────────────────────────

export type ClusterFinding = {
  config: TraefikKubernetesConfig | null;
  summary: string;
  warnings: string[];
};

/**
 * `ingressClasses` : les classes dont le contrôleur est Traefik.
 * `args` : les arguments du conteneur du déploiement Traefik, s'il a été trouvé.
 */
export function interpretTraefikCluster(
  ingressClasses: string[],
  deployment: { namespace: string; args: string[] } | null,
): ClusterFinding {
  if (ingressClasses.length === 0) {
    return { config: null, summary: 'aucune IngressClass Traefik dans le cluster', warnings: [] };
  }
  const read = readTraefik(staticConfigFromArgs(deployment?.args ?? []));
  const warnings: string[] = [];
  if (!deployment)
    warnings.push("le déploiement de Traefik n'a pas été trouvé : réglages par défaut");
  if (read.resolvers.length === 0) {
    warnings.push(
      'aucun résolveur ACME : les domaines seront servis avec le certificat par défaut',
    );
  }
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
    summary: `Traefik du cluster — IngressClass ${ingressClass}`,
    warnings,
  };
}

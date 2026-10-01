import { stringify } from 'yaml';
import { acmeDirectory, type AcmeSettings } from '../model.js';

/**
 * Ce que Pupitre pose quand on lui demande d'installer Traefik — rendu pur,
 * appliqué par le provider.
 *
 * ── En conteneur ────────────────────────────────────────────────────────────
 * Un projet Compose `pupitre-proxy`, en réseau hôte : Traefik écoute
 * directement sur 80 et 443, et joint les applications sur `127.0.0.1:{port}`
 * — ce qui permet à leur port de ne pas être ouvert au monde. Ni socket
 * Docker monté, ni tableau de bord : il ne lit que le dossier où Pupitre
 * dépose les routes, en lecture seule. Les certificats vivent dans un volume.
 *
 * ── Dans K3s ────────────────────────────────────────────────────────────────
 * K3s livre déjà Traefik. On ne le remplace pas, on le règle par une
 * `HelmChartConfig` : un résolveur ACME et un volume pour les certificats.
 * Si quelqu'un a déjà écrit la sienne, Pupitre ne l'écrase pas.
 */

/** Version épinglée : la série 3.7, mise à jour de correctifs comprise. */
export const TRAEFIK_IMAGE = 'traefik:v3.7';
export const MANAGED_PROJECT = 'pupitre-proxy';
export const MANAGED_CONTAINER = 'pupitre-traefik';
export const MANAGED_RESOLVER = 'pupitre';
/** Le point d'entrée de la sonde de vie, sur la boucle locale seulement. */
export const PING_ADDRESS = '127.0.0.1:8082';
export const MANAGED_ANNOTATION = 'pupitre.io/managed-by';

/** Le dossier du proxy sur la machine : `{racine du driver}/proxy`. */
export function proxyRoot(rootPath: string): string {
  return `${rootPath.replace(/\/+$/, '')}/proxy`;
}

export function defaultDynamicDirectory(rootPath: string): string {
  return `${proxyRoot(rootPath)}/dynamic`;
}

function acmeArguments(acme: AcmeSettings, storage: string): string[] {
  const resolver = `--certificatesresolvers.${MANAGED_RESOLVER}.acme`;
  return [
    `${resolver}.email=${acme.email}`,
    `${resolver}.storage=${storage}`,
    `${resolver}.httpchallenge.entrypoint=web`,
    `${resolver}.caserver=${acmeDirectory(acme)}`,
  ];
}

const HEALTHCHECK = [
  'CMD',
  'traefik',
  'healthcheck',
  '--ping',
  '--ping.entrypoint=ping',
  `--entrypoints.ping.address=${PING_ADDRESS}`,
];

export function renderManagedCompose(rootPath: string, acme: AcmeSettings): string {
  const root = proxyRoot(rootPath);
  const ca = acme.caCertificate !== null;
  const document = {
    name: MANAGED_PROJECT,
    services: {
      traefik: {
        image: TRAEFIK_IMAGE,
        container_name: MANAGED_CONTAINER,
        restart: 'unless-stopped',
        network_mode: 'host',
        security_opt: ['no-new-privileges:true'],
        command: [
          '--entrypoints.web.address=:80',
          '--entrypoints.websecure.address=:443',
          `--entrypoints.ping.address=${PING_ADDRESS}`,
          '--ping=true',
          '--ping.entrypoint=ping',
          '--providers.file.directory=/etc/traefik/dynamic',
          '--providers.file.watch=true',
          ...acmeArguments(acme, '/data/acme.json'),
          '--log.level=INFO',
          '--global.checknewversion=false',
          '--global.sendanonymoususage=false',
        ],
        ...(ca ? { environment: { LEGO_CA_CERTIFICATES: '/etc/traefik/acme-ca.pem' } } : {}),
        volumes: [
          `${root}/dynamic:/etc/traefik/dynamic:ro`,
          ...(ca ? [`${root}/acme-ca.pem:/etc/traefik/acme-ca.pem:ro`] : []),
          'acme:/data',
        ],
        labels: {
          'pupitre.managed-by': 'pupitre',
          'pupitre.role': 'proxy',
        },
        healthcheck: {
          test: HEALTHCHECK,
          interval: '10s',
          timeout: '5s',
          retries: 3,
          start_period: '10s',
        },
      },
    },
    volumes: { acme: { name: `${MANAGED_PROJECT}-acme` } },
  };
  return `# Généré par Pupitre — le reverse proxy de cette machine.\n${stringify(document, { lineWidth: 0 })}`;
}

export const CA_CONFIGMAP = 'pupitre-acme-ca';

export function renderHelmChartConfig(namespace: string, acme: AcmeSettings): string {
  const ca = acme.caCertificate !== null;
  const values = {
    additionalArguments: acmeArguments(acme, '/data/acme.json'),
    persistence: { enabled: true },
    ...(ca
      ? {
          env: [{ name: 'LEGO_CA_CERTIFICATES', value: '/pupitre-acme-ca/ca.pem' }],
          volumes: [{ name: CA_CONFIGMAP, mountPath: '/pupitre-acme-ca', type: 'configMap' }],
        }
      : {}),
  };
  const objects: unknown[] = [];
  if (ca) {
    objects.push({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: CA_CONFIGMAP, namespace, annotations: { [MANAGED_ANNOTATION]: 'pupitre' } },
      data: { 'ca.pem': acme.caCertificate },
    });
  }
  objects.push({
    apiVersion: 'helm.cattle.io/v1',
    kind: 'HelmChartConfig',
    metadata: { name: 'traefik', namespace, annotations: { [MANAGED_ANNOTATION]: 'pupitre' } },
    spec: { valuesContent: stringify(values, { lineWidth: 0, version: '1.1' }) },
  });
  // YAML 1.1, comme tout ce qui part vers l'API Kubernetes : voir `serializeKubeObjects`.
  return objects.map((object) => stringify(object, { lineWidth: 0, version: '1.1' })).join('---\n');
}

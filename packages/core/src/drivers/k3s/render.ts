import { stringify } from 'yaml';
import { WORKSPACE_PREFIX } from '../../naming.js';
import {
  exposedService,
  serviceSecretNames,
  topologicalOrder,
  type AppSpec,
  type Service,
} from '../../spec/index.js';
import { isHttpProbed, probePort } from '../probe.js';
import { completeSecretValues } from '../secrets.js';
import type { RenderedFile } from '../types.js';
import {
  mebibytes,
  milliCpu,
  type ConfigMapManifest,
  type Container,
  type ContainerSecurityContext,
  type DeploymentManifest,
  type EnvFromSource,
  type KubeManifest,
  type NamespaceManifest,
  type PersistentVolumeClaimManifest,
  type PodSecurityContext,
  type PodVolume,
  type Probe,
  type SecretManifest,
  type ServiceManifest,
  type VolumeMount,
} from './manifest-model.js';

/**
 * Traduction AppSpec → manifests Kubernetes.
 *
 * Pendant exact de `docker/render.ts` : c'est le seul endroit du projet, avec le
 * driver, qui a le droit de connaître Kubernetes. Tout ce que la spec neutre ne
 * sait pas dire — classe de stockage, stratégie de mise à jour, contexte de
 * sécurité, classe d'ingress — est décidé ici, parce que c'est une affaire de
 * runtime.
 *
 * Les deux rendus partent des **mêmes** fixtures, sans un champ de plus.
 */

/** Dérivé de la convention partagée : une seule définition de `app-`. */
export const NAMESPACE_PREFIX = WORKSPACE_PREFIX;

/** Répertoire, dans la release, où atterrissent les manifests. */
export const MANIFEST_DIR = 'k8s';

export const MANAGED_BY = 'pupitre';

/**
 * La valeur d'avant le renommage, encore posée sur tout ce qui a été déployé
 * jusqu'ici. Les sélecteurs du driver acceptent les deux — un `rollout restart`
 * ou un suivi de logs qui ne verrait que la nouvelle passerait silencieusement
 * à côté d'une application vivante, ce qui est pire qu'une erreur : c'est un
 * succès qui n'a rien fait.
 */
export const LEGACY_MANAGED_BY = 'bootstrap-tp';

/**
 * Sélecteur d'étiquette qui reconnaît les deux générations.
 * `kubectl` accepte la forme ensembliste ; elle évite d'avoir à lancer deux
 * commandes et à en fusionner les sorties.
 */
export const MANAGED_SELECTOR =
  `app.kubernetes.io/managed-by in (${MANAGED_BY},${LEGACY_MANAGED_BY})`;

/** Classe de stockage par défaut de K3s. */
export const DEFAULT_STORAGE_CLASS = 'local-path';

/** Taille de PVC retenue quand l'AppSpec n'en donne pas. */
export const DEFAULT_VOLUME_SIZE = '1Gi';

/**
 * UID/GID du compte non privilégié. La spec ne le dit pas : c'est une décision
 * de runtime, comme la politique de redémarrage côté Compose.
 *
 * Il sert deux usages qu'il ne faut pas confondre : l'identité du processus,
 * imposée aux seules images que nous construisons, et le `fsGroup` des volumes,
 * posé sur tous les pods. Voir `podSecurityContext()`.
 */
export const RUN_AS_UID = 1000;

/** Namespace de l'application. Convention CLAUDE.md : `app-{slug}`. */
export function namespaceName(appSlug: string): string {
  return `${NAMESPACE_PREFIX}${appSlug}`;
}

/**
 * Image construite sur le node. Même convention que le driver Docker : sans
 * registry, le tag n'a besoin d'être unique que sur la machine.
 */
export function builtImageTag(appSlug: string, service: string, version: string): string {
  return `${namespaceName(appSlug)}/${service}:${version}`;
}

export function configMapName(service: string): string {
  return `${service}-env`;
}

export function secretName(service: string): string {
  return `${service}-secrets`;
}

/** Le namespace isole déjà : inutile de préfixer par le slug comme en Docker. */
export function pvcName(service: string, volume: string): string {
  return `${service}-${volume}`;
}

/**
 * Une valeur de label Kubernetes est plus stricte qu'un semver : `1.0.0+build`
 * contient un `+` interdit. On assainit plutôt que de refuser une AppSpec
 * valide — le champ n'est qu'informatif.
 */
export function labelSafe(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 63);
  return cleaned.replace(/^[^A-Za-z0-9]+/, '').replace(/[^A-Za-z0-9]+$/, '') || 'unknown';
}

/**
 * Labels du sélecteur : **immuables**. La version en est volontairement absente,
 * `spec.selector` d'un Deployment ne pouvant plus changer après création.
 */
export function selectorLabels(appSlug: string, serviceName: string): Record<string, string> {
  return {
    'app.kubernetes.io/name': serviceName,
    'app.kubernetes.io/instance': appSlug,
  };
}

/** Labels standard posés sur toutes les ressources. */
export function standardLabels(
  appSlug: string,
  serviceName: string,
  version: string,
): Record<string, string> {
  return {
    ...selectorLabels(appSlug, serviceName),
    'app.kubernetes.io/version': labelSafe(version),
    'app.kubernetes.io/part-of': appSlug,
    'app.kubernetes.io/managed-by': MANAGED_BY,
  };
}

export type RenderInput = {
  spec: AppSpec;
  appSlug: string;
  /**
   * Valeurs des secrets déclarés. Une valeur manquante fait **échouer** le
   * rendu, comme côté Docker : voir `completeSecretValues()`.
   */
  secretValues?: Record<string, string>;
};

function renderProbe(service: Service, http: boolean, initialDelaySeconds: number): Probe {
  const port = probePort(service);
  const probe: Probe = {
    ...(http
      ? { httpGet: { path: service.healthcheck.path, port, scheme: 'HTTP' as const } }
      : { tcpSocket: { port } }),
    initialDelaySeconds,
    periodSeconds: service.healthcheck.intervalSec,
    timeoutSeconds: service.healthcheck.timeoutSec,
    failureThreshold: service.healthcheck.retries,
  };
  return probe;
}

/**
 * Le durcissement n'est légitime que sur ce qu'on connaît.
 *
 * Sur une image que **nous** construisons depuis un Dockerfile, on sait ce
 * qu'elle écrit, sous quel compte elle tourne, ce dont son point d'entrée a
 * besoin : on peut donc tout verrouiller. Sur une image tierce tirée d'un
 * registry (`postgres`, `nginx`, `mariadb`, `wordpress`…), on ne sait rien de
 * tout cela, et chaque contrainte imposée à l'aveugle devient une panne au
 * démarrage — sur un runtime seulement, alors que la même AppSpec tourne en
 * Docker. C'est exactement ce que les trois abstractions du projet existent
 * pour empêcher.
 *
 * `isOwnImage()` est donc la question posée à chaque champ du contexte de
 * sécurité, pas seulement à la racine en lecture seule.
 */
function isOwnImage(service: Service): boolean {
  return service.source.type === 'dockerfile';
}

/** Racine en lecture seule : tenable seulement sur une image que l'on bâtit. */
function allowsReadOnlyRoot(service: Service): boolean {
  return isOwnImage(service);
}

/**
 * Capacités rendues aux images tierces.
 *
 * Mesuré sur le cluster de test, `drop: ALL` seul suffit à casser les images
 * officielles les plus banales :
 *
 *     nginx    : chown("/var/cache/nginx/client_temp", 101) failed (1: Operation not permitted)
 *     postgres : chmod: /var/run/postgresql: Operation not permitted
 *
 * Leur point d'entrée démarre root, prépare ses répertoires, puis abandonne
 * ses privilèges — c'est le schéma standard, et il réclame ces cinq capacités
 * et pas une de plus. Docker, lui, en accorde quatorze par défaut
 * (`NET_RAW`, `MKNOD`, `SYS_CHROOT`, `SETPCAP`, `SETFCAP`, `KILL`… incluses) :
 * même élargi, K3s reste strictement plus fermé que l'autre runtime.
 *
 * `NET_BIND_SERVICE` en est volontairement absente : le kubelet positionne
 * `net.ipv4.ip_unprivileged_port_start=0` dans le bac à sable, et un `nginx`
 * écoutant sur 80 démarre sans elle — vérifié sur la cible.
 */
const THIRD_PARTY_CAPABILITIES = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID'];

/**
 * Identité d'exécution du pod.
 *
 * Les quatre champs n'ont pas la même nature, et ne se décident donc pas
 * ensemble :
 *
 * - `runAsNonRoot`, `runAsUser`, `runAsGroup` **choisissent le compte** sous
 *   lequel le processus démarre. Sur une image tierce, c'est un pari perdu :
 *   ni son arborescence ni son point d'entrée ne nous appartiennent, et le
 *   kubelet refuse même de lancer un conteneur dont l'image déclare `root`
 *   quand `runAsNonRoot` est posé. On ne les impose qu'à nos propres images.
 * - `fsGroup` ne touche pas à l'identité du processus : il donne au **volume
 *   monté** le groupe indiqué (et l'ajoute aux groupes secondaires du
 *   conteneur). C'est précisément ce qui rend un PVC fraîchement provisionné —
 *   `root:root 0755` — inscriptible par un conteneur tournant sous son propre
 *   uid. Le retirer serait la seule de ces quatre décisions à casser quelque
 *   chose : il reste inconditionnel.
 * - `seccompProfile` ne dépend d'aucune identité, et Docker applique son propre
 *   profil par défaut : inconditionnel là aussi.
 */
function podSecurityContext(service: Service): PodSecurityContext {
  return {
    ...(isOwnImage(service)
      ? { runAsNonRoot: true, runAsUser: RUN_AS_UID, runAsGroup: RUN_AS_UID }
      : {}),
    fsGroup: RUN_AS_UID,
    seccompProfile: { type: 'RuntimeDefault' },
  };
}

function containerSecurityContext(service: Service): ContainerSecurityContext {
  return {
    allowPrivilegeEscalation: false,
    privileged: false,
    readOnlyRootFilesystem: allowsReadOnlyRoot(service),
    capabilities: isOwnImage(service)
      ? { drop: ['ALL'] }
      : { drop: ['ALL'], add: [...THIRD_PARTY_CAPABILITIES] },
  };
}

function renderNamespace(input: RenderInput): NamespaceManifest {
  const { spec, appSlug } = input;
  return {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
      name: namespaceName(appSlug),
      labels: standardLabels(appSlug, appSlug, spec.version),
    },
  };
}

function renderConfigMap(input: RenderInput, service: Service): ConfigMapManifest | null {
  if (Object.keys(service.env).length === 0) return null;
  const { spec, appSlug } = input;

  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: configMapName(service.name),
      namespace: namespaceName(appSlug),
      labels: standardLabels(appSlug, service.name, spec.version),
    },
    data: { ...service.env },
  };
}

function renderSecret(input: RenderInput, service: Service): SecretManifest | null {
  if (service.secrets.length === 0) return null;
  const { spec, appSlug } = input;
  // `renderManifests()` a déjà complété et validé la table : chaque nom déclaré
  // y figure, sans quoi le rendu aurait échoué avant d'arriver ici.
  const values = input.secretValues ?? {};

  // Les noms tels que l'image les attend : un alias est une clé du Secret comme
  // une autre, et `completeSecretValues()` lui a déjà donné la valeur de sa
  // racine. Kubernetes n'interpole rien — il reçoit la carte complète.
  const stringData: Record<string, string> = {};
  for (const name of serviceSecretNames(service)) {
    stringData[name] = values[name] ?? '';
  }

  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: secretName(service.name),
      namespace: namespaceName(appSlug),
      labels: standardLabels(appSlug, service.name, spec.version),
    },
    type: 'Opaque',
    stringData,
  };
}

function renderClaims(input: RenderInput, service: Service): PersistentVolumeClaimManifest[] {
  const { spec, appSlug } = input;

  return service.volumes.map((volume) => ({
    apiVersion: 'v1' as const,
    kind: 'PersistentVolumeClaim' as const,
    metadata: {
      name: pvcName(service.name, volume.name),
      namespace: namespaceName(appSlug),
      labels: standardLabels(appSlug, service.name, spec.version),
    },
    spec: {
      // `local-path` ne sait faire que du ReadWriteOnce : le volume suit le node
      // qui héberge le pod. C'est le défaut de K3s, et l'AppSpec ne demande pas
      // mieux.
      accessModes: ['ReadWriteOnce'],
      storageClassName: DEFAULT_STORAGE_CLASS,
      resources: { requests: { storage: volume.size ?? DEFAULT_VOLUME_SIZE } },
    },
  }));
}

function renderDeployment(input: RenderInput, service: Service): DeploymentManifest {
  const { spec, appSlug } = input;
  const http = isHttpProbed(spec, service);

  const image =
    service.source.type === 'image'
      ? service.source.ref
      : builtImageTag(appSlug, service.name, spec.version);

  const envFrom: EnvFromSource[] = [];
  if (Object.keys(service.env).length > 0) {
    envFrom.push({ configMapRef: { name: configMapName(service.name) } });
  }
  if (service.secrets.length > 0) {
    envFrom.push({ secretRef: { name: secretName(service.name) } });
  }

  const volumeMounts: VolumeMount[] = service.volumes.map((volume) => ({
    name: volume.name,
    mountPath: volume.mountPath,
  }));
  const volumes: PodVolume[] = service.volumes.map((volume) => ({
    name: volume.name,
    persistentVolumeClaim: { claimName: pvcName(service.name, volume.name) },
  }));

  // Racine en lecture seule : il faut rendre `/tmp` inscriptible, sinon presque
  // aucun runtime applicatif ne démarre. Sauf si la spec y monte déjà un volume.
  if (
    allowsReadOnlyRoot(service) &&
    !service.volumes.some((volume) => volume.mountPath === '/tmp')
  ) {
    volumeMounts.push({ name: 'tmp-scratch', mountPath: '/tmp' });
    volumes.push({ name: 'tmp-scratch', emptyDir: {} });
  }

  const container: Container = {
    name: service.name,
    image,
    // Sans registry, l'image construite n'existe que dans le containerd du node :
    // `Always` la ferait chercher sur docker.io et échouer.
    imagePullPolicy: 'IfNotPresent',
    ports: [
      { name: http ? 'http' : 'tcp', containerPort: service.port, protocol: 'TCP' },
    ],
    ...(envFrom.length > 0 ? { envFrom } : {}),
    resources: {
      requests: {
        cpu: milliCpu(service.resources.cpuMilli),
        memory: mebibytes(service.resources.memoryMi),
      },
      limits: {
        cpu: milliCpu(service.resources.cpuMilli),
        memory: mebibytes(service.resources.memoryMi),
      },
    },
    ...(volumeMounts.length > 0 ? { volumeMounts } : {}),
    readinessProbe: renderProbe(service, http, service.healthcheck.intervalSec),
    livenessProbe: renderProbe(service, http, service.healthcheck.intervalSec * 2),
    securityContext: containerSecurityContext(service),
  };
  container.readinessProbe.successThreshold = 1;

  // Un volume `local-path` est ReadWriteOnce : deux pods ne peuvent pas le
  // monter en même temps. `Recreate` évite l'interblocage du rolling update.
  const usesClaim = service.volumes.length > 0;

  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: service.name,
      namespace: namespaceName(appSlug),
      labels: standardLabels(appSlug, service.name, spec.version),
    },
    spec: {
      replicas: service.replicas,
      selector: { matchLabels: selectorLabels(appSlug, service.name) },
      strategy: usesClaim
        ? { type: 'Recreate' }
        : { type: 'RollingUpdate', rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } },
      // `rollback()` s'appuie sur `kubectl rollout undo` : sans historique, il
      // n'aurait rien vers quoi revenir.
      revisionHistoryLimit: 10,
      template: {
        metadata: { labels: standardLabels(appSlug, service.name, spec.version) },
        spec: {
          securityContext: podSecurityContext(service),
          containers: [container],
          ...(volumes.length > 0 ? { volumes } : {}),
        },
      },
    },
  };
}

function renderService(input: RenderInput, service: Service): ServiceManifest {
  const { spec, appSlug } = input;
  const http = isHttpProbed(spec, service);

  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: service.name,
      namespace: namespaceName(appSlug),
      labels: standardLabels(appSlug, service.name, spec.version),
    },
    spec: {
      // Jamais de NodePort : en K3s l'exposition passe par le proxy du cluster,
      // qui joint ce Service — la raison pour laquelle `allocatePort()` retourne
      // `null`, et `upstream()` le Service.
      type: 'ClusterIP',
      selector: selectorLabels(appSlug, service.name),
      ports: [
        {
          name: http ? 'http' : 'tcp',
          port: service.port,
          targetPort: service.port,
          protocol: 'TCP',
        },
      ],
    },
  };
}

/**
 * Manifests dans l'ordre d'application : le namespace d'abord, la configuration
 * ensuite, les charges de travail en dernier. `kubectl apply -f <dir>` respecte
 * l'ordre lexicographique des fichiers — d'où les préfixes numériques.
 */
export function renderManifests(rawInput: RenderInput): KubeManifest[] {
  // Un secret déclaré sans valeur résolue fait échouer le rendu, en le nommant.
  const input: RenderInput = {
    ...rawInput,
    secretValues: completeSecretValues(rawInput.spec, rawInput.secretValues ?? {}),
  };

  const manifests: KubeManifest[] = [renderNamespace(input)];
  const services = topologicalOrder(input.spec);

  for (const service of services) {
    const configMap = renderConfigMap(input, service);
    if (configMap) manifests.push(configMap);
  }
  for (const service of services) {
    const secret = renderSecret(input, service);
    if (secret) manifests.push(secret);
  }
  for (const service of services) {
    manifests.push(...renderClaims(input, service));
  }
  for (const service of services) {
    manifests.push(renderDeployment(input, service));
  }
  for (const service of services) {
    manifests.push(renderService(input, service));
  }

  // Pas d'Ingress ici : un domaine est une route, posée par le reverse proxy
  // de la cible (`@pupitre/core/proxy`) vers le Service rendu ci-dessus.
  return manifests;
}

/**
 * Sérialise un manifest.
 *
 * `version: '1.1'` n'est pas un détail : l'API Kubernetes lit le YAML avec un
 * analyseur **1.1**, où `y`, `no`, `on`, `off` sont des booléens et `12:30` un
 * nombre sexagésimal. Un mot de passe valant `y`, sérialisé en 1.2, part donc en
 * `true` et l'API refuse le Secret. Sérialiser en 1.1 force les guillemets là où
 * l'analyseur d'en face en a besoin.
 *
 * `lineWidth: 0` évite par ailleurs les replis de ligne inattendus.
 */
export function serializeManifest(manifest: KubeManifest): string {
  const where = manifest.metadata.namespace
    ? `${manifest.metadata.namespace}/${manifest.metadata.name}`
    : manifest.metadata.name;
  const header = [
    '# Généré par Pupitre — ne pas éditer à la main.',
    `# ${manifest.kind} ${where}`,
    '',
  ].join('\n');
  return `${header}${stringify(manifest, { lineWidth: 0, singleQuote: false, version: '1.1' })}`;
}

/**
 * Nom de fichier d'un manifest. Le préfixe numérique porte l'ordre
 * d'application, le suffixe rend le fichier reconnaissable dans les logs.
 */
export function manifestFileName(manifest: KubeManifest): string {
  const order: Record<KubeManifest['kind'], number> = {
    Namespace: 0,
    ConfigMap: 10,
    Secret: 20,
    PersistentVolumeClaim: 30,
    Deployment: 40,
    Service: 50,
    Ingress: 60,
  };
  const kind = manifest.kind.toLowerCase();
  return `${MANIFEST_DIR}/${order[manifest.kind]}-${kind}-${manifest.metadata.name}.yaml`;
}

/**
 * Chemin du manifest de namespace dans la release.
 *
 * Le driver l'applique seul avant le reste : `kubectl apply -f <dir>` suit
 * l'ordre lexicographique, mais on ne parie pas la création du namespace sur une
 * convention de nommage. Un test verrouille l'accord entre les deux.
 */
export function namespaceFilePath(appSlug: string): string {
  return `${MANIFEST_DIR}/0-namespace-${namespaceName(appSlug)}.yaml`;
}

/** Ensemble complet des fichiers à déposer sur la cible. */
export function renderFiles(input: RenderInput): RenderedFile[] {
  return renderManifests(input).map((manifest) => ({
    path: manifestFileName(manifest),
    content: serializeManifest(manifest),
    // Un Secret contient des valeurs en clair dans `stringData` : il ne doit pas
    // être lisible par tout le monde sur la cible, comme le `.env` côté Docker.
    mode: manifest.kind === 'Secret' ? 0o600 : 0o644,
  }));
}

/** Les services que le driver doit construire avant de déployer. */
export function buildableServices(spec: AppSpec): Service[] {
  return spec.services.filter((service) => service.source.type === 'dockerfile');
}

/** Service par lequel l'application est jointe de l'extérieur. */
export function entrypointService(spec: AppSpec): Service {
  if (spec.ingress) {
    const target = spec.services.find(
      (service) => service.name === spec.ingress?.targetService,
    );
    if (target) return target;
  }
  return exposedService(spec);
}

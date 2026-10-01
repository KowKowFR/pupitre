/**
 * Modèle typé des manifests Kubernetes.
 *
 * Même parti pris que `docker/compose-model.ts` : le rendu construit des objets,
 * puis un sérialiseur YAML les écrit. On ne concatène jamais de chaînes — un nom
 * de service exotique, une valeur d'environnement multi-ligne ou un secret
 * contenant des guillemets sont l'affaire du sérialiseur, pas d'échappements
 * écrits à la main.
 *
 * Le modèle ne couvre que ce que l'AppSpec sait exprimer. Ajouter un champ ici
 * n'a de sens que si un champ neutre correspondant existe dans la spec.
 */

export type ObjectMeta = {
  name: string;
  namespace?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
};

type Resource<K extends string> = {
  apiVersion: string;
  kind: K;
  metadata: ObjectMeta;
};

export type NamespaceManifest = Resource<'Namespace'> & {
  apiVersion: 'v1';
};

export type ConfigMapManifest = Resource<'ConfigMap'> & {
  apiVersion: 'v1';
  data: Record<string, string>;
};

/**
 * `stringData` plutôt que `data` : Kubernetes encode lui-même en base64. Un
 * base64 fait maison serait une occasion supplémentaire de se tromper, et il ne
 * protège rien — ce n'est pas du chiffrement.
 */
export type SecretManifest = Resource<'Secret'> & {
  apiVersion: 'v1';
  type: 'Opaque';
  stringData: Record<string, string>;
};

export type PersistentVolumeClaimManifest = Resource<'PersistentVolumeClaim'> & {
  apiVersion: 'v1';
  spec: {
    accessModes: string[];
    storageClassName: string;
    resources: { requests: { storage: string } };
  };
};

export type HttpProbeAction = {
  path: string;
  port: number;
  scheme: 'HTTP' | 'HTTPS';
};

export type Probe = {
  httpGet?: HttpProbeAction;
  tcpSocket?: { port: number };
  initialDelaySeconds: number;
  periodSeconds: number;
  timeoutSeconds: number;
  failureThreshold: number;
  successThreshold?: number;
};

/**
 * `securityContext` au niveau du pod.
 *
 * L'identité d'exécution est **optionnelle** : elle ne peut être imposée qu'à
 * une image dont on connaît le contenu. Voir `podSecurityContext()`.
 */
export type PodSecurityContext = {
  runAsNonRoot?: boolean;
  runAsUser?: number;
  runAsGroup?: number;
  /** Propriétaire des volumes montés : sans lui, un PVC reste illisible en non-root. */
  fsGroup: number;
  seccompProfile: { type: 'RuntimeDefault' };
};

/** `securityContext` au niveau du conteneur. */
export type ContainerSecurityContext = {
  allowPrivilegeEscalation: boolean;
  privileged: boolean;
  readOnlyRootFilesystem: boolean;
  capabilities: { drop: string[]; add?: string[] };
};

export type ResourceRequirements = {
  requests: { cpu: string; memory: string };
  limits: { cpu: string; memory: string };
};

export type VolumeMount = {
  name: string;
  mountPath: string;
};

export type PodVolume =
  | { name: string; persistentVolumeClaim: { claimName: string } }
  | { name: string; emptyDir: Record<string, never> };

export type EnvFromSource =
  | { configMapRef: { name: string } }
  | { secretRef: { name: string } };

export type Container = {
  name: string;
  image: string;
  imagePullPolicy: 'Always' | 'IfNotPresent' | 'Never';
  ports: Array<{ name: string; containerPort: number; protocol: 'TCP' }>;
  envFrom?: EnvFromSource[];
  resources: ResourceRequirements;
  volumeMounts?: VolumeMount[];
  readinessProbe: Probe;
  livenessProbe: Probe;
  securityContext: ContainerSecurityContext;
};

export type DeploymentManifest = Resource<'Deployment'> & {
  apiVersion: 'apps/v1';
  spec: {
    replicas: number;
    /**
     * Immuable après création : jamais de label variable ici — surtout pas la
     * version, qui changerait à chaque déploiement et ferait échouer l'`apply`.
     */
    selector: { matchLabels: Record<string, string> };
    strategy: {
      type: 'RollingUpdate' | 'Recreate';
      rollingUpdate?: { maxSurge: number; maxUnavailable: number };
    };
    /** Nombre de révisions conservées : c'est ce qui rend `rollout undo` possible. */
    revisionHistoryLimit: number;
    template: {
      metadata: { labels: Record<string, string>; annotations?: Record<string, string> };
      spec: {
        securityContext: PodSecurityContext;
        containers: Container[];
        volumes?: PodVolume[];
      };
    };
  };
};

export type ServiceManifest = Resource<'Service'> & {
  apiVersion: 'v1';
  spec: {
    type: 'ClusterIP' | 'NodePort';
    /** `Local` : le pod voit l'adresse d'origine, que la NetworkPolicy filtre. */
    externalTrafficPolicy?: 'Local' | 'Cluster';
    selector: Record<string, string>;
    ports: Array<{
      name: string;
      port: number;
      targetPort: number;
      protocol: 'TCP';
      /** Seulement en `NodePort` : le port publié sur les nœuds. */
      nodePort?: number;
    }>;
  };
};

export type IngressManifest = Resource<'Ingress'> & {
  apiVersion: 'networking.k8s.io/v1';
  spec: {
    ingressClassName: string;
    tls?: Array<{ hosts: string[]; secretName: string }>;
    rules: Array<{
      host?: string;
      http: {
        paths: Array<{
          path: string;
          pathType: 'Prefix' | 'Exact' | 'ImplementationSpecific';
          backend: { service: { name: string; port: { number: number } } };
        }>;
      };
    }>;
  };
};

export type NetworkPolicyManifest = Resource<'NetworkPolicy'> & {
  apiVersion: 'networking.k8s.io/v1';
  spec: {
    podSelector: { matchLabels: Record<string, string> };
    policyTypes: Array<'Ingress'>;
    ingress: Array<{
      from: Array<{ podSelector: Record<string, never> } | { ipBlock: { cidr: string } }>;
      ports?: Array<{ protocol: 'TCP'; port: number }>;
    }>;
  };
};

export type KubeManifest =
  | NamespaceManifest
  | ConfigMapManifest
  | SecretManifest
  | PersistentVolumeClaimManifest
  | DeploymentManifest
  | ServiceManifest
  | NetworkPolicyManifest
  | IngressManifest;

/** Millicores Kubernetes : `500m`. */
export function milliCpu(value: number): string {
  return `${Math.max(1, Math.round(value))}m`;
}

/** Quantité mémoire Kubernetes : `512Mi`. */
export function mebibytes(value: number): string {
  return `${Math.max(1, Math.round(value))}Mi`;
}

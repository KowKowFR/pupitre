/**
 * Typed model of the Kubernetes manifests.
 *
 * The same stance as `docker/compose-model.ts`: the render builds objects, then
 * a YAML serializer writes them. We never concatenate strings — an exotic
 * service name, a multi-line environment value or a secret containing quotes
 * are the serializer's business, not hand-written escapes'.
 *
 * The model only covers what the AppSpec can express. Adding a field here only
 * makes sense if a matching neutral field exists in the spec.
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
 * `stringData` rather than `data`: Kubernetes encodes to base64 itself. A
 * home-made base64 would be one more chance to get it wrong, and it protects
 * nothing — it is not encryption.
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
 * Pod-level `securityContext`.
 *
 * The run identity is **optional**: it can only be imposed on an image whose
 * content we know. See `podSecurityContext()`.
 */
export type PodSecurityContext = {
  runAsNonRoot?: boolean;
  runAsUser?: number;
  runAsGroup?: number;
  /** Owner of the mounted volumes: without it, a PVC stays unreadable as non-root. */
  fsGroup: number;
  seccompProfile: { type: 'RuntimeDefault' };
};

/** Container-level `securityContext`. */
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
     * Immutable after creation: never a variable label here — above all not the
     * version, which would change at each deployment and fail the `apply`.
     */
    selector: { matchLabels: Record<string, string> };
    strategy: {
      type: 'RollingUpdate' | 'Recreate';
      rollingUpdate?: { maxSurge: number; maxUnavailable: number };
    };
    /** Number of revisions kept: that is what makes `rollout undo` possible. */
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
    /** `Local`: the pod sees the original address, which the NetworkPolicy filters. */
    externalTrafficPolicy?: 'Local' | 'Cluster';
    selector: Record<string, string>;
    ports: Array<{
      name: string;
      port: number;
      targetPort: number;
      protocol: 'TCP';
      /** Only with `NodePort`: the port published on the nodes. */
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

/** Kubernetes memory quantity: `512Mi`. */
export function mebibytes(value: number): string {
  return `${Math.max(1, Math.round(value))}Mi`;
}

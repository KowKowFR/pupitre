/**
 * Typed model of a Compose file.
 *
 * The render goes through this model then a YAML serializer: we never
 * concatenate strings. A service name containing an apostrophe, a multi-line
 * environment value or a command with quotes are handled by the serializer, not
 * by hand-written escapes.
 */

export type ComposeHealthcheck = {
  test: string[];
  interval: string;
  timeout: string;
  retries: number;
  start_period: string;
};

export type ComposeDependency = {
  condition: 'service_started' | 'service_healthy' | 'service_completed_successfully';
};

export type ComposeBuild = {
  context: string;
  dockerfile: string;
};

export type ComposeDeploy = {
  replicas?: number;
  resources?: {
    limits?: { cpus?: string; memory?: string };
  };
};

export type ComposeService = {
  image: string;
  build?: ComposeBuild;
  container_name?: string;
  restart: string;
  environment?: Record<string, string>;
  env_file?: string[];
  ports?: string[];
  expose?: string[];
  volumes?: string[];
  depends_on?: Record<string, ComposeDependency>;
  healthcheck?: ComposeHealthcheck;
  networks?: string[];
  deploy?: ComposeDeploy;
  labels?: Record<string, string>;

  // ── Security context ────────────────────────────────────────────────────────
  // Compose counterparts of the K8s manifests' `securityContext`. What decides
  // them is in `render.ts`; what has no Compose equivalent is said there too.

  /** `uid:gid` imposed on the process. Counterpart of `runAsUser`/`runAsGroup`. */
  user?: string;
  /** Capabilities dropped. Always `['ALL']`: we start from zero then give back. */
  cap_drop?: string[];
  /** Capabilities given back. Counterpart of `capabilities.add`. */
  cap_add?: string[];
  /** Counterpart of `allowPrivilegeEscalation: false`: `no-new-privileges:true`. */
  security_opt?: string[];
  /** Counterpart of `readOnlyRootFilesystem`. */
  read_only?: boolean;
  /**
   * tmpfs mounts. Short `path:options` syntax — Compose passes it as is to
   * `--tmpfs`, which the long syntax (`size`/`mode` only) does not allow.
   */
  tmpfs?: string[];
};

export type ComposeFile = {
  name: string;
  services: Record<string, ComposeService>;
  volumes?: Record<string, Record<string, never>>;
  networks?: Record<string, { name: string; driver: string }>;
};

/** Compose duration (`10s`). Compose does not accept milliseconds here. */
export function seconds(value: number): string {
  return `${Math.max(1, Math.round(value))}s`;
}

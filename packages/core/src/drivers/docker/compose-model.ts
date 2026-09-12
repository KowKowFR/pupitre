/**
 * Modèle typé d'un fichier Compose.
 *
 * Le rendu passe par ce modèle puis par un sérialiseur YAML : on ne concatène
 * jamais de chaînes. Un nom de service contenant une apostrophe, une valeur
 * d'environnement multi-ligne ou une commande avec des guillemets sont gérés
 * par le sérialiseur, pas par des échappements écrits à la main.
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

  // ── Contexte de sécurité ────────────────────────────────────────────────────
  // Pendants Compose du `securityContext` des manifests K8s. Ce qui les décide
  // est dans `render.ts` ; ce qui n'a pas d'équivalent Compose y est dit aussi.

  /** `uid:gid` imposé au processus. Pendant de `runAsUser`/`runAsGroup`. */
  user?: string;
  /** Capacités retirées. Toujours `['ALL']` : on part de zéro puis on rend. */
  cap_drop?: string[];
  /** Capacités rendues. Pendant de `capabilities.add`. */
  cap_add?: string[];
  /** Pendant de `allowPrivilegeEscalation: false` : `no-new-privileges:true`. */
  security_opt?: string[];
  /** Pendant de `readOnlyRootFilesystem`. */
  read_only?: boolean;
  /**
   * Montages tmpfs. Syntaxe courte `chemin:options` — Compose la transmet telle
   * quelle à `--tmpfs`, ce que la syntaxe longue (`size`/`mode` seulement) ne
   * permet pas.
   */
  tmpfs?: string[];
};

export type ComposeFile = {
  name: string;
  services: Record<string, ComposeService>;
  volumes?: Record<string, Record<string, never>>;
  networks?: Record<string, { name: string; driver: string }>;
};

/** Durée Compose (`10s`). Compose n'accepte pas les millisecondes ici. */
export function seconds(value: number): string {
  return `${Math.max(1, Math.round(value))}s`;
}

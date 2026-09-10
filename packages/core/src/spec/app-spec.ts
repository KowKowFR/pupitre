import { z } from 'zod';

/**
 * AppSpec — la spécification neutre d'une application.
 *
 * Elle décrit *ce que* l'application est, jamais *comment* on la déploie.
 * Aucun champ ne doit pouvoir être rattaché à un runtime précis : pas de
 * `image_pull_policy`, pas de `restart_policy`, pas de `compose`. La traduction
 * vers un `compose.yml` ou vers des manifests Kubernetes appartient au driver,
 * au moment du déploiement.
 *
 * Conséquence recherchée : la même AppSpec se redéploie sur l'autre runtime en
 * changeant un seul champ, ailleurs.
 */

export const SERVICE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** `major.minor.patch`, avec pré-version et build optionnels (semver 2.0.0). */
export const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export const slugSchema = z
  .string()
  .min(2)
  .max(48)
  .regex(SERVICE_NAME_PATTERN, 'nom en kebab-case : minuscules, chiffres et tirets');

export const semverSchema = z
  .string()
  .regex(SEMVER_PATTERN, 'version semver attendue, ex. 1.4.2');

/** Image déjà construite, référencée par son tag. */
export const imageSourceSchema = z.object({
  type: z.literal('image'),
  ref: z.string().min(1).max(512),
});

/**
 * Sources à construire. Le build a lieu sur la machine cible, quel que soit le
 * runtime : c'est une propriété de l'application, pas du moteur d'exécution.
 */
export const dockerfileSourceSchema = z.object({
  type: z.literal('dockerfile'),
  /** Répertoire de build, relatif à la racine du bundle envoyé sur la cible. */
  context: z.string().min(1).max(512),
  /** Chemin du Dockerfile, relatif au `context`. */
  dockerfile: z.string().min(1).max(512).default('Dockerfile'),
});

export const sourceSchema = z.discriminatedUnion('type', [
  imageSourceSchema,
  dockerfileSourceSchema,
]);

export const portSchema = z.number().int().min(1).max(65535);

/**
 * Sonde de vivacité.
 *
 * `path` ne vaut que pour un service qui parle HTTP. Le driver décide de la
 * traduction : sonde HTTP sur `path` pour le service exposé, simple test de
 * port ouvert pour les autres. La spec ne dit pas *comment* sonder.
 */
export const healthcheckSchema = z.object({
  path: z.string().min(1).max(512).startsWith('/').default('/'),
  port: portSchema.optional(),
  intervalSec: z.number().int().min(1).max(300).default(10),
  timeoutSec: z.number().int().min(1).max(120).default(5),
  retries: z.number().int().min(1).max(50).default(3),
});

export const resourcesSchema = z.object({
  cpuMilli: z.number().int().min(10).max(64_000).default(500),
  memoryMi: z.number().int().min(16).max(262_144).default(512),
});

/** Taille au format Kubernetes (`10Gi`, `500Mi`), neutre vis-à-vis du runtime. */
export const volumeSizeSchema = z
  .string()
  .regex(/^\d+(?:\.\d+)?(?:Ki|Mi|Gi|Ti|K|M|G|T)$/, 'taille attendue, ex. 10Gi');

export const volumeSchema = z.object({
  name: slugSchema,
  mountPath: z.string().min(1).max(512).startsWith('/'),
  size: volumeSizeSchema.optional(),
});

export const serviceSchema = z.object({
  name: slugSchema,
  source: sourceSchema,
  port: portSchema,
  exposed: z.boolean().default(false),
  replicas: z.number().int().min(1).max(50).default(1),
  /** Valeurs littérales. Les valeurs sensibles passent par `secrets`. */
  env: z
    .record(
      z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'variable en MAJUSCULES_AVEC_UNDERSCORES'),
      z.string().max(4096),
    )
    .default({}),
  /** Noms uniquement. Les valeurs vivent ailleurs, chiffrées. */
  secrets: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).default([]),
  resources: resourcesSchema.prefault({}),
  healthcheck: healthcheckSchema.prefault({}),
  volumes: z.array(volumeSchema).default([]),
  dependsOn: z.array(slugSchema).default([]),
});

export const ingressSchema = z.object({
  /** Absent = le driver expose sur un port alloué, sans nom de domaine. */
  host: z.string().min(1).max(253).optional(),
  tls: z.boolean().default(false),
  targetService: slugSchema,
});

/**
 * Forme de l'AppSpec, **sans** les contraintes croisées.
 *
 * Publiée pour un usage précis : la sortie structurée d'un LLM. Un JSON Schema
 * ne sait pas exprimer « exactement un service exposé » ni « pas de cycle dans
 * `dependsOn` » — ces règles disparaissent de toute façon à la traduction. En
 * donnant cette forme au modèle et en repassant ensuite par `appSpecSchema`,
 * c'est **notre** code qui tient la validation et qui peut réinjecter les
 * reproches de Zod dans une relance, au lieu de la déléguer au SDK.
 *
 * Elle ne remplace jamais `appSpecSchema` : rien n'est persisté ni déployé sans
 * être passé par les refinements.
 */
export const appSpecShapeSchema = z.object({
  name: slugSchema,
  version: semverSchema,
  services: z.array(serviceSchema).min(1, 'au moins un service'),
  ingress: ingressSchema.optional(),
});

const baseAppSpecSchema = appSpecShapeSchema;

/** Cherche un cycle dans le graphe `dependsOn`. Retourne le cycle trouvé. */
export function findDependencyCycle(
  services: ReadonlyArray<{ name: string; dependsOn: readonly string[] }>,
): string[] | null {
  const graph = new Map(services.map((s) => [s.name, s.dependsOn]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  function visit(name: string): string[] | null {
    const current = state.get(name);
    if (current === 'done') return null;
    if (current === 'visiting') {
      // Le cycle va de la première occurrence du nom jusqu'à maintenant.
      return [...stack.slice(stack.indexOf(name)), name];
    }

    state.set(name, 'visiting');
    stack.push(name);
    for (const dependency of graph.get(name) ?? []) {
      if (!graph.has(dependency)) continue; // signalé par un autre refinement
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(name, 'done');
    return null;
  }

  for (const service of services) {
    const cycle = visit(service.name);
    if (cycle) return cycle;
  }
  return null;
}

export const appSpecSchema = baseAppSpecSchema.superRefine((spec, ctx) => {
  const names = spec.services.map((service) => service.name);
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
  }

  if (duplicates.size > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['services'],
      message: `noms de services dupliqués : ${[...duplicates].join(', ')}`,
    });
  }

  const exposed = spec.services.filter((service) => service.exposed);
  if (exposed.length !== 1) {
    ctx.addIssue({
      code: 'custom',
      path: ['services'],
      message:
        exposed.length === 0
          ? 'exactement un service doit porter `exposed: true`, aucun ne le fait'
          : `exactement un service doit porter \`exposed: true\`, ${exposed.length} le font : ${exposed
              .map((service) => service.name)
              .join(', ')}`,
    });
  }

  for (const [index, service] of spec.services.entries()) {
    for (const [position, dependency] of service.dependsOn.entries()) {
      if (!seen.has(dependency)) {
        ctx.addIssue({
          code: 'custom',
          path: ['services', index, 'dependsOn', position],
          message: `dépendance vers un service inconnu « ${dependency} »`,
        });
      }
      if (dependency === service.name) {
        ctx.addIssue({
          code: 'custom',
          path: ['services', index, 'dependsOn', position],
          message: `« ${service.name} » ne peut pas dépendre de lui-même`,
        });
      }
    }

    const volumeNames = service.volumes.map((volume) => volume.name);
    if (new Set(volumeNames).size !== volumeNames.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['services', index, 'volumes'],
        message: 'noms de volumes dupliqués au sein du service',
      });
    }

    const overlap = service.secrets.filter((secret) => secret in service.env);
    if (overlap.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['services', index, 'secrets'],
        message: `déclarés à la fois dans env et dans secrets : ${overlap.join(', ')}`,
      });
    }
  }

  const cycle = findDependencyCycle(spec.services);
  if (cycle) {
    ctx.addIssue({
      code: 'custom',
      path: ['services'],
      message: `cycle de dépendances : ${cycle.join(' → ')}`,
    });
  }

  if (spec.ingress && !seen.has(spec.ingress.targetService)) {
    ctx.addIssue({
      code: 'custom',
      path: ['ingress', 'targetService'],
      message: `l'ingress cible le service inconnu « ${spec.ingress.targetService} »`,
    });
  }
});

export type ImageSource = z.infer<typeof imageSourceSchema>;
export type DockerfileSource = z.infer<typeof dockerfileSourceSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type Healthcheck = z.infer<typeof healthcheckSchema>;
export type Resources = z.infer<typeof resourcesSchema>;
export type Volume = z.infer<typeof volumeSchema>;
export type Service = z.infer<typeof serviceSchema>;
export type Ingress = z.infer<typeof ingressSchema>;
export type AppSpec = z.infer<typeof appSpecSchema>;

/** Entrée non validée : les defaults Zod ne sont pas encore appliqués. */
export type AppSpecInput = z.input<typeof appSpecSchema>;

export function parseAppSpec(input: unknown): AppSpec {
  return appSpecSchema.parse(input);
}

export function safeParseAppSpec(input: unknown) {
  return appSpecSchema.safeParse(input);
}

/** Le service marqué `exposed`. La validation garantit qu'il y en a exactement un. */
export function exposedService(spec: AppSpec): Service {
  const service = spec.services.find((candidate) => candidate.exposed);
  if (!service) {
    throw new Error('AppSpec invalide : aucun service exposé');
  }
  return service;
}

export function findService(spec: AppSpec, name: string): Service | undefined {
  return spec.services.find((service) => service.name === name);
}

/**
 * Ordre de démarrage respectant `dependsOn` : une dépendance apparaît toujours
 * avant le service qui la déclare. Sans cycle, garanti par la validation.
 */
export function topologicalOrder(spec: AppSpec): Service[] {
  const byName = new Map(spec.services.map((service) => [service.name, service]));
  const ordered: Service[] = [];
  const done = new Set<string>();

  function visit(service: Service): void {
    if (done.has(service.name)) return;
    done.add(service.name);
    for (const dependency of service.dependsOn) {
      const next = byName.get(dependency);
      if (next) visit(next);
    }
    ordered.push(service);
  }

  for (const service of spec.services) visit(service);
  return ordered;
}

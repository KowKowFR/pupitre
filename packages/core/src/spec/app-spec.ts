import { z } from 'zod';
import { invalid } from '../validation.js';

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
/**
 * Un chemin de construction reste **dans** ce qui est envoyé : ni absolu, ni
 * `..`. Un `pupitre.json` vient parfois d'un dépôt — c'est-à-dire de quiconque
 * peut y pousser — : un contexte `../..` irait chercher les dossiers des
 * autres applications de la machine, leurs `.env` de secrets compris, et les
 * embarquerait dans une image.
 */
const confinedPath = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (path) => !path.startsWith('/') && !path.split(/[\\/]+/).includes('..'),
    invalid('spec.relativePath'),
  );

export const dockerfileSourceSchema = z.object({
  type: z.literal('dockerfile'),
  /**
   * Répertoire de build, relatif à la racine du code envoyé sur la cible —
   * celle du dépôt pour une application liée à un dépôt.
   */
  context: confinedPath,
  /** Chemin du Dockerfile, relatif au `context`. */
  dockerfile: confinedPath.default('Dockerfile'),
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

/** Grammaire d'une variable d'environnement. Commune à `env` et à `secrets`. */
export const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

const envNameSchema = z
  .string()
  .regex(ENV_NAME_PATTERN, 'variable en MAJUSCULES_AVEC_UNDERSCORES');

/**
 * Un secret qui prend sa valeur d'un autre.
 *
 * ── Pourquoi ce champ existe ────────────────────────────────────────────────
 *
 * Une application et sa base sont deux images distinctes qui attendent le
 * *même* mot de passe sous *deux* noms : `mariadb:11` lit `MARIADB_PASSWORD`,
 * `wordpress` lit `WORDPRESS_DB_PASSWORD`, `glpi/glpi` lit `GLPI_DB_PASSWORD`.
 * Tant que `secrets` n'était qu'une liste de noms, le magasin tirait une valeur
 * aléatoire **par nom** : les deux services recevaient deux mots de passe
 * différents et l'application ne pouvait pas joindre sa base. C'était la panne,
 * et elle était garantie par construction.
 *
 * `from` dit « ce nom-ci désigne la valeur de ce nom-là ». Il n'y a toujours
 * qu'un secret, qu'une ligne en base, qu'une valeur : plusieurs noms la lisent.
 *
 * ── Pourquoi ce n'est pas résolu par le runtime ─────────────────────────────
 *
 * Compose sait interpoler `${MARIADB_PASSWORD}` depuis le `.env`, et il aurait
 * été tentant d'écrire l'alias dans `env`. Kubernetes, lui, n'interpole rien :
 * la même AppSpec aurait marché sur un runtime et pas sur l'autre. La
 * résolution appartient donc au code neutre (`drivers/secrets.ts`), avant le
 * rendu, et les deux drivers reçoivent une carte déjà complète.
 */
export const secretAliasSchema = z.object({
  name: envNameSchema,
  /** Nom du secret dont la valeur est reprise. Doit être déclaré par la spec. */
  from: envNameSchema,
});

/**
 * Déclaration d'un secret par un service, sous l'une de ses deux formes.
 *
 * La chaîne nue reste la forme normale et **reste lue telle quelle** : des
 * AppSpec figées dans des déploiements passés portent `secrets: ["NOM"]` et
 * doivent continuer de se relire sans erreur. L'union n'ajoute une forme, elle
 * n'en remplace aucune — et volontairement sans `.transform()` : l'AppSpec est
 * relue depuis un JSONB souvent **sans repasser par Zod** (`getApplication()`
 * rend la colonne telle quelle), donc le type de sortie doit décrire ce qui est
 * réellement en base, y compris les anciennes lignes.
 */
export const secretDeclarationSchema = z.union([envNameSchema, secretAliasSchema]);

export const serviceSchema = z.object({
  name: slugSchema,
  source: sourceSchema,
  port: portSchema,
  exposed: z.boolean().default(false),
  replicas: z.number().int().min(1).max(50).default(1),
  /** Valeurs littérales. Les valeurs sensibles passent par `secrets`. */
  env: z
    .record(envNameSchema, z.string().max(4096))
    .default({}),
  /**
   * Noms uniquement — les valeurs vivent ailleurs, chiffrées. Un nom peut
   * déclarer qu'il reprend la valeur d'un autre : `{ name, from }`.
   */
  secrets: z.array(secretDeclarationSchema).default([]),
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

/* ─── Secrets : lecture des deux formes de déclaration ─────────────────────── */

export type SecretAlias = z.infer<typeof secretAliasSchema>;
export type SecretDeclaration = z.infer<typeof secretDeclarationSchema>;

/** Forme minimale d'un service, suffisante pour lire ses secrets. */
type SecretHolder = { readonly secrets: readonly SecretDeclaration[] };
type SecretSpec = { readonly services: readonly SecretHolder[] };

export function isSecretAlias(declaration: SecretDeclaration): declaration is SecretAlias {
  return typeof declaration !== 'string';
}

/** Nom sous lequel le service lit le secret — la variable que voit l'image. */
export function secretDeclarationName(declaration: SecretDeclaration): string {
  return typeof declaration === 'string' ? declaration : declaration.name;
}

/** Nom dont la valeur est reprise. Le sien s'il n'est pas un alias. */
export function secretDeclarationSource(declaration: SecretDeclaration): string {
  return typeof declaration === 'string' ? declaration : declaration.from;
}

/** Noms de variables qu'un service attend dans son environnement, alias compris. */
export function serviceSecretNames(service: SecretHolder): string[] {
  return [...new Set(service.secrets.map(secretDeclarationName))];
}

/** Tous les noms déclarés par la spec, alias compris, dans l'ordre de lecture. */
export function secretNamesOf(spec: SecretSpec): string[] {
  return [...new Set(spec.services.flatMap(serviceSecretNames))];
}

/**
 * Table « nom → nom dont il tire sa valeur ». Un nom non aliasé se pointe
 * lui-même : le résultat se lit sans jamais tester la forme de la déclaration.
 */
export function secretBindings(spec: SecretSpec): Map<string, string> {
  const bindings = new Map<string, string>();
  for (const service of spec.services) {
    for (const declaration of service.secrets) {
      const name = secretDeclarationName(declaration);
      const source = secretDeclarationSource(declaration);
      // Un alias l'emporte sur une déclaration nue du même nom : la validation
      // interdit déjà ce mélange, mais la table est aussi lue sur des AppSpec
      // anciennes que personne n'a repassées par Zod.
      if (source !== name || !bindings.has(name)) bindings.set(name, source);
    }
  }
  return bindings;
}

/**
 * Suit la chaîne d'alias jusqu'au secret qui porte réellement la valeur.
 *
 * Tolère un cycle plutôt que de boucler : `appSpecSchema` le refuse déjà, mais
 * cette fonction lit aussi des AppSpec relues depuis le JSONB sans validation.
 */
export function secretRootName(bindings: ReadonlyMap<string, string>, name: string): string {
  const seen = new Set<string>([name]);
  let current = name;
  for (;;) {
    const next = bindings.get(current);
    if (next === undefined || next === current || seen.has(next)) return current;
    seen.add(next);
    current = next;
  }
}

/**
 * Noms qui ont besoin d'une **valeur** : les racines, alias exclus.
 *
 * C'est la liste que le magasin reçoit. Un alias ne crée jamais de ligne :
 * sinon on retrouverait deux valeurs indépendantes pour un seul mot de passe,
 * c'est-à-dire la panne d'origine avec une étape de plus.
 */
export function storedSecretNames(spec: SecretSpec): string[] {
  const bindings = secretBindings(spec);
  return [...new Set(secretNamesOf(spec).map((name) => secretRootName(bindings, name)))];
}

/** Cherche un cycle dans les alias de secrets. Retourne le cycle trouvé. */
export function findSecretAliasCycle(bindings: ReadonlyMap<string, string>): string[] | null {
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  function visit(name: string): string[] | null {
    const current = state.get(name);
    if (current === 'done') return null;
    if (current === 'visiting') return [...stack.slice(stack.indexOf(name)), name];

    state.set(name, 'visiting');
    stack.push(name);
    const source = bindings.get(name);
    if (source !== undefined && source !== name) {
      const cycle = visit(source);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(name, 'done');
    return null;
  }

  for (const name of bindings.keys()) {
    const cycle = visit(name);
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
      ...invalid('spec.duplicateServices', { names: [...duplicates].join(', ') }),
    });
  }

  const exposed = spec.services.filter((service) => service.exposed);
  if (exposed.length !== 1) {
    ctx.addIssue({
      code: 'custom',
      path: ['services'],
      ...(exposed.length === 0
        ? invalid('spec.noExposed')
        : invalid('spec.tooManyExposed', {
            count: exposed.length,
            names: exposed.map((service) => service.name).join(', '),
          })),
    });
  }

  // Tous les noms déclarés par la spec : la cible d'un alias doit s'y trouver,
  // quel que soit le service qui la déclare — c'est justement le propos.
  const allSecretNames = new Set(secretNamesOf(spec));
  /** Nom → source déjà vue pour lui, pour repérer deux alias contradictoires. */
  const sources = new Map<string, string>();

  for (const [index, service] of spec.services.entries()) {
    for (const [position, dependency] of service.dependsOn.entries()) {
      if (!seen.has(dependency)) {
        ctx.addIssue({
          code: 'custom',
          path: ['services', index, 'dependsOn', position],
          ...invalid('spec.unknownDependency', { name: dependency }),
        });
      }
      if (dependency === service.name) {
        ctx.addIssue({
          code: 'custom',
          path: ['services', index, 'dependsOn', position],
          ...invalid('spec.selfDependency', { name: service.name }),
        });
      }
    }

    const volumeNames = service.volumes.map((volume) => volume.name);
    if (new Set(volumeNames).size !== volumeNames.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['services', index, 'volumes'],
        ...invalid('spec.duplicateVolumes'),
      });
    }

    const secretNames = service.secrets.map(secretDeclarationName);

    const overlap = secretNames.filter((secret) => secret in service.env);
    if (overlap.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['services', index, 'secrets'],
        ...invalid('spec.envAndSecrets', { names: overlap.join(', ') }),
      });
    }

    // Deux déclarations du même nom dans un même service se contrediraient :
    // laquelle des deux dit d'où vient la valeur ?
    const repeated = secretNames.filter((name, position) => secretNames.indexOf(name) !== position);
    if (repeated.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['services', index, 'secrets'],
        ...invalid('spec.duplicateSecrets', { names: [...new Set(repeated)].join(', ') }),
      });
    }

    for (const [position, declaration] of service.secrets.entries()) {
      if (!isSecretAlias(declaration)) continue;
      if (declaration.from === declaration.name) {
        ctx.addIssue({
          code: 'custom',
          path: ['services', index, 'secrets', position],
          ...invalid('spec.selfAlias', { name: declaration.name }),
        });
      } else if (!allSecretNames.has(declaration.from)) {
        ctx.addIssue({
          code: 'custom',
          path: ['services', index, 'secrets', position],
          ...invalid('spec.unknownAlias', { name: declaration.name, from: declaration.from }),
        });
      }

      const settled = sources.get(declaration.name);
      if (settled !== undefined && settled !== declaration.from) {
        ctx.addIssue({
          code: 'custom',
          path: ['services', index, 'secrets', position],
          ...invalid('spec.conflictingAlias', {
            name: declaration.name,
            from: declaration.from,
            other: settled,
          }),
        });
      }
      sources.set(declaration.name, declaration.from);
    }
  }

  const aliasCycle = findSecretAliasCycle(secretBindings(spec));
  if (aliasCycle) {
    ctx.addIssue({
      code: 'custom',
      path: ['services'],
      ...invalid('spec.aliasCycle', { cycle: aliasCycle.join(' → ') }),
    });
  }

  // Un nom déclaré nu quelque part et aliasé ailleurs : deux réponses à la
  // question « d'où vient sa valeur ». Refusé aussi.
  for (const [index, service] of spec.services.entries()) {
    for (const [position, declaration] of service.secrets.entries()) {
      if (isSecretAlias(declaration)) continue;
      const alias = sources.get(declaration);
      if (alias === undefined) continue;
      ctx.addIssue({
        code: 'custom',
        path: ['services', index, 'secrets', position],
        ...invalid('spec.bareAndAlias', { name: declaration, alias }),
      });
    }
  }

  const cycle = findDependencyCycle(spec.services);
  if (cycle) {
    ctx.addIssue({
      code: 'custom',
      path: ['services'],
      ...invalid('spec.dependencyCycle', { cycle: cycle.join(' → ') }),
    });
  }

  if (spec.ingress && !seen.has(spec.ingress.targetService)) {
    ctx.addIssue({
      code: 'custom',
      path: ['ingress', 'targetService'],
      ...invalid('spec.unknownIngressTarget', { name: spec.ingress.targetService }),
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

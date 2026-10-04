import { z } from 'zod';
import { invalid } from '../validation.js';

/**
 * AppSpec — an application's neutral specification.
 *
 * It describes *what* the application is, never *how* it is deployed. No field
 * may be tied to a specific runtime: no `image_pull_policy`, no
 * `restart_policy`, no `compose`. Translating it into a `compose.yml` or into
 * Kubernetes manifests belongs to the driver, at deployment time.
 *
 * The intended consequence: the same AppSpec redeploys on the other runtime by
 * changing a single field, elsewhere.
 */

export const SERVICE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** `major.minor.patch`, with optional pre-release and build (semver 2.0.0). */
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

/** An image already built, referenced by its tag. */
export const imageSourceSchema = z.object({
  type: z.literal('image'),
  ref: z.string().min(1).max(512),
});

/**
 * Sources to build. The build happens on the target machine, whatever the
 * runtime: it is a property of the application, not of the execution engine.
 */
/**
 * A build path stays **within** what is sent: neither absolute, nor `..`. A
 * `pupitre.json` sometimes comes from a repository — that is, from whoever can
 * push to it —: a `../..` context would go and fetch the folders of the
 * machine's other applications, their secret `.env` files included, and embed
 * them in an image.
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
   * Build directory, relative to the root of the code sent to the target — the
   * repository's, for an application linked to a repository.
   */
  context: confinedPath,
  /** Path of the Dockerfile, relative to `context`. */
  dockerfile: confinedPath.default('Dockerfile'),
});

export const sourceSchema = z.discriminatedUnion('type', [
  imageSourceSchema,
  dockerfileSourceSchema,
]);

export const portSchema = z.number().int().min(1).max(65535);

/**
 * Liveness probe.
 *
 * `path` only applies to a service that speaks HTTP. The driver decides the
 * translation: an HTTP probe on `path` for the exposed service, a simple
 * open-port test for the others. The spec does not say *how* to probe.
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

/** Size in Kubernetes format (`10Gi`, `500Mi`), neutral regarding the runtime. */
export const volumeSizeSchema = z
  .string()
  .regex(/^\d+(?:\.\d+)?(?:Ki|Mi|Gi|Ti|K|M|G|T)$/, 'taille attendue, ex. 10Gi');

export const volumeSchema = z.object({
  name: slugSchema,
  mountPath: z.string().min(1).max(512).startsWith('/'),
  size: volumeSizeSchema.optional(),
});

/** Grammar of an environment variable. Shared by `env` and `secrets`. */
export const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

const envNameSchema = z
  .string()
  .regex(ENV_NAME_PATTERN, 'variable en MAJUSCULES_AVEC_UNDERSCORES');

/**
 * A secret that takes its value from another.
 *
 * ── Why this field exists ───────────────────────────────────────────────────
 *
 * An application and its database are two distinct images that expect the
 * *same* password under *two* names: `mariadb:11` reads `MARIADB_PASSWORD`,
 * `wordpress` reads `WORDPRESS_DB_PASSWORD`, `glpi/glpi` reads
 * `GLPI_DB_PASSWORD`. As long as `secrets` was only a list of names, the store
 * drew a random value **per name**: the two services got two different
 * passwords and the application could not reach its database. It was the
 * outage, and it was guaranteed by construction.
 *
 * `from` says "this name designates the value of that name". There is still
 * only one secret, one row in the database, one value: several names read it.
 *
 * ── Why it is not resolved by the runtime ───────────────────────────────────
 *
 * Compose can interpolate `${MARIADB_PASSWORD}` from the `.env`, and it would
 * have been tempting to write the alias in `env`. Kubernetes interpolates
 * nothing: the same AppSpec would have worked on one runtime and not the other.
 * Resolution therefore belongs to neutral code (`drivers/secrets.ts`), before
 * the render, and both drivers receive an already complete map.
 */
export const secretAliasSchema = z.object({
  name: envNameSchema,
  /** Name of the secret whose value is reused. Must be declared by the spec. */
  from: envNameSchema,
});

/**
 * A secret declared by a service, in one of its two forms.
 *
 * The bare string stays the normal form and **is still read as is**: AppSpecs
 * frozen in past deployments carry `secrets: ["NAME"]` and must keep reading
 * without error. The union adds a form, it replaces none — and deliberately
 * without `.transform()`: the AppSpec is often read back from a JSONB **without
 * going through Zod again** (`getApplication()` returns the column as is), so
 * the output type must describe what is really in the database, old rows
 * included.
 */
export const secretDeclarationSchema = z.union([envNameSchema, secretAliasSchema]);

export const serviceSchema = z.object({
  name: slugSchema,
  source: sourceSchema,
  port: portSchema,
  exposed: z.boolean().default(false),
  replicas: z.number().int().min(1).max(50).default(1),
  /** Literal values. Sensitive values go through `secrets`. */
  env: z
    .record(envNameSchema, z.string().max(4096))
    .default({}),
  /**
   * Names only — the values live elsewhere, encrypted. A name can declare that it
   * reuses another one's value: `{ name, from }`.
   */
  secrets: z.array(secretDeclarationSchema).default([]),
  resources: resourcesSchema.prefault({}),
  healthcheck: healthcheckSchema.prefault({}),
  volumes: z.array(volumeSchema).default([]),
  dependsOn: z.array(slugSchema).default([]),
});

export const ingressSchema = z.object({
  /** Absent = the driver exposes on an allocated port, without a domain name. */
  host: z.string().min(1).max(253).optional(),
  tls: z.boolean().default(false),
  targetService: slugSchema,
});

/**
 * The AppSpec's shape, **without** the cross-field constraints.
 *
 * Published for a precise use: an LLM's structured output. A JSON Schema cannot
 * express "exactly one exposed service" or "no cycle in `dependsOn`" — those
 * rules disappear in translation anyway. By giving this shape to the model and
 * then going through `appSpecSchema`, it is **our** code that holds the
 * validation and can feed Zod's complaints back into a retry, instead of
 * delegating it to the SDK.
 *
 * It never replaces `appSpecSchema`: nothing is persisted or deployed without
 * going through the refinements.
 */
export const appSpecShapeSchema = z.object({
  name: slugSchema,
  version: semverSchema,
  services: z.array(serviceSchema).min(1, 'au moins un service'),
  ingress: ingressSchema.optional(),
});

const baseAppSpecSchema = appSpecShapeSchema;

/** Looks for a cycle in the `dependsOn` graph. Returns the cycle found. */
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
      // The cycle goes from the name's first occurrence until now.
      return [...stack.slice(stack.indexOf(name)), name];
    }

    state.set(name, 'visiting');
    stack.push(name);
    for (const dependency of graph.get(name) ?? []) {
      if (!graph.has(dependency)) continue; // reported by another refinement
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

/* ─── Secrets: reading both declaration forms ──────────────────────────────── */

export type SecretAlias = z.infer<typeof secretAliasSchema>;
export type SecretDeclaration = z.infer<typeof secretDeclarationSchema>;

/** Minimal shape of a service, enough to read its secrets. */
type SecretHolder = { readonly secrets: readonly SecretDeclaration[] };
type SecretSpec = { readonly services: readonly SecretHolder[] };

export function isSecretAlias(declaration: SecretDeclaration): declaration is SecretAlias {
  return typeof declaration !== 'string';
}

/** Name under which the service reads the secret — the variable the image sees. */
export function secretDeclarationName(declaration: SecretDeclaration): string {
  return typeof declaration === 'string' ? declaration : declaration.name;
}

/** Name whose value is reused. Its own if it is not an alias. */
export function secretDeclarationSource(declaration: SecretDeclaration): string {
  return typeof declaration === 'string' ? declaration : declaration.from;
}

/** Variable names a service expects in its environment, aliases included. */
export function serviceSecretNames(service: SecretHolder): string[] {
  return [...new Set(service.secrets.map(secretDeclarationName))];
}

/** Every name the spec declares, aliases included, in reading order. */
export function secretNamesOf(spec: SecretSpec): string[] {
  return [...new Set(spec.services.flatMap(serviceSecretNames))];
}

/**
 * A "name → name it takes its value from" table. A non-aliased name points to
 * itself: the result reads without ever testing the declaration's form.
 */
export function secretBindings(spec: SecretSpec): Map<string, string> {
  const bindings = new Map<string, string>();
  for (const service of spec.services) {
    for (const declaration of service.secrets) {
      const name = secretDeclarationName(declaration);
      const source = secretDeclarationSource(declaration);
      // An alias wins over a bare declaration of the same name: validation already
      // forbids this mix, but the table is also read on old AppSpecs nobody passed
      // through Zod again.
      if (source !== name || !bindings.has(name)) bindings.set(name, source);
    }
  }
  return bindings;
}

/**
 * Follows the alias chain to the secret that really carries the value.
 *
 * Tolerates a cycle rather than looping: `appSpecSchema` already refuses it,
 * but this function also reads AppSpecs read back from the JSONB without
 * validation.
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
 * Names that need a **value**: the roots, aliases excluded.
 *
 * It is the list the store receives. An alias never creates a row: otherwise we
 * would find two independent values for a single password, that is, the
 * original outage with one more step.
 */
export function storedSecretNames(spec: SecretSpec): string[] {
  const bindings = secretBindings(spec);
  return [...new Set(secretNamesOf(spec).map((name) => secretRootName(bindings, name)))];
}

/** Looks for a cycle in the secret aliases. Returns the cycle found. */
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

  // Every name the spec declares: an alias's target must be among them, whatever
  // the service that declares it — that is precisely the point.
  const allSecretNames = new Set(secretNamesOf(spec));
  /** Name → source already seen for it, to spot two contradictory aliases. */
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

    // Two declarations of the same name in the same service would contradict each
    // other: which of the two says where the value comes from?
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

  // A name declared bare somewhere and aliased elsewhere: two answers to the
  // question "where does its value come from". Refused too.
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

/** Unvalidated input: Zod defaults are not applied yet. */
export type AppSpecInput = z.input<typeof appSpecSchema>;

export function parseAppSpec(input: unknown): AppSpec {
  return appSpecSchema.parse(input);
}

export function safeParseAppSpec(input: unknown) {
  return appSpecSchema.safeParse(input);
}

/** The service marked `exposed`. Validation guarantees there is exactly one. */
export function exposedService(spec: AppSpec): Service {
  const service = spec.services.find((candidate) => candidate.exposed);
  if (!service) {
    throw new Error('Invalid AppSpec: no exposed service');
  }
  return service;
}

export function findService(spec: AppSpec, name: string): Service | undefined {
  return spec.services.find((service) => service.name === name);
}

/**
 * Start order honoring `dependsOn`: a dependency always appears before the
 * service that declares it. Without a cycle, guaranteed by validation.
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

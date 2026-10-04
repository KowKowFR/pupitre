import type { AppSpec, Service } from '../spec/index.js';

/**
 * What a commit changes in the AppSpec, and whether it is **code** or
 * **infrastructure**.
 *
 * It is the heart of the "automatic unless infra changes" mode: a commit that
 * only touches code (and the `version`) goes out on its own; a commit that opens
 * a port to the world, changes a domain, mounts a volume or asks for a secret
 * waits for a human to have seen the diff. A merge must not be able to expose a
 * database without anybody having read it.
 *
 * The list of infra fields is deliberately wide: we prefer asking for one
 * approval too many than forgetting one. `env` is part of it — a variable can
 * redirect the application to another database.
 */

export type SpecChangeKind = 'code' | 'infra';

export type SpecChange = {
  /** Chemin lisible : `services.web.port`, `ingress.host`, `services.worker`. */
  path: string;
  kind: SpecChangeKind;
  /** `added`, `removed`, ou `changed`. */
  change: 'added' | 'removed' | 'changed';
};

export type SpecChangeReport = {
  /** At least one infrastructure change. */
  infra: boolean;
  changes: SpecChange[];
};

/** A service's fields whose change counts as infrastructure. */
const INFRA_SERVICE_FIELDS = [
  'port',
  'exposed',
  'replicas',
  'env',
  'secrets',
  'resources',
  'volumes',
] as const satisfies ReadonlyArray<keyof Service>;

/** A service's fields whose change counts as code. */
const CODE_SERVICE_FIELDS = ['healthcheck', 'dependsOn'] as const satisfies ReadonlyArray<
  keyof Service
>;

/** Structural comparison, indifferent to the order of an object's keys. */
function same(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function compareService(previous: Service, next: Service, changes: SpecChange[]): void {
  const base = `services.${next.name}`;

  // The source: changing image or tag is delivering code. Going from a ready-made
  // image to a build (or the reverse) is changing how the application is made —
  // infra.
  if (previous.source.type !== next.source.type) {
    changes.push({ path: `${base}.source`, kind: 'infra', change: 'changed' });
  } else if (!same(previous.source, next.source)) {
    changes.push({ path: `${base}.source`, kind: 'code', change: 'changed' });
  }

  for (const field of INFRA_SERVICE_FIELDS) {
    if (!same(previous[field], next[field])) {
      changes.push({ path: `${base}.${field}`, kind: 'infra', change: 'changed' });
    }
  }
  for (const field of CODE_SERVICE_FIELDS) {
    if (!same(previous[field], next[field])) {
      changes.push({ path: `${base}.${field}`, kind: 'code', change: 'changed' });
    }
  }
}

/**
 * Compares the spec in service with the commit's. Without a previous spec — the
 * first time —, everything is new, hence infra.
 */
export function classifySpecChange(previous: AppSpec | null, next: AppSpec): SpecChangeReport {
  const changes: SpecChange[] = [];

  if (previous === null) {
    changes.push({ path: 'services', kind: 'infra', change: 'added' });
    return { infra: true, changes };
  }

  if (previous.version !== next.version) {
    changes.push({ path: 'version', kind: 'code', change: 'changed' });
  }

  const before = new Map(previous.services.map((service) => [service.name, service]));
  const after = new Map(next.services.map((service) => [service.name, service]));

  for (const [name, service] of after) {
    const old = before.get(name);
    if (!old) changes.push({ path: `services.${name}`, kind: 'infra', change: 'added' });
    else compareService(old, service, changes);
  }
  for (const name of before.keys()) {
    if (!after.has(name)) changes.push({ path: `services.${name}`, kind: 'infra', change: 'removed' });
  }

  if (!same(previous.ingress ?? null, next.ingress ?? null)) {
    changes.push({
      path: 'ingress',
      kind: 'infra',
      change: !previous.ingress ? 'added' : !next.ingress ? 'removed' : 'changed',
    });
  }

  return { infra: changes.some((change) => change.kind === 'infra'), changes };
}

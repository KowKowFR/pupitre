import type { AppSpec, Service } from '../spec/index.js';

/**
 * Ce qu'un commit change à l'AppSpec, et si c'est du **code** ou de
 * l'**infrastructure**.
 *
 * C'est le cœur du mode « automatique sauf changement d'infra » : un commit
 * qui ne touche que le code (et la `version`) part tout seul ; un commit qui
 * ouvre un port au monde, change un domaine, monte un volume ou réclame un
 * secret attend qu'un humain ait vu le diff. Une fusion ne doit pas pouvoir
 * exposer une base de données sans que personne ne l'ait lu.
 *
 * La liste des champs d'infra est volontairement large : on préfère demander
 * une validation de trop qu'en oublier une. `env` en fait partie — une
 * variable peut rediriger l'application vers une autre base.
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
  /** Au moins un changement d'infrastructure. */
  infra: boolean;
  changes: SpecChange[];
};

/** Champs d'un service dont un changement relève de l'infrastructure. */
const INFRA_SERVICE_FIELDS = [
  'port',
  'exposed',
  'replicas',
  'env',
  'secrets',
  'resources',
  'volumes',
] as const satisfies ReadonlyArray<keyof Service>;

/** Champs d'un service dont un changement relève du code. */
const CODE_SERVICE_FIELDS = ['healthcheck', 'dependsOn'] as const satisfies ReadonlyArray<
  keyof Service
>;

/** Comparaison structurelle, indifférente à l'ordre des clés d'un objet. */
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

  // La source : changer d'image ou de tag, c'est livrer du code. Passer d'une
  // image toute faite à un build (ou l'inverse), c'est changer la façon dont
  // l'application est fabriquée — de l'infra.
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
 * Compare la spec en service à celle du commit. Sans spec précédente — la
 * première fois —, tout est nouveau, donc de l'infra.
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

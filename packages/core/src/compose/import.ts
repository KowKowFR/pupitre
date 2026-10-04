import { parse as parseYaml } from 'yaml';
import { renderMessage, type UiLanguage, type Vars } from '../i18n.js';
import {
  ENV_NAME_PATTERN,
  SERVICE_NAME_PATTERN,
  appSpecSchema,
  type AppSpecInput,
} from '../spec/index.js';
import {
  composeImportMessages,
  composeReasons,
  type ComposeIssueCode,
  type ComposeReason,
} from './messages.js';
import { issueMessage } from '../validation.js';

/**
 * Importing a `docker-compose.yml`: the way in for whoever arrives with an
 * existing project.
 *
 * The result is a **proposed** AppSpec, never saved automatically, and the list
 * of everything that could not go through as is, on three levels:
 *
 *   - `blocking`: the application will probably not work without a human
 *     decision (a start command, the Docker socket, a mounted host file);
 *   - `warning`:  translated, but approximately (a host folder turned into an
 *     empty volume, a secret whose value is not carried over);
 *   - `info`:     deliberately ignored, because Pupitre decides it otherwise
 *     (`restart`, `container_name`, networks).
 *
 * Nothing is silent: each key of the file is either translated or named in a
 * message. And nothing that touches isolation is translated "as best we can" —
 * a `privileged: true` does not become an almost privileged AppSpec, it becomes
 * a blocking message.
 *
 * A pure module: no I/O, no network. The YAML is read with a limit on aliases,
 * so that a booby-trapped file does not blow up memory.
 */

export type ComposeIssueLevel = 'blocking' | 'warning' | 'info';

export type ComposeIssue = {
  level: ComposeIssueLevel;
  code: ComposeIssueCode;
  /** The service concerned, under its original name. `null`: the whole file. */
  service: string | null;
  vars: Vars;
  /** Reason for an `ignored` / `unsupported` / `topLevel`, translated separately. */
  reason?: ComposeReason;
  /** An AppSpec schema complaint, kept whole to be said again (`issueMessage()`). */
  schemaIssue?: { path: string; message: string; params?: unknown };
};

export type ComposeImport = {
  /** `null` only when the file is unreadable or describes no service. */
  spec: AppSpecInput | null;
  /** The AppSpec passes `appSpecSchema` as is. */
  valid: boolean;
  issues: ComposeIssue[];
};

type ServiceInput = AppSpecInput['services'][number];
type Record_ = Record<string, unknown>;

const DEFAULT_APP_NAME = 'imported-app';

/** Images whose port is known, when the compose file does not say it. */
const KNOWN_PORTS: Array<[RegExp, number]> = [
  [/^(postgres|postgis|timescaledb|pgvector)$/, 5432],
  [/^(mysql|mariadb|percona)$/, 3306],
  [/^(redis|valkey|keydb|dragonfly)$/, 6379],
  [/^mongo$/, 27017],
  [/^memcached$/, 11211],
  [/^rabbitmq$/, 5672],
  [/^(elasticsearch|opensearch)$/, 9200],
  [/^minio$/, 9000],
  [/^clickhouse(-server)?$/, 8123],
  [/^(nginx|httpd|caddy|apache|php)$/, 80],
];

/** Images that are never an application's entry point. */
const BACKING_IMAGES =
  /^(postgres|postgis|timescaledb|pgvector|mysql|mariadb|percona|redis|valkey|keydb|dragonfly|mongo|memcached|rabbitmq|elasticsearch|opensearch|clickhouse(-server)?|minio)$/;

/** The names usually given to the service that receives the traffic. */
const ENTRY_NAMES = ['web', 'app', 'front', 'frontend', 'nginx', 'proxy', 'server', 'api', 'ui'];

const IGNORED: Partial<Record<string, ComposeReason>> = {
  restart: 'restart',
  container_name: 'container_name',
  hostname: 'hostname',
  domainname: 'domainname',
  networks: 'networks',
  logging: 'logging',
  stop_grace_period: 'stop_grace_period',
  stop_signal: 'stop_grace_period',
  init: 'init',
  profiles: 'profiles',
  pull_policy: 'pull_policy',
  tty: 'tty',
  stdin_open: 'stdin_open',
};

const UNSUPPORTED_WARNING: Partial<Record<string, ComposeReason>> = {
  cap_add: 'cap_add',
  cap_drop: 'cap_drop',
  security_opt: 'security_opt',
  sysctls: 'sysctls',
  ulimits: 'ulimits',
  user: 'user',
  working_dir: 'working_dir',
  extra_hosts: 'extra_hosts',
  dns: 'dns',
  dns_search: 'dns',
  platform: 'platform',
  secrets: 'secrets',
  configs: 'configs',
};

const UNSUPPORTED_BLOCKING: Partial<Record<string, ComposeReason>> = {
  privileged: 'privileged',
  network_mode: 'network_mode',
  pid: 'pid',
  ipc: 'ipc',
  devices: 'devices',
};

const HANDLED = new Set([
  'image',
  'build',
  'ports',
  'expose',
  'environment',
  'env_file',
  'volumes',
  'tmpfs',
  'depends_on',
  'links',
  'healthcheck',
  'deploy',
  'scale',
  'mem_limit',
  'cpus',
  'command',
  'entrypoint',
  'labels',
]);

// ─── small reads ─────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record_ {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/** `My Service_2` → `my-service-2`, at least two characters, at most 48. */
export function slugify(raw: string, fallback: string): string {
  const slug = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  if (slug.length === 0) return fallback;
  return slug.length < 2 ? `${slug}-svc` : slug;
}

/** `30s`, `1m30s`, `500ms`, `2h` → seconds, rounded up. `null` if unreadable. */
export function parseDuration(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(1, Math.ceil(value));
  if (typeof value !== 'string') return null;
  const units: Record<string, number> = { h: 3600, m: 60, s: 1, ms: 0.001, us: 0.000001 };
  let total = 0;
  let matched = false;
  for (const part of value.trim().matchAll(/(\d+(?:\.\d+)?)(h|ms|us|m|s)/g)) {
    total += Number(part[1]) * (units[part[2] ?? 's'] ?? 0);
    matched = true;
  }
  return matched ? Math.max(1, Math.ceil(total)) : null;
}

/** `512m`, `1g`, `1.5G`, `512Mi`, `1048576` (bytes) → MiB. */
export function parseMemoryMi(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(16, Math.round(value / (1024 * 1024)));
  }
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*([kmgt])?(i?b?)?$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const factor = { k: 1 / 1024, m: 1, g: 1024, t: 1024 * 1024 }[
    (match[2] ?? '').toLowerCase() as 'k' | 'm' | 'g' | 't'
  ];
  if (factor === undefined) return Math.max(16, Math.round(amount / (1024 * 1024)));
  return Math.max(16, Math.round(amount * factor));
}

/** `0.5`, `"2"` → milli-CPU. */
export function parseCpusMilli(value: unknown): number | null {
  const amount = typeof value === 'number' ? value : Number(asString(value));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Math.min(64_000, Math.max(10, Math.round(amount * 1000)));
}

/** An image's short name: `ghcr.io/org/postgres:16-alpine` → `postgres`. */
function imageBase(image: string): string {
  const withoutDigest = image.split('@')[0] ?? image;
  const last = withoutDigest.split('/').pop() ?? withoutDigest;
  return (last.split(':')[0] ?? last).toLowerCase();
}

function hasTag(image: string): boolean {
  if (image.includes('@')) return true;
  const last = image.split('/').pop() ?? image;
  return last.includes(':');
}

type PortEntry =
  | { kind: 'tcp'; container: number; host: string | null }
  | { kind: 'udp'; text: string }
  | { kind: 'range'; text: string };

function parsePort(entry: unknown): PortEntry | null {
  if (typeof entry === 'number') return { kind: 'tcp', container: entry, host: null };
  if (isRecord(entry)) {
    const container = Number(entry.target);
    if (!Number.isInteger(container)) return null;
    if (entry.protocol === 'udp') return { kind: 'udp', text: String(container) };
    const published = asString(entry.published);
    return { kind: 'tcp', container, host: published };
  }
  const text = asString(entry);
  if (!text) return null;
  const [mapping = '', protocol] = text.split('/');
  if (protocol === 'udp') return { kind: 'udp', text };
  if (mapping.includes('-')) return { kind: 'range', text };
  const parts = mapping.split(':');
  const container = Number(parts.pop());
  if (!Number.isInteger(container)) return null;
  const host = parts.length > 0 ? (parts.pop() ?? '') : '';
  return { kind: 'tcp', container, host: host.length > 0 ? host : null };
}

/** Environment variables, as a list or a dictionary. `null`: taken from the shell. */
function readEnvironment(value: unknown): Array<[string, string | null]> {
  if (Array.isArray(value)) {
    return value.flatMap((item): Array<[string, string | null]> => {
      const text = asString(item);
      if (text === null) return [];
      const index = text.indexOf('=');
      return index === -1 ? [[text, null]] : [[text.slice(0, index), text.slice(index + 1)]];
    });
  }
  if (isRecord(value)) {
    return Object.entries(value).map(([name, raw]) => [name, raw === null ? null : asString(raw)]);
  }
  return [];
}

function readLabels(value: unknown): Record<string, string> {
  if (Array.isArray(value)) {
    return Object.fromEntries(
      value.flatMap((item) => {
        const text = asString(item);
        if (!text) return [];
        const index = text.indexOf('=');
        return [
          [index === -1 ? text : text.slice(0, index), index === -1 ? '' : text.slice(index + 1)],
        ];
      }),
    );
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, raw]) => [key, asString(raw) ?? '']),
    );
  }
  return {};
}

const INTERPOLATION =
  /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?[-?]([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

type Interpolated = {
  value: string;
  /** The first shell variable met, and its default value. */
  variable: { name: string; fallback: string | null; expression: string } | null;
};

/** Resolves `${VAR:-default}` to its default, `${VAR}` to empty, `$$` to `$`. */
function interpolate(raw: string): Interpolated {
  let variable: Interpolated['variable'] = null;
  const value = raw.replace(
    INTERPOLATION,
    (whole, braced?: string, fallback?: string, bare?: string) => {
      if (whole === '$$') return '$';
      const name = braced ?? bare ?? '';
      variable ??= { name, fallback: fallback ?? null, expression: whole };
      return fallback ?? '';
    },
  );
  return { value, variable };
}

/**
 * A variable that looks like a secret. A purely numeric or boolean value is not
 * one, even under a worrying name (`PASSWORD_MIN_LENGTH=8`): replacing it with a
 * random value would break the application.
 */
function looksSecret(name: string, value: string | null): boolean {
  if (name.endsWith('_FILE')) return false;
  if (value !== null && /^(\d+|true|false|yes|no)$/i.test(value.trim())) return false;
  return /(^|_)(PASSWORD|PASSWD|PASS|PWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIALS?|SALT)(_|$)|_KEY$/.test(
    name,
  );
}

const HTTP_IN_PROBE =
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::(\d+))?(\/[^\s'"\\|;&]*)?/;

// ─── the import ──────────────────────────────────────────────────────────────

type Draft = {
  original: string;
  name: string;
  service: ServiceInput;
  published: boolean;
  backing: boolean;
  traefik: { host: string | null; tls: boolean; port: number | null };
  probe:
    { kind: 'http'; path: string; port: number | null } | { kind: 'other'; test: string } | null;
};

export function importCompose(
  source: string,
  options: { name?: string | null } = {},
): ComposeImport {
  const issues: ComposeIssue[] = [];
  const issue = (
    level: ComposeIssueLevel,
    code: ComposeIssueCode,
    service: string | null,
    vars: Vars = {},
    reason?: ComposeReason,
  ) => {
    issues.push({ level, code, service, vars, ...(reason ? { reason } : {}) });
  };

  let document: unknown;
  try {
    document = parseYaml(source, { merge: true, maxAliasCount: 100 });
  } catch (error) {
    issue('blocking', 'yaml.invalid', null, {
      message:
        error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error),
    });
    return { spec: null, valid: false, issues };
  }

  if (
    !isRecord(document) ||
    !isRecord(document.services) ||
    Object.keys(document.services).length === 0
  ) {
    issue('blocking', 'yaml.notCompose', null);
    return { spec: null, valid: false, issues };
  }

  // ── Top level ───────────────────────────────────────────────────────────
  for (const key of Object.keys(document)) {
    if (key === 'services' || key === 'name') continue;
    if (key.startsWith('x-')) issue('info', 'topLevel', null, { key }, 'extension');
    else if (key === 'version') issue('info', 'topLevel', null, { key }, 'version');
    else if (key === 'volumes' || key === 'networks' || key === 'secrets' || key === 'configs') {
      issue('info', 'topLevel', null, { key }, key === 'networks' ? 'networks' : key);
    } else issue('warning', 'topLevel', null, { key }, 'unknownTop');
  }

  const appName = slugify(
    options.name?.trim() || asString(document.name) || DEFAULT_APP_NAME,
    DEFAULT_APP_NAME,
  );
  issue('info', 'app.name', null, { name: appName });

  // ── Service names: stable, unique, in the AppSpec's format ──────────────
  const renamed = new Map<string, string>();
  for (const original of Object.keys(document.services)) {
    let name =
      SERVICE_NAME_PATTERN.test(original) && original.length >= 2
        ? original
        : slugify(original, 'service');
    for (let index = 2; [...renamed.values()].includes(name); index += 1) {
      name = `${slugify(original, 'service').slice(0, 44)}-${index}`;
    }
    renamed.set(original, name);
    if (name !== original)
      issue('warning', 'service.renamed', original, { from: original, to: name });
  }

  // Secrets: one group per shared value (or per shell variable). The first name
  // met carries the value, the others reuse it through an alias.
  const secretRoots = new Map<string, string>();
  const secretGroupOf = new Map<string, string>();
  let dependsOnConditionNoted = false;

  const drafts: Draft[] = [];

  for (const [original, raw] of Object.entries(document.services)) {
    const name = renamed.get(original) ?? original;
    if (!isRecord(raw)) {
      issue('blocking', 'service.dropped', original, { name: original, reason: '—' });
      continue;
    }

    // ── Keys the AppSpec does not have ────────────────────────────────────
    for (const key of Object.keys(raw)) {
      if (HANDLED.has(key)) continue;
      const ignored = IGNORED[key];
      const warning = UNSUPPORTED_WARNING[key];
      const blocking = UNSUPPORTED_BLOCKING[key];
      if (key.startsWith('x-')) issue('info', 'ignored', original, { key }, 'extension');
      else if (ignored) issue('info', 'ignored', original, { key }, ignored);
      else if (blocking) {
        // `privileged: false` asks for nothing: no need to block.
        if (!(key === 'privileged' && raw[key] === false)) {
          issue('blocking', 'unsupported', original, { key }, blocking);
        }
      } else if (warning) issue('warning', 'unsupported', original, { key }, warning);
      else issue('warning', 'unknown', original, { key });
    }

    // ── What is started ───────────────────────────────────────────────────
    let serviceSource: ServiceInput['source'] | null = null;
    const image = asString(raw.image);
    if (raw.build !== undefined) {
      const build = raw.build;
      const context = isRecord(build) ? (asString(build.context) ?? '.') : (asString(build) ?? '.');
      const dockerfile = isRecord(build)
        ? (asString(build.dockerfile) ?? 'Dockerfile')
        : 'Dockerfile';
      serviceSource = { type: 'dockerfile', context, dockerfile };
      issue('warning', 'build.context', original, { context });
      if (isRecord(build) && build.args !== undefined) {
        const names = isRecord(build.args)
          ? Object.keys(build.args)
          : readEnvironment(build.args).map(([key]) => key);
        issue('warning', 'build.args', original, { names: names.join(', ') || '—' });
      }
    } else if (image) {
      serviceSource = { type: 'image', ref: image };
      if (!hasTag(image)) issue('info', 'image.untagged', original, { image });
    }
    if (!serviceSource) {
      issue('blocking', 'service.noSource', original);
      serviceSource = { type: 'image', ref: `${name}:latest` };
    }
    const base = serviceSource.type === 'image' ? imageBase(serviceSource.ref) : '';
    const backing = BACKING_IMAGES.test(base);

    for (const key of ['command', 'entrypoint'] as const) {
      if (raw[key] !== undefined && raw[key] !== null)
        issue('blocking', 'command', original, { key });
    }

    // ── Traefik labels: domain and port, if they are there ────────────────
    const labels = readLabels(raw.labels);
    const traefik: Draft['traefik'] = { host: null, tls: false, port: null };
    for (const [key, value] of Object.entries(labels)) {
      if (/^traefik\.http\.routers\.[^.]+\.rule$/.test(key)) {
        traefik.host ??= value.match(/Host\(`([^`]+)`\)/)?.[1] ?? null;
      } else if (/^traefik\.http\.routers\.[^.]+\.tls(\.certresolver)?$/.test(key)) {
        traefik.tls ||= value !== 'false';
      } else if (/^traefik\.http\.services\.[^.]+\.loadbalancer\.server\.port$/.test(key)) {
        const port = Number(value);
        if (Number.isInteger(port)) traefik.port = port;
      }
    }
    if (Object.keys(labels).length > 0 && !traefik.host) {
      issue('info', 'ignored', original, { key: 'labels' }, 'labels');
    }

    // ── Port ──────────────────────────────────────────────────────────────
    const tcp: number[] = [];
    let published = false;
    for (const entry of Array.isArray(raw.ports) ? raw.ports : []) {
      const port = parsePort(entry);
      if (!port) continue;
      if (port.kind === 'udp') issue('warning', 'port.udp', original, { port: port.text });
      else if (port.kind === 'range')
        issue('warning', 'port.range', original, { range: port.text });
      else {
        published = true;
        tcp.push(port.container);
        if (port.host) issue('info', 'port.hostIgnored', original, { host: port.host });
      }
    }
    for (const entry of Array.isArray(raw.expose) ? raw.expose : []) {
      const port = parsePort(entry);
      if (port?.kind === 'tcp') tcp.push(port.container);
    }
    let port = tcp[0] ?? traefik.port ?? null;
    if (tcp.length > 1) {
      const dropped = [...new Set(tcp.slice(1))].filter((value) => value !== tcp[0]);
      if (dropped.length > 0) {
        issue('warning', 'port.multiple', original, {
          kept: tcp[0] ?? 0,
          dropped: dropped.join(', '),
        });
      }
    }
    if (port === null) {
      const known = KNOWN_PORTS.find(([pattern]) => pattern.test(base))?.[1] ?? null;
      port = known ?? 80;
      issue('warning', known ? 'port.guessed' : 'port.default', original, { port });
    }

    // ── Environment and secrets ───────────────────────────────────────────
    const env: Record<string, string> = {};
    const secrets: ServiceInput['secrets'] = [];
    for (const [variable, rawValue] of readEnvironment(raw.environment)) {
      if (!ENV_NAME_PATTERN.test(variable)) {
        issue('warning', 'env.invalidName', original, { name: variable });
        continue;
      }
      const interpolated =
        rawValue === null
          ? {
              value: '',
              variable: { name: variable, fallback: null, expression: `\${${variable}}` },
            }
          : interpolate(rawValue);

      if (looksSecret(variable, rawValue)) {
        // The group: the shell variable if the value comes from it, otherwise the value
        // itself. Two names, one value: a secret, an alias.
        const group = interpolated.variable
          ? `shell:${interpolated.variable.name}`
          : `value:${interpolated.value}`;
        const known = secretGroupOf.get(variable);
        if (known !== undefined) {
          if (known !== group) issue('warning', 'env.secretConflict', original, { name: variable });
          const root = secretRoots.get(known);
          if (root && root !== variable) secrets.push({ name: variable, from: root });
          else secrets.push(variable);
          continue;
        }
        const root = secretRoots.get(group);
        secretGroupOf.set(variable, group);
        if (root && root !== variable) {
          secrets.push({ name: variable, from: root });
          issue('info', 'env.secretAlias', original, { name: variable, from: root });
        } else {
          secretRoots.set(group, variable);
          secrets.push(variable);
          issue('info', 'env.secret', original, { name: variable });
        }
        continue;
      }

      if (interpolated.variable) {
        issue('warning', 'env.interpolated', original, {
          name: variable,
          expression: interpolated.variable.expression,
          // The rest of the sentence depends on the language: translated at render.
          outcomeCode:
            interpolated.variable.fallback !== null
              ? 'env.interpolated.default'
              : 'env.interpolated.empty',
          value: interpolated.variable.fallback ?? '',
        });
      }
      env[variable] = interpolated.value.slice(0, 4096);
    }
    const envFiles = Array.isArray(raw.env_file)
      ? raw.env_file
      : raw.env_file
        ? [raw.env_file]
        : [];
    for (const file of envFiles) {
      const path = isRecord(file) ? asString(file.path) : asString(file);
      issue('warning', 'env_file', original, { file: path ?? '—' });
    }

    // ── Volumes ───────────────────────────────────────────────────────────
    const volumes: NonNullable<ServiceInput['volumes']> = [];
    const takeVolumeName = (wanted: string) => {
      let volumeName = slugify(wanted, 'data');
      for (let index = 2; volumes.some((volume) => volume.name === volumeName); index += 1) {
        volumeName = `${slugify(wanted, 'data').slice(0, 44)}-${index}`;
      }
      return volumeName;
    };
    for (const entry of Array.isArray(raw.volumes) ? raw.volumes : []) {
      let kind: 'volume' | 'bind' | 'tmpfs' = 'volume';
      let volumeSource = '';
      let target = '';
      let readOnly = false;
      if (isRecord(entry)) {
        kind = entry.type === 'bind' ? 'bind' : entry.type === 'tmpfs' ? 'tmpfs' : 'volume';
        volumeSource = asString(entry.source) ?? '';
        target = asString(entry.target) ?? '';
        readOnly = entry.read_only === true;
      } else {
        const text = asString(entry) ?? '';
        const parts = text.split(':');
        if (parts.length === 1) {
          target = parts[0] ?? '';
        } else {
          volumeSource = parts[0] ?? '';
          target = parts[1] ?? '';
          readOnly = (parts[2] ?? '').split(',').includes('ro');
        }
        if (/^(\/|\.|~)/.test(volumeSource)) kind = 'bind';
      }
      if (!target.startsWith('/')) continue;

      if (kind === 'tmpfs') {
        issue('info', 'volume.tmpfs', original, { target });
        continue;
      }
      if (/docker\.sock$/.test(volumeSource) || /docker\.sock$/.test(target)) {
        issue('blocking', 'volume.socket', original, { target });
        continue;
      }
      if (readOnly) issue('info', 'volume.readonly', original, { target });

      if (kind === 'bind') {
        const lastSource = volumeSource.split('/').pop() ?? '';
        const lastTarget = target.split('/').pop() ?? '';
        if (/\.[a-z0-9]{1,8}$/i.test(lastSource) || /\.[a-z0-9]{1,8}$/i.test(lastTarget)) {
          issue('blocking', 'volume.file', original, { source: volumeSource, target });
          continue;
        }
        const volumeName = takeVolumeName(lastSource || lastTarget || 'data');
        volumes.push({ name: volumeName, mountPath: target });
        issue('warning', 'volume.bind', original, {
          source: volumeSource,
          target,
          name: volumeName,
        });
        continue;
      }

      if (!volumeSource) {
        const volumeName = takeVolumeName(target.split('/').filter(Boolean).pop() ?? 'data');
        volumes.push({ name: volumeName, mountPath: target });
        issue('info', 'volume.anonymous', original, { target, name: volumeName });
        continue;
      }
      volumes.push({ name: takeVolumeName(volumeSource), mountPath: target });
    }
    if (raw.tmpfs !== undefined) {
      for (const target of Array.isArray(raw.tmpfs) ? raw.tmpfs : [raw.tmpfs]) {
        issue('info', 'volume.tmpfs', original, { target: asString(target) ?? '—' });
      }
    }

    // ── Dependencies ──────────────────────────────────────────────────────
    const dependsOn: string[] = [];
    const wanted: string[] = Array.isArray(raw.depends_on)
      ? raw.depends_on.flatMap((item) => (asString(item) ? [asString(item) as string] : []))
      : isRecord(raw.depends_on)
        ? Object.keys(raw.depends_on)
        : [];
    if (isRecord(raw.depends_on) && !dependsOnConditionNoted) {
      dependsOnConditionNoted = true;
      issue('info', 'dependsOn.condition', original);
    }
    if (Array.isArray(raw.links)) {
      issue('info', 'ignored', original, { key: 'links' }, 'links');
      for (const link of raw.links) {
        const target = asString(link)?.split(':')[0];
        if (target) wanted.push(target);
      }
    }
    for (const dependency of wanted) {
      const mapped = renamed.get(dependency);
      if (!mapped) issue('warning', 'dependsOn.unknown', original, { name: dependency });
      else if (mapped !== name && !dependsOn.includes(mapped)) dependsOn.push(mapped);
    }

    // ── Replicas and resources ────────────────────────────────────────────
    const deploy = isRecord(raw.deploy) ? raw.deploy : {};
    const replicasRaw = Number(deploy.replicas ?? raw.scale ?? 1);
    const replicas = Number.isInteger(replicasRaw) ? Math.min(50, Math.max(1, replicasRaw)) : 1;
    const otherDeployKeys = Object.keys(deploy).filter(
      (key) => key !== 'replicas' && key !== 'resources',
    );
    if (otherDeployKeys.length > 0)
      issue(
        'info',
        'ignored',
        original,
        { key: `deploy.${otherDeployKeys.join(', deploy.')}` },
        'deploy',
      );

    const limits =
      isRecord(deploy.resources) && isRecord(deploy.resources.limits)
        ? deploy.resources.limits
        : {};
    const cpuRaw = limits.cpus ?? raw.cpus;
    const memoryRaw = limits.memory ?? raw.mem_limit;
    const resources: ServiceInput['resources'] = {};
    if (cpuRaw !== undefined) {
      const cpu = parseCpusMilli(cpuRaw);
      if (cpu === null)
        issue('warning', 'resources.unreadable', original, { value: String(cpuRaw) });
      else resources.cpuMilli = cpu;
    }
    if (memoryRaw !== undefined) {
      const memory = parseMemoryMi(memoryRaw);
      if (memory === null)
        issue('warning', 'resources.unreadable', original, { value: String(memoryRaw) });
      else resources.memoryMi = memory;
    }
    if (resources.cpuMilli !== undefined || resources.memoryMi !== undefined) {
      issue('info', 'resources', original, {
        cpu: resources.cpuMilli ?? 500,
        memory: resources.memoryMi ?? 512,
      });
    }

    // ── Probe: read now, judged once the exposure is known ────────────────
    let probe: Draft['probe'] = null;
    let healthcheck: NonNullable<ServiceInput['healthcheck']> = {};
    if (isRecord(raw.healthcheck)) {
      const test = Array.isArray(raw.healthcheck.test)
        ? raw.healthcheck.test.map((part) => asString(part) ?? '').join(' ')
        : (asString(raw.healthcheck.test) ?? '');
      if (raw.healthcheck.disable === true || /^NONE\b/.test(test.trim())) {
        issue('info', 'healthcheck.disabled', original);
      } else if (test) {
        const http = test.match(HTTP_IN_PROBE);
        probe = http
          ? { kind: 'http', path: http[2] ?? '/', port: http[1] ? Number(http[1]) : null }
          : { kind: 'other', test: test.replace(/^(CMD-SHELL|CMD)\s+/, '').slice(0, 80) };
      }
      const interval = parseDuration(raw.healthcheck.interval);
      const timeout = parseDuration(raw.healthcheck.timeout);
      const retries = Number(raw.healthcheck.retries);
      healthcheck = {
        ...(interval ? { intervalSec: Math.min(300, interval) } : {}),
        ...(timeout ? { timeoutSec: Math.min(120, timeout) } : {}),
        ...(Number.isInteger(retries) && retries > 0 ? { retries: Math.min(50, retries) } : {}),
      };
    }

    const service: ServiceInput = {
      name,
      source: serviceSource,
      port,
      exposed: false,
      ...(replicas > 1 ? { replicas } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(secrets.length > 0 ? { secrets } : {}),
      ...(Object.keys(resources).length > 0 ? { resources } : {}),
      healthcheck,
      ...(volumes.length > 0 ? { volumes } : {}),
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
    };
    drafts.push({ original, name, service, published, backing, traefik, probe });
  }

  if (drafts.length === 0) {
    issue('blocking', 'yaml.notCompose', null);
    return { spec: null, valid: false, issues };
  }

  // ── The exposed service: a single one, the entry point ──────────────────
  const rank = (draft: Draft) => {
    const index = ENTRY_NAMES.indexOf(draft.name);
    return [draft.traefik.host ? 0 : 1, index === -1 ? ENTRY_NAMES.length : index];
  };
  const byPreference = (candidates: Draft[]) =>
    [...candidates].sort((a, b) => {
      const [ta, na] = rank(a);
      const [tb, nb] = rank(b);
      return (ta ?? 0) - (tb ?? 0) || (na ?? 0) - (nb ?? 0);
    });

  const publishing = drafts.filter((draft) => draft.published);
  let exposed: Draft;
  if (publishing.length > 0) {
    exposed = byPreference(publishing)[0] ?? publishing[0]!;
    issue('info', 'exposed.chosen', exposed.original, { service: exposed.name });
    for (const other of publishing) {
      if (other !== exposed)
        issue('warning', 'exposed.others', other.original, { service: other.name });
    }
  } else {
    const fronts = drafts.filter((draft) => !draft.backing);
    exposed = byPreference(fronts.length > 0 ? fronts : drafts)[0] ?? drafts[0]!;
    issue('warning', 'exposed.guessed', exposed.original, { service: exposed.name });
  }
  exposed.service.exposed = true;
  const exposedReplicas = exposed.service.replicas ?? 1;
  if (exposedReplicas > 1) {
    issue('warning', 'replicas.exposed', exposed.original, { count: exposedReplicas });
  }

  // ── The probes, now that we know who speaks HTTP ────────────────────────
  for (const draft of drafts) {
    if (!draft.probe) continue;
    if (draft.probe.kind === 'http') {
      const port = draft.probe.port;
      draft.service.healthcheck = {
        ...draft.service.healthcheck,
        path: draft.probe.path,
        ...(port && port !== draft.service.port ? { port } : {}),
      };
      issue('info', 'healthcheck.http', draft.original, {
        path: draft.probe.path,
        portNote: port && port !== draft.service.port ? ` (port ${port})` : '',
      });
    } else {
      issue(draft === exposed ? 'warning' : 'info', 'healthcheck.unparsed', draft.original, {
        test: draft.probe.test,
      });
    }
  }

  const spec: AppSpecInput = {
    name: appName,
    version: '1.0.0',
    services: drafts.map((draft) => draft.service),
    ...(exposed.traefik.host
      ? {
          ingress: {
            host: exposed.traefik.host,
            tls: exposed.traefik.tls,
            targetService: exposed.name,
          },
        }
      : {}),
  };
  if (exposed.traefik.host) {
    issue('info', 'ingress.traefik', exposed.original, {
      host: exposed.traefik.host,
      tlsNote: exposed.traefik.tls ? ', HTTPS' : '',
    });
  }

  const checked = appSpecSchema.safeParse(spec);
  if (!checked.success) {
    for (const problem of checked.error.issues) {
      const path = problem.path.join('.') || '—';
      issues.push({
        level: 'blocking',
        code: 'schema',
        service: null,
        vars: { message: `${path} : ${problem.message}` },
        schemaIssue: {
          path,
          message: problem.message,
          ...('params' in problem && problem.params ? { params: problem.params } : {}),
        },
      });
    }
  }

  return { spec, valid: checked.success, issues };
}

/**
 * A message's sentence, in the screen's language. The `outcome` and `reason`
 * composed separately are translated again here, so that the whole message
 * speaks the same language.
 */
export function renderComposeIssue(issue: ComposeIssue, lang: UiLanguage): string {
  const vars: Record<string, string | number> = { ...issue.vars };
  if (issue.reason) vars.reason = renderMessage(composeReasons, lang, issue.reason);
  if (issue.schemaIssue) {
    vars.message = `${issue.schemaIssue.path} : ${issueMessage(issue.schemaIssue, lang)}`;
  }
  if (issue.code === 'env.interpolated' && typeof issue.vars.outcomeCode === 'string') {
    vars.outcome = renderMessage(
      composeImportMessages,
      lang,
      issue.vars.outcomeCode as ComposeIssueCode,
      { value: issue.vars.value ?? '' },
    );
  }
  return renderMessage(composeImportMessages, lang, issue.code, vars);
}

/** The levels, from the most to the least severe: the reading order. */
export const COMPOSE_ISSUE_LEVELS: readonly ComposeIssueLevel[] = ['blocking', 'warning', 'info'];

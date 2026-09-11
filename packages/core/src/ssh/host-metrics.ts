import {
  unreachableHostMetrics,
  type HostDisk,
  type HostLoad,
  type HostMemory,
  type HostMetrics,
  type HostOs,
  type HostProbe,
} from '../host-metrics.js';
import { connect, disconnect, exec } from './client.js';
import { SshAuthError } from './errors.js';
import type { SshLogger, SshTarget } from './types.js';
import type { SshSession } from './client.js';

/**
 * Relevé des métriques d'une machine cible.
 *
 * Même règle de conception que le preflight, dont ce module est le voisin :
 * **chaque relevé est indépendant**. `nproc` absent laisse la charge lisible,
 * `df` absent laisse la mémoire lisible. Seule l'impossibilité d'ouvrir la
 * session SSH est fatale — et même là, elle rend un rapport « injoignable »
 * plutôt qu'une exception, parce que l'écran doit pouvoir *dire* qu'il n'a pas
 * pu relever, et continuer d'afficher ce que la base sait de la machine.
 *
 * Rien ici ne dépend du runtime : aucun `docker`, aucun `kubectl`, aucune
 * branche sur `docker | k3s`. C'est ce qui justifie que ce code ne soit pas
 * dans les drivers.
 */

/**
 * Chaque commande est plafonnée court. Ce sont des lectures de `/proc` et un
 * `df` : au-delà de cinq secondes, ce n'est plus une machine lente, c'est une
 * machine qui ne répond plus, et le relevé doit le dire au lieu d'attendre.
 */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Une seule tentative de connexion, garde courte.
 *
 * Le preflight, lui, réessaie : c'est un diagnostic, il a le droit d'insister.
 * Un relevé de supervision est rafraîchi à la demande et sa réponse est
 * attendue par une requête HTTP ; trois tentatives avec backoff mettraient près
 * d'une minute à conclure « injoignable » — une conclusion qu'on tire mieux en
 * huit secondes, quitte à la redemander.
 */
const CONNECT_TIMEOUT_MS = 8_000;
const CONNECT_RETRIES = 1;

/**
 * Exécute un relevé en capturant son échec au lieu de le propager, et rend
 * `null` quand la mesure n'a pas pu être prise.
 */
async function probe<T>(
  key: string,
  label: string,
  run: () => Promise<{ value: T | null; detail: string | null }>,
): Promise<{ value: T | null; probe: HostProbe }> {
  const startedAt = Date.now();
  try {
    const { value, detail } = await run();
    return {
      value,
      probe: {
        key,
        label,
        status: 'success',
        durationMs: Date.now() - startedAt,
        detail,
        error: null,
      },
    };
  } catch (error) {
    return {
      value: null,
      probe: {
        key,
        label,
        status: 'failed',
        durationMs: Date.now() - startedAt,
        detail: null,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/** `/proc/loadavg` — « 0.42 0.31 0.28 1/234 5678 ». */
export function parseLoadAvg(output: string): Omit<HostLoad, 'cores' | 'perCore'> | null {
  const columns = output.trim().split(/\s+/);
  const [one, five, fifteen] = [columns[0], columns[1], columns[2]].map((value) =>
    Number.parseFloat(value ?? ''),
  );
  if ([one, five, fifteen].some((value) => value === undefined || Number.isNaN(value))) return null;
  return { one: one as number, five: five as number, fifteen: fifteen as number };
}

/**
 * `/proc/meminfo`. On y lit `MemAvailable` et **pas** `MemFree` : voir le
 * commentaire de `hostMemorySchema`.
 */
export function parseMemInfo(output: string): HostMemory | null {
  const fields = new Map<string, number>();
  for (const line of output.split('\n')) {
    const match = /^(\w+):\s+(\d+)\s*kB/i.exec(line.trim());
    if (match?.[1] && match[2]) fields.set(match[1], Number.parseInt(match[2], 10));
  }

  const totalKb = fields.get('MemTotal');
  const availableKb = fields.get('MemAvailable');
  // Sans `MemAvailable` (noyaux antérieurs à 3.14), toute proportion serait une
  // invention : on préfère ne rien dire.
  if (totalKb === undefined || availableKb === undefined || totalKb <= 0) return null;

  const usedKb = Math.max(0, totalKb - availableKb);
  return {
    totalKb,
    availableKb,
    usedKb,
    usedPercent: Math.min(100, Math.max(0, Math.round((usedKb / totalKb) * 1000) / 10)),
  };
}

/** `df -Pk <chemin>` — le format POSIX est stable, contrairement à `df -h`. */
export function parseDf(output: string, path: string): HostDisk | null {
  const lines = output.trim().split('\n');
  if (lines.length < 2) return null;

  const columns = (lines[lines.length - 1] ?? '').trim().split(/\s+/);
  if (columns.length < 6) return null;

  const [filesystem, size, used, available, percent, ...mount] = columns;
  const sizeKb = Number.parseInt(size ?? '', 10);
  const usedKb = Number.parseInt(used ?? '', 10);
  const availableKb = Number.parseInt(available ?? '', 10);
  const usePercent = Number.parseInt((percent ?? '').replace('%', ''), 10);

  if (!filesystem || [sizeKb, usedKb, availableKb, usePercent].some(Number.isNaN)) return null;

  return {
    path,
    filesystem,
    sizeKb,
    usedKb,
    availableKb,
    usePercent: Math.min(100, Math.max(0, usePercent)),
    mountedOn: mount.join(' ') || '/',
  };
}

/** `/proc/uptime` — « 12345.67 98765.43 ». Seul le premier nombre nous intéresse. */
export function parseUptime(output: string): number | null {
  const seconds = Number.parseFloat(output.trim().split(/\s+/)[0] ?? '');
  return Number.isNaN(seconds) ? null : Math.floor(seconds);
}

function parseOsRelease(content: string): Omit<HostOs, 'kernel'> {
  const fields = new Map<string, string>();
  for (const line of content.split('\n')) {
    const separator = line.indexOf('=');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^"|"$/g, '');
    if (key) fields.set(key, value);
  }
  return {
    name: fields.get('NAME') ?? null,
    version: fields.get('VERSION_ID') ?? fields.get('VERSION') ?? null,
    prettyName: fields.get('PRETTY_NAME') ?? null,
  };
}

/** Kibioctets → Gio, une décimale. Pour les seules lignes de détail. */
function gib(kb: number): string {
  return `${(kb / 1024 / 1024).toFixed(1)} Gio`;
}

/**
 * `df` sur la racine des déploiements — ou, si elle n'existe pas encore, sur
 * l'ancêtre existant le plus proche.
 *
 * Une cible neuve n'a pas encore de `/opt/bootstrap` : répondre « inconnu »
 * serait exact mais inutile, alors que la partition qui *portera* les
 * déploiements, elle, est parfaitement mesurable. Le chemin réellement mesuré
 * repart dans le relevé, donc rien n'est déguisé.
 */
async function probeDisk(session: SshSession, rootPath: string): Promise<HostDisk | null> {
  const script =
    `p=${shellQuote(rootPath)}; ` +
    'while [ ! -d "$p" ] && [ "$p" != "/" ]; do p=$(dirname "$p"); done; ' +
    'printf "%s\\n" "$p"; df -Pk "$p"';

  const result = await exec(session, script, { timeout: PROBE_TIMEOUT_MS });
  const [measured, ...rest] = result.stdout.split('\n');
  if (result.code !== 0 || !measured) {
    throw new Error(
      `df indisponible : ${result.stderr.trim().split('\n')[0] ?? `code ${result.code}`}`,
    );
  }
  return parseDf(rest.join('\n'), measured.trim());
}

/** Échappement POSIX en quotes simples — le chemin vient de la configuration. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export type HostMetricsOptions = {
  /** Racine des déploiements, pour choisir la partition à mesurer. */
  rootPath: string;
  logger?: SshLogger;
};

/**
 * Ouvre une session, prend les six relevés, referme.
 *
 * Les relevés partent ensemble : ce sont six lectures indépendantes sur la même
 * session, les enchaîner ne ferait qu'additionner six allers-retours réseau
 * pour un résultat identique.
 */
export async function collectHostMetrics(
  targetId: string,
  target: SshTarget,
  options: HostMetricsOptions,
): Promise<HostMetrics> {
  const checkedAt = new Date().toISOString();
  const { rootPath, logger } = options;

  let session: SshSession;
  const connectStartedAt = Date.now();
  try {
    session = await connect(target, {
      retries: CONNECT_RETRIES,
      readyTimeout: CONNECT_TIMEOUT_MS,
      ...(logger ? { logger } : {}),
    });
  } catch (error) {
    const message =
      error instanceof SshAuthError
        ? 'Authentification refusée (clé, mot de passe ou passphrase invalide)'
        : error instanceof Error
          ? error.message
          : String(error);

    return unreachableHostMetrics(targetId, message, checkedAt, [
      {
        key: 'ssh',
        label: 'Connexion SSH',
        status: 'failed',
        durationMs: Date.now() - connectStartedAt,
        detail: null,
        error: message,
      },
    ]);
  }

  try {
    const [loadAvg, cores, memory, disk, uptime, os] = await Promise.all([
      probe('load', 'Charge moyenne', async () => {
        const result = await exec(session, 'cat /proc/loadavg', { timeout: PROBE_TIMEOUT_MS });
        if (result.code !== 0) throw new Error('/proc/loadavg illisible');
        const parsed = parseLoadAvg(result.stdout);
        return {
          value: parsed,
          detail: parsed ? `${parsed.one} ${parsed.five} ${parsed.fifteen}` : 'sortie illisible',
        };
      }),

      probe('cpu', 'Cœurs', async () => {
        const result = await exec(session, 'nproc', { timeout: PROBE_TIMEOUT_MS });
        if (result.code !== 0) {
          throw new Error(
            `nproc indisponible : ${result.stderr.trim().split('\n')[0] ?? `code ${result.code}`}`,
          );
        }
        const parsed = Number.parseInt(result.stdout.trim(), 10);
        const value = Number.isNaN(parsed) || parsed <= 0 ? null : parsed;
        return { value, detail: value === null ? 'sortie illisible' : `${value} cœur(s)` };
      }),

      probe('memory', 'Mémoire', async () => {
        const result = await exec(session, 'cat /proc/meminfo', { timeout: PROBE_TIMEOUT_MS });
        if (result.code !== 0) throw new Error('/proc/meminfo illisible');
        const parsed = parseMemInfo(result.stdout);
        return {
          value: parsed,
          detail: parsed
            ? `${gib(parsed.availableKb)} disponibles sur ${gib(parsed.totalKb)}`
            : 'MemTotal ou MemAvailable absent',
        };
      }),

      probe('disk', 'Espace disque', async () => {
        const parsed = await probeDisk(session, rootPath);
        return {
          value: parsed,
          detail: parsed
            ? `${parsed.path} — ${gib(parsed.availableKb)} libres (${parsed.usePercent} % utilisés)`
            : 'sortie de df illisible',
        };
      }),

      probe('uptime', 'Uptime', async () => {
        const result = await exec(session, 'cat /proc/uptime', { timeout: PROBE_TIMEOUT_MS });
        if (result.code !== 0) throw new Error('/proc/uptime illisible');
        const parsed = parseUptime(result.stdout);
        return {
          value: parsed,
          detail: parsed === null ? 'sortie illisible' : `${Math.floor(parsed / 86400)} jour(s)`,
        };
      }),

      probe<HostOs>('os', 'Système', async () => {
        const [kernel, release] = await Promise.all([
          exec(session, 'uname -r', { timeout: PROBE_TIMEOUT_MS }),
          exec(session, 'cat /etc/os-release 2>/dev/null || true', { timeout: PROBE_TIMEOUT_MS }),
        ]);
        const parsed = parseOsRelease(release.stdout);
        const value: HostOs = {
          kernel: kernel.code === 0 ? (kernel.stdout.trim() || null) : null,
          ...parsed,
        };
        return { value, detail: parsed.prettyName ?? value.kernel };
      }),
    ]);

    const load: HostLoad | null = loadAvg.value
      ? {
          ...loadAvg.value,
          cores: cores.value,
          perCore:
            cores.value === null
              ? null
              : Math.round((loadAvg.value.one / cores.value) * 1000) / 1000,
        }
      : null;

    return {
      targetId,
      checkedAt,
      reachable: true,
      latencyMs: session.latencyMs,
      error: null,
      load,
      memory: memory.value,
      disk: disk.value,
      uptimeSeconds: uptime.value,
      os: os.value ?? { kernel: null, name: null, version: null, prettyName: null },
      probes: [
        {
          key: 'ssh',
          label: 'Connexion SSH',
          status: 'success',
          durationMs: Date.now() - connectStartedAt,
          detail: `${session.latencyMs} ms`,
          error: null,
        },
        loadAvg.probe,
        cores.probe,
        memory.probe,
        disk.probe,
        uptime.probe,
        os.probe,
      ],
    };
  } finally {
    await disconnect(session);
  }
}

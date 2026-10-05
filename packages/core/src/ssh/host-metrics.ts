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
import { shellQuote } from '../shell.js';
import type { UiLanguage } from '../i18n.js';
import { sshSay, type SshSay } from './messages.js';

/**
 * Reading a target machine's metrics.
 *
 * The same design rule as the preflight, this module's neighbor: **each reading
 * is independent**. A missing `nproc` leaves the load readable, a missing `df`
 * leaves memory readable. Only the impossibility of opening the SSH session is
 * fatal — and even then, it returns an "unreachable" report rather than an
 * exception, because the screen must be able to *say* it could not read, and
 * keep showing what the database knows about the machine.
 *
 * Nothing here depends on the runtime: no `docker`, no `kubectl`, no branch on
 * `docker | k3s`. That is what justifies this code not being in the drivers.
 */

/**
 * Each command is capped short. They are reads of `/proc` and a `df`: beyond
 * five seconds, it is no longer a slow machine, it is a machine that no longer
 * answers, and the reading must say so instead of waiting.
 */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * A single connection attempt, short guard.
 *
 * The preflight retries: it is a diagnosis, it has the right to insist. A
 * monitoring reading is refreshed on demand and its answer is awaited by an HTTP
 * request; three attempts with backoff would take nearly a minute to conclude
 * "unreachable" — a conclusion better drawn in eight seconds, even if it means
 * asking again.
 */
const CONNECT_TIMEOUT_MS = 8_000;
const CONNECT_RETRIES = 1;

/**
 * Runs a reading capturing its failure instead of propagating it, and returns
 * `null` when the measurement could not be taken.
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

/** `/proc/loadavg` — "0.42 0.31 0.28 1/234 5678". */
export function parseLoadAvg(output: string): Omit<HostLoad, 'cores' | 'perCore'> | null {
  const columns = output.trim().split(/\s+/);
  const [one, five, fifteen] = [columns[0], columns[1], columns[2]].map((value) =>
    Number.parseFloat(value ?? ''),
  );
  if ([one, five, fifteen].some((value) => value === undefined || Number.isNaN(value))) return null;
  return { one: one as number, five: five as number, fifteen: fifteen as number };
}

/**
 * `/proc/meminfo`. We read `MemAvailable` and **not** `MemFree`: see the comment
 * of `hostMemorySchema`.
 */
export function parseMemInfo(output: string): HostMemory | null {
  const fields = new Map<string, number>();
  for (const line of output.split('\n')) {
    const match = /^(\w+):\s+(\d+)\s*kB/i.exec(line.trim());
    if (match?.[1] && match[2]) fields.set(match[1], Number.parseInt(match[2], 10));
  }

  const totalKb = fields.get('MemTotal');
  const availableKb = fields.get('MemAvailable');
  // Without `MemAvailable` (kernels before 3.14), any proportion would be made
  // up: we prefer to say nothing.
  if (totalKb === undefined || availableKb === undefined || totalKb <= 0) return null;

  const usedKb = Math.max(0, totalKb - availableKb);
  return {
    totalKb,
    availableKb,
    usedKb,
    usedPercent: Math.min(100, Math.max(0, Math.round((usedKb / totalKb) * 1000) / 10)),
  };
}

/** `df -Pk <path>` — the POSIX format is stable, unlike `df -h`. */
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

/** `/proc/uptime` — "12345.67 98765.43". Only the first number interests us. */
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

/** Kibibytes → GiB, one decimal. For the detail lines only. */

/**
 * `df` on the deployments' root — or, if it does not exist yet, on the closest
 * existing ancestor.
 *
 * A new target has no `/opt/bootstrap` yet: answering "unknown" would be
 * accurate but useless, whereas the partition that *will carry* the
 * deployments is perfectly measurable. The path actually measured goes back in
 * the reading, so nothing is disguised.
 */
async function probeDisk(
  session: SshSession,
  rootPath: string,
  say: SshSay,
): Promise<HostDisk | null> {
  const script =
    `p=${shellQuote(rootPath)}; ` +
    'while [ ! -d "$p" ] && [ "$p" != "/" ]; do p=$(dirname "$p"); done; ' +
    'printf "%s\\n" "$p"; df -Pk "$p"';

  const result = await exec(session, script, { timeout: PROBE_TIMEOUT_MS });
  const [measured, ...rest] = result.stdout.split('\n');
  if (result.code !== 0 || !measured) {
    throw new Error(
      say('metrics.unavailable', {
        tool: 'df',
        detail: result.stderr.trim().split('\n')[0] ?? `code ${result.code}`,
      }),
    );
  }
  return parseDf(rest.join('\n'), measured.trim());
}

export type HostMetricsOptions = {
  /** The deployments' root, to choose the partition to measure. */
  rootPath: string;
  /** The language of the reading's labels and errors: the instance's. */
  language: UiLanguage;
  logger?: SshLogger;
};

/**
 * Opens a session, takes the six readings, closes.
 *
 * The readings go out together: they are six independent reads on the same
 * session, chaining them would only add up six network round trips for an
 * identical result.
 */
export async function collectHostMetrics(
  targetId: string,
  target: SshTarget,
  options: HostMetricsOptions,
): Promise<HostMetrics> {
  const checkedAt = new Date().toISOString();
  const { rootPath, logger, language } = options;
  const say = sshSay(language);
  const gib = (kb: number) => say('gib', { value: (kb / 1024 / 1024).toFixed(1) });

  let session: SshSession;
  const connectStartedAt = Date.now();
  try {
    session = await connect(target, {
      retries: CONNECT_RETRIES,
      readyTimeout: CONNECT_TIMEOUT_MS,
      language,
      ...(logger ? { logger } : {}),
    });
  } catch (error) {
    const message =
      error instanceof SshAuthError
        ? say('auth.refused.short')
        : error instanceof Error
          ? error.message
          : String(error);

    return unreachableHostMetrics(targetId, message, checkedAt, [
      {
        key: 'ssh',
        label: say('check.ssh'),
        status: 'failed',
        durationMs: Date.now() - connectStartedAt,
        detail: null,
        error: message,
      },
    ]);
  }

  try {
    const [loadAvg, cores, memory, disk, uptime, os] = await Promise.all([
      probe('load', say('metrics.load'), async () => {
        const result = await exec(session, 'cat /proc/loadavg', { timeout: PROBE_TIMEOUT_MS });
        if (result.code !== 0)
          throw new Error(say('metrics.unreadableFile', { file: '/proc/loadavg' }));
        const parsed = parseLoadAvg(result.stdout);
        return {
          value: parsed,
          detail: parsed ? `${parsed.one} ${parsed.five} ${parsed.fifteen}` : say('unreadable'),
        };
      }),

      probe('cpu', say('metrics.cores'), async () => {
        const result = await exec(session, 'nproc', { timeout: PROBE_TIMEOUT_MS });
        if (result.code !== 0) {
          throw new Error(
            say('metrics.unavailable', {
              tool: 'nproc',
              detail: result.stderr.trim().split('\n')[0] ?? `code ${result.code}`,
            }),
          );
        }
        const parsed = Number.parseInt(result.stdout.trim(), 10);
        const value = Number.isNaN(parsed) || parsed <= 0 ? null : parsed;
        return {
          value,
          detail: value === null ? say('unreadable') : say('metrics.cores.count', { count: value }),
        };
      }),

      probe('memory', say('check.memory'), async () => {
        const result = await exec(session, 'cat /proc/meminfo', { timeout: PROBE_TIMEOUT_MS });
        if (result.code !== 0)
          throw new Error(say('metrics.unreadableFile', { file: '/proc/meminfo' }));
        const parsed = parseMemInfo(result.stdout);
        return {
          value: parsed,
          detail: parsed
            ? say('metrics.memory.available', {
                available: gib(parsed.availableKb),
                total: gib(parsed.totalKb),
              })
            : say('metrics.memory.missing'),
        };
      }),

      probe('disk', say('check.disk'), async () => {
        const parsed = await probeDisk(session, rootPath, say);
        return {
          value: parsed,
          detail: parsed
            ? say('metrics.disk.free', {
                path: parsed.path,
                available: gib(parsed.availableKb),
                percent: parsed.usePercent,
              })
            : say('check.disk.unreadable'),
        };
      }),

      probe('uptime', 'Uptime', async () => {
        const result = await exec(session, 'cat /proc/uptime', { timeout: PROBE_TIMEOUT_MS });
        if (result.code !== 0)
          throw new Error(say('metrics.unreadableFile', { file: '/proc/uptime' }));
        const parsed = parseUptime(result.stdout);
        return {
          value: parsed,
          detail:
            parsed === null
              ? say('unreadable')
              : say('metrics.uptime.days', { count: Math.floor(parsed / 86400) }),
        };
      }),

      probe<HostOs>('os', say('metrics.os'), async () => {
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
          label: say('check.ssh'),
          status: 'success',
          durationMs: Date.now() - connectStartedAt,
          detail: say('check.ssh.detail', { latency: session.latencyMs }),
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

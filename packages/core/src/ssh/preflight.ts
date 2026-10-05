import {
  EMPTY_RUNTIMES,
  type DockerRuntime,
  type K3sRuntime,
  type SudoInfo,
  type DiskInfo,
  type FirewallInfo,
  type MemoryInfo,
  type OsInfo,
  type PreflightCheck,
  type PreflightReport,
  type RuntimesAvailable,
  type TargetHealth,
  type Tools,
} from '../preflight.js';
import { isManagedUfwRule } from '../drivers/ufw.js';
import { connect, disconnect, exec } from './client.js';
import { SshAuthError } from './errors.js';
import type { SshLogger, SshTarget } from './types.js';
import type { SshSession } from './client.js';
import { firstLine } from '../shell.js';
import type { UiLanguage } from '../i18n.js';
import { sshSay } from './messages.js';

/**
 * Preflight d'une machine cible.
 *
 * Règle de conception : **chaque contrôle est indépendant**. Un `kubectl`
 * absent marque K3s indisponible, il ne fait pas échouer le preflight.
 * Seule l'impossibilité d'ouvrir la session SSH est fatale.
 */

const CHECK_TIMEOUT_MS = 15_000;

/** Exécute un contrôle en capturant son échec au lieu de le propager. */
async function runCheck<T>(
  checks: PreflightCheck[],
  key: string,
  label: string,
  run: () => Promise<{ value: T; detail: string | null }>,
  fallback: T,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const { value, detail } = await run();
    checks.push({
      key,
      label,
      status: 'success',
      durationMs: Date.now() - startedAt,
      detail,
      error: null,
    });
    return value;
  } catch (error) {
    checks.push({
      key,
      label,
      status: 'failed',
      durationMs: Date.now() - startedAt,
      detail: null,
      error: error instanceof Error ? error.message : String(error),
    });
    return fallback;
  }
}

function parseOsRelease(content: string): { name: string | null; version: string | null; prettyName: string | null } {
  const fields = new Map<string, string>();
  for (const line of content.split('\n')) {
    const separator = line.indexOf('=');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^"|"$/g, '');
    if (key) fields.set(key, value);
  }
  return {
    name: fields.get('NAME') ?? null,
    version: fields.get('VERSION_ID') ?? fields.get('VERSION') ?? null,
    prettyName: fields.get('PRETTY_NAME') ?? null,
  };
}

/** `df -Pk /` — le format POSIX est stable, contrairement à `df -h`. */
function parseDf(output: string): DiskInfo | null {
  const lines = output.trim().split('\n');
  const row = lines[lines.length - 1];
  if (!row || lines.length < 2) return null;

  const columns = row.trim().split(/\s+/);
  if (columns.length < 6) return null;

  const [filesystem, size, used, available, percent, ...mount] = columns;
  const sizeKb = Number.parseInt(size ?? '', 10);
  const usedKb = Number.parseInt(used ?? '', 10);
  const availableKb = Number.parseInt(available ?? '', 10);
  const usePercent = Number.parseInt((percent ?? '').replace('%', ''), 10);

  if (!filesystem || [sizeKb, usedKb, availableKb, usePercent].some(Number.isNaN)) return null;

  return {
    filesystem,
    sizeKb,
    usedKb,
    availableKb,
    usePercent: Math.min(100, Math.max(0, usePercent)),
    mountedOn: mount.join(' ') || '/',
  };
}

/** `free -m`, ligne `Mem:`. */
function parseFree(output: string): MemoryInfo | null {
  const row = output.split('\n').find((line) => line.trim().startsWith('Mem:'));
  if (!row) return null;

  const columns = row.trim().split(/\s+/);
  const total = Number.parseInt(columns[1] ?? '', 10);
  const used = Number.parseInt(columns[2] ?? '', 10);
  const free = Number.parseInt(columns[3] ?? '', 10);
  // `available` est la 7e colonne sur les `free` récents, absente sur les anciens.
  const available = Number.parseInt(columns[6] ?? columns[3] ?? '', 10);

  if ([total, used, free].some(Number.isNaN)) return null;

  return {
    totalMb: total,
    usedMb: used,
    freeMb: free,
    availableMb: Number.isNaN(available) ? free : available,
  };
}

type KubectlNodes = {
  items?: Array<{
    status?: { conditions?: Array<{ type?: string; status?: string }> };
    nodeInfo?: { kubeletVersion?: string };
  }>;
};

function parseKubectlNodes(json: string): {
  nodes: number;
  readyNodes: number;
  version: string | null;
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  const payload = parsed as KubectlNodes & {
    items?: Array<{ status?: { nodeInfo?: { kubeletVersion?: string } } }>;
  };
  if (!Array.isArray(payload.items)) return null;

  let readyNodes = 0;
  let version: string | null = null;

  for (const item of payload.items) {
    const conditions = item.status?.conditions ?? [];
    if (conditions.some((c) => c.type === 'Ready' && c.status === 'True')) readyNodes += 1;
    version ??= item.status?.nodeInfo?.kubeletVersion ?? null;
  }

  return { nodes: payload.items.length, readyNodes, version };
}

async function probeTools(session: SshSession): Promise<Tools> {
  // Un seul aller-retour pour les cinq binaires.
  const result = await exec(
    session,
    'for b in ufw curl git docker kubectl; do ' +
      'if command -v "$b" >/dev/null 2>&1; then echo "$b=1"; else echo "$b=0"; fi; done',
    { timeout: CHECK_TIMEOUT_MS },
  );

  const found = new Set(
    result.stdout
      .split('\n')
      .filter((line) => line.trim().endsWith('=1'))
      .map((line) => line.split('=')[0]?.trim())
      .filter((name): name is string => Boolean(name)),
  );

  return {
    ufw: found.has('ufw'),
    curl: found.has('curl'),
    git: found.has('git'),
    docker: found.has('docker'),
    kubectl: found.has('kubectl'),
  };
}

/**
 * État du pare-feu et règles posées par le panel.
 *
 * Les règles sont reconnues à leur commentaire `pupitre:` — le même marqueur
 * que celui posé par le driver, plus celui d'avant le renommage. C'est ce qui permet à l'UI de montrer
 * ce que le panel a ouvert sans le confondre avec ce que l'administrateur de la
 * machine a ouvert lui-même.
 */
async function probeFirewall(session: SshSession, installed: boolean): Promise<FirewallInfo> {
  if (!installed) return { installed: false, active: false, managedRules: [] };

  // `ufw status` exige root.
  const status = await exec(session, 'ufw status 2>/dev/null || true', {
    sudo: true,
    timeout: CHECK_TIMEOUT_MS,
  });
  const active = /Status:\s*active/i.test(status.stdout);

  const managedRules = status.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => isManagedUfwRule(line));

  return { installed: true, active, managedRules };
}

/**
 * Déduit le statut global.
 * `ok` : au moins un runtime exploitable. `degraded` : la machine répond mais
 * rien n'est déployable dessus. `unreachable` : session SSH impossible.
 */
function deriveStatus(runtimes: RuntimesAvailable, checks: PreflightCheck[]): TargetHealth {
  const hasRuntime =
    runtimes.docker.available || (runtimes.k3s.available && runtimes.k3s.clusterReady);
  if (!hasRuntime) return 'degraded';
  return checks.some((check) => check.status === 'failed') ? 'degraded' : 'ok';
}

export async function runPreflight(
  target: SshTarget,
  language: UiLanguage,
  logger?: SshLogger,
): Promise<PreflightReport> {
  const say = sshSay(language);
  const checks: PreflightCheck[] = [];
  const checkedAt = new Date().toISOString();

  let session: SshSession;
  const connectStartedAt = Date.now();
  try {
    session = await connect(target, { language, ...(logger ? { logger } : {}) });
    checks.push({
      key: 'ssh',
      label: say('check.ssh'),
      status: 'success',
      durationMs: Date.now() - connectStartedAt,
      detail: session.hostKey
        ? say('check.ssh.key', { latency: session.latencyMs, key: session.hostKey })
        : say('check.ssh.detail', { latency: session.latencyMs }),
      error: null,
    });
  } catch (error) {
    // Seul échec fatal : sans session, aucun autre contrôle n'a de sens.
    const message =
      error instanceof SshAuthError
        ? say('auth.refused.short')
        : error instanceof Error
          ? error.message
          : String(error);

    return {
      checkedAt,
      reachable: false,
      status: 'unreachable',
      latencyMs: null,
      os: { uname: null, name: null, version: null, prettyName: null },
      sudo: { available: false, nopasswd: false },
      disk: null,
      memory: null,
      tools: { ufw: false, curl: false, git: false, docker: false, kubectl: false },
      firewall: null,
      runtimes: EMPTY_RUNTIMES,
      checks: [
        {
          key: 'ssh',
          label: say('check.ssh'),
          status: 'failed',
          durationMs: Date.now() - connectStartedAt,
          detail: null,
          error: message,
        },
      ],
      error: message,
    };
  }

  try {
    const os = await runCheck<OsInfo>(
      checks,
      'os',
      say('check.os'),
      async () => {
        const [uname, release] = await Promise.all([
          exec(session, 'uname -a', { timeout: CHECK_TIMEOUT_MS }),
          exec(session, 'cat /etc/os-release 2>/dev/null || true', { timeout: CHECK_TIMEOUT_MS }),
        ]);
        const parsed = parseOsRelease(release.stdout);
        return {
          value: { uname: firstLine(uname.stdout), ...parsed },
          detail: parsed.prettyName ?? firstLine(uname.stdout),
        };
      },
      { uname: null, name: null, version: null, prettyName: null },
    );

    const sudo = await runCheck<SudoInfo>(
      checks,
      'sudo',
      say('check.sudo'),
      async () => {
        const nopasswd = await exec(session, 'sudo -n true', { timeout: CHECK_TIMEOUT_MS });
        const available = await exec(session, 'command -v sudo >/dev/null 2>&1', {
          timeout: CHECK_TIMEOUT_MS,
        });
        const info = { available: available.code === 0, nopasswd: nopasswd.code === 0 };
        return {
          value: info,
          detail: info.nopasswd
            ? say('check.sudo.nopasswd')
            : info.available
              ? say('check.sudo.password')
              : say('check.sudo.absent'),
        };
      },
      { available: false, nopasswd: false },
    );

    const tools = await runCheck<Tools>(
      checks,
      'tools',
      say('check.tools'),
      async () => {
        const found = await probeTools(session);
        const present = Object.entries(found)
          .filter(([, ok]) => ok)
          .map(([name]) => name);
        return {
          value: found,
          detail: present.length > 0 ? present.join(', ') : say('check.tools.none'),
        };
      },
      { ufw: false, curl: false, git: false, docker: false, kubectl: false },
    );

    const firewall = await runCheck<FirewallInfo>(
      checks,
      'firewall',
      say('check.firewall'),
      async () => {
        const value = await probeFirewall(session, tools.ufw);
        return {
          value,
          detail: !value.installed
            ? say('check.firewall.absent')
            : value.active
              ? say('check.firewall.active', { count: value.managedRules.length })
              : say('check.firewall.inactive'),
        };
      },
      { installed: tools.ufw, active: false, managedRules: [] },
    );

    const docker = await runCheck<DockerRuntime>(
      checks,
      'docker',
      'Docker',
      async () => {
        if (!tools.docker) {
          return {
            value: { available: false, version: null, composeVersion: null },
            detail: say('check.docker.noBinary'),
          };
        }
        const [info, compose] = await Promise.all([
          exec(session, "docker info --format '{{.ServerVersion}}'", { timeout: CHECK_TIMEOUT_MS }),
          exec(session, 'docker compose version --short 2>/dev/null || true', {
            timeout: CHECK_TIMEOUT_MS,
          }),
        ]);
        const version = info.code === 0 ? firstLine(info.stdout) : null;
        const composeVersion = firstLine(compose.stdout);
        return {
          value: { available: version !== null, version, composeVersion },
          detail:
            version === null
              ? say('check.docker.daemon', {
                  detail: firstLine(info.stderr) ?? `code ${info.code}`,
                })
              : `Docker ${version}${composeVersion ? `, Compose ${composeVersion}` : ''}`,
        };
      },
      { available: false, version: null, composeVersion: null },
    );

    const k3s = await runCheck<K3sRuntime>(
      checks,
      'k3s',
      'Kubernetes / K3s',
      async () => {
        if (!tools.kubectl) {
          return {
            value: {
              available: false,
              version: null,
              nodes: null,
              readyNodes: null,
              clusterReady: false,
            },
            detail: say('check.k3s.noKubectl'),
          };
        }
        const nodes = await exec(session, 'kubectl get nodes -o json 2>/dev/null', {
          timeout: CHECK_TIMEOUT_MS,
        });
        const parsed = nodes.code === 0 ? parseKubectlNodes(nodes.stdout) : null;
        if (!parsed) {
          return {
            value: {
              available: false,
              version: null,
              nodes: null,
              readyNodes: null,
              clusterReady: false,
            },
            detail: say('check.k3s.noCluster'),
          };
        }
        return {
          value: {
            available: true,
            version: parsed.version,
            nodes: parsed.nodes,
            readyNodes: parsed.readyNodes,
            clusterReady: parsed.readyNodes > 0,
          },
          detail: say('check.k3s.nodes', {
            ready: parsed.readyNodes,
            total: parsed.nodes,
            version: parsed.version ? ` — ${parsed.version}` : '',
          }),
        };
      },
      { available: false, version: null, nodes: null, readyNodes: null, clusterReady: false },
    );

    const disk = await runCheck<DiskInfo | null>(
      checks,
      'disk',
      say('check.disk'),
      async () => {
        const result = await exec(session, 'df -Pk /', { timeout: CHECK_TIMEOUT_MS });
        const parsed = parseDf(result.stdout);
        return {
          value: parsed,
          detail: parsed
            ? say('check.disk.free', {
                gib: Math.round(parsed.availableKb / 1024 / 1024),
                percent: parsed.usePercent,
              })
            : say('check.disk.unreadable'),
        };
      },
      null,
    );

    const memory = await runCheck<MemoryInfo | null>(
      checks,
      'memory',
      say('check.memory'),
      async () => {
        const result = await exec(session, 'free -m 2>/dev/null || true', {
          timeout: CHECK_TIMEOUT_MS,
        });
        const parsed = parseFree(result.stdout);
        return {
          value: parsed,
          detail: parsed
            ? say('check.memory.available', {
                available: parsed.availableMb,
                total: parsed.totalMb,
              })
            : say('check.memory.unavailable'),
        };
      },
      null,
    );

    const runtimes: RuntimesAvailable = { docker, k3s };

    return {
      checkedAt,
      reachable: true,
      status: deriveStatus(runtimes, checks),
      latencyMs: session.latencyMs,
      os,
      sudo,
      disk,
      memory,
      tools,
      firewall,
      runtimes,
      checks,
      error: null,
    };
  } finally {
    await disconnect(session);
  }
}

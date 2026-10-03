import {
  SCANNERS,
  type Finding,
  type ImageStore,
  type ScanReport,
  type Severity,
} from '../scan.js';
import type { SshSession } from '../ssh/client.js';
import { cachePath, ensureBinary, toolPath } from './install.js';
import { canonicalImageReference } from '../images/reference.js';
import { shellQuote } from '../shell.js';
import {
  containerdEnv,
  parseJsonOutput,
  runTool,
  SCAN_TIMEOUT_MS,
  toolCommandFor,
  type ToolCommand,
} from './run.js';
import type { ScanContext, ScanLogSink, Scanner } from './types.js';

/**
 * Trivy — vulnérabilités des paquets système et applicatifs.
 *
 * Version relevée sur `api.github.com/repos/aquasecurity/trivy/releases/latest`
 * le 2026-09-10, et non de mémoire. Elle est épinglée : un scanner qui change
 * de version sous les pieds rendrait deux déploiements incomparables.
 */
export const TRIVY_VERSION = '0.74.0';

/** `uname -m` → suffixe d'archive Trivy. */
const ARCH_SUFFIX: Record<string, string> = {
  x86_64: '64bit',
  amd64: '64bit',
  aarch64: 'ARM64',
  arm64: 'ARM64',
  armv7l: 'ARM',
  armv6l: 'ARM',
  i386: '32bit',
  i686: '32bit',
  s390x: 's390x',
  ppc64le: 'PPC64LE',
};

export type TrivyOutput = {
  ArtifactName?: string;
  Results?: Array<{
    Target?: string;
    Vulnerabilities?: Array<{
      VulnerabilityID?: string;
      PkgName?: string;
      InstalledVersion?: string;
      FixedVersion?: string;
      Severity?: string;
      Title?: string;
      Description?: string;
      PrimaryURL?: string;
    }> | null;
  }> | null;
};

export class TrivyScanner implements Scanner {
  readonly key = 'trivy' as const;
  readonly kind = SCANNERS.trivy.kind;

  async ensureInstalled(session: SshSession, onLog?: ScanLogSink): Promise<string> {
    return ensureBinary(
      session,
      this.key,
      {
        binary: 'trivy',
        version: TRIVY_VERSION,
        assetUrl: (arch) => {
          const suffix = ARCH_SUFFIX[arch];
          if (!suffix) return null;
          return (
            `https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}` +
            `/trivy_${TRIVY_VERSION}_Linux-${suffix}.tar.gz`
          );
        },
      },
      onLog,
    );
  }

  async run(ctx: ScanContext, onLog: ScanLogSink): Promise<ScanReport> {
    await this.ensureInstalled(ctx.session, onLog);

    const timeout = ctx.timeoutMs ?? SCAN_TIMEOUT_MS;
    const { command, sudo } = trivyCommand(ctx.image, ctx.store, timeout);

    onLog(`trivy image --format json --scanners vuln ${ctx.image}`);
    const run = await runTool(ctx.session, this.key, command, onLog, timeout, sudo);
    const raw = parseJsonOutput<TrivyOutput>(this.key, run);
    const findings = normalizeTrivyReport(raw);

    onLog(`${findings.length} vulnérabilité(s) rapportée(s)`);

    return {
      scanner: this.key,
      kind: this.kind,
      durationMs: run.durationMs,
      findings,
      raw,
    };
  }
}

/**
 * La ligne de commande de Trivy pour une image et l'endroit où elle se trouve.
 *
 * Docker : la détection par défaut de Trivy, inchangée. Containerd : ses
 * variables `CONTAINERD_*` et `--image-src containerd,remote` — l'image
 * construite d'abord dans le containerd déclaré, et une image publique encore
 * jamais tirée sur son registry. Le nom y est complet (`docker.io/…`) :
 * Trivy trouve l'image sous le nom court, puis échoue à l'exporter.
 */
export function trivyCommand(image: string, store: ImageStore, timeoutMs: number): ToolCommand {
  // Le délai interne de Trivy est légèrement plus court que le nôtre : mieux
  // vaut un message de l'outil qu'une coupure sèche de la session SSH.
  const internal = `${Math.max(1, Math.floor(timeoutMs / 60_000) - 1)}m`;
  const options = `--format json --scanners vuln --no-progress --timeout ${internal}`;
  const cache = `TRIVY_CACHE_DIR=${cachePath('trivy')}`;

  switch (store.kind) {
    case 'docker':
      return {
        command: `${cache} ${toolPath('trivy')} image ${options} ${shellQuote(image)}`,
        sudo: false,
      };
    case 'containerd':
      return toolCommandFor(
        store,
        `${cache} ${containerdEnv(store)} ${toolPath('trivy')} image ${options} ` +
          `--image-src containerd,remote ${shellQuote(canonicalImageReference(image))}`,
        cachePath('trivy'),
      );
  }
}

/**
 * Rapport Trivy → findings normalisés.
 *
 * Exporté pour être testable sans SSH : c'est la traduction qui compte, pas le
 * transport.
 */
export function normalizeTrivyReport(raw: TrivyOutput): Finding[] {
  const findings: Finding[] = [];
  for (const result of raw.Results ?? []) {
    for (const vulnerability of result.Vulnerabilities ?? []) {
      if (!vulnerability.VulnerabilityID || !vulnerability.PkgName) continue;
      findings.push({
        cveId: vulnerability.VulnerabilityID,
        severity: normalizeSeverity(vulnerability.Severity),
        package: vulnerability.PkgName,
        installedVersion: vulnerability.InstalledVersion ?? null,
        fixedVersion: emptyToNull(vulnerability.FixedVersion),
        title: emptyToNull(vulnerability.Title) ?? emptyToNull(vulnerability.Description),
        primaryUrl: emptyToNull(vulnerability.PrimaryURL),
      });
    }
  }
  return findings;
}

/**
 * Trivy parle déjà l'échelle commune (`CRITICAL`…`UNKNOWN`), mais on ne lui
 * fait pas confiance sur parole : toute valeur inattendue devient `UNKNOWN`
 * plutôt que de traverser la frontière telle quelle.
 */
function normalizeSeverity(value: string | undefined): Severity {
  switch ((value ?? '').toUpperCase()) {
    case 'CRITICAL':
      return 'CRITICAL';
    case 'HIGH':
      return 'HIGH';
    case 'MEDIUM':
      return 'MEDIUM';
    case 'LOW':
      return 'LOW';
    default:
      return 'UNKNOWN';
  }
}

function emptyToNull(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length === 0 ? null : trimmed;
}

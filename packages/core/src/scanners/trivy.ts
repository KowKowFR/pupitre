import { SCANNERS, type Finding, type ScanReport, type Severity } from '../scan.js';
import type { SshSession } from '../ssh/client.js';
import { cachePath, ensureBinary, shellQuote, toolPath } from './install.js';
import { parseJsonOutput, runTool, SCAN_TIMEOUT_MS } from './run.js';
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
    // Le délai interne de Trivy est légèrement plus court que le nôtre : mieux
    // vaut un message de l'outil qu'une coupure sèche de la session SSH.
    const internal = `${Math.max(1, Math.floor(timeout / 60_000) - 1)}m`;

    const command =
      `TRIVY_CACHE_DIR=${cachePath('trivy')} ${toolPath('trivy')} image ` +
      `--format json --scanners vuln --no-progress --timeout ${internal} ` +
      shellQuote(ctx.image);

    onLog(`trivy image --format json --scanners vuln ${ctx.image}`);
    const run = await runTool(ctx.session, this.key, command, onLog, timeout);
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

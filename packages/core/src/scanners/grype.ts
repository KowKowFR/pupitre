import { SCANNERS, type Finding, type ScanReport, type Severity } from '../scan.js';
import type { SshSession } from '../ssh/client.js';
import { cachePath, ensureBinary, shellQuote, toolPath } from './install.js';
import { parseJsonOutput, runTool, SCAN_TIMEOUT_MS } from './run.js';
import type { ScanContext, ScanLogSink, Scanner } from './types.js';

/**
 * Grype — vulnérabilités, base Anchore.
 *
 * Version relevée sur `api.github.com/repos/anchore/grype/releases/latest`
 * le 2026-09-10.
 *
 * Tout l'intérêt de l'abstraction est ici : Grype décrit la même CVE que Trivy avec un
 * vocabulaire différent (`Negligible`, `artifact.name`, `fix.versions`). La
 * traduction vers l'échelle commune se fait dans cette classe, et nulle part
 * ailleurs. Pour une même CVE sur un même paquet, les deux scanners produisent
 * le même `Finding`.
 */
export const GRYPE_VERSION = '0.118.0';

/** `uname -m` → suffixe d'archive Grype. */
const ARCH_SUFFIX: Record<string, string> = {
  x86_64: 'amd64',
  amd64: 'amd64',
  aarch64: 'arm64',
  arm64: 'arm64',
  s390x: 's390x',
  ppc64le: 'ppc64le',
};

export type GrypeOutput = {
  matches?: Array<{
    vulnerability?: {
      id?: string;
      severity?: string;
      dataSource?: string;
      description?: string;
      urls?: string[];
      fix?: { versions?: string[]; state?: string };
    };
    relatedVulnerabilities?: Array<{ id?: string; description?: string; dataSource?: string }>;
    artifact?: { name?: string; version?: string };
  }> | null;
};

export class GrypeScanner implements Scanner {
  readonly key = 'grype' as const;
  readonly kind = SCANNERS.grype.kind;

  async ensureInstalled(session: SshSession, onLog?: ScanLogSink): Promise<string> {
    return ensureBinary(
      session,
      this.key,
      {
        binary: 'grype',
        version: GRYPE_VERSION,
        assetUrl: (arch) => {
          const suffix = ARCH_SUFFIX[arch];
          if (!suffix) return null;
          return (
            `https://github.com/anchore/grype/releases/download/v${GRYPE_VERSION}` +
            `/grype_${GRYPE_VERSION}_linux_${suffix}.tar.gz`
          );
        },
      },
      onLog,
    );
  }

  async run(ctx: ScanContext, onLog: ScanLogSink): Promise<ScanReport> {
    await this.ensureInstalled(ctx.session, onLog);

    const timeout = ctx.timeoutMs ?? SCAN_TIMEOUT_MS;
    const command =
      `GRYPE_DB_CACHE_DIR=${cachePath('grype')} GRYPE_CHECK_FOR_APP_UPDATE=false ` +
      `${toolPath('grype')} ${shellQuote(ctx.image)} -o json`;

    onLog(`grype ${ctx.image} -o json`);
    const run = await runTool(ctx.session, this.key, command, onLog, timeout);
    const raw = parseJsonOutput<GrypeOutput>(this.key, run);
    const findings = normalizeGrypeReport(raw);

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
 * Rapport Grype → findings normalisés.
 *
 * Exporté pour être testable sans SSH : un test compare le résultat de cette
 * fonction à celui de `normalizeTrivyReport` pour la même CVE.
 */
export function normalizeGrypeReport(raw: GrypeOutput): Finding[] {
  const findings: Finding[] = [];
  for (const match of raw.matches ?? []) {
    const vulnerability = match.vulnerability;
    const artifact = match.artifact;
    if (!vulnerability?.id || !artifact?.name) continue;

    const related = match.relatedVulnerabilities?.[0];

    findings.push({
      cveId: vulnerability.id,
      severity: normalizeSeverity(vulnerability.severity),
      package: artifact.name,
      installedVersion: artifact.version ?? null,
      // Grype liste toutes les versions correctives connues ; on retient la
      // première, qui est la plus proche.
      fixedVersion: emptyToNull(vulnerability.fix?.versions?.[0]),
      title: emptyToNull(vulnerability.description) ?? emptyToNull(related?.description),
      primaryUrl:
        emptyToNull(vulnerability.dataSource) ??
        emptyToNull(vulnerability.urls?.[0]) ??
        emptyToNull(related?.dataSource),
    });
  }
  return findings;
}

/**
 * Échelle Grype → échelle commune.
 *
 * `Negligible` n'a pas d'équivalent chez Trivy : on la range en `LOW`, le cran
 * le moins alarmant qui reste une vraie sévérité. La classer `UNKNOWN` la
 * ferait remonter plus haut dans un tri « inconnu = à examiner ».
 */
function normalizeSeverity(value: string | undefined): Severity {
  switch ((value ?? '').toLowerCase()) {
    case 'critical':
      return 'CRITICAL';
    case 'high':
      return 'HIGH';
    case 'medium':
      return 'MEDIUM';
    case 'low':
      return 'LOW';
    case 'negligible':
      return 'LOW';
    default:
      return 'UNKNOWN';
  }
}

function emptyToNull(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length === 0 ? null : trimmed;
}

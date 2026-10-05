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
  MACHINE_PLATFORM_FLAG,
  parseJsonOutput,
  runTool,
  SCAN_TIMEOUT_MS,
  toolCommandFor,
  type ToolCommand,
} from './run.js';
import type { ScanContext, ScanLogSink, Scanner } from './types.js';
import { scannerSay } from './messages.js';

/**
 * Grype — vulnerabilities, Anchore database.
 *
 * Version taken from `api.github.com/repos/anchore/grype/releases/latest` on
 * 2026-09-10.
 *
 * The whole point of the abstraction is here: Grype describes the same CVE as
 * Trivy with a different vocabulary (`Negligible`, `artifact.name`,
 * `fix.versions`). The translation to the common scale is done in this class,
 * and nowhere else. For the same CVE on the same package, both scanners produce
 * the same `Finding`.
 */
export const GRYPE_VERSION = '0.118.0';

/** `uname -m` → Grype archive suffix. */
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
    const { command, sudo } = grypeCommand(ctx.image, ctx.store);

    onLog(`grype ${ctx.image} -o json`);
    const run = await runTool(ctx.session, this.key, command, onLog, timeout, sudo);
    const raw = parseJsonOutput<GrypeOutput>(this.key, run);
    const findings = normalizeGrypeReport(raw);

    onLog(scannerSay(ctx.session.language)('report.vulnerabilities', { count: findings.length }));

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
 * Grype's command line for an image and the place where it is.
 *
 * Docker: the default detection, unchanged. Containerd: its `CONTAINERD_*`
 * variables, the `containerd` source then `registry`, and the machine's
 * platform (see `MACHINE_PLATFORM_FLAG`).
 */
export function grypeCommand(image: string, store: ImageStore): ToolCommand {
  const cache = `GRYPE_DB_CACHE_DIR=${cachePath('grype')} GRYPE_CHECK_FOR_APP_UPDATE=false`;
  switch (store.kind) {
    case 'docker':
      return { command: `${cache} ${toolPath('grype')} ${shellQuote(image)} -o json`, sudo: false };
    case 'containerd':
      return toolCommandFor(
        store,
        `${cache} ${containerdEnv(store)} ${toolPath('grype')} ${shellQuote(canonicalImageReference(image))} ` +
          `--from containerd --from registry ${MACHINE_PLATFORM_FLAG} -o json`,
        cachePath('grype'),
      );
  }
}
/**
 * Grype report → normalized findings.
 *
 * Exported to be testable without SSH: a test compares this function's result
 * with `normalizeTrivyReport`'s for the same CVE.
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
      // Grype lists every known fixed version; we keep the first, which is the
      // closest.
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
 * Grype scale → common scale.
 *
 * `Negligible` has no equivalent at Trivy: we file it as `LOW`, the least
 * alarming step that is still a real severity. Filing it as `UNKNOWN` would make
 * it rise higher in an "unknown = to examine" sort.
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

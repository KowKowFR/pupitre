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
import { scannerSay } from './messages.js';
import { GIB } from './space.js';

/**
 * Trivy — vulnerabilities of system and application packages.
 *
 * Version taken from `api.github.com/repos/aquasecurity/trivy/releases/latest`
 * on 2026-09-10, and not from memory. It is pinned: a scanner that changes
 * version underfoot would make two deployments incomparable.
 */
export const TRIVY_VERSION = '0.74.0';

/** `uname -m` → Trivy archive suffix. */
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
  /** Its database (1.4 GB), plus its Java database (1.4 GB) the first time it meets Java. */
  readonly diskNeed = { firstBytes: 3 * GIB, updateBytes: 1.5 * GIB };

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
 * Trivy's command line for an image and the place where it is.
 *
 * Docker: Trivy's default detection, unchanged. Containerd: its `CONTAINERD_*`
 * variables and `--image-src containerd,remote` — the image built first in the
 * declared containerd, and a public image never pulled yet from its registry.
 * The name is complete there (`docker.io/…`): Trivy finds the image under the
 * short name, then fails to export it.
 */
export function trivyCommand(image: string, store: ImageStore, timeoutMs: number): ToolCommand {
  // Trivy's internal timeout is slightly shorter than ours: better a message from
  // the tool than a hard cut of the SSH session.
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
 * Trivy report → normalized findings.
 *
 * Exported to be testable without SSH: it is the translation that matters, not
 * the transport.
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
 * Trivy already speaks the common scale (`CRITICAL`…`UNKNOWN`), but we do not
 * take its word for it: any unexpected value becomes `UNKNOWN` rather than
 * crossing the boundary as is.
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

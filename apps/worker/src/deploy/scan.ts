import {
  countBySeverity,
  EMPTY_SEVERITY_COUNTS,
  errorMessage,
  findingBlocks,
  SCANNER_KEYS,
  scannerLabel,
  summarizeFindings,
  verdictFor,
  worstSeverity,
  type Finding,
  type ImageStore,
  type ScanConfig,
  type ScannerKey,
  type ScanPolicy,
  type ScanVerdict,
  type SeverityCounts,
} from '@pupitre/core';
import type { DriverContext } from '@pupitre/core/drivers';
import {
  cachePath,
  getScanner,
  parseScanSpaceProbe,
  planScanSpace,
  ScannerError,
  scanSpaceProbeCommand,
  type ScannerDiskNeed,
} from '@pupitre/core/scanners';
import { exec } from '@pupitre/core/ssh';
import {
  activeAcceptancesForDeployment,
  clearScanRuns,
  createScanRun,
  finishScanRun,
} from '@pupitre/db';
import { logger } from '../logger.js';
import { formatBytes, workerSay } from '../messages.js';

/**
 * The pipeline's "scan" step.
 *
 * The worker knows no scanner: it reads `deployment.scan_config`, asks the
 * factory for the classes, runs them in parallel and compares the worst finding
 * with the threshold. No `if (scanner === …)` here — the divergences (how to
 * install, how to talk, how to translate a severity) are the implementation's
 * responsibilities, exactly as runtime divergences are the driver's
 * responsibilities.
 */

export type ScanRunOutcome = {
  scanner: ScannerKey;
  image: string;
  status: 'success' | 'failed';
  verdict: ScanVerdict;
  counts: SeverityCounts;
  durationMs: number;
  error: string | null;
  /** This run's findings that reach the threshold. */
  blocking: Finding[];
};

export type ScanStepResult = {
  /** `true` when at least one finding reaches the blocking threshold. */
  blocked: boolean;
  runs: ScanRunOutcome[];
  counts: SeverityCounts;
  /** Findings that reach the threshold, deduplicated by CVE. */
  blocking: Array<{ cveId: string; severity: string; package: string }>;
};

export type ScanStepInput = {
  deploymentId: string;
  ctx: DriverContext;
  config: ScanConfig;
  images: readonly string[];
  /**
   * Where the runtime keeps these images — `driver.imageStore(ctx)`. The worker
   * passes it on without reading it: it is each scanner that knows how to use it.
   */
  store: ImageStore;
  onLog: (line: string) => void;
  /**
   * Erase the deployment's previous runs before scanning again.
   *
   * True in the pipeline: a retry replays the step and must start again from a
   * clean slate, otherwise the security page would add up two reports with no way
   * to tell them apart. False for the **periodic** scan, whose whole point is
   * precisely to stack reports over time on a deployment that did not move.
   */
  clearPrevious?: boolean;
};

/**
 * Runs the selected scanners on all of the deployment's images.
 *
 * One run = one (scanner, image) pair, hence one `scan_runs` row. It is the most
 * honest model: the table carries a singular `image_ref` column since the
 * beginning, and a report aggregated over several images would make the verdict
 * impossible to attach to anything.
 */
export async function runSecurityScan(input: ScanStepInput): Promise<ScanStepResult> {
  const { deploymentId, ctx, config, images, onLog } = input;
  const say = workerSay(ctx.language);

  if (input.clearPrevious !== false) {
    // A retry replays the step: we start again from a clean slate.
    const removed = await clearScanRuns(deploymentId);
    if (removed > 0) onLog(say('scan.cleared', { count: removed }));
  }

  // Accepted vulnerabilities hold at scan time: it is the application that carries
  // them, not the frozen version.
  const acceptances = await activeAcceptancesForDeployment(deploymentId);
  const policy: ScanPolicy = {
    failOn: config.failOn,
    onlyFixable: config.onlyFixable ?? false,
    acceptances,
  };

  onLog(
    say('scan.plan', {
      scanners: config.scanners.map(scannerLabel).join(', '),
      images: images.length,
      failOn: config.failOn,
      options:
        (policy.onlyFixable ? say('scan.plan.onlyFixable') : '') +
        (acceptances.length > 0 ? say('scan.plan.accepted', { count: acceptances.length }) : ''),
    }),
  );

  // Room first: a vulnerability database weighs gigabytes, and a scan must never be
  // what fills the target's disk. A scanner that would is not run (`planScanSpace()`).
  const skipped = await makeScanRoom(input);

  // Installation first, in parallel across distinct tools: two runs of the same
  // scanner on two images would otherwise fight over the same file.
  await Promise.allSettled(
    config.scanners.filter((key) => !skipped.has(key)).map(async (key) => {
      const prefix = `[${key}]`;
      try {
        const version = await getScanner(key).ensureInstalled(ctx.sshSession, (line) =>
          onLog(`${prefix} ${line}`),
        );
        logger.info({ scanner: key, version }, 'scanner available on the target');
      } catch (error) {
        // The failure is reproduced — and recorded — at `run` time.
        onLog(say('scan.installFailed', { prefix, error: errorMessage(error) }));
      }
    }),
  );

  const tasks: ScanTask[] = [];
  for (const scanner of config.scanners) {
    for (const image of images) tasks.push({ scanner, image, skip: skipped.get(scanner) });
  }

  const settled = await Promise.allSettled(tasks.map((task) => runOne(task, input, policy)));

  const runs: ScanRunOutcome[] = [];
  for (const [index, result] of settled.entries()) {
    if (result.status === 'fulfilled') {
      runs.push(result.value);
      continue;
    }
    // `runOne` already catches its errors: a rejection here signals a database write
    // problem, not a faulty scanner. We make it visible.
    const task = tasks[index];
    const message = errorMessage(result.reason);
    onLog(say('scan.unrecorded', { scanner: task?.scanner ?? '?', error: message }));
    if (task) {
      runs.push({
        scanner: task.scanner,
        image: task.image,
        status: 'failed',
        verdict: 'unknown',
        counts: { ...EMPTY_SEVERITY_COUNTS },
        durationMs: 0,
        error: message,
        blocking: [],
      });
    }
  }

  const counts = { ...EMPTY_SEVERITY_COUNTS };
  for (const run of runs) {
    for (const severity of Object.keys(counts) as Array<keyof SeverityCounts>) {
      counts[severity] += run.counts[severity];
    }
  }

  const blocking = collectBlocking(runs);
  const blocked = runs.some((run) => run.verdict === 'fail');

  return { blocked, runs, counts, blocking };
}

/** Findings that block, deduplicated by CVE and package. */
function collectBlocking(runs: readonly ScanRunOutcome[]) {
  const seen = new Set<string>();
  const blockingFindings: Array<{ cveId: string; severity: string; package: string }> = [];

  for (const run of runs) {
    for (const finding of run.blocking) {
      const key = `${finding.cveId}|${finding.package}`;
      if (seen.has(key)) continue;
      seen.add(key);
      blockingFindings.push({
        cveId: finding.cveId,
        severity: finding.severity,
        package: finding.package,
      });
    }
  }

  return blockingFindings;
}

type ScanTask = {
  scanner: ScannerKey;
  image: string;
  /** Why the scanner is not run — recorded as its failure, readable on the security page. */
  skip?: string | undefined;
};

/**
 * Makes room for the scan, and says which scanners cannot run for lack of it.
 *
 * An unreadable probe does not stop the scan: the check protects the disk, it
 * must not become a new reason to scan nothing.
 */
async function makeScanRoom(input: ScanStepInput): Promise<Map<ScannerKey, string>> {
  const { ctx, config, onLog } = input;
  const language = ctx.language;
  const say = workerSay(language);
  const skipped = new Map<ScannerKey, string>();

  const probe = await exec(ctx.sshSession, scanSpaceProbeCommand(), { timeout: 30_000 })
    .then((result) => parseScanSpaceProbe(result.stdout))
    .catch(() => null);
  if (!probe) {
    onLog(say('scan.space.unknown'));
    return skipped;
  }

  const needs = Object.fromEntries(
    SCANNER_KEYS.map((key) => [key, getScanner(key).diskNeed]),
  ) as Record<ScannerKey, ScannerDiskNeed>;
  const plan = planScanSpace(probe, config.scanners, needs);

  let free = plan.freeBytes;
  for (const { scanner, bytes } of plan.reclaim) {
    await exec(ctx.sshSession, `rm -rf ${cachePath(scanner)}`, { timeout: 60_000 }).catch(
      () => undefined,
    );
    free += bytes;
    onLog(say('scan.space.reclaimed', { scanner, size: formatBytes(bytes, language) }));
  }
  for (const { scanner, needBytes } of plan.skipped) {
    skipped.set(
      scanner,
      say('scan.space.skipped', {
        scanner: scannerLabel(scanner),
        free: formatBytes(free, language),
        need: formatBytes(needBytes, language),
        floor: formatBytes(plan.floorBytes, language),
      }),
    );
  }
  return skipped;
}

async function runOne(
  task: ScanTask,
  input: ScanStepInput,
  policy: ScanPolicy,
): Promise<ScanRunOutcome> {
  const { deploymentId, ctx, config, store, onLog } = input;
  const say = workerSay(ctx.language);
  const prefix = `[${task.scanner}]`;
  const scanner = getScanner(task.scanner);

  const run = await createScanRun({
    deploymentId,
    scanner: task.scanner,
    failOn: config.failOn,
    onlyFixable: policy.onlyFixable,
    imageRef: task.image,
  });

  const startedAt = Date.now();

  try {
    if (task.skip) throw new ScannerError(task.skip, task.scanner, 'run');
    const report = await scanner.run(
      { session: ctx.sshSession, image: task.image, store },
      (line) => onLog(`${prefix} ${line}`),
    );

    const counts = countBySeverity(report.findings);
    const verdict = verdictFor(report.kind, report.findings, policy);
    const summary = summarizeFindings(report.findings, policy);

    await finishScanRun(run.id, {
      status: 'success',
      verdict,
      findings: report.findings,
      // For an `sbom` scanner, `raw` IS the document: it is what the download route
      // serves. See `packages/db/src/scans.ts`.
      raw: report.raw,
    });

    const worst = worstSeverity(counts);
    onLog(
      `${prefix} ` +
        (report.kind === 'sbom'
          ? say('scan.sbom')
          : say('scan.findings', { count: report.findings.length })) +
        (worst ? say('scan.worst', { severity: worst }) : '') +
        (report.kind === 'vulnerability'
          ? say('scan.vulnerabilities', {
              fixable: summary.fixable,
              accepted:
                summary.accepted > 0 ? say('scan.accepted', { count: summary.accepted }) : '',
              blocking: summary.blocking,
            })
          : '') +
        say('scan.verdict', { verdict, ms: report.durationMs }),
    );

    return {
      scanner: task.scanner,
      image: task.image,
      status: 'success',
      verdict,
      counts,
      durationMs: report.durationMs,
      error: null,
      // An SBOM never blocks: it is the `kind` that says so, not the name.
      blocking:
        report.kind === 'vulnerability'
          ? report.findings.filter((finding) => findingBlocks(finding, policy))
          : [],
    };
  } catch (error) {
    const message = errorMessage(error);
    onLog(`${prefix} ✗ ${message}`);
    logger.error({ err: error, scanner: task.scanner, image: task.image }, 'scanner failed');

    await finishScanRun(run.id, {
      status: 'failed',
      // A scanner that crashes gives no verdict: it does not block, and it does not
      // clear either. `unknown` says exactly that.
      verdict: 'unknown',
      error: message,
    });

    return {
      scanner: task.scanner,
      image: task.image,
      status: 'failed',
      verdict: 'unknown',
      counts: { ...EMPTY_SEVERITY_COUNTS },
      durationMs: Date.now() - startedAt,
      error: message,
      blocking: [],
    };
  }
}

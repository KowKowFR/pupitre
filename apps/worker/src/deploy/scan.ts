import {
  EMPTY_SEVERITY_COUNTS,
  blocks,
  countBySeverity,
  scannerLabel,
  verdictFor,
  worstSeverity,
  type Finding,
  type ScanConfig,
  type ScanVerdict,
  type ScannerKey,
  type SeverityCounts,
} from '@pupitre/core';
import type { DriverContext } from '@pupitre/core/drivers';
import { getScanner } from '@pupitre/core/scanners';
import { clearScanRuns, createScanRun, finishScanRun } from '@pupitre/db';
import { logger } from '../logger.js';

/**
 * Étape « scan » du pipeline.
 *
 * Le worker ne connaît aucun scanner : il lit `deployment.scan_config`, demande
 * les classes à la fabrique, les lance en parallèle et compare le pire finding
 * au seuil. Aucun `if (scanner === …)` ici — les divergences (comment
 * s'installer, comment parler, comment traduire une sévérité) sont des
 * responsabilités de l'implémentation, exactement comme les divergences de
 * runtime sont des responsabilités du driver.
 */

export type ScanRunOutcome = {
  scanner: ScannerKey;
  image: string;
  status: 'success' | 'failed';
  verdict: ScanVerdict;
  counts: SeverityCounts;
  durationMs: number;
  error: string | null;
  /** Findings de cette exécution qui atteignent le seuil. */
  blocking: Finding[];
};

export type ScanStepResult = {
  /** `true` quand au moins un finding atteint le seuil de blocage. */
  blocked: boolean;
  runs: ScanRunOutcome[];
  counts: SeverityCounts;
  /** Findings qui atteignent le seuil, dédoublonnés par CVE. */
  blocking: Array<{ cveId: string; severity: string; package: string }>;
};

export type ScanStepInput = {
  deploymentId: string;
  ctx: DriverContext;
  config: ScanConfig;
  images: readonly string[];
  onLog: (line: string) => void;
  /**
   * Effacer les exécutions précédentes du déploiement avant de rescanner.
   *
   * Vrai dans le pipeline : une relance rejoue l'étape et doit repartir d'une
   * ardoise propre, sinon la page de sécurité cumulerait deux rapports sans
   * moyen de les distinguer. Faux pour le scan **périodique**, dont
   * tout l'intérêt est justement d'empiler les rapports dans le temps sur un
   * déploiement qui, lui, n'a pas bougé.
   */
  clearPrevious?: boolean;
};

/**
 * Exécute les scanners sélectionnés sur toutes les images du déploiement.
 *
 * Une exécution = un couple (scanner, image), et donc une ligne `scan_runs`.
 * C'est le modèle le plus honnête : la table porte une colonne `image_ref` au
 * singulier depuis l'origine, et un rapport agrégé sur plusieurs images
 * rendrait le verdict impossible à rattacher à quoi que ce soit.
 */
export async function runSecurityScan(input: ScanStepInput): Promise<ScanStepResult> {
  const { deploymentId, ctx, config, images, onLog } = input;

  if (input.clearPrevious !== false) {
    // Une relance rejoue l'étape : on repart d'une ardoise propre.
    const removed = await clearScanRuns(deploymentId);
    if (removed > 0) onLog(`${removed} exécution(s) précédente(s) écartée(s)`);
  }

  onLog(
    `${config.scanners.map(scannerLabel).join(', ')} sur ${images.length} image(s) — ` +
      `seuil de blocage : ${config.failOn}`,
  );

  // Installation d'abord, en parallèle entre outils distincts : deux exécutions
  // du même scanner sur deux images se disputeraient sinon le même fichier.
  await Promise.allSettled(
    config.scanners.map(async (key) => {
      const prefix = `[${key}]`;
      try {
        const version = await getScanner(key).ensureInstalled(ctx.sshSession, (line) =>
          onLog(`${prefix} ${line}`),
        );
        logger.info({ scanner: key, version }, 'scanner disponible sur la cible');
      } catch (error) {
        // L'échec est reproduit — et enregistré — au moment du `run`.
        onLog(`${prefix} installation impossible : ${messageOf(error)}`);
      }
    }),
  );

  const tasks: Array<{ scanner: ScannerKey; image: string }> = [];
  for (const scanner of config.scanners) {
    for (const image of images) tasks.push({ scanner, image });
  }

  const settled = await Promise.allSettled(
    tasks.map((task) => runOne(task, input)),
  );

  const runs: ScanRunOutcome[] = [];
  for (const [index, result] of settled.entries()) {
    if (result.status === 'fulfilled') {
      runs.push(result.value);
      continue;
    }
    // `runOne` capture déjà ses erreurs : un rejet ici signale un problème
    // d'écriture en base, pas un scanner en défaut. On le rend visible.
    const task = tasks[index];
    const message = messageOf(result.reason);
    onLog(`[${task?.scanner ?? '?'}] exécution non enregistrée : ${message}`);
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

/** Findings qui bloquent, dédoublonnés par CVE et paquet. */
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

async function runOne(
  task: { scanner: ScannerKey; image: string },
  input: ScanStepInput,
): Promise<ScanRunOutcome> {
  const { deploymentId, ctx, config, onLog } = input;
  const prefix = `[${task.scanner}]`;
  const scanner = getScanner(task.scanner);

  const run = await createScanRun({
    deploymentId,
    scanner: task.scanner,
    failOn: config.failOn,
    imageRef: task.image,
  });

  const startedAt = Date.now();

  try {
    const report = await scanner.run(
      { session: ctx.sshSession, image: task.image },
      (line) => onLog(`${prefix} ${line}`),
    );

    const counts = countBySeverity(report.findings);
    const verdict = verdictFor(report.kind, report.findings, config.failOn);

    await finishScanRun(run.id, {
      status: 'success',
      verdict,
      findings: report.findings,
      // Pour un scanner `sbom`, `raw` EST le document : c'est ce que sert la
      // route de téléchargement. Voir `packages/db/src/scans.ts`.
      raw: report.raw,
    });

    const worst = worstSeverity(counts);
    onLog(
      `${prefix} ${report.kind === 'sbom' ? 'SBOM produit' : `${report.findings.length} finding(s)`}` +
        `${worst ? ` — pire sévérité : ${worst}` : ''} — verdict ${verdict} (${report.durationMs} ms)`,
    );

    return {
      scanner: task.scanner,
      image: task.image,
      status: 'success',
      verdict,
      counts,
      durationMs: report.durationMs,
      error: null,
      // Un SBOM ne bloque jamais : c'est le `kind` qui le dit, pas le nom.
      blocking:
        report.kind === 'vulnerability'
          ? report.findings.filter((finding) => blocks(finding.severity, config.failOn))
          : [],
    };
  } catch (error) {
    const message = messageOf(error);
    onLog(`${prefix} ✗ ${message}`);
    logger.error({ err: error, scanner: task.scanner, image: task.image }, 'scanner en échec');

    await finishScanRun(run.id, {
      status: 'failed',
      // Un scanner qui plante ne prononce aucun verdict : il ne bloque pas, et
      // il ne dédouane pas non plus. `unknown` dit exactement cela.
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

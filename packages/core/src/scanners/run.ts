import type { ScannerKey } from '../scan.js';
import { execStream } from '../ssh/client.js';
import type { SshSession } from '../ssh/client.js';
import { firstLine } from '../shell.js';
import { ScannerError, type ScanLogSink } from './types.js';

/**
 * Exécution d'un outil qui écrit un document JSON sur `stdout` et sa
 * progression sur `stderr`.
 *
 * Les trois scanners fonctionnent ainsi. On diffuse `stderr` ligne par ligne —
 * c'est ce que l'utilisateur voit défiler dans le flux SSE — et on garde
 * `stdout` intact pour l'analyser à la fin. Mélanger les deux flux rendrait le
 * JSON illisible.
 */

/** Un scanner n'a pas le droit de bloquer le pipeline indéfiniment. */
export const SCAN_TIMEOUT_MS = 10 * 60_000;

export type ToolRun = {
  /** Sortie brute, non analysée. */
  stdout: string;
  code: number;
  durationMs: number;
};

export async function runTool(
  session: SshSession,
  scanner: ScannerKey,
  command: string,
  onLog: ScanLogSink,
  timeoutMs: number = SCAN_TIMEOUT_MS,
): Promise<ToolRun> {
  const result = await execStream(
    session,
    command,
    (line, stream) => {
      // `stdout` porte le rapport : on ne le journalise pas, il ferait des
      // milliers de lignes illisibles dans le flux de déploiement.
      if (stream === 'stderr' && line.trim().length > 0) onLog(line);
    },
    { timeout: timeoutMs, logOutput: false },
  );

  if (result.timedOut) {
    throw new ScannerError(
      `délai dépassé après ${Math.round(timeoutMs / 1000)} s`,
      scanner,
      'run',
    );
  }

  return { stdout: result.stdout, code: result.code, durationMs: result.durationMs };
}

/**
 * Analyse la sortie JSON d'un outil.
 *
 * Un code de retour non nul n'est pas toujours un échec — certains scanners
 * sortent en erreur quand ils *trouvent* quelque chose. Le critère est donc la
 * présence d'un document exploitable, pas le code de retour.
 */
export function parseJsonOutput<T>(
  scanner: ScannerKey,
  run: ToolRun,
  stderrHint: string | null = null,
): T {
  const trimmed = run.stdout.trim();
  if (trimmed.length === 0) {
    throw new ScannerError(
      `aucune sortie (code ${run.code})${stderrHint ? ` : ${firstLine(stderrHint) ?? ''}` : ''}`,
      scanner,
      'run',
    );
  }

  try {
    return JSON.parse(trimmed) as T;
  } catch (error) {
    throw new ScannerError(
      `sortie JSON illisible (code ${run.code}) : ${trimmed.slice(0, 200)}`,
      scanner,
      'parse',
      error,
    );
  }
}

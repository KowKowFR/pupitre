import { execStream } from '../ssh/client.js';
import type { SshSession } from '../ssh/client.js';
import type { LogSink } from './types.js';

/**
 * Une commande dans une charge, partagée par les deux drivers : seule la
 * ligne de commande change (`docker exec` d'un côté, `kubectl exec` de
 * l'autre). Le reste — la borne de sortie, le délai, le code de retour —
 * doit se comporter pareil, sinon la même console dirait deux choses.
 */

export type WorkloadExecOptions = {
  timeoutMs: number;
  /** Au-delà, les lignes ne sont plus transmises : une commande bavarde ne noie pas l'écran. */
  maxLines: number;
};

export type WorkloadExecResult = {
  exitCode: number;
  truncated: boolean;
  timedOut: boolean;
};

/**
 * Échappement POSIX en quotes simples. La commande de l'opérateur traverse
 * **deux** shells : celui de la machine (SSH), puis `sh -c` dans la charge.
 * Citée ici, elle reste une seule chaîne pour le premier, et ne s'exécute
 * donc que dans le second — jamais sur l'hôte.
 */
export function quoteForShell(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export async function runBoundedExec(
  session: SshSession,
  command: string,
  onLine: LogSink,
  options: WorkloadExecOptions,
): Promise<WorkloadExecResult> {
  let lines = 0;
  let truncated = false;
  const result = await execStream(
    session,
    command,
    (line) => {
      lines += 1;
      if (lines <= options.maxLines) onLine(line);
      else truncated = true;
    },
    // La sortie d'une commande peut porter n'importe quoi, secrets compris :
    // elle ne va que vers l'écran qui l'a demandée, jamais dans un journal.
    { timeout: options.timeoutMs, logOutput: false },
  );
  return { exitCode: result.code, truncated, timedOut: result.timedOut };
}

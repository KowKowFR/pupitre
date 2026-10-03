import type { ImageStore, ScannerKey } from '../scan.js';
import { execStream } from '../ssh/client.js';
import type { SshSession } from '../ssh/client.js';
import { firstLine, shellQuote } from '../shell.js';
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

/**
 * Une commande d'outil prête à partir : la ligne de shell, et s'il faut
 * l'élever. Construite par des fonctions pures, testables sans SSH.
 */
export type ToolCommand = { command: string; sudo: boolean };

/** Les variables qui pointent un outil vers un containerd qui n'est pas celui par défaut. */
export function containerdEnv(store: Extract<ImageStore, { kind: 'containerd' }>): string {
  return (
    `CONTAINERD_ADDRESS=${shellQuote(store.address)} ` +
    `CONTAINERD_NAMESPACE=${shellQuote(store.namespace)}`
  );
}

/**
 * `--platform linux/<arch>` pour Grype et Syft, d'après `uname -m`.
 *
 * Sans elle, ils exportent l'index multi-plateforme de l'image depuis
 * containerd — qui n'en garde que les couches de la machine — et échouent sur
 * un « content digest … not found ». Trivy, lui, choisit seul.
 *
 * Les motifs du `case` portent leur parenthèse ouvrante (forme POSIX) : sans
 * elle, certains shells prennent le `)` d'un motif pour la fin du `$(…)`.
 */
export const MACHINE_PLATFORM_FLAG =
  '--platform "linux/$(case "$(uname -m)" in ' +
  '(x86_64|amd64) echo amd64 ;; (aarch64|arm64) echo arm64 ;; (armv7l) echo arm/v7 ;; ' +
  '(*) uname -m ;; esac)"';

/**
 * Enrobe une commande d'outil pour qu'elle tourne sous `sudo` **sans quitter
 * le répertoire des outils de l'utilisateur**.
 *
 * Sous `sudo`, `$HOME` devient celui de root : le binaire installé dans
 * `"$HOME"/.bootstrap-tp` ne serait plus trouvé, et sa base de vulnérabilités
 * (plusieurs centaines de Mo) serait retéléchargée ailleurs. On rétablit donc
 * le `HOME` de l'utilisateur d'origine (`SUDO_USER`), et on lui rend le cache
 * à la fin : sans cela, une base mise à jour par root deviendrait illisible à
 * un passage sans élévation. Le répertoire parent aussi — le premier passage
 * élevé le crée, en root et en 0700 — mais sans récursion : il porte les
 * caches des autres outils, qui sont déjà à l'utilisateur. Le code de sortie
 * de l'outil est préservé.
 *
 * Sans `SUDO_USER` (connexion directe en root), rien ne change.
 */
export function asToolOwner(command: string, cacheDir: string): string {
  return [
    'if [ -n "${SUDO_USER:-}" ]; then',
    '  owner_home="$(getent passwd "$SUDO_USER" 2>/dev/null | cut -d: -f6)"',
    '  [ -n "$owner_home" ] || owner_home="$(eval echo "~$SUDO_USER")"',
    '  HOME="$owner_home"; export HOME',
    'fi',
    command,
    'status=$?',
    'if [ -n "${SUDO_UID:-}" ]; then',
    `  chown -R "$SUDO_UID:$SUDO_GID" ${cacheDir} 2>/dev/null`,
    `  chown "$SUDO_UID:$SUDO_GID" "$(dirname ${cacheDir})" 2>/dev/null`,
    'fi',
    'exit $status',
  ].join('\n');
}

/** La commande telle quelle, ou élevée quand le stockage d'images l'exige. */
export function toolCommandFor(store: ImageStore, command: string, cacheDir: string): ToolCommand {
  return store.kind === 'containerd' && store.elevated
    ? { command: asToolOwner(command, cacheDir), sudo: true }
    : { command, sudo: false };
}

export async function runTool(
  session: SshSession,
  scanner: ScannerKey,
  command: string,
  onLog: ScanLogSink,
  timeoutMs: number = SCAN_TIMEOUT_MS,
  sudo = false,
): Promise<ToolRun> {
  const result = await execStream(
    session,
    command,
    (line, stream) => {
      // `stdout` porte le rapport : on ne le journalise pas, il ferait des
      // milliers de lignes illisibles dans le flux de déploiement.
      if (stream === 'stderr' && line.trim().length > 0) onLog(line);
    },
    { timeout: timeoutMs, logOutput: false, sudo },
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

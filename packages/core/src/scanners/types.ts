import type { ScanKind, ScanReport, ScannerKey } from '../scan.js';
import type { SshSession } from '../ssh/client.js';

/**
 * Contrat que doit remplir un outil pour être exécutable par le panel.
 *
 * Même règle structurante que pour les drivers : un scanner **n'importe rien**
 * de `packages/db`, ni de `apps/web`, ni de Redis. Il reçoit une session SSH et
 * une référence d'image, il exécute sur la machine cible, et il émet des lignes.
 * C'est l'appelant qui décide de les publier sur Redis ou de les jeter.
 *
 * Ajouter un scanner doit se faire en ajoutant une classe et une entrée dans la
 * fabrique, sans modifier le worker ni les routes.
 */

/** Le scanner émet des lignes, il ne sait pas où elles vont. */
export type ScanLogSink = (line: string) => void;

export type ScanContext = {
  session: SshSession;
  /** Référence de l'image à analyser, telle que le runtime la nomme. */
  image: string;
  /** Millisecondes. Défaut : `SCAN_TIMEOUT_MS`. */
  timeoutMs?: number;
};

export interface Scanner {
  readonly key: ScannerKey;
  readonly kind: ScanKind;

  /**
   * Garantit la présence de l'outil sur la cible, à la version attendue.
   * Idempotent et bon marché : un binaire déjà à la bonne version n'est pas
   * réinstallé.
   */
  ensureInstalled(session: SshSession, onLog?: ScanLogSink): Promise<string>;

  /** Analyse l'image et retourne un rapport normalisé. */
  run(ctx: ScanContext, onLog: ScanLogSink): Promise<ScanReport>;
}

/** Échec imputable à un scanner, avec le contexte utile au diagnostic. */
export class ScannerError extends Error {
  constructor(
    message: string,
    readonly scanner: ScannerKey,
    readonly phase: 'install' | 'run' | 'parse',
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ScannerError';
  }
}

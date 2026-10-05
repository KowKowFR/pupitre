import type { ImageStore, ScanKind, ScanReport, ScannerKey } from '../scan.js';
import type { SshSession } from '../ssh/client.js';
import type { ScannerDiskNeed } from './space.js';

/**
 * The contract a tool must fulfill to be runnable by the panel.
 *
 * The same structuring rule as for drivers: a scanner **imports nothing** from
 * `packages/db`, nor `apps/web`, nor Redis. It receives an SSH session and an
 * image reference, it runs on the target machine, and it emits lines. It is the
 * caller that decides to publish them on Redis or to discard them.
 *
 * Adding a scanner must be done by adding a class and an entry in the factory,
 * without changing the worker or the routes.
 */

/** The scanner emits lines, it does not know where they go. */
export type ScanLogSink = (line: string) => void;

export type ScanContext = {
  session: SshSession;
  /** Reference of the image to analyze, as the runtime names it. */
  image: string;
  /** Where the runtime keeps this image — declared by the driver. */
  store: ImageStore;
  /** Milliseconds. Default: `SCAN_TIMEOUT_MS`. */
  timeoutMs?: number;
};

export interface Scanner {
  readonly key: ScannerKey;
  readonly kind: ScanKind;
  /**
   * What the tool may download into its cache on the target, at worst — its
   * vulnerability database. The worker checks the target keeps room for it
   * before scanning (`planScanSpace()`).
   */
  readonly diskNeed: ScannerDiskNeed;

  /**
   * Guarantees the tool is present on the target, at the expected version.
   * Idempotent and cheap: a binary already at the right version is not
   * reinstalled.
   */
  ensureInstalled(session: SshSession, onLog?: ScanLogSink): Promise<string>;

  /** Analyzes the image and returns a normalized report. */
  run(ctx: ScanContext, onLog: ScanLogSink): Promise<ScanReport>;
}

/** A failure attributable to a scanner, with the context useful for diagnosis. */
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

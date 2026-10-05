import type { ImageStore, ScannerKey } from '../scan.js';
import { execStream } from '../ssh/client.js';
import type { SshSession } from '../ssh/client.js';
import { firstLine, shellQuote } from '../shell.js';
import { ScannerError, type ScanLogSink } from './types.js';
import type { UiLanguage } from '../i18n.js';
import { scannerSay } from './messages.js';

/**
 * Running a tool that writes a JSON document on `stdout` and its progress on
 * `stderr`.
 *
 * The three scanners work that way. We stream `stderr` line by line — it is what
 * the user sees scrolling in the SSE stream — and keep `stdout` intact to parse
 * it at the end. Mixing both streams would make the JSON unreadable.
 */

/** A scanner may not block the pipeline indefinitely. */
export const SCAN_TIMEOUT_MS = 10 * 60_000;

export type ToolRun = {
  /** Raw output, not parsed. */
  stdout: string;
  code: number;
  durationMs: number;
  /** The session's language: that of a parsing failure. */
  language: UiLanguage;
};

/**
 * A tool command ready to go: the shell line, and whether it must be elevated.
 * Built by pure functions, testable without SSH.
 */
export type ToolCommand = { command: string; sudo: boolean };

/** The variables that point a tool at a containerd that is not the default one. */
export function containerdEnv(store: Extract<ImageStore, { kind: 'containerd' }>): string {
  return (
    `CONTAINERD_ADDRESS=${shellQuote(store.address)} ` +
    `CONTAINERD_NAMESPACE=${shellQuote(store.namespace)}`
  );
}

/**
 * `--platform linux/<arch>` for Grype and Syft, from `uname -m`.
 *
 * Without it, they export the image's multi-platform index from containerd —
 * which only keeps the machine's layers — and fail on a "content digest … not
 * found". Trivy chooses by itself.
 *
 * The `case` patterns carry their opening parenthesis (POSIX form): without it,
 * some shells take a pattern's `)` for the end of the `$(…)`.
 */
export const MACHINE_PLATFORM_FLAG =
  '--platform "linux/$(case "$(uname -m)" in ' +
  '(x86_64|amd64) echo amd64 ;; (aarch64|arm64) echo arm64 ;; (armv7l) echo arm/v7 ;; ' +
  '(*) uname -m ;; esac)"';

/**
 * Wraps a tool command so that it runs under `sudo` **without leaving the
 * user's tools directory**.
 *
 * Under `sudo`, `$HOME` becomes root's: the binary installed in
 * `"$HOME"/.bootstrap-tp` would no longer be found, and its vulnerability
 * database (several hundred MB) would be downloaded again elsewhere. We
 * therefore restore the original user's `HOME` (`SUDO_USER`), and give them back
 * the cache at the end: without that, a database updated by root would become
 * unreadable on a pass without elevation. The parent directory too — the first
 * elevated pass creates it, as root and 0700 — but without recursion: it carries
 * the other tools' caches, which already belong to the user. The tool's exit
 * code is preserved.
 *
 * Without `SUDO_USER` (direct root connection), nothing changes.
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

/** The command as is, or elevated when the image storage requires it. */
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
      // `stdout` carries the report: we do not log it, it would make thousands of
      // unreadable lines in the deployment stream.
      if (stream === 'stderr' && line.trim().length > 0) onLog(line);
    },
    { timeout: timeoutMs, logOutput: false, sudo },
  );

  if (result.timedOut) {
    throw new ScannerError(
      scannerSay(session.language)('run.timeout', { seconds: Math.round(timeoutMs / 1000) }),
      scanner,
      'run',
    );
  }

  return {
    stdout: result.stdout,
    code: result.code,
    durationMs: result.durationMs,
    language: session.language,
  };
}

/**
 * Parses a tool's JSON output.
 *
 * A non-zero exit code is not always a failure — some scanners exit with an
 * error when they *find* something. The criterion is therefore the presence of
 * a usable document, not the exit code.
 */
export function parseJsonOutput<T>(
  scanner: ScannerKey,
  run: ToolRun,
  stderrHint: string | null = null,
): T {
  const say = scannerSay(run.language);
  const trimmed = run.stdout.trim();
  if (trimmed.length === 0) {
    throw new ScannerError(
      say('run.noOutput', {
        code: run.code,
        hint: stderrHint ? ` : ${firstLine(stderrHint) ?? ''}` : '',
      }),
      scanner,
      'run',
    );
  }

  try {
    return JSON.parse(trimmed) as T;
  } catch (error) {
    throw new ScannerError(
      say('run.unreadable', { code: run.code, excerpt: trimmed.slice(0, 200) }),
      scanner,
      'parse',
      error,
    );
  }
}

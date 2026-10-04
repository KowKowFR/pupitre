import type { ScannerKey } from '../scan.js';
import { exec } from '../ssh/client.js';
import type { SshSession } from '../ssh/client.js';
import { ScannerError, type ScanLogSink } from './types.js';
import { firstLine, shellQuote } from '../shell.js';
import { scannerSay } from './messages.js';

/**
 * Installing the tools on the target machine.
 *
 * The three scanners are static Go binaries distributed as `tar.gz` on GitHub
 * releases: the mechanics are the same for all, only the archive's name and the
 * translation of `uname -m` change. It is therefore written here, once, and each
 * implementation only provides what is specific to it.
 *
 * Nothing is installed by the package manager: the target is not necessarily
 * Debian, and repositories distribute arbitrarily old versions — an outdated
 * security scanner is worse than no scanner.
 */

/** The scanners' working root on the target. */
/**
 * Where the scan binaries are placed on the target machine.
 *
 * **This path does not follow the renaming, on purpose.** It is a cache already
 * filled on each target: Trivy, Grype and Syft are installed there, with their
 * vulnerability databases. Moving it would help nobody — the directory appears
 * nowhere in the interface — and would cost a complete download again on every
 * target at the next scan, plus an orphan directory left behind.
 */
export const TOOL_HOME = '"$HOME"/.bootstrap-tp';
export const TOOL_BIN = `${TOOL_HOME}/bin`;

const INSTALL_TIMEOUT_MS = 5 * 60_000;
const VERSION_TIMEOUT_MS = 60_000;

export type ReleaseAsset = {
  /** Name of the binary once installed, e.g. `trivy`. */
  binary: string;
  /** Pinned version, without the leading `v`. */
  version: string;
  /**
   * The archive's URL for an architecture as `uname -m` reports it. `null` when
   * the tool publishes nothing for that architecture.
   */
  assetUrl: (arch: string) => string | null;
};

export function toolPath(binary: string): string {
  return `${TOOL_BIN}/${binary}`;
}

/** Path of the caches, isolated per tool. */
export function cachePath(binary: string): string {
  return `${TOOL_HOME}/cache/${binary}`;
}

/**
 * Installs the tool if it is missing or outdated, then returns its version.
 *
 * Detection goes through `--version`: it is the tool itself that answers, not a
 * marker file a misplaced `rm` would make lie.
 */
export async function ensureBinary(
  session: SshSession,
  scanner: ScannerKey,
  asset: ReleaseAsset,
  onLog?: ScanLogSink,
): Promise<string> {
  const say = scannerSay(session.language);
  const installed = await readVersion(session, asset.binary);
  if (installed !== null && installed.includes(asset.version)) {
    onLog?.(say('install.present', { binary: asset.binary, version: asset.version }));
    return asset.version;
  }

  const uname = await exec(session, 'uname -m', { timeout: VERSION_TIMEOUT_MS });
  const arch = uname.stdout.trim();
  if (uname.code !== 0 || arch.length === 0) {
    throw new ScannerError(say('install.noArch'), scanner, 'install');
  }

  const url = asset.assetUrl(arch);
  if (url === null) {
    throw new ScannerError(
      say('install.noBinary', { binary: asset.binary, arch }),
      scanner,
      'install',
    );
  }

  onLog?.(
    say(installed === null ? 'install.installing' : 'install.updating', {
      binary: asset.binary,
      version: asset.version,
      arch,
    }),
  );

  const script = [
    'set -e',
    `mkdir -p ${TOOL_BIN}`,
    'tmp="$(mktemp -d)"',
    `trap 'rm -rf "$tmp"' EXIT`,
    `curl -fsSL --retry 3 --connect-timeout 20 -o "$tmp"/asset.tar.gz ${shellQuote(url)}`,
    `tar -xzf "$tmp"/asset.tar.gz -C "$tmp" ${shellQuote(asset.binary)}`,
    `chmod 0755 "$tmp"/${asset.binary}`,
    `mv -f "$tmp"/${asset.binary} ${toolPath(asset.binary)}`,
  ].join('\n');

  const result = await exec(session, script, { timeout: INSTALL_TIMEOUT_MS });
  if (result.code !== 0) {
    throw new ScannerError(
      say('install.failed', {
        binary: asset.binary,
        detail: firstLine(result.stderr) ?? `code ${result.code}`,
      }),
      scanner,
      'install',
    );
  }

  const confirmed = await readVersion(session, asset.binary);
  if (confirmed === null) {
    throw new ScannerError(
      say('install.unreachable', { binary: asset.binary }),
      scanner,
      'install',
    );
  }

  onLog?.(say('install.done', { binary: asset.binary, version: confirmed }));
  return confirmed;
}

/** Version reported by the tool, or `null` if it is not installed. */
async function readVersion(session: SshSession, binary: string): Promise<string | null> {
  const result = await exec(session, `${toolPath(binary)} --version 2>&1 || true`, {
    timeout: VERSION_TIMEOUT_MS,
    logOutput: false,
  });
  const text = `${result.stdout}\n${result.stderr}`.trim();
  if (text.length === 0) return null;
  if (/not found|No such file|Permission denied/i.test(text)) return null;
  return text.split('\n')[0]?.trim() ?? null;
}

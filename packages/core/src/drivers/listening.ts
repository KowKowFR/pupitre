import { exec } from '../ssh/client.js';
import type { TargetContext } from './types.js';

/**
 * Ports already listening on the target.
 *
 * The unique `(target_id, port)` constraint prevents **two panel applications**
 * from stepping on each other. It says nothing about a service installed by hand
 * on the machine: a Postgres on 30001 never asked the panel for permission. This
 * probe is the complement — the database decides between our reservations, the
 * target decides on what it already hosts.
 *
 * `ss` is the reference tool, but it comes from `iproute2`, absent from minimal
 * images (Alpine, for example, only has BusyBox's `netstat`). We try both, in
 * that order, and consider the probe unavailable rather than wrongly conclude
 * "no port taken".
 */

const PROBE_TIMEOUT_MS = 30_000;

/**
 * TCP ports listening, or `null` if the target offers no tool to say so.
 *
 * `null` and "empty set" do not mean the same thing: the first means "I could
 * not look", the second "I looked, there is nothing". Confusing the two would
 * silence the check.
 */
export async function listeningPorts(ctx: TargetContext): Promise<Set<number> | null> {
  // `ss -tlnH`: TCP, listening, numeric, without header.
  // `-p` (process) requires root and is only informative: we do not ask for it,
  // so that the probe also works without elevation.
  const ss = await exec(ctx.sshSession, 'ss -tlnH 2>/dev/null', { timeout: PROBE_TIMEOUT_MS });
  if (ss.code === 0 && ss.stdout.trim().length > 0) {
    return parseListeningPorts(ss.stdout);
  }

  const netstat = await exec(ctx.sshSession, 'netstat -tln 2>/dev/null', {
    timeout: PROBE_TIMEOUT_MS,
  });
  if (netstat.code === 0 && netstat.stdout.trim().length > 0) {
    return parseListeningPorts(netstat.stdout);
  }

  return null;
}

/**
 * Extracts the ports from the "local address" column.
 *
 * Both tools put it at the same rank, and write the address in various forms:
 * `0.0.0.0:30001`, `[::]:30001`, `*:30001`. The port is always what follows the
 * last `:`.
 */
export function parseListeningPorts(output: string, column = 3): Set<number> {
  const ports = new Set<number>();

  for (const line of output.split('\n')) {
    const columns = line.trim().split(/\s+/);
    // `netstat` keeps a header line; it contains no `:` followed by digits, so it
    // drops by itself.
    const address = columns[column] ?? columns[columns.length - 2];
    if (!address) continue;

    const separator = address.lastIndexOf(':');
    if (separator === -1) continue;

    const port = Number.parseInt(address.slice(separator + 1), 10);
    if (!Number.isNaN(port) && port > 0 && port <= 65_535) ports.add(port);
  }

  return ports;
}

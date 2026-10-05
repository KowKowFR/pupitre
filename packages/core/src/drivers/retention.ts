import { exec } from '../ssh/client.js';
import type { DriverContext, LogSink } from './types.js';
import { shellQuote } from '../shell.js';
import { driverSay } from './messages.js';

/**
 * Retention of version directories on the target.
 *
 * Each deployment places a release in `{appPath}/{version}`. Without cleanup, a
 * target ends up carrying the whole history — and a rollback only needs the one
 * before last.
 *
 * Cleanup is done **at the next deployment**, not at destroy: it is the only
 * moment when we know which release just became the current one.
 *
 * The code lives here because both drivers have exactly the same problem and the
 * same tree. It is not a runtime divergence: it is file cleanup, and a third
 * driver would reuse it as is.
 */

export const RELEASES_KEPT = 5;

const PRUNE_TIMEOUT_MS = 60_000;

/**
 * Deletes the oldest version directories, keeping the `keep` most recent and
 * **always** the one `current` points to.
 *
 * Sorting is done on the modification date (`ls -1dt`) and not on the name: a
 * semantic version does not sort lexicographically (`1.10.0` < `1.9.0`), and it
 * is the deployment order that matters here, not the version order.
 */
export async function pruneReleases(
  ctx: DriverContext,
  appPath: string,
  onLog: LogSink,
  keep: number = RELEASES_KEPT,
): Promise<string[]> {
  const script = [
    `cd ${shellQuote(appPath)} 2>/dev/null || exit 0`,
    // Resolving the `current` link: the active release must never go, even if its
    // directory is old — that is exactly the case after a rollback.
    'CUR=""',
    'if [ -L current ]; then CUR=$(basename "$(readlink -f current)"); fi',
    // `ls -1dt */` lists the directories from newest to oldest.
    //
    // The `sed` and `grep` scripts are in SINGLE quotes, and it is not a matter of
    // style: between double quotes, the shell would see `$#` in `s#/$##` and
    // substitute the number of positional arguments. `sed` would then receive
    // `s#/0#`, complain about an unmatched delimiter, and cleanup would never
    // delete anything again — silently.
    "ls -1dt */ 2>/dev/null | sed 's#/$##' | grep -v '^current$' | {",
    '  KEPT=0',
    '  while IFS= read -r dir; do',
    '    [ -z "$dir" ] && continue',
    '    if [ "$dir" = "$CUR" ]; then KEPT=$((KEPT+1)); continue; fi',
    `    if [ "$KEPT" -lt ${keep} ]; then KEPT=$((KEPT+1)); continue; fi`,
    '    rm -rf -- "$dir" && echo "$dir"',
    '  done',
    '}',
  ].join('\n');

  const result = await exec(ctx.sshSession, script, { timeout: PRUNE_TIMEOUT_MS });
  const removed = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (removed.length > 0) {
    onLog(
      driverSay(ctx.language)('retention.removed', {
        count: removed.length,
        releases: removed.join(', '),
      }),
    );
  }
  return removed;
}

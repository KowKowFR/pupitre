import { exec } from '../ssh/client.js';
import type { DriverContext, LogSink, TargetContext } from './types.js';
import { firstLine, shellQuote } from '../shell.js';
import { driverSay } from './messages.js';

/**
 * UFW firewall on the target machine.
 *
 * Two principles:
 *
 * 1. **We never force enabling it.** A panel that enables the firewall of a
 *    machine it does not know can cut the SSH session that drives it. UFW
 *    inactive → warning, and we go on: the port published by Docker is
 *    reachable anyway, it is the firewall that filters nothing.
 *
 * 2. **The rule is identified by its comment, not by its number.**
 *    `ufw status numbered` renumbers at each deletion: a rule deleted by index
 *    deletes its neighbor as soon as another one left in the meantime. The
 *    `pupitre:{slug}` comment is stable, and it also tells the machine's
 *    administrator who opened this port and what for.
 */

const UFW_TIMEOUT_MS = 30_000;

/** Marker set on each rule created by the panel. */
export function ufwComment(appSlug: string): string {
  return `${UFW_MARKER}:${appSlug}`;
}

/**
 * The prefix of the rules the panel claims, and the one from before the
 * renaming.
 *
 * These comments are **written in the target machine's firewall**, not on our
 * side. A rule opened yesterday carries `bootstrap-tp:`, and if the panel
 * stopped recognizing it, it would also stop closing it: the port would stay
 * open after the application is destroyed, with nothing to report it. A
 * renaming must not leave an open door behind it.
 *
 * We therefore write the new one and read both, `UFW_MARKERS` being the list
 * the cleanup and the preflight consult.
 */
export const UFW_MARKER = 'pupitre';
export const LEGACY_UFW_MARKER = 'bootstrap-tp';
export const UFW_MARKERS = [UFW_MARKER, LEGACY_UFW_MARKER] as const;

/** Does the `ufw status` line belong to the panel, all generations included? */
export function isManagedUfwRule(line: string): boolean {
  return UFW_MARKERS.some((marker) => line.includes(`${marker}:`));
}

export type UfwState = 'active' | 'inactive' | 'absent';

/**
 * Firewall state.
 *
 * `ufw status` requires root: we go through sudo, and fall back on `absent` when
 * the binary is not there — which is the case of many minimal images.
 */
export async function ufwState(ctx: TargetContext): Promise<UfwState> {
  const present = await exec(ctx.sshSession, 'command -v ufw >/dev/null 2>&1', {
    timeout: UFW_TIMEOUT_MS,
  });
  if (present.code !== 0) return 'absent';

  const status = await exec(ctx.sshSession, 'ufw status 2>/dev/null || true', {
    sudo: true,
    timeout: UFW_TIMEOUT_MS,
  });
  return /Status:\s*active/i.test(status.stdout) ? 'active' : 'inactive';
}

/**
 * Opens `port/tcp` with the application's comment.
 *
 * `ufw allow` is idempotent: replaying the same rule produces "Skipping adding
 * existing rule". We therefore do not test before adding.
 */
export async function ufwAllow(
  ctx: DriverContext,
  port: number,
  onLog: LogSink,
): Promise<void> {
  await ufwAllowPort(ctx, port, ufwComment(ctx.appSlug), onLog);
}

/**
 * The same gesture for what is not an application — ports 80 and 443 of a
 * reverse proxy installed by Pupitre. The comment carries the marker: the rule
 * stays recognizable as set by the panel.
 */
export async function ufwAllowPort(
  ctx: TargetContext,
  port: number,
  comment: string,
  onLog: LogSink,
  /** Only open to this address — a remote proxy. Absent: to everyone. */
  from?: string,
): Promise<void> {
  const say = driverSay(ctx.language);
  const state = await ufwState(ctx);
  if (state !== 'active') {
    onLog(
      say(state === 'absent' ? 'ufw.absent' : 'ufw.inactive', { target: ctx.target.name, port }),
    );
    return;
  }

  const rule = from
    ? `allow from ${shellQuote(from)} to any port ${port} proto tcp`
    : `allow ${port}/tcp`;
  const result = await exec(ctx.sshSession, `ufw ${rule} comment ${shellQuote(comment)}`, {
    sudo: true,
    timeout: UFW_TIMEOUT_MS,
  });

  if (result.code !== 0) {
    // A firewall that refuses a rule is no reason to lose the deployment: we say it
    // loudly, we do not interrupt it.
    onLog(
      say('ufw.ruleFailed', { rule, detail: firstLine(result.stderr) ?? `code ${result.code}` }),
    );
    return;
  }
  onLog(`ufw ${rule} (${comment})`);
}

/**
 * Deletes the rules carrying the application's comment.
 *
 * `ufw delete allow <port>/tcp` deletes by rule match, not by number. We then
 * check that nothing carries our comment on this port anymore: it is the
 * comment that is authoritative, it is our marker.
 */
export async function ufwDelete(
  ctx: DriverContext,
  port: number,
  onLog: LogSink,
): Promise<void> {
  const say = driverSay(ctx.language);
  const state = await ufwState(ctx);
  if (state !== 'active') {
    onLog(say(state === 'absent' ? 'ufw.nothingToRemove.absent' : 'ufw.nothingToRemove.inactive'));
    return;
  }

  const comment = ufwComment(ctx.appSlug);
  const result = await exec(ctx.sshSession, `ufw --force delete allow ${port}/tcp`, {
    sudo: true,
    timeout: UFW_TIMEOUT_MS,
  });
  // A rule limited to a source — that of a remote proxy — is not removed by
  // `delete allow <port>/tcp`: we find it by its number, from our marker and the
  // port, from the largest to the smallest so that the remaining numbers do not
  // move.
  await exec(
    ctx.sshSession,
    `ufw status numbered | grep -E ${shellQuote(UFW_MARKERS.map((marker) => `${marker}:`).join('|'))} ` +
      `| grep -E ${shellQuote(`(^|[^0-9])${port}(/tcp)?([^0-9]|$)`)} ` +
      `| sed -n 's/^\\[ *\\([0-9]*\\)\\].*/\\1/p' | sort -rn | while read n; do ufw --force delete "$n" >/dev/null; done; true`,
    { sudo: true, timeout: UFW_TIMEOUT_MS },
  );

  // Deletion is done by rule match (`allow <port>/tcp`), never by comment: a rule
  // from before the renaming is therefore removed like the others. The check that
  // follows must accept both markers — otherwise a leftover carrying the old one
  // would pass for an absence, and the port would stay open without anything
  // saying so.
  const markers = UFW_MARKERS.map((marker) => `${marker}:`).join('|');
  const remaining = await exec(
    ctx.sshSession,
    `ufw status | grep -E ${shellQuote(markers)} | grep -F ${shellQuote(String(port))} || true`,
    { sudo: true, timeout: UFW_TIMEOUT_MS },
  );

  if (remaining.stdout.trim().length > 0) {
    onLog(say('ufw.stillThere', { port, comment, rules: remaining.stdout.trim() }));
    return;
  }
  onLog(
    result.code === 0
      ? `ufw delete allow ${port}/tcp (${comment})`
      : say('ufw.noRuleLeft', { port, comment }),
  );
}

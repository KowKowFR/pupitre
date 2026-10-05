import 'server-only';
import { getAppSettings, getDb, gt, sessions } from '@pupitre/db';
import { logger } from './logger';

/**
 * The sessions' duration, as Better Auth and `requireSession()` use it right now.
 *
 * Better Auth freezes a session's duration when its instance is built: as for
 * single sign-on, the effective policy lives on `globalThis` and `getAuth()`
 * rebuilds its instance when it changes. It is read again at startup and after
 * each save of the settings.
 */
export type SessionPolicy = {
  /** Without activity for this duration, the session closes. */
  idleSeconds: number;
  /** Beyond this, the session closes even when active. `null`: no ceiling. */
  maxSeconds: number | null;
};

const DEFAULT_POLICY: SessionPolicy = { idleSeconds: 168 * 3600, maxSeconds: null };

declare global {
  var __pupitreSessionPolicy: SessionPolicy | undefined;
}

export function sessionPolicy(): SessionPolicy {
  return globalThis.__pupitreSessionPolicy ?? DEFAULT_POLICY;
}

/**
 * Shortening the duration without activity also holds for the sessions already
 * open. Better Auth only extends a session as its expiry approaches — computed
 * with the old duration —: doing nothing, a session opened for seven days would
 * stay so. We therefore bring each expiry back to "now plus the new duration"; a
 * used session will be extended like the others. Returns the number of shortened
 * sessions.
 */
export async function clampOpenSessions(idleSeconds: number): Promise<number> {
  const limit = new Date(Date.now() + idleSeconds * 1000);
  const rows = await getDb()
    .update(sessions)
    .set({ expiresAt: limit })
    .where(gt(sessions.expiresAt, limit))
    .returning({ id: sessions.id });
  return rows.length;
}

export async function refreshSessionPolicy(): Promise<SessionPolicy> {
  try {
    const { accounts } = (await getAppSettings()).settings;
    globalThis.__pupitreSessionPolicy = {
      idleSeconds: accounts.sessionIdleHours * 3600,
      maxSeconds: accounts.sessionMaxHours === null ? null : accounts.sessionMaxHours * 3600,
    };
  } catch (error) {
    logger.error({ err: error }, 'sessions duration unreadable — default values');
  }
  return sessionPolicy();
}

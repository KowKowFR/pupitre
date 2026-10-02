import 'server-only';
import { getAppSettings, getDb, gt, sessions } from '@pupitre/db';
import { logger } from './logger';

/**
 * La durée des sessions, telle que Better Auth et `requireSession()` s'en
 * servent à l'instant.
 *
 * Better Auth fige la durée d'une session à la construction de son instance :
 * comme pour la connexion unique, la politique effective vit sur `globalThis`
 * et `getAuth()` reconstruit son instance quand elle change. Elle est relue au
 * démarrage et après chaque enregistrement des réglages.
 */
export type SessionPolicy = {
  /** Sans activité pendant cette durée, la session se ferme. */
  idleSeconds: number;
  /** Au-delà, la session se ferme même active. `null` : pas de plafond. */
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
 * Raccourcir la durée sans activité vaut aussi pour les sessions déjà
 * ouvertes. Better Auth ne prolonge une session qu'à l'approche de son
 * échéance — calculée avec l'ancienne durée — : sans rien faire, une session
 * ouverte pour sept jours le resterait. On ramène donc chaque échéance à
 * « maintenant plus la nouvelle durée » ; une session utilisée sera prolongée
 * comme les autres. Rend le nombre de sessions raccourcies.
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
    logger.error({ err: error }, 'durée des sessions illisible — valeurs par défaut');
  }
  return sessionPolicy();
}

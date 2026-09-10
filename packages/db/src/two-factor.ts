import { and, eq, like, ne } from 'drizzle-orm';
import { getDb, type Database } from './client.js';
import { sessions, twoFactors, users, verifications } from './schema/auth.js';

/**
 * Second facteur vu depuis l'administration.
 *
 * Better Auth n'expose aucun chemin permettant à un tiers de retirer le second
 * facteur de quelqu'un : `/two-factor/disable` travaille sur la session de
 * l'appelant et exige SON mot de passe, et le plugin `admin` (ban, set-role,
 * set-user-password, revoke-user-sessions…) ne couvre pas le sujet. Un
 * administrateur n'a donc, par la bibliothèque, aucune porte de sortie pour un
 * utilisateur qui a perdu son téléphone ET ses codes de secours.
 *
 * C'est la seule raison pour laquelle ce module écrit directement dans les
 * tables de Better Auth. Il reproduit exactement ce que fait
 * `disableTwoFactor` côté serveur — effacer la ligne `two_factors` et remettre
 * `users.two_factor_enabled` à false — mais dans UNE transaction : un compte
 * marqué « 2FA actif » sans ligne `two_factors` ne peut plus ni se connecter,
 * ni se réparer ; la ligne sans le drapeau bloque en silence toute nouvelle
 * activation (`enableTwoFactor` refuse tant qu'une ligne vérifiée existe).
 * Aucun de ces deux états ne doit pouvoir naître d'un crash à mi-chemin.
 */

/** L'utilisateur visé n'existe pas — la route la traduit en 404. */
export class UserNotFoundError extends Error {
  constructor(readonly userId: string) {
    super(`Utilisateur « ${userId} » introuvable`);
    this.name = 'UserNotFoundError';
  }
}

export type TwoFactorState =
  /** Aucun second facteur, ni armé ni en cours de configuration. */
  | 'none'
  /** Secret généré mais jamais confirmé par un code : la connexion n'en tient pas compte. */
  | 'pending'
  /** Second facteur armé : la connexion réclame un code. */
  | 'active';

/**
 * État du second facteur de chaque utilisateur, indexé par id.
 * Croise le drapeau `users.two_factor_enabled` et la ligne `two_factors` :
 * les deux ensemble, parce qu'une incohérence entre eux est précisément ce
 * qu'un administrateur doit pouvoir voir puis réparer.
 */
export async function getTwoFactorStates(
  db: Database = getDb(),
): Promise<Map<string, TwoFactorState>> {
  const rows = await db
    .select({ id: users.id, enabled: users.twoFactorEnabled, verified: twoFactors.verified })
    .from(users)
    .leftJoin(twoFactors, eq(twoFactors.userId, users.id));

  const states = new Map<string, TwoFactorState>();
  for (const row of rows) {
    // Le schéma n'impose pas l'unicité de `two_factors.user_id` : plusieurs
    // lignes donneraient plusieurs tuples pour le même utilisateur, et c'est
    // toujours la plus armée qui décrit l'état vécu à la connexion.
    if (states.get(row.id) === 'active') continue;
    states.set(
      row.id,
      row.enabled || row.verified === true ? 'active' : row.verified === false ? 'pending' : 'none',
    );
  }
  return states;
}

export type TwoFactorResetOptions = {
  /**
   * Session épargnée par la révocation. Sert au cas où un administrateur
   * réinitialise son propre second facteur : le fermer sous ses pieds le
   * renverrait à l'écran de connexion sans raison de sécurité.
   */
  keepSessionId?: string | null;
};

export type TwoFactorResetOutcome = {
  /** État observé avant l'opération. `none` ⇒ il n'y avait rien à retirer. */
  stateBefore: TwoFactorState;
  removedFactors: number;
  revokedSessions: number;
  revokedTrustedDevices: number;
};

/**
 * Retire le second facteur d'un utilisateur, sans son mot de passe.
 *
 * Tout se joue dans une seule transaction : le facteur, le drapeau, les
 * sessions et les appareils de confiance tombent ensemble ou pas du tout.
 */
export async function resetUserTwoFactor(
  userId: string,
  options: TwoFactorResetOptions = {},
  db: Database = getDb(),
): Promise<TwoFactorResetOutcome> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({ enabled: users.twoFactorEnabled })
      .from(users)
      .where(eq(users.id, userId));
    if (!user) throw new UserNotFoundError(userId);

    const existing = await tx
      .select({ verified: twoFactors.verified })
      .from(twoFactors)
      .where(eq(twoFactors.userId, userId));

    const stateBefore: TwoFactorState =
      user.enabled || existing.some((row) => row.verified)
        ? 'active'
        : existing.length > 0
          ? 'pending'
          : 'none';

    if (stateBefore === 'none') {
      return { stateBefore, removedFactors: 0, revokedSessions: 0, revokedTrustedDevices: 0 };
    }

    const removed = await tx
      .delete(twoFactors)
      .where(eq(twoFactors.userId, userId))
      .returning({ id: twoFactors.id });

    await tx
      .update(users)
      .set({ twoFactorEnabled: false, updatedAt: new Date() })
      .where(eq(users.id, userId));

    // Un appareil « de confiance » saute le second facteur pendant trente
    // jours. Le laisser en vie survivrait à la réinitialisation et rendrait un
    // nouveau facteur inopérant sur le navigateur qui l'avait mémorisé — la
    // preuve gardée serait celle du facteur qu'on vient justement de retirer.
    // Better Auth stocke ces autorisations dans `verifications`, identifiant
    // préfixé `trust-device-`, valeur = id de l'utilisateur.
    const trusted = await tx
      .delete(verifications)
      .where(
        and(eq(verifications.value, userId), like(verifications.identifier, 'trust-device-%')),
      )
      .returning({ id: verifications.id });

    const keep = options.keepSessionId;
    const revoked = await tx
      .delete(sessions)
      .where(keep ? and(eq(sessions.userId, userId), ne(sessions.id, keep)) : eq(sessions.userId, userId))
      .returning({ id: sessions.id });

    return {
      stateBefore,
      removedFactors: removed.length,
      revokedSessions: revoked.length,
      revokedTrustedDevices: trusted.length,
    };
  });
}

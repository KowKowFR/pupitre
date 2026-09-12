import 'server-only';
import {
  and,
  accounts,
  eq,
  getDb,
  isNotNull,
  sql,
  verifications,
  type Database,
} from '@pupitre/db';

/**
 * L'état du cycle de vie d'un compte — **déduit**, jamais stocké.
 *
 * Vit dans `lib/` et non dans le Route Handler parce que les deux le lisent :
 * l'API pour le rendre en JSON, l'écran `/admin/users` pour l'afficher. Une
 * page qui importerait un fichier `route.ts` marcherait, mais brouillerait la
 * frontière entre ce qui est une route et ce qui est du code partagé.
 */

/**
 * Où en est un compte dans son cycle de vie.
 *
 *   `invited`   créé, sans mot de passe, un lien d'invitation encore valable
 *   `expired`   créé, sans mot de passe, plus aucun lien valable
 *   `active`    la personne a choisi son mot de passe
 *
 * Ce n'est pas une colonne : c'est une **lecture** de deux faits qui existent
 * déjà — l'existence d'une ligne `accounts` de type `credential`, et celle d'un
 * jeton vivant dans `verifications`. Ajouter une colonne `status` créerait une
 * troisième vérité à tenir d'accord avec les deux autres, et c'est elle qui
 * finirait par mentir.
 */
export type AccountState = 'invited' | 'expired' | 'active';

/**
 * L'état de tous les comptes, en deux requêtes.
 *
 * Pas une par utilisateur : la liste des utilisateurs faisait déjà un
 * `getUserGrants()` par ligne, et en ajouter deux de plus rendrait l'écran
 * quadratique pour un renseignement d'affichage.
 */
export async function accountStates(
  db: Database = getDb(),
): Promise<Map<string, { hasPassword: boolean; invitationExpiresAt: Date | null }>> {
  const withPassword = await db
    .selectDistinct({ userId: accounts.userId })
    .from(accounts)
    .where(and(eq(accounts.providerId, 'credential'), isNotNull(accounts.password)));

  const pending = await db
    .select({ userId: verifications.value, expiresAt: verifications.expiresAt })
    .from(verifications)
    .where(sql`${verifications.identifier} like 'reset-password:%'`);

  const now = Date.now();
  const passwords = new Set(withPassword.map((row) => row.userId));
  const expiries = new Map<string, Date>();
  for (const row of pending) {
    if (row.expiresAt.getTime() <= now) continue;
    const current = expiries.get(row.userId);
    if (!current || row.expiresAt > current) expiries.set(row.userId, row.expiresAt);
  }

  const all = new Map<string, { hasPassword: boolean; invitationExpiresAt: Date | null }>();
  for (const id of new Set([...passwords, ...expiries.keys()])) {
    all.set(id, { hasPassword: passwords.has(id), invitationExpiresAt: expiries.get(id) ?? null });
  }
  return all;
}

export function accountStateOf(entry?: {
  hasPassword: boolean;
  invitationExpiresAt: Date | null;
}): AccountState {
  if (entry?.hasPassword) return 'active';
  return entry?.invitationExpiresAt ? 'invited' : 'expired';
}


import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';

/**
 * Jetons d'API : ce qu'une CI présente à la place d'une session de navigateur,
 * dans `Authorization: Bearer pup_…`.
 *
 * Un jeton appartient à la personne qui l'a créé et n'agit qu'en son nom. Ses
 * permissions sont un sous-ensemble des siennes, **relues à chaque appel** :
 * un rôle retiré, un compte désactivé ou supprimé, et le jeton perd ce qu'il
 * perd. Il ne peut jamais en faire plus que son auteur.
 *
 * Le jeton lui-même n'est jamais gardé : seulement son empreinte SHA-256, qui
 * suffit à le reconnaître (il porte 256 bits d'aléa, rien à deviner) et ne
 * permet pas de le reconstituer. Il n'est montré qu'une fois, à sa création.
 */
export const apiTokens = pgTable(
  'api_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Le début du jeton (`pup_` et huit caractères), pour le reconnaître sans le révéler. */
    prefix: text('prefix').notNull(),
    /** SHA-256 du jeton, en hexadécimal. */
    tokenHash: text('token_hash').notNull().unique(),
    /** Clés `ressource:action` demandées à la création. */
    permissions: jsonb('permissions').$type<string[]>().notNull(),
    /**
     * Les applications auxquelles le jeton se limite, ou `null` pour toutes.
     * Limité, il n'est accepté que par les routes qui vérifient l'application
     * visée — toutes les autres le refusent.
     */
    applicationIds: jsonb('application_ids').$type<string[] | null>(),
    /** `null` : sans échéance. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    lastUsedIp: text('last_used_ip'),
    /** Un jeton révoqué reste en base : le journal continue de dire lequel a agi. */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('api_tokens_user_id_idx').on(t.userId)],
);

export type ApiTokenRow = typeof apiTokens.$inferSelect;

import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';

/**
 * API tokens: what a CI presents instead of a browser session, in
 * `Authorization: Bearer pup_…`.
 *
 * A token belongs to the person who created it and only acts in their name. Its
 * permissions are a subset of theirs, **read again at each call**: a role
 * removed, an account disabled or deleted, and the token loses what it loses. It
 * can never do more than its author.
 *
 * The token itself is never kept: only its SHA-256 hash, which is enough to
 * recognize it (it carries 256 bits of randomness, nothing to guess) and does not
 * allow rebuilding it. It is only shown once, at creation.
 */
export const apiTokens = pgTable(
  'api_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** The token's start (`pup_` and eight characters), to recognize it without revealing it. */
    prefix: text('prefix').notNull(),
    /** The token's SHA-256, in hexadecimal. */
    tokenHash: text('token_hash').notNull().unique(),
    /** `resource:action` keys requested at creation. */
    permissions: jsonb('permissions').$type<string[]>().notNull(),
    /**
     * The applications the token is limited to, or `null` for all. Limited, it is
     * only accepted by the routes that check the targeted application — all the
     * others refuse it.
     */
    applicationIds: jsonb('application_ids').$type<string[] | null>(),
    /** `null`: without expiry. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    lastUsedIp: text('last_used_ip'),
    /** A revoked token stays in the database: the log keeps saying which one acted. */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('api_tokens_user_id_idx').on(t.userId)],
);

export type ApiTokenRow = typeof apiTokens.$inferSelect;

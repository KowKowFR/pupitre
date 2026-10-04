import type { ImageMediaType } from '@pupitre/core';
import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { bytea } from './columns.js';

/**
 * Each person's profile picture, in the database — no file service on the side,
 * nothing more to back up than the database itself.
 *
 * At most one row per person, replaced at each upload. The picture is small by
 * construction: a 256 px square re-encoded by the browser, 512 KiB at most (see
 * `media.ts` in `@pupitre/core`).
 *
 * `users.image`, the field Better Auth carries in the session, receives the
 * picture's **versioned** URL (`/api/users/:id/avatar?v=…`): each screen that
 * knows the person knows their picture, and a new picture changes URL — the
 * browser can therefore keep the old one in cache as long as it likes.
 */
export const userAvatars = pgTable('user_avatars', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** Read from the bytes on arrival, never taken from the request's header. */
  contentType: text('content_type').$type<ImageMediaType>().notNull(),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
  bytes: integer('bytes').notNull(),
  data: bytea('data').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

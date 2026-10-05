import type { StatusBlock } from '@pupitre/core';
import { boolean, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';

/**
 * Public status pages. Empty `slug`: the `/status` page. An unpublished page
 * does not exist for a visitor — it answers 404, like an unknown address, so as
 * not to say there is something behind it.
 */
export const statusPages = pgTable(
  'status_pages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    published: boolean('published').notNull().default(false),
    blocks: jsonb('blocks').$type<StatusBlock[]>().notNull().default([]),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('status_pages_slug_idx').on(t.slug)],
);

export type StatusPageRow = typeof statusPages.$inferSelect;

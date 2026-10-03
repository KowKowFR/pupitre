import type { StatusBlock } from '@pupitre/core';
import { boolean, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';

/**
 * Les pages de statut publiques. `slug` vide : la page de `/status`. Une page
 * non publiée n'existe pas pour un visiteur — elle répond 404, comme une
 * adresse inconnue, pour ne pas dire qu'il y a quelque chose derrière.
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

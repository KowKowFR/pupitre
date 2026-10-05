import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { statusUpdatePhaseEnum } from '../enums.js';
import { users } from './auth.js';
import { maintenanceWindows } from './maintenance.js';
import { monitorIncidents } from './monitors.js';

/**
 * Status page announcements: "we are investigating", "resolved". Each is attached
 * to **one** subject — a probe incident or a maintenance window — and disappears
 * with it. It appears on any page that shows an affected probe; `created_by`
 * never leaves a public page.
 */
export const statusUpdates = pgTable(
  'status_updates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    monitorIncidentId: uuid('monitor_incident_id').references(() => monitorIncidents.id, {
      onDelete: 'cascade',
    }),
    maintenanceWindowId: uuid('maintenance_window_id').references(() => maintenanceWindows.id, {
      onDelete: 'cascade',
    }),
    phase: statusUpdatePhaseEnum('phase').notNull(),
    message: text('message').notNull(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    /** The publication time: the one a visitor reads. */
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('status_updates_incident_idx').on(t.monitorIncidentId, t.createdAt),
    index('status_updates_window_idx').on(t.maintenanceWindowId, t.createdAt),
    // One subject, and only one.
    check(
      'status_updates_one_subject',
      sql`(${t.monitorIncidentId} is null) <> (${t.maintenanceWindowId} is null)`,
    ),
  ],
);

export type StatusUpdateRow = typeof statusUpdates.$inferSelect;

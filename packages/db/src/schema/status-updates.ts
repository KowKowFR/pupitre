import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { statusUpdatePhaseEnum } from '../enums.js';
import { users } from './auth.js';
import { maintenanceWindows } from './maintenance.js';
import { monitorIncidents } from './monitors.js';

/**
 * Les annonces des pages de statut : « on enquête », « résolu ». Chacune est
 * rattachée à **un** sujet — un incident de sonde ou une fenêtre de
 * maintenance — et disparaît avec lui. Elle paraît sur toute page qui montre
 * une sonde touchée ; `created_by` ne sort jamais d'une page publique.
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
    /** L'heure de publication : celle que lit un visiteur. */
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('status_updates_incident_idx').on(t.monitorIncidentId, t.createdAt),
    index('status_updates_window_idx').on(t.maintenanceWindowId, t.createdAt),
    // Un sujet, et un seul.
    check(
      'status_updates_one_subject',
      sql`(${t.monitorIncidentId} is null) <> (${t.maintenanceWindowId} is null)`,
    ),
  ],
);

export type StatusUpdateRow = typeof statusUpdates.$inferSelect;

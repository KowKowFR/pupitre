import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { targets } from './infra.js';
import { monitors } from './monitors.js';

/**
 * Les fenêtres de maintenance : « prod-1 en maintenance de 22 h à 23 h ».
 *
 * `starts_at` et `ends_at` font foi pour la mise en sourdine : la distribution
 * des notifications les compare à l'heure, sans attendre personne.
 * `started_at` et `ended_at` ne disent que ce que le balayage a **annoncé** —
 * le début (une fois) et la fin (une fois, en libérant ce qui est resté en
 * panne). Ce sont eux qui empêchent une seconde annonce.
 */
export const maintenanceWindows = pgTable(
  'maintenance_windows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    note: text('note'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('maintenance_windows_ends_idx').on(t.endsAt),
    check('maintenance_windows_order', sql`${t.endsAt} > ${t.startsAt}`),
  ],
);

/** Les cibles d'une fenêtre. Supprimer la cible la retire de la fenêtre. */
export const maintenanceWindowTargets = pgTable(
  'maintenance_window_targets',
  {
    windowId: uuid('window_id')
      .notNull()
      .references(() => maintenanceWindows.id, { onDelete: 'cascade' }),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.windowId, t.targetId] }),
    index('maintenance_window_targets_target_idx').on(t.targetId),
  ],
);

/** Les sondes d'une fenêtre, nommées explicitement. */
export const maintenanceWindowMonitors = pgTable(
  'maintenance_window_monitors',
  {
    windowId: uuid('window_id')
      .notNull()
      .references(() => maintenanceWindows.id, { onDelete: 'cascade' }),
    monitorId: uuid('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.windowId, t.monitorId] }),
    index('maintenance_window_monitors_monitor_idx').on(t.monitorId),
  ],
);

/**
 * Une alerte retenue par une fenêtre : la tâche de distribution telle qu'elle
 * serait partie, recopiée pour pouvoir partir plus tard, à l'identique.
 *
 * `family` regroupe la panne et le rétablissement d'un même sujet ; `opens`
 * dit lequel des deux. À la fin de la fenêtre, la dernière alerte de chaque
 * famille part si elle ouvre un problème (`released_at`).
 */
export const maintenanceHeldAlerts = pgTable(
  'maintenance_held_alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    windowId: uuid('window_id')
      .notNull()
      .references(() => maintenanceWindows.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    family: text('family').notNull(),
    opens: boolean('opens').notNull(),
    /** Ce que l'alerte aurait dit, pour l'écran et le message de fin. */
    label: text('label').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull(),
    heldAt: timestamp('held_at', { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
  },
  (t) => [index('maintenance_held_alerts_window_idx').on(t.windowId, t.heldAt)],
);

export type MaintenanceWindowRow = typeof maintenanceWindows.$inferSelect;
export type MaintenanceHeldAlertRow = typeof maintenanceHeldAlerts.$inferSelect;

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
 * Maintenance windows: "prod-1 under maintenance from 10 pm to 11 pm".
 *
 * `starts_at` and `ends_at` are authoritative for muting: the notification
 * delivery compares them with the time, without waiting for anyone. `started_at`
 * and `ended_at` only say what the sweep **announced** — the start (once) and the
 * end (once, releasing what stayed down). They are what prevents a second
 * announcement.
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

/** A window's targets. Deleting the target removes it from the window. */
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

/** A window's probes, named explicitly. */
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
 * An alert held by a window: the delivery job as it would have gone out, copied
 * so it can go out later, identically.
 *
 * `family` groups the outage and the recovery of the same subject; `opens` says
 * which of the two. At the end of the window, the last alert of each family goes
 * out if it opens a problem (`released_at`).
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
    /** What the alert would have said, for the screen and the end message. */
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

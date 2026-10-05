import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import type {
  CreateStatusUpdateInput,
  StatusUpdateSubject,
  UpdateStatusUpdateInput,
} from '@pupitre/core';
import { getDb, type Database } from './client.js';
import { users } from './schema/auth.js';
import { monitorIncidents, monitors } from './schema/monitors.js';
import { statusUpdates, type StatusUpdateRow } from './schema/status-updates.js';

/**
 * Status page announcements, in the database. What suits which subject, and
 * what a visitor reads of it, is decided in `@pupitre/core`
 * (`status-updates.ts`); here, reads and writes.
 */

export type { StatusUpdateRow };

/** An announcement, with its publisher's name — for the screen, never for a public page. */
export type StatusUpdateView = StatusUpdateRow & { authorName: string | null };

/** A row's subject: the table's constraint guarantees there is one, and only one. */
export function statusUpdateSubjectOf(row: StatusUpdateRow): StatusUpdateSubject {
  return row.monitorIncidentId
    ? { type: 'incident', id: row.monitorIncidentId }
    : { type: 'maintenance', id: row.maintenanceWindowId! };
}

export async function createStatusUpdate(
  input: CreateStatusUpdateInput,
  createdBy: string | null,
  db: Database = getDb(),
): Promise<StatusUpdateRow> {
  const [row] = await db
    .insert(statusUpdates)
    .values({
      monitorIncidentId: input.subject.type === 'incident' ? input.subject.id : null,
      maintenanceWindowId: input.subject.type === 'maintenance' ? input.subject.id : null,
      phase: input.phase,
      message: input.message,
      createdBy,
    })
    .returning();
  if (!row) throw new Error('announcement not created');
  return row;
}

export async function getStatusUpdate(
  id: string,
  db: Database = getDb(),
): Promise<StatusUpdateRow | null> {
  const [row] = await db.select().from(statusUpdates).where(eq(statusUpdates.id, id));
  return row ?? null;
}

/**
 * Corrects an announcement. The publication time does not move: it is the one
 * that was read. `updated_at` takes the database's time, like `created_at`:
 * comparing them says whether the announcement was corrected, without depending
 * on the panel's clock.
 */
export async function updateStatusUpdate(
  id: string,
  patch: UpdateStatusUpdateInput,
  db: Database = getDb(),
): Promise<StatusUpdateRow | null> {
  const [row] = await db
    .update(statusUpdates)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(eq(statusUpdates.id, id))
    .returning();
  return row ?? null;
}

export async function deleteStatusUpdate(id: string, db: Database = getDb()): Promise<boolean> {
  const rows = await db
    .delete(statusUpdates)
    .where(eq(statusUpdates.id, id))
    .returning({ id: statusUpdates.id });
  return rows.length > 0;
}

/** The announcements of these subjects, from oldest to newest. */
export async function listStatusUpdates(
  subjects: { incidentIds?: readonly string[]; windowIds?: readonly string[] },
  db: Database = getDb(),
): Promise<StatusUpdateView[]> {
  const incidentIds = [...(subjects.incidentIds ?? [])];
  const windowIds = [...(subjects.windowIds ?? [])];
  const clauses = [
    incidentIds.length > 0 ? inArray(statusUpdates.monitorIncidentId, incidentIds) : undefined,
    windowIds.length > 0 ? inArray(statusUpdates.maintenanceWindowId, windowIds) : undefined,
  ].filter((clause) => clause !== undefined);
  if (clauses.length === 0) return [];
  const rows = await db
    .select({ update: statusUpdates, authorName: users.name })
    .from(statusUpdates)
    .leftJoin(users, eq(users.id, statusUpdates.createdBy))
    .where(or(...clauses))
    .orderBy(asc(statusUpdates.createdAt));
  return rows.map((row) => ({ ...row.update, authorName: row.authorName }));
}

/** How many announcements each of these incidents carries. */
export async function countStatusUpdatesByIncident(
  incidentIds: readonly string[],
  db: Database = getDb(),
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (incidentIds.length === 0) return counts;
  const rows = await db
    .select({ id: statusUpdates.monitorIncidentId, count: sql<number>`count(*)::int` })
    .from(statusUpdates)
    .where(inArray(statusUpdates.monitorIncidentId, [...incidentIds]))
    .groupBy(statusUpdates.monitorIncidentId);
  for (const row of rows) if (row.id) counts.set(row.id, Number(row.count));
  return counts;
}

export type AnnounceableIncident = {
  id: string;
  monitorId: string;
  monitorName: string;
  startedAt: Date;
  resolvedAt: Date | null;
};

/**
 * The outages that can be announced on these probes: the ongoing ones, and those
 * closed since `resolvedAfter` — time to write "resolved" and what was learned.
 * The most recent first.
 */
export async function announceableIncidents(
  monitorIds: readonly string[],
  resolvedAfter: Date,
  db: Database = getDb(),
): Promise<AnnounceableIncident[]> {
  if (monitorIds.length === 0) return [];
  return db
    .select({
      id: monitorIncidents.id,
      monitorId: monitorIncidents.monitorId,
      monitorName: monitors.name,
      startedAt: monitorIncidents.startedAt,
      resolvedAt: monitorIncidents.resolvedAt,
    })
    .from(monitorIncidents)
    .innerJoin(monitors, eq(monitors.id, monitorIncidents.monitorId))
    .where(
      and(
        inArray(monitorIncidents.monitorId, [...monitorIds]),
        or(isNull(monitorIncidents.resolvedAt), gt(monitorIncidents.resolvedAt, resolvedAfter)),
      ),
    )
    .orderBy(desc(monitorIncidents.startedAt))
    .limit(50);
}

/** A probe incident, whatever the probe: to announce it from its record. */
export async function getAnnounceableIncident(
  id: string,
  db: Database = getDb(),
): Promise<AnnounceableIncident | null> {
  const [row] = await db
    .select({
      id: monitorIncidents.id,
      monitorId: monitorIncidents.monitorId,
      monitorName: monitors.name,
      startedAt: monitorIncidents.startedAt,
      resolvedAt: monitorIncidents.resolvedAt,
    })
    .from(monitorIncidents)
    .innerJoin(monitors, eq(monitors.id, monitorIncidents.monitorId))
    .where(eq(monitorIncidents.id, id));
  return row ?? null;
}

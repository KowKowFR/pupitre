import { and, asc, eq, gt, inArray, lt, or, isNull, sql } from 'drizzle-orm';
import type { StatusPageInput } from '@pupitre/core';
import { getDb, type Database } from './client.js';
import { listLiveDeployments } from './deployments.js';
import {
  maintenanceWindowMonitors,
  maintenanceWindows,
  maintenanceWindowTargets,
} from './schema/maintenance.js';
import { monitorChecks, monitorIncidents, monitors } from './schema/monitors.js';
import { statusPages, type StatusPageRow } from './schema/status-pages.js';

/**
 * Status pages in the database, and the reads a public page asks for: the
 * probes' daily history, their recent outages, the maintenance windows that
 * touch them. What a visitor reads of it is decided in `@pupitre/core`
 * (`status-page.ts`); here, only reads.
 */

export type { StatusPageRow };

/** The address is already taken by another page. */
export class StatusPageSlugTakenError extends Error {
  constructor(readonly slug: string) {
    super(`status page address already taken: "${slug}"`);
    this.name = 'StatusPageSlugTakenError';
  }
}

function translateConflict(slug: string | undefined) {
  return (error: unknown): never => {
    const code =
      (error as { code?: unknown; cause?: { code?: unknown } })?.code ??
      (error as { cause?: { code?: unknown } })?.cause?.code;
    if (code === '23505') throw new StatusPageSlugTakenError(slug ?? '');
    throw error;
  };
}

export async function listStatusPages(db: Database = getDb()): Promise<StatusPageRow[]> {
  return db.select().from(statusPages).orderBy(asc(statusPages.slug));
}

export async function getStatusPage(
  id: string,
  db: Database = getDb(),
): Promise<StatusPageRow | null> {
  const [row] = await db.select().from(statusPages).where(eq(statusPages.id, id));
  return row ?? null;
}

/** The page **published** at this address, or nothing. */
export async function getPublishedStatusPage(
  slug: string,
  db: Database = getDb(),
): Promise<StatusPageRow | null> {
  const [row] = await db
    .select()
    .from(statusPages)
    .where(and(eq(statusPages.slug, slug), eq(statusPages.published, true)));
  return row ?? null;
}

export async function createStatusPage(
  input: StatusPageInput,
  createdBy: string | null,
  db: Database = getDb(),
): Promise<StatusPageRow> {
  const [row] = await db
    .insert(statusPages)
    .values({ ...input, createdBy })
    .returning()
    .catch(translateConflict(input.slug));
  if (!row) throw new Error('status page not created');
  return row;
}

export async function updateStatusPage(
  id: string,
  patch: Partial<StatusPageInput>,
  db: Database = getDb(),
): Promise<StatusPageRow | null> {
  const [row] = await db
    .update(statusPages)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(statusPages.id, id))
    .returning()
    .catch(translateConflict(patch.slug));
  return row ?? null;
}

export async function deleteStatusPage(id: string, db: Database = getDb()): Promise<boolean> {
  const rows = await db
    .delete(statusPages)
    .where(eq(statusPages.id, id))
    .returning({ id: statusPages.id });
  return rows.length > 0;
}

// ─── A public page's reads ────────────────────────────────────────────────────

/**
 * Per probe and per day (in the instance's time zone), the measurements and
 * those that were healthy, over the last `days` days — bounded by the
 * measurements' retention.
 */
export async function monitorDayTallies(
  monitorIds: string[],
  days: number,
  timeZone: string,
  db: Database = getDb(),
): Promise<Map<string, Array<{ day: string; total: number; healthy: number }>>> {
  const tallies = new Map<string, Array<{ day: string; total: number; healthy: number }>>();
  if (monitorIds.length === 0) return tallies;
  const day = sql<string>`to_char((${monitorChecks.checkedAt} at time zone ${timeZone})::date, 'YYYY-MM-DD')`;
  const rows = await db
    .select({
      monitorId: monitorChecks.monitorId,
      day,
      total: sql<number>`count(*)::int`,
      healthy: sql<number>`count(*) filter (where ${monitorChecks.outcome} = 'healthy')::int`,
    })
    .from(monitorChecks)
    .where(
      and(
        inArray(monitorChecks.monitorId, monitorIds),
        sql`${monitorChecks.checkedAt} > now() - make_interval(days => ${days + 1})`,
      ),
    )
    // By position: the time zone is a parameter, and Postgres does not recognize the
    // SELECT's `$1` and the GROUP BY's `$4` as the same expression.
    .groupBy(sql`1`, sql`2`);
  for (const row of rows) {
    const list = tallies.get(row.monitorId) ?? [];
    list.push({ day: row.day, total: Number(row.total), healthy: Number(row.healthy) });
    tallies.set(row.monitorId, list);
  }
  return tallies;
}

/** The probes' outages that lasted during the last `days` days, the most recent first. */
export async function recentMonitorIncidents(
  monitorIds: string[],
  days: number,
  db: Database = getDb(),
): Promise<Array<{ id: string; monitorId: string; startedAt: Date; resolvedAt: Date | null }>> {
  if (monitorIds.length === 0) return [];
  return db
    .select({
      id: monitorIncidents.id,
      monitorId: monitorIncidents.monitorId,
      startedAt: monitorIncidents.startedAt,
      resolvedAt: monitorIncidents.resolvedAt,
    })
    .from(monitorIncidents)
    .where(
      and(
        inArray(monitorIncidents.monitorId, monitorIds),
        or(
          isNull(monitorIncidents.resolvedAt),
          sql`${monitorIncidents.resolvedAt} > now() - make_interval(days => ${days})`,
        ),
      ),
    )
    .orderBy(sql`${monitorIncidents.startedAt} desc`)
    .limit(50);
}

export type MaintenanceTouching = {
  id: string;
  /** The internal title: it never leaves a public page. */
  title: string;
  startsAt: Date;
  endsAt: Date;
  monitorIds: string[];
};

/**
 * The windows that end after `endsAfter` and start before `startsBefore`, with
 * the probes of this list they touch: named, or whose application runs on a
 * named target (`listLiveDeployments`). A window that touches none is not
 * returned.
 */
export async function maintenanceTouching(
  monitorIds: string[],
  range: { endsAfter: Date; startsBefore: Date },
  db: Database = getDb(),
): Promise<MaintenanceTouching[]> {
  if (monitorIds.length === 0) return [];
  const windows = await db
    .select({
      id: maintenanceWindows.id,
      title: maintenanceWindows.title,
      startsAt: maintenanceWindows.startsAt,
      endsAt: maintenanceWindows.endsAt,
    })
    .from(maintenanceWindows)
    .where(
      and(
        gt(maintenanceWindows.endsAt, range.endsAfter),
        lt(maintenanceWindows.startsAt, range.startsBefore),
      ),
    )
    .orderBy(asc(maintenanceWindows.startsAt));
  if (windows.length === 0) return [];
  const ids = windows.map((window) => window.id);
  const [monitorLinks, targetLinks, monitorApps, live] = await Promise.all([
    db
      .select()
      .from(maintenanceWindowMonitors)
      .where(
        and(
          inArray(maintenanceWindowMonitors.windowId, ids),
          inArray(maintenanceWindowMonitors.monitorId, monitorIds),
        ),
      ),
    db
      .select()
      .from(maintenanceWindowTargets)
      .where(inArray(maintenanceWindowTargets.windowId, ids)),
    db
      .select({ id: monitors.id, applicationId: monitors.applicationId })
      .from(monitors)
      .where(inArray(monitors.id, monitorIds)),
    listLiveDeployments({}, db),
  ]);
  return windows
    .map((window) => {
      const covered = new Set(
        monitorLinks.filter((link) => link.windowId === window.id).map((link) => link.monitorId),
      );
      const targets = new Set(
        targetLinks.filter((link) => link.windowId === window.id).map((link) => link.targetId),
      );
      for (const monitor of monitorApps) {
        if (!monitor.applicationId) continue;
        if (
          live.some(
            (row) => row.applicationId === monitor.applicationId && targets.has(row.targetId),
          )
        ) {
          covered.add(monitor.id);
        }
      }
      return { ...window, monitorIds: monitorIds.filter((id) => covered.has(id)) };
    })
    .filter((window) => window.monitorIds.length > 0);
}

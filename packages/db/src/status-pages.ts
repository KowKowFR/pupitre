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
 * Les pages de statut en base, et les lectures qu'une page publique demande :
 * l'historique par jour des sondes, leurs pannes récentes, les maintenances
 * qui les touchent. Ce qu'un visiteur en lit est décidé dans `@pupitre/core`
 * (`status-page.ts`) ; ici, seulement des lectures.
 */

export type { StatusPageRow };

/** L'adresse est déjà prise par une autre page. */
export class StatusPageSlugTakenError extends Error {
  constructor(readonly slug: string) {
    super(`adresse de page de statut déjà prise : « ${slug} »`);
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

/** La page **publiée** à cette adresse, ou rien. */
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
  if (!row) throw new Error('page de statut non créée');
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

// ─── Les lectures d'une page publique ─────────────────────────────────────────

/**
 * Par sonde et par jour (dans le fuseau de l'instance), les mesures et celles
 * qui étaient saines, sur les `days` derniers jours — bornés par la
 * rétention des mesures.
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
    // Par position : le fuseau est un paramètre, et Postgres ne reconnaît pas
    // `$1` du SELECT et `$4` du GROUP BY comme la même expression.
    .groupBy(sql`1`, sql`2`);
  for (const row of rows) {
    const list = tallies.get(row.monitorId) ?? [];
    list.push({ day: row.day, total: Number(row.total), healthy: Number(row.healthy) });
    tallies.set(row.monitorId, list);
  }
  return tallies;
}

/** Les pannes des sondes qui ont duré pendant les `days` derniers jours, les plus récentes d'abord. */
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
  /** Le titre interne : il ne sort jamais d'une page publique. */
  title: string;
  startsAt: Date;
  endsAt: Date;
  monitorIds: string[];
};

/**
 * Les fenêtres qui finissent après `endsAfter` et commencent avant
 * `startsBefore`, avec les sondes de cette liste qu'elles touchent : nommées,
 * ou dont l'application tourne sur une cible nommée (`listLiveDeployments`).
 * Une fenêtre qui n'en touche aucune n'est pas rendue.
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

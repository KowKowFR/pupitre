import { and, asc, desc, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm';
import type {
  CreateMaintenanceInput,
  MaintenanceSubject,
  UpdateMaintenanceInput,
} from '@pupitre/core';
import { getDb, type Database } from './client.js';
import { listLiveDeployments } from './deployments.js';
import { targets } from './schema/infra.js';
import {
  maintenanceHeldAlerts,
  maintenanceWindowMonitors,
  maintenanceWindows,
  maintenanceWindowTargets,
  type MaintenanceHeldAlertRow,
  type MaintenanceWindowRow,
} from './schema/maintenance.js';
import { monitors } from './schema/monitors.js';
import { routes } from './schema/proxies.js';

/**
 * Les fenêtres de maintenance en base : les fenêtres et leurs sujets, la
 * question « qu'est-ce qui couvre ce sujet maintenant ? » que pose la
 * distribution des notifications, et les alertes retenues. Les règles (phase,
 * validité, ce qui part à la fin) sont dans `@pupitre/core`.
 */

export type { MaintenanceHeldAlertRow, MaintenanceWindowRow };

export type MaintenanceWindowView = MaintenanceWindowRow & {
  targets: Array<{ id: string; name: string }>;
  monitors: Array<{ id: string; name: string }>;
  /** Alertes retenues par la fenêtre, et celles qui sont parties à sa fin. */
  held: number;
  released: number;
};

async function viewsOf(
  rows: MaintenanceWindowRow[],
  db: Database,
): Promise<MaintenanceWindowView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const [targetRows, monitorRows, counts] = await Promise.all([
    db
      .select({ windowId: maintenanceWindowTargets.windowId, id: targets.id, name: targets.name })
      .from(maintenanceWindowTargets)
      .innerJoin(targets, eq(targets.id, maintenanceWindowTargets.targetId))
      .where(inArray(maintenanceWindowTargets.windowId, ids))
      .orderBy(asc(targets.name)),
    db
      .select({
        windowId: maintenanceWindowMonitors.windowId,
        id: monitors.id,
        name: monitors.name,
      })
      .from(maintenanceWindowMonitors)
      .innerJoin(monitors, eq(monitors.id, maintenanceWindowMonitors.monitorId))
      .where(inArray(maintenanceWindowMonitors.windowId, ids))
      .orderBy(asc(monitors.name)),
    db
      .select({
        windowId: maintenanceHeldAlerts.windowId,
        held: sql<number>`count(*)::int`,
        released: sql<number>`count(${maintenanceHeldAlerts.releasedAt})::int`,
      })
      .from(maintenanceHeldAlerts)
      .where(inArray(maintenanceHeldAlerts.windowId, ids))
      .groupBy(maintenanceHeldAlerts.windowId),
  ]);
  return rows.map((row) => {
    const count = counts.find((entry) => entry.windowId === row.id);
    return {
      ...row,
      targets: targetRows
        .filter((entry) => entry.windowId === row.id)
        .map(({ id, name }) => ({ id, name })),
      monitors: monitorRows
        .filter((entry) => entry.windowId === row.id)
        .map(({ id, name }) => ({ id, name })),
      held: count?.held ?? 0,
      released: count?.released ?? 0,
    };
  });
}

async function writeSubjects(
  tx: Database,
  windowId: string,
  subjects: { targetIds?: string[]; monitorIds?: string[] },
): Promise<void> {
  if (subjects.targetIds) {
    await tx
      .delete(maintenanceWindowTargets)
      .where(eq(maintenanceWindowTargets.windowId, windowId));
    const unique = [...new Set(subjects.targetIds)];
    if (unique.length > 0) {
      await tx
        .insert(maintenanceWindowTargets)
        .values(unique.map((targetId) => ({ windowId, targetId })));
    }
  }
  if (subjects.monitorIds) {
    await tx
      .delete(maintenanceWindowMonitors)
      .where(eq(maintenanceWindowMonitors.windowId, windowId));
    const unique = [...new Set(subjects.monitorIds)];
    if (unique.length > 0) {
      await tx
        .insert(maintenanceWindowMonitors)
        .values(unique.map((monitorId) => ({ windowId, monitorId })));
    }
  }
}

export async function createMaintenanceWindow(
  input: CreateMaintenanceInput,
  createdBy: string | null,
  db: Database = getDb(),
): Promise<MaintenanceWindowView> {
  const id = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(maintenanceWindows)
      .values({
        title: input.title,
        note: input.note,
        startsAt: new Date(input.startsAt),
        endsAt: new Date(input.endsAt),
        createdBy,
      })
      .returning({ id: maintenanceWindows.id });
    if (!row) throw new Error('fenêtre de maintenance non créée');
    await writeSubjects(tx as unknown as Database, row.id, input);
    return row.id;
  });
  const created = await getMaintenanceWindow(id, db);
  if (!created) throw new Error('fenêtre de maintenance introuvable après création');
  return created;
}

export async function updateMaintenanceWindow(
  id: string,
  patch: UpdateMaintenanceInput,
  db: Database = getDb(),
): Promise<MaintenanceWindowView | null> {
  const found = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(maintenanceWindows)
      .set({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.note !== undefined ? { note: patch.note } : {}),
        // Un début repoussé dans le futur sera annoncé de nouveau, le moment venu.
        ...(patch.startsAt !== undefined
          ? {
              startsAt: new Date(patch.startsAt),
              ...(new Date(patch.startsAt) > new Date() ? { startedAt: null } : {}),
            }
          : {}),
        ...(patch.endsAt !== undefined ? { endsAt: new Date(patch.endsAt) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(maintenanceWindows.id, id))
      .returning({ id: maintenanceWindows.id });
    if (!row) return false;
    await writeSubjects(tx as unknown as Database, id, patch);
    return true;
  });
  return found ? getMaintenanceWindow(id, db) : null;
}

export async function deleteMaintenanceWindow(
  id: string,
  db: Database = getDb(),
): Promise<boolean> {
  const rows = await db
    .delete(maintenanceWindows)
    .where(eq(maintenanceWindows.id, id))
    .returning({ id: maintenanceWindows.id });
  return rows.length > 0;
}

export async function getMaintenanceWindow(
  id: string,
  db: Database = getDb(),
): Promise<MaintenanceWindowView | null> {
  const rows = await db.select().from(maintenanceWindows).where(eq(maintenanceWindows.id, id));
  return (await viewsOf(rows, db))[0] ?? null;
}

/**
 * Les fenêtres à montrer : en cours et à venir, puis les `endedLimit`
 * dernières terminées. Les plus proches d'abord.
 */
export async function listMaintenanceWindows(
  options: { endedLimit?: number; now?: Date } = {},
  db: Database = getDb(),
): Promise<MaintenanceWindowView[]> {
  const now = options.now ?? new Date();
  const [current, ended] = await Promise.all([
    db
      .select()
      .from(maintenanceWindows)
      .where(gt(maintenanceWindows.endsAt, now))
      .orderBy(asc(maintenanceWindows.startsAt)),
    db
      .select()
      .from(maintenanceWindows)
      .where(lte(maintenanceWindows.endsAt, now))
      .orderBy(desc(maintenanceWindows.endsAt))
      .limit(options.endedLimit ?? 20),
  ]);
  return viewsOf([...current, ...ended], db);
}

// ─── Ce qui couvre un sujet ───────────────────────────────────────────────────

/** Les fenêtres actives à `at` qui nomment l'une de ces cibles, la plus tardive d'abord. */
async function windowsForTargets(
  targetIds: string[],
  at: Date,
  db: Database,
): Promise<Array<{ id: string; endsAt: Date }>> {
  if (targetIds.length === 0) return [];
  return db
    .selectDistinct({ id: maintenanceWindows.id, endsAt: maintenanceWindows.endsAt })
    .from(maintenanceWindows)
    .innerJoin(
      maintenanceWindowTargets,
      eq(maintenanceWindowTargets.windowId, maintenanceWindows.id),
    )
    .where(
      and(
        inArray(maintenanceWindowTargets.targetId, targetIds),
        lte(maintenanceWindows.startsAt, at),
        gt(maintenanceWindows.endsAt, at),
      ),
    );
}

/**
 * Les fenêtres qui couvrent ce sujet à l'instant `at`, celle qui finit le plus
 * tard d'abord — c'est elle qui garde l'alerte, pour qu'elle ne parte qu'une
 * fois toutes les fenêtres refermées.
 *
 * - une cible : les fenêtres qui la nomment ;
 * - une sonde : celles qui la nomment, et celles qui nomment une cible où
 *   tourne l'application qu'elle surveille (`listLiveDeployments`, l'unique
 *   définition de « ce qui tourne ») ;
 * - un domaine : celles qui nomment sa cible.
 */
export async function windowsCovering(
  subject: MaintenanceSubject,
  at: Date = new Date(),
  db: Database = getDb(),
): Promise<Array<{ id: string; endsAt: Date }>> {
  const found: Array<{ id: string; endsAt: Date }> = [];
  if (subject.type === 'target') {
    found.push(...(await windowsForTargets([subject.id], at, db)));
  } else if (subject.type === 'route') {
    const [route] = await db
      .select({ targetId: routes.targetId })
      .from(routes)
      .where(eq(routes.id, subject.id));
    if (route) found.push(...(await windowsForTargets([route.targetId], at, db)));
  } else {
    const named = await db
      .select({ id: maintenanceWindows.id, endsAt: maintenanceWindows.endsAt })
      .from(maintenanceWindows)
      .innerJoin(
        maintenanceWindowMonitors,
        eq(maintenanceWindowMonitors.windowId, maintenanceWindows.id),
      )
      .where(
        and(
          eq(maintenanceWindowMonitors.monitorId, subject.id),
          lte(maintenanceWindows.startsAt, at),
          gt(maintenanceWindows.endsAt, at),
        ),
      );
    found.push(...named);
    const [monitor] = await db
      .select({ applicationId: monitors.applicationId })
      .from(monitors)
      .where(eq(monitors.id, subject.id));
    if (monitor?.applicationId) {
      const live = await listLiveDeployments({ applicationId: monitor.applicationId }, db);
      found.push(
        ...(await windowsForTargets([...new Set(live.map((row) => row.targetId))], at, db)),
      );
    }
  }
  const unique = new Map(found.map((window) => [window.id, window]));
  return [...unique.values()].sort((a, b) => b.endsAt.getTime() - a.endsAt.getTime());
}

export type MaintenanceCoverage = {
  /** Par cible, les fenêtres actives qui la couvrent. */
  targets: Map<string, Array<{ id: string; title: string; endsAt: Date }>>;
  /** Par sonde, les fenêtres actives qui la couvrent, directement ou par sa cible. */
  monitors: Map<string, Array<{ id: string; title: string; endsAt: Date }>>;
};

/**
 * Tout ce que couvrent les fenêtres actives à `at`, d'un coup : pour les écrans
 * qui marquent leurs lignes « en maintenance » sans poser la question sujet
 * par sujet.
 */
export async function maintenanceCoverage(
  at: Date = new Date(),
  db: Database = getDb(),
): Promise<MaintenanceCoverage> {
  const coverage: MaintenanceCoverage = { targets: new Map(), monitors: new Map() };
  const active = await db
    .select()
    .from(maintenanceWindows)
    .where(and(lte(maintenanceWindows.startsAt, at), gt(maintenanceWindows.endsAt, at)));
  if (active.length === 0) return coverage;
  const byId = new Map(active.map((row) => [row.id, row]));
  const brief = (id: string) => {
    const row = byId.get(id)!;
    return { id: row.id, title: row.title, endsAt: row.endsAt };
  };
  const push = (
    map: Map<string, Array<{ id: string; title: string; endsAt: Date }>>,
    key: string,
    windowId: string,
  ) => {
    const list = map.get(key) ?? [];
    if (!list.some((entry) => entry.id === windowId)) list.push(brief(windowId));
    map.set(key, list);
  };

  const ids = [...byId.keys()];
  const [targetLinks, monitorLinks, monitorApps, live] = await Promise.all([
    db
      .select()
      .from(maintenanceWindowTargets)
      .where(inArray(maintenanceWindowTargets.windowId, ids)),
    db
      .select()
      .from(maintenanceWindowMonitors)
      .where(inArray(maintenanceWindowMonitors.windowId, ids)),
    db
      .select({ id: monitors.id, applicationId: monitors.applicationId })
      .from(monitors)
      .where(sql`${monitors.applicationId} is not null`),
    listLiveDeployments({}, db),
  ]);
  for (const link of targetLinks) push(coverage.targets, link.targetId, link.windowId);
  for (const link of monitorLinks) push(coverage.monitors, link.monitorId, link.windowId);
  for (const monitor of monitorApps) {
    for (const row of live) {
      if (row.applicationId !== monitor.applicationId) continue;
      for (const window of coverage.targets.get(row.targetId) ?? []) {
        push(coverage.monitors, monitor.id, window.id);
      }
    }
  }
  return coverage;
}

// ─── Les alertes retenues ─────────────────────────────────────────────────────

export async function holdMaintenanceAlert(
  alert: {
    windowId: string;
    event: string;
    family: string;
    opens: boolean;
    label: string;
    subject: MaintenanceSubject;
    data: Record<string, unknown>;
  },
  db: Database = getDb(),
): Promise<void> {
  await db.insert(maintenanceHeldAlerts).values({
    windowId: alert.windowId,
    event: alert.event,
    family: alert.family,
    opens: alert.opens,
    label: alert.label,
    subjectType: alert.subject.type,
    subjectId: alert.subject.id,
    data: alert.data,
  });
}

export async function heldMaintenanceAlerts(
  windowId: string,
  db: Database = getDb(),
): Promise<MaintenanceHeldAlertRow[]> {
  return db
    .select()
    .from(maintenanceHeldAlerts)
    .where(eq(maintenanceHeldAlerts.windowId, windowId))
    .orderBy(asc(maintenanceHeldAlerts.heldAt));
}

export async function markMaintenanceAlertsReleased(
  ids: string[],
  at: Date = new Date(),
  db: Database = getDb(),
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(maintenanceHeldAlerts)
    .set({ releasedAt: at })
    .where(inArray(maintenanceHeldAlerts.id, ids));
}

// ─── Le balayage ──────────────────────────────────────────────────────────────

/**
 * Les fenêtres dont le début est passé et pas encore annoncé — prises d'un
 * coup, pour qu'un second balayage concurrent ne les annonce pas deux fois.
 * Une fenêtre déjà finie n'est pas annoncée : sa fin le sera.
 */
export async function claimMaintenanceStarts(
  now: Date = new Date(),
  db: Database = getDb(),
): Promise<MaintenanceWindowRow[]> {
  return db
    .update(maintenanceWindows)
    .set({ startedAt: now })
    .where(
      and(
        isNull(maintenanceWindows.startedAt),
        lte(maintenanceWindows.startsAt, now),
        gt(maintenanceWindows.endsAt, now),
      ),
    )
    .returning();
}

/** Les fenêtres dont la fin est passée et pas encore traitée, prises d'un coup. */
export async function claimMaintenanceEnds(
  now: Date = new Date(),
  db: Database = getDb(),
): Promise<MaintenanceWindowRow[]> {
  return db
    .update(maintenanceWindows)
    .set({ endedAt: now })
    .where(and(isNull(maintenanceWindows.endedAt), lte(maintenanceWindows.endsAt, now)))
    .returning();
}

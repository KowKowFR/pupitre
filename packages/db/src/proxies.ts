import {
  decrypt,
  encrypt,
  type ProxyKind,
  type ProxyStatus,
  type RouteCertificate,
  type RouteInput,
  type RouteStatus,
} from '@pupitre/core';
import { and, asc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { getDb, type Database } from './client.js';
import { applications, targets } from './schema/infra.js';
import { proxies, routes, type ProxyRow, type RouteRow } from './schema/proxies.js';

/**
 * Les reverse proxies et leurs routes.
 *
 * Même règle que `targets.ts` et `backups.ts` : `encrypted_secrets` ne sort
 * d'ici que par `resolveProxySecrets()`, réservée au worker. Toute autre
 * lecture rend la connexion sans ses secrets.
 */

export type ProxyView = Omit<ProxyRow, 'encryptedSecrets'>;

function view(row: ProxyRow): ProxyView {
  const { encryptedSecrets: _secrets, ...rest } = row;
  return rest;
}

// ─── connexions ──────────────────────────────────────────────────────────────

/** Le proxy qui sert cette machine — aujourd'hui, celui qui y tourne. */
export async function getProxyForTarget(
  targetId: string,
  db: Database = getDb(),
): Promise<ProxyView | null> {
  const [row] = await db.select().from(proxies).where(eq(proxies.hostTargetId, targetId));
  return row ? view(row) : null;
}

export async function getProxy(id: string, db: Database = getDb()): Promise<ProxyView | null> {
  const [row] = await db.select().from(proxies).where(eq(proxies.id, id));
  return row ? view(row) : null;
}

/** Les proxies par machine servie : pour la liste des cibles. */
export async function listTargetProxies(db: Database = getDb()): Promise<Map<string, ProxyView>> {
  const rows = await db.select().from(proxies);
  return new Map(
    rows.filter((row) => row.hostTargetId !== null).map((row) => [row.hostTargetId!, view(row)]),
  );
}

/**
 * Pose (ou remplace) la connexion d'une machine. Une seule par machine : un
 * second proxy sur les mêmes ports 80 et 443 n'aurait pas de sens.
 */
export async function saveTargetProxy(
  input: {
    targetId: string;
    kind: ProxyKind;
    name: string;
    config: Record<string, unknown>;
    managed: boolean;
    status: ProxyStatus;
    secrets?: Record<string, string> | null;
    createdBy: string | null;
  },
  db: Database = getDb(),
): Promise<ProxyView> {
  const values = {
    kind: input.kind,
    name: input.name,
    placement: 'target' as const,
    hostTargetId: input.targetId,
    config: input.config,
    encryptedSecrets:
      input.secrets && Object.keys(input.secrets).length > 0
        ? encrypt(JSON.stringify(input.secrets))
        : null,
    managed: input.managed,
    status: input.status,
    lastCheckedAt: null,
    lastCheckError: null,
    lastCheck: null,
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(proxies)
    .values({ ...values, createdBy: input.createdBy })
    .onConflictDoUpdate({
      target: proxies.hostTargetId,
      targetWhere: sql`${proxies.hostTargetId} is not null`,
      set: values,
    })
    .returning();
  if (!row) throw new Error("la connexion au proxy n'a pas été enregistrée");
  return view(row);
}

export async function setProxyStatus(
  id: string,
  update: {
    status: ProxyStatus;
    error?: string | null;
    check?: Record<string, unknown> | null;
    config?: Record<string, unknown>;
    managed?: boolean;
  },
  db: Database = getDb(),
): Promise<void> {
  await db
    .update(proxies)
    .set({
      status: update.status,
      ...(update.error !== undefined ? { lastCheckError: update.error } : {}),
      ...(update.check !== undefined ? { lastCheck: update.check, lastCheckedAt: new Date() } : {}),
      ...(update.config ? { config: update.config } : {}),
      ...(update.managed !== undefined ? { managed: update.managed } : {}),
      updatedAt: new Date(),
    })
    .where(eq(proxies.id, id));
}

export async function deleteProxy(id: string, db: Database = getDb()): Promise<void> {
  await db.delete(proxies).where(eq(proxies.id, id));
}

/** Pour le worker seul : les secrets de la connexion, déchiffrés. */
export async function resolveProxySecrets(
  id: string,
  db: Database = getDb(),
): Promise<Record<string, string>> {
  const [row] = await db
    .select({ secrets: proxies.encryptedSecrets })
    .from(proxies)
    .where(eq(proxies.id, id));
  return row?.secrets ? (JSON.parse(decrypt(row.secrets)) as Record<string, string>) : {};
}

// ─── routes ──────────────────────────────────────────────────────────────────

/** Un domaine déjà pris par une autre application, ou sur une autre cible. */
export class RouteTakenError extends Error {
  constructor(
    readonly hostname: string,
    readonly application: string | null,
  ) {
    super(
      application
        ? `le domaine « ${hostname} » est déjà routé vers « ${application} »`
        : `le domaine « ${hostname} » est déjà routé`,
    );
    this.name = 'RouteTakenError';
  }
}

function isUniqueViolation(error: unknown): boolean {
  const cause = (error as { cause?: unknown } | null)?.cause ?? error;
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === '23505';
}

export type RouteView = RouteRow & { applicationSlug: string; targetName: string };

export async function listRoutes(
  filter: { applicationId?: string; targetId?: string },
  db: Database = getDb(),
): Promise<RouteView[]> {
  const rows = await db
    .select({ route: routes, applicationSlug: applications.slug, targetName: targets.name })
    .from(routes)
    .innerJoin(applications, eq(applications.id, routes.applicationId))
    .innerJoin(targets, eq(targets.id, routes.targetId))
    .where(
      and(
        filter.applicationId ? eq(routes.applicationId, filter.applicationId) : undefined,
        filter.targetId ? eq(routes.targetId, filter.targetId) : undefined,
      ),
    )
    .orderBy(asc(routes.hostname));
  return rows.map((row) => ({
    ...row.route,
    applicationSlug: row.applicationSlug,
    targetName: row.targetName,
  }));
}

/**
 * Les domaines d'une application sur une cible, en une fois : ceux qui ne
 * sont plus dans la liste partent, les autres sont posés ou mis à jour. Un
 * domaine pris ailleurs est refusé — vérifié avant, et tenu par la contrainte
 * d'unicité si deux demandes se croisent.
 */
export async function replaceRoutes(
  applicationId: string,
  targetId: string,
  wanted: Array<Required<RouteInput>>,
  db: Database = getDb(),
): Promise<RouteRow[]> {
  try {
    return await db.transaction(async (tx) => {
      const hostnames = wanted.map((route) => route.hostname);
      if (hostnames.length > 0) {
        const existing = await tx
          .select({
            hostname: routes.hostname,
            slug: applications.slug,
            targetId: routes.targetId,
            applicationId: routes.applicationId,
          })
          .from(routes)
          .innerJoin(applications, eq(applications.id, routes.applicationId))
          .where(inArray(routes.hostname, hostnames));
        const taken = existing.find(
          (row) => row.applicationId !== applicationId || row.targetId !== targetId,
        );
        if (taken) throw new RouteTakenError(taken.hostname, taken.slug);
      }
      await tx
        .delete(routes)
        .where(
          and(
            eq(routes.applicationId, applicationId),
            eq(routes.targetId, targetId),
            hostnames.length > 0 ? notInArray(routes.hostname, hostnames) : undefined,
          ),
        );
      const saved: RouteRow[] = [];
      for (const route of wanted) {
        const [row] = await tx
          .insert(routes)
          .values({ applicationId, targetId, ...route })
          .onConflictDoUpdate({
            target: routes.hostname,
            set: { tls: route.tls, redirectHttps: route.redirectHttps, updatedAt: new Date() },
          })
          .returning();
        if (row) saved.push(row);
      }
      return saved;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new RouteTakenError(wanted[0]?.hostname ?? '?', null);
    }
    throw error;
  }
}

export async function setRouteStatus(
  id: string,
  update: { status: RouteStatus; error: string | null; certificate?: RouteCertificate | null },
  db: Database = getDb(),
): Promise<void> {
  await db
    .update(routes)
    .set({
      status: update.status,
      lastError: update.error,
      lastCheckedAt: new Date(),
      ...(update.certificate !== undefined ? { certificate: update.certificate } : {}),
      updatedAt: new Date(),
    })
    .where(eq(routes.id, id));
}

export async function deleteRoutesOf(
  applicationId: string,
  targetId: string,
  db: Database = getDb(),
): Promise<number> {
  const removed = await db
    .delete(routes)
    .where(and(eq(routes.applicationId, applicationId), eq(routes.targetId, targetId)))
    .returning({ id: routes.id });
  return removed.length;
}

/** Les routes d'une machine, par application : pour la carte du proxy et sa suppression. */
export async function countRoutesByTarget(
  targetId: string,
  db: Database = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(routes)
    .where(eq(routes.targetId, targetId));
  return row?.count ?? 0;
}

/** Les couples (application, cible) qui ont des routes — ce que la sonde périodique parcourt. */
export async function listRoutedCouples(
  db: Database = getDb(),
): Promise<Array<{ applicationId: string; targetId: string }>> {
  return db
    .selectDistinct({ applicationId: routes.applicationId, targetId: routes.targetId })
    .from(routes);
}

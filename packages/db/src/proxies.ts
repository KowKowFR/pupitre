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
import {
  proxies,
  proxyLinks,
  routes,
  type ProxyLinkRow,
  type ProxyRow,
  type RouteRow,
} from './schema/proxies.js';

/**
 * The reverse proxies and their routes.
 *
 * The same rule as `targets.ts` and `backups.ts`: `encrypted_secrets` only
 * leaves here through `resolveProxySecrets()`, reserved to the worker. Any other
 * read returns the connection without its secrets.
 */

export type ProxyView = Omit<ProxyRow, 'encryptedSecrets'>;

function view(row: ProxyRow): ProxyView {
  const { encryptedSecrets: _secrets, ...rest } = row;
  return rest;
}

// ─── connections ─────────────────────────────────────────────────────────────

/** The proxy serving this machine — today, the one running on it. */
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

/** The proxies per served machine: for the targets list. */
export async function listTargetProxies(db: Database = getDb()): Promise<Map<string, ProxyView>> {
  const rows = await db.select().from(proxies);
  return new Map(
    rows.filter((row) => row.hostTargetId !== null).map((row) => [row.hostTargetId!, view(row)]),
  );
}

/**
 * Sets (or replaces) a machine's connection. Only one per machine: a second
 * proxy on the same ports 80 and 443 would make no sense.
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
  if (!row) throw new Error('the proxy connection was not saved');
  return view(row);
}

/**
 * A connection to a **remote** proxy — outside the targets, reached through its
 * API (Nginx Proxy Manager). Its credentials are encrypted here, and only come
 * back out through `resolveProxySecrets()`.
 */
export async function createRemoteProxy(
  input: {
    kind: ProxyKind;
    name: string;
    config: Record<string, unknown>;
    secrets: Record<string, string>;
    createdBy: string | null;
  },
  db: Database = getDb(),
): Promise<ProxyView> {
  const [row] = await db
    .insert(proxies)
    .values({
      kind: input.kind,
      name: input.name,
      placement: 'remote',
      hostTargetId: null,
      config: input.config,
      encryptedSecrets: encrypt(JSON.stringify(input.secrets)),
      managed: false,
      status: 'unknown',
      createdBy: input.createdBy,
    })
    .returning();
  if (!row) throw new Error('the proxy connection was not saved');
  return view(row);
}

/**
 * Changes a remote connection. `secrets` absent: the previous ones stay — a form
 * does not have to send back a password it never received.
 */
export async function updateRemoteProxy(
  id: string,
  input: {
    name?: string;
    config: Record<string, unknown>;
    secrets?: Record<string, string>;
  },
  db: Database = getDb(),
): Promise<ProxyView | null> {
  const [row] = await db
    .update(proxies)
    .set({
      ...(input.name ? { name: input.name } : {}),
      config: input.config,
      ...(input.secrets ? { encryptedSecrets: encrypt(JSON.stringify(input.secrets)) } : {}),
      status: 'unknown',
      lastCheckError: null,
      lastCheck: null,
      lastCheckedAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(proxies.id, id), eq(proxies.placement, 'remote')))
    .returning();
  return row ? view(row) : null;
}

/** The remote proxies, each with the number of machines it serves. */
export async function listRemoteProxies(
  db: Database = getDb(),
): Promise<Array<ProxyView & { linkCount: number }>> {
  const rows = await db
    .select({
      proxy: proxies,
      linkCount: sql<number>`(select count(*)::int from ${proxyLinks} where ${proxyLinks.proxyId} = ${proxies.id})`,
    })
    .from(proxies)
    .where(eq(proxies.placement, 'remote'))
    .orderBy(asc(proxies.name));
  return rows.map((row) => ({ ...view(row.proxy), linkCount: row.linkCount }));
}

export async function setProxyStatus(
  id: string,
  update: {
    status: ProxyStatus;
    error?: string | null;
    check?: Record<string, unknown> | null;
    config?: Record<string, unknown>;
    managed?: boolean;
    name?: string;
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
      ...(update.name ? { name: update.name } : {}),
      updatedAt: new Date(),
    })
    .where(eq(proxies.id, id));
}

export async function deleteProxy(id: string, db: Database = getDb()): Promise<void> {
  await db.delete(proxies).where(eq(proxies.id, id));
}

/** For the worker alone: the connection's secrets, decrypted. */
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

// ─── the central proxy ───────────────────────────────────────────────────────

/** The proxy serving a machine: its own, or another's through a link. */
export type ServingProxy = {
  proxy: ProxyView;
  /** `null`: the proxy runs on the machine itself. */
  link: ProxyLinkRow | null;
};

export async function getTargetLink(
  targetId: string,
  db: Database = getDb(),
): Promise<ProxyLinkRow | null> {
  const [row] = await db.select().from(proxyLinks).where(eq(proxyLinks.targetId, targetId));
  return row ?? null;
}

/**
 * Who serves this machine. Its own proxy first — a machine that has one has no
 * link, the API makes sure of it —, otherwise its link's.
 */
export async function resolveServingProxy(
  targetId: string,
  db: Database = getDb(),
): Promise<ServingProxy | null> {
  const own = await getProxyForTarget(targetId, db);
  if (own) return { proxy: own, link: null };
  const link = await getTargetLink(targetId, db);
  if (!link) return null;
  const proxy = await getProxy(link.proxyId, db);
  return proxy ? { proxy, link } : null;
}

/** Each served machine's proxy, its own or another's: for the lists. */
export async function listServingProxies(
  db: Database = getDb(),
): Promise<Map<string, ServingProxy>> {
  const [all, links] = await Promise.all([db.select().from(proxies), db.select().from(proxyLinks)]);
  const byId = new Map(all.map((row) => [row.id, view(row)]));
  const serving = new Map<string, ServingProxy>();
  for (const row of all) {
    if (row.hostTargetId) serving.set(row.hostTargetId, { proxy: view(row), link: null });
  }
  for (const link of links) {
    const proxy = byId.get(link.proxyId);
    if (proxy && !serving.has(link.targetId)) serving.set(link.targetId, { proxy, link });
  }
  return serving;
}

export async function saveTargetLink(
  input: { targetId: string; proxyId: string; address: string; createdBy: string | null },
  db: Database = getDb(),
): Promise<ProxyLinkRow> {
  const values = {
    proxyId: input.proxyId,
    address: input.address,
    sourceAddress: null,
    bindable: false,
    status: 'unknown' as const,
    lastCheckedAt: null,
    lastCheckError: null,
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(proxyLinks)
    .values({ targetId: input.targetId, ...values, createdBy: input.createdBy })
    .onConflictDoUpdate({ target: proxyLinks.targetId, set: values })
    .returning();
  if (!row) throw new Error('the link was not saved');
  return row;
}

export async function setTargetLinkCheck(
  targetId: string,
  check: {
    status: ProxyStatus;
    sourceAddress: string | null;
    bindable: boolean;
    error: string | null;
  },
  db: Database = getDb(),
): Promise<void> {
  await db
    .update(proxyLinks)
    .set({
      status: check.status,
      sourceAddress: check.sourceAddress,
      bindable: check.bindable,
      lastCheckError: check.error,
      lastCheckedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(proxyLinks.targetId, targetId));
}

export async function deleteTargetLink(targetId: string, db: Database = getDb()): Promise<void> {
  await db.delete(proxyLinks).where(eq(proxyLinks.targetId, targetId));
}

/** The machines a proxy serves through a link, with their name. */
export async function listProxyLinks(
  proxyId: string,
  db: Database = getDb(),
): Promise<Array<ProxyLinkRow & { targetName: string }>> {
  const rows = await db
    .select({ link: proxyLinks, targetName: targets.name })
    .from(proxyLinks)
    .innerJoin(targets, eq(targets.id, proxyLinks.targetId))
    .where(eq(proxyLinks.proxyId, proxyId))
    .orderBy(asc(targets.name));
  return rows.map((row) => ({ ...row.link, targetName: row.targetName }));
}

/** The domains going through this proxy: its machine's and those of the machines it serves. */
export async function countRoutesServedBy(
  proxyId: string,
  db: Database = getDb(),
): Promise<number> {
  const proxy = await getProxy(proxyId, db);
  if (!proxy) return 0;
  const linked = await db
    .select({ targetId: proxyLinks.targetId })
    .from(proxyLinks)
    .where(eq(proxyLinks.proxyId, proxyId));
  const targetIds = [
    ...(proxy.hostTargetId ? [proxy.hostTargetId] : []),
    ...linked.map((row) => row.targetId),
  ];
  if (targetIds.length === 0) return 0;
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(routes)
    .where(inArray(routes.targetId, targetIds));
  return row?.count ?? 0;
}

// ─── routes ──────────────────────────────────────────────────────────────────

/** A domain already taken by another application, or on another target. */
export class RouteTakenError extends Error {
  constructor(
    readonly hostname: string,
    readonly application: string | null,
  ) {
    super(
      application
        ? `the domain "${hostname}" is already routed to "${application}"`
        : `the domain "${hostname}" is already routed`,
    );
    this.name = 'RouteTakenError';
  }
}

function isUniqueViolation(error: unknown): boolean {
  const cause = (error as { cause?: unknown } | null)?.cause ?? error;
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === '23505';
}

export type RouteView = RouteRow & { applicationSlug: string; targetName: string };

/** A route, by its identifier. */
export async function getRouteById(id: string, db: Database = getDb()): Promise<RouteRow | null> {
  const [row] = await db.select().from(routes).where(eq(routes.id, id)).limit(1);
  return row ?? null;
}

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
 * An application's domains on a target, at once: those no longer in the list
 * go, the others are set or updated. A domain taken elsewhere is refused —
 * checked before, and held by the uniqueness constraint if two requests cross.
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
            set: {
              tls: route.tls,
              redirectHttps: route.redirectHttps,
              waf: route.waf,
              updatedAt: new Date(),
            },
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

/** The expiry of the certificate reported for this route, or `null` once renewed. */
export async function setRouteCertificateAlert(
  id: string,
  notAfter: string | null,
  db: Database = getDb(),
): Promise<void> {
  await db.update(routes).set({ certificateAlert: notAfter }).where(eq(routes.id, id));
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

/** A machine's routes, per application: for the proxy's map and its deletion. */
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

/** The (application, target) pairs that have routes — what the periodic probe goes through. */
export async function listRoutedCouples(
  db: Database = getDb(),
): Promise<Array<{ applicationId: string; targetId: string }>> {
  return db
    .selectDistinct({ applicationId: routes.applicationId, targetId: routes.targetId })
    .from(routes);
}

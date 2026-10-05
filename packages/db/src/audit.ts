import { z } from 'zod';
import { and, asc, count, desc, eq, gte, ilike, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import {
  AUDIT_SEVERITIES,
  AUDIT_SEVERITY_RULES,
  auditSeverityLikePattern,
  parseAuditSeverities,
  type AuditSeverity,
} from '@pupitre/core';
import { getDb, type Database } from './client.js';
import { auditLogs } from './schema/ops.js';
import { apiTokens } from './schema/api-tokens.js';
import { users } from './schema/auth.js';

/**
 * SINGLE entry point of the audit log.
 * No `insert into audit_logs` must exist anywhere else in the project.
 *
 * `logAudit()` never throws: an unavailable audit log degrades traceability, it
 * must not break the user's request. The failure is reported on the error
 * channel provided by the caller.
 */

export const auditEntrySchema = z.object({
  /** `null` for a system action (worker, scheduler) or an anonymous actor. */
  actorId: z.string().min(1).nullable().default(null),
  /** Business verb, e.g. `auth.login.succeeded`, `deployment.created`. */
  action: z.string().min(1).max(120),
  resourceType: z.string().min(1).max(60),
  resourceId: z.string().min(1).max(200).nullable().default(null),
  before: z.unknown().nullable().default(null),
  after: z.unknown().nullable().default(null),
  ip: z.string().min(1).max(64).nullable().default(null),
  /**
   * Absent: read from the current request by the context provider (see
   * `setAuditContextProvider`). Cut rather than refused beyond 512 characters — a
   * header too long must not cost the audit line.
   */
  userAgent: z
    .string()
    .nullable()
    .optional()
    .transform((value) => (value ? value.slice(0, 512) : value)),
});

export type AuditEntryInput = z.input<typeof auditEntrySchema>;
export type AuditLogRow = typeof auditLogs.$inferSelect;

/** Reports an audit write failure without interrupting the caller. */
export type AuditFailureReporter = (error: unknown, entry: AuditEntryInput) => void;

let reportFailure: AuditFailureReporter = (error, entry) => {
  // eslint-disable-next-line no-console
  console.error('[audit] write failed', { action: entry.action, error });
};

/** Plugs the application's logger (Pino) into audit failures. */
export function setAuditFailureReporter(reporter: AuditFailureReporter): void {
  reportFailure = reporter;
}

/**
 * Observer of the entries **really written**.
 *
 * Why hook in here rather than emit notifications from each action site:
 * `logAudit()` is already the single entry point every event worth notifying
 * goes through — a failed deployment, an automatic rollback, a second factor
 * reset, a role change. Emitting them again by hand would require touching the
 * deployment pipeline, two administration routes and the worker, then starting
 * over at the next event. Here, the mapping fits in a single data table
 * (`@pupitre/core` → `notifiableEventFor`).
 *
 * Three precautions, because this entry point is fragile:
 *   1. the observer is called **after** the write, never before: we do not
 *      notify an event that was not recorded;
 *   2. it cannot fail `logAudit()` — its exception is caught and reported as
 *      such, distinct from a write failure;
 *   3. it is **synchronous and not awaited**: it must merely queue a job. All
 *      real work belongs to the worker.
 *
 * The state lives on `globalThis` and not in a module variable: Next splits the
 * server code into chunks and may load several copies of this module. With a
 * module variable, the observer installed at the panel's startup would be
 * invisible from the copy loaded by a Route Handler. The same pattern as the
 * instance settings cache, and for the same reason.
 */
export type AuditObserver = (row: AuditLogRow) => void;

declare global {
  var __tpAuditObserver: AuditObserver | undefined;
  var __tpAuditObservers: Map<string, AuditObserver> | undefined;
}

/**
 * What the current request says about itself, for the entries that do not
 * specify it: the `User-Agent`, and the API token it authenticated with — that
 * is what tells apart, in the log, what a person did from what their CI did in
 * their name.
 *
 * A provider rather than a field added to each call: `logAudit()` is called from
 * a hundred places, and a browser forgotten at one of them would be a silent
 * hole in the log. The panel installs its own at startup (it reads the request's
 * headers); the worker installs none — its actions have no request behind them.
 * The same storage as the observer, on `globalThis`, and for the same reason.
 */
export type AuditContextProvider = () => Promise<{
  userAgent: string | null;
  apiTokenId?: string | null;
}>;

declare global {
  var __tpAuditContext: AuditContextProvider | undefined;
}

export function setAuditContextProvider(provider: AuditContextProvider | null): void {
  globalThis.__tpAuditContext = provider ?? undefined;
}

async function requestContext(): Promise<{ userAgent: string | null; apiTokenId: string | null }> {
  const provider = globalThis.__tpAuditContext;
  if (!provider) return { userAgent: null, apiTokenId: null };
  try {
    const context = await provider();
    return { userAgent: context.userAgent, apiTokenId: context.apiTokenId ?? null };
  } catch {
    return { userAgent: null, apiTokenId: null };
  }
}

export function setAuditObserver(observer: AuditObserver | null): void {
  globalThis.__tpAuditObserver = observer ?? undefined;
}

/**
 * One more observer, under a name — real time, next to notifications. The same
 * three precautions: called after the write, never blocking, never able to fail
 * the audit. Installing again under the same name replaces (`next dev`'s HMR
 * reruns the installation).
 */
export function setNamedAuditObserver(name: string, observer: AuditObserver | null): void {
  globalThis.__tpAuditObservers ??= new Map();
  if (observer) globalThis.__tpAuditObservers.set(name, observer);
  else globalThis.__tpAuditObservers.delete(name);
}

function notifyObserver(row: AuditLogRow): void {
  const observers = [
    globalThis.__tpAuditObserver,
    ...(globalThis.__tpAuditObservers?.values() ?? []),
  ];
  for (const observer of observers) {
    if (!observer) continue;
    try {
      observer(row);
    } catch (error) {
      reportFailure(error, { action: `observer:${row.action}`, resourceType: row.resourceType });
    }
  }
}

/**
 * Writes an audit line. Returns `null` if the write failed — the caller has
 * nothing to handle, the failure is already logged as an error.
 */
export async function logAudit(
  entry: AuditEntryInput,
  db: Database = getDb(),
): Promise<AuditLogRow | null> {
  try {
    const parsed = auditEntrySchema.parse(entry);
    const context = await requestContext();
    const userAgent =
      parsed.userAgent !== undefined ? parsed.userAgent : context.userAgent?.slice(0, 512);
    const [row] = await db
      .insert(auditLogs)
      .values({
        actorId: parsed.actorId,
        action: parsed.action,
        resourceType: parsed.resourceType,
        resourceId: parsed.resourceId,
        before: parsed.before ?? null,
        after: parsed.after ?? null,
        ip: parsed.ip,
        userAgent: userAgent ?? null,
        apiTokenId: context.apiTokenId,
      })
      .returning();
    // `notifyObserver` never fails: placing it here rather than after the `try`
    // avoids duplicating the return path without risking turning a notification
    // problem into an audit failure.
    if (row) notifyObserver(row);
    return row ?? null;
  } catch (error) {
    reportFailure(error, entry);
    return null;
  }
}

// ─── Reading ──────────────────────────────────────────────────────────────────

export const auditQuerySchema = z.object({
  actorId: z.string().min(1).max(200).optional(),
  action: z.string().min(1).max(120).optional(),
  resourceType: z.string().min(1).max(60).optional(),
  /** `high,critical`: one or several severities; empty, all of them. */
  severity: z
    .string()
    .max(60)
    .optional()
    .transform((value) => parseAuditSeverities(value)),
  /** Free search: action, resource, actor, IP, payload. */
  q: z.string().trim().min(1).max(200).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export type AuditQuery = z.infer<typeof auditQuerySchema>;

/** The filters alone, without pagination or order: what the export takes from the list. */
export type AuditFilter = Pick<
  AuditQuery,
  'actorId' | 'action' | 'resourceType' | 'from' | 'to' | 'q'
> & { severity?: AuditSeverity[] };

/**
 * An entry's severity, computed in the database from `@pupitre/core`'s table —
 * the one the screen uses: the filtered list and the badges cannot contradict
 * each other. The patterns are written in clear in the query (they are our
 * constants, checked below), so that the expression is identical wherever it is
 * used, `GROUP BY` included.
 */
const severityExpression: SQL<AuditSeverity> = (() => {
  const literal = (value: string) => {
    if (!/^[a-z0-9_.%\\]+$/.test(value)) throw new Error(`invalid severity pattern: ${value}`);
    return `'${value}'`;
  };
  const branches = AUDIT_SEVERITY_RULES.map(
    ([pattern, severity]) =>
      `when "audit_logs"."action" like ${literal(auditSeverityLikePattern(pattern))} then ${literal(severity)}`,
  );
  return sql.raw(`(case ${branches.join(' ')} else 'low' end)`) as SQL<AuditSeverity>;
})();

/** `%term%`, the user's wildcards escaped: we search for what they typed. */
function containing(term: string): string {
  return `%${term.replace(/[\\%_]/g, '\\$&')}%`;
}

function auditWhere(filter: AuditFilter) {
  const term = filter.q ? containing(filter.q) : null;
  const filters = [
    filter.actorId ? eq(auditLogs.actorId, filter.actorId) : undefined,
    filter.action ? eq(auditLogs.action, filter.action) : undefined,
    filter.resourceType ? eq(auditLogs.resourceType, filter.resourceType) : undefined,
    filter.from ? gte(auditLogs.createdAt, filter.from) : undefined,
    filter.to ? lte(auditLogs.createdAt, filter.to) : undefined,
    filter.severity &&
    filter.severity.length > 0 &&
    filter.severity.length < AUDIT_SEVERITIES.length
      ? sql`${severityExpression} in (${sql.join(
          filter.severity.map((severity) => sql`${severity}`),
          sql`, `,
        )})`
      : undefined,
    term
      ? or(
          ilike(auditLogs.action, term),
          ilike(auditLogs.resourceType, term),
          ilike(auditLogs.resourceId, term),
          ilike(auditLogs.ip, term),
          sql`${auditLogs.actorId} in (select ${users.id} from ${users} where ${users.email} ilike ${term} or ${users.name} ilike ${term})`,
          sql`${auditLogs.after}::text ilike ${term}`,
          sql`${auditLogs.before}::text ilike ${term}`,
        )
      : undefined,
  ].filter((f) => f !== undefined);

  return filters.length > 0 ? and(...filters) : undefined;
}

export type AuditLogPage = {
  items: Array<
    AuditLogRow & {
      actorEmail: string | null;
      actorName: string | null;
      /** The name of the API token that carried the action, if there was one. */
      apiTokenName: string | null;
    }
  >;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export async function listAuditLogs(
  query: AuditQuery,
  db: Database = getDb(),
): Promise<AuditLogPage> {
  const where = auditWhere(query);
  const orderBy = query.order === 'asc' ? asc(auditLogs.createdAt) : desc(auditLogs.createdAt);

  const [rows, total] = await Promise.all([
    db
      .select({
        auditLog: auditLogs,
        actorEmail: users.email,
        actorName: users.name,
        apiTokenName: apiTokens.name,
      })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.actorId))
      .leftJoin(apiTokens, eq(apiTokens.id, auditLogs.apiTokenId))
      .where(where)
      .orderBy(orderBy)
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    countAuditLogs(query, db),
  ]);

  return {
    items: rows.map((row) => ({
      ...row.auditLog,
      actorEmail: row.actorEmail,
      actorName: row.actorName,
      apiTokenName: row.apiTokenName,
    })),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  };
}

/** Number of entries matching the filters. */
export async function countAuditLogs(filter: AuditFilter, db: Database = getDb()): Promise<number> {
  const [row] = await db.select({ value: count() }).from(auditLogs).where(auditWhere(filter));
  return row?.value ?? 0;
}

/**
 * How many entries per severity, under the other filters: what the filter's
 * badges say. The chosen severity does not go into it — otherwise the others
 * would drop to zero as soon as one is ticked.
 */
export async function countAuditLogsBySeverity(
  filter: AuditFilter,
  db: Database = getDb(),
): Promise<Record<AuditSeverity, number>> {
  const rows = await db
    .select({ severity: severityExpression, value: count() })
    .from(auditLogs)
    .where(auditWhere({ ...filter, severity: undefined }))
    .groupBy(severityExpression);
  const counts: Record<AuditSeverity, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const row of rows) counts[row.severity] = row.value;
  return counts;
}

export type AuditExportRow = AuditLogRow & {
  actorEmail: string | null;
  apiTokenName: string | null;
};

/**
 * All the entries matching the filters, in batches, from newest to oldest: it is
 * the export's read.
 *
 * Cursor pagination `(created_at, id)` and not offset: the log grows while it is
 * read — the export itself writes a line in it — and an offset would then make
 * the pages slide. `limit` caps the total.
 */
export async function* iterateAuditLogs(
  filter: AuditFilter,
  options: { limit: number; batchSize?: number },
  db: Database = getDb(),
): AsyncGenerator<AuditExportRow[]> {
  const batchSize = options.batchSize ?? 500;
  let remaining = options.limit;
  let cursor: { createdAt: Date; id: string } | null = null;

  while (remaining > 0) {
    const where = auditWhere(filter);
    const rows: Array<{
      auditLog: AuditLogRow;
      actorEmail: string | null;
      apiTokenName: string | null;
    }> = await db
      .select({ auditLog: auditLogs, actorEmail: users.email, apiTokenName: apiTokens.name })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.actorId))
      .leftJoin(apiTokens, eq(apiTokens.id, auditLogs.apiTokenId))
      .where(
        cursor === null
          ? where
          : and(
              where,
              or(
                lt(auditLogs.createdAt, cursor.createdAt),
                and(eq(auditLogs.createdAt, cursor.createdAt), lt(auditLogs.id, cursor.id)),
              ),
            ),
      )
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(Math.min(batchSize, remaining));

    if (rows.length === 0) return;
    yield rows.map((row) => ({
      ...row.auditLog,
      actorEmail: row.actorEmail,
      apiTokenName: row.apiTokenName,
    }));
    remaining -= rows.length;
    const last = rows[rows.length - 1]!.auditLog;
    cursor = { createdAt: last.createdAt, id: last.id };
    if (rows.length < batchSize) return;
  }
}

/**
 * The people who appear in the log, for the "Actor" filter.
 *
 * Taken from the log and not from the users table: offering someone who never
 * did anything would give an empty list each time. A deleted account no longer
 * appears — its entries lost their actor (`set null`).
 */
export async function listAuditActors(
  db: Database = getDb(),
): Promise<Array<{ id: string; email: string; name: string }>> {
  return db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(users)
    .where(sql`exists (select 1 from ${auditLogs} where ${auditLogs.actorId} = ${users.id})`)
    .orderBy(asc(users.email));
}

/**
 * How a sign-in was completed: password alone, a second factor, or single
 * sign-on.
 */
export type SignInMethod = 'password' | 'totp' | 'backup_code' | 'sso';

/**
 * A user's last successful sign-in, read from the log — the only place where the
 * method is kept: `auth.login.succeeded` carries `method` when a second factor
 * concluded, nothing when the password was enough; a single sign-on is written
 * `auth.sso.login.succeeded`.
 *
 * `before` excludes more recent sign-ins: "My account" passes the start of the
 * current session to get the **previous** sign-in.
 */
export async function lastSignIn(
  userId: string,
  options: { before?: Date } = {},
  db: Database = getDb(),
): Promise<{ at: Date; method: SignInMethod; ip: string | null } | null> {
  const [row] = await db
    .select({
      at: auditLogs.createdAt,
      action: auditLogs.action,
      after: auditLogs.after,
      ip: auditLogs.ip,
    })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.actorId, userId),
        or(
          eq(auditLogs.action, 'auth.login.succeeded'),
          eq(auditLogs.action, 'auth.sso.login.succeeded'),
        ),
        options.before ? lt(auditLogs.createdAt, options.before) : undefined,
      ),
    )
    .orderBy(desc(auditLogs.createdAt))
    .limit(1);
  if (!row) return null;
  const method = (row.after as { method?: unknown } | null)?.method;
  return {
    at: row.at,
    method:
      row.action === 'auth.sso.login.succeeded'
        ? 'sso'
        : method === 'totp' || method === 'backup_code'
          ? method
          : 'password',
    ip: row.ip,
  };
}

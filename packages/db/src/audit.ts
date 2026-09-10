import { z } from 'zod';
import { and, asc, count, desc, eq, gte, lte } from 'drizzle-orm';
import { getDb, type Database } from './client.js';
import { auditLogs } from './schema/ops.js';
import { users } from './schema/auth.js';

/**
 * Point d'entrée UNIQUE du journal d'audit.
 * Aucun `insert into audit_logs` ne doit exister ailleurs dans le projet.
 *
 * `logAudit()` ne throw jamais : un journal d'audit indisponible dégrade la
 * traçabilité, il ne doit pas casser la requête de l'utilisateur. L'échec est
 * remonté sur le canal d'erreur fourni par l'appelant.
 */

export const auditEntrySchema = z.object({
  /** `null` pour une action système (worker, scheduler) ou un acteur anonyme. */
  actorId: z.string().min(1).nullable().default(null),
  /** Verbe métier, ex. `auth.login.succeeded`, `deployment.created`. */
  action: z.string().min(1).max(120),
  resourceType: z.string().min(1).max(60),
  resourceId: z.string().min(1).max(200).nullable().default(null),
  before: z.unknown().nullable().default(null),
  after: z.unknown().nullable().default(null),
  ip: z.string().min(1).max(64).nullable().default(null),
});

export type AuditEntryInput = z.input<typeof auditEntrySchema>;
export type AuditLogRow = typeof auditLogs.$inferSelect;

/** Signale un échec d'écriture d'audit sans interrompre l'appelant. */
export type AuditFailureReporter = (error: unknown, entry: AuditEntryInput) => void;

let reportFailure: AuditFailureReporter = (error, entry) => {
  // eslint-disable-next-line no-console
  console.error('[audit] écriture impossible', { action: entry.action, error });
};

/** Branche le logger de l'application (Pino) sur les échecs d'audit. */
export function setAuditFailureReporter(reporter: AuditFailureReporter): void {
  reportFailure = reporter;
}

/**
 * Écrit une ligne d'audit. Retourne `null` si l'écriture a échoué —
 * l'appelant n'a rien à gérer, l'échec est déjà journalisé en erreur.
 */
export async function logAudit(
  entry: AuditEntryInput,
  db: Database = getDb(),
): Promise<AuditLogRow | null> {
  try {
    const parsed = auditEntrySchema.parse(entry);
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
      })
      .returning();
    return row ?? null;
  } catch (error) {
    reportFailure(error, entry);
    return null;
  }
}

// ─── Lecture ──────────────────────────────────────────────────────────────────

export const auditQuerySchema = z.object({
  actorId: z.string().min(1).max(200).optional(),
  action: z.string().min(1).max(120).optional(),
  resourceType: z.string().min(1).max(60).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export type AuditQuery = z.infer<typeof auditQuerySchema>;

export type AuditLogPage = {
  items: Array<AuditLogRow & { actorEmail: string | null; actorName: string | null }>;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export async function listAuditLogs(
  query: AuditQuery,
  db: Database = getDb(),
): Promise<AuditLogPage> {
  const filters = [
    query.actorId ? eq(auditLogs.actorId, query.actorId) : undefined,
    query.action ? eq(auditLogs.action, query.action) : undefined,
    query.resourceType ? eq(auditLogs.resourceType, query.resourceType) : undefined,
    query.from ? gte(auditLogs.createdAt, query.from) : undefined,
    query.to ? lte(auditLogs.createdAt, query.to) : undefined,
  ].filter((f) => f !== undefined);

  const where = filters.length > 0 ? and(...filters) : undefined;
  const orderBy = query.order === 'asc' ? asc(auditLogs.createdAt) : desc(auditLogs.createdAt);

  const [rows, [totalRow]] = await Promise.all([
    db
      .select({
        auditLog: auditLogs,
        actorEmail: users.email,
        actorName: users.name,
      })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.actorId))
      .where(where)
      .orderBy(orderBy)
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    db.select({ value: count() }).from(auditLogs).where(where),
  ]);

  const total = totalRow?.value ?? 0;

  return {
    items: rows.map((row) => ({
      ...row.auditLog,
      actorEmail: row.actorEmail,
      actorName: row.actorName,
    })),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  };
}

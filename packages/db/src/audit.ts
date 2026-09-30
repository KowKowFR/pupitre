import { z } from 'zod';
import { and, asc, count, desc, eq, gte, lt, lte, or, sql } from 'drizzle-orm';
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
 * Observateur des entrées **réellement écrites**.
 *
 * Pourquoi se greffer ici plutôt que d'émettre les notifications depuis chaque
 * site d'action : `logAudit()` est déjà le point d'entrée unique par lequel
 * passent tous les événements qui méritent d'être notifiés — un déploiement en
 * échec, un rollback automatique, une réinitialisation de second facteur, un
 * changement de rôle. Les réémettre à la main obligerait à toucher le pipeline
 * de déploiement, deux routes d'administration et le worker, puis à recommencer
 * au prochain événement. Ici, la correspondance tient dans une seule table de
 * données (`@pupitre/core` → `notifiableEventFor`).
 *
 * Trois précautions, parce que ce point d'entrée est fragile :
 *   1. l'observateur est appelé **après** l'écriture, jamais avant : on ne
 *      notifie pas un événement qui n'a pas été tracé ;
 *   2. il ne peut pas faire échouer `logAudit()` — son exception est attrapée
 *      et rapportée comme telle, distincte d'un échec d'écriture ;
 *   3. il est **synchrone et non attendu** : il doit se contenter d'enfiler une
 *      tâche. Tout travail réel appartient au worker.
 *
 * L'état vit sur `globalThis` et non dans une variable de module : Next découpe
 * le code serveur en chunks et peut charger plusieurs copies de ce module. Avec
 * une variable de module, l'observateur installé au démarrage du panel serait
 * invisible depuis la copie chargée par un Route Handler. Même motif que le
 * cache des paramètres d'instance, et pour la même raison.
 */
export type AuditObserver = (row: AuditLogRow) => void;

declare global {
  var __tpAuditObserver: AuditObserver | undefined;
}

export function setAuditObserver(observer: AuditObserver | null): void {
  globalThis.__tpAuditObserver = observer ?? undefined;
}

function notifyObserver(row: AuditLogRow): void {
  const observer = globalThis.__tpAuditObserver;
  if (!observer) return;
  try {
    observer(row);
  } catch (error) {
    reportFailure(error, { action: `observer:${row.action}`, resourceType: row.resourceType });
  }
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
    // `notifyObserver` n'échoue jamais : le placer ici plutôt qu'après le
    // `try` évite de dupliquer le chemin de retour sans risquer de transformer
    // un problème de notification en échec d'audit.
    if (row) notifyObserver(row);
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

/** Les filtres seuls, sans pagination ni ordre : ce que l'export reprend de la liste. */
export type AuditFilter = Pick<AuditQuery, 'actorId' | 'action' | 'resourceType' | 'from' | 'to'>;

function auditWhere(filter: AuditFilter) {
  const filters = [
    filter.actorId ? eq(auditLogs.actorId, filter.actorId) : undefined,
    filter.action ? eq(auditLogs.action, filter.action) : undefined,
    filter.resourceType ? eq(auditLogs.resourceType, filter.resourceType) : undefined,
    filter.from ? gte(auditLogs.createdAt, filter.from) : undefined,
    filter.to ? lte(auditLogs.createdAt, filter.to) : undefined,
  ].filter((f) => f !== undefined);

  return filters.length > 0 ? and(...filters) : undefined;
}

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
  const where = auditWhere(query);
  const orderBy = query.order === 'asc' ? asc(auditLogs.createdAt) : desc(auditLogs.createdAt);

  const [rows, total] = await Promise.all([
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
    countAuditLogs(query, db),
  ]);

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

/** Nombre d'entrées qui répondent aux filtres. */
export async function countAuditLogs(filter: AuditFilter, db: Database = getDb()): Promise<number> {
  const [row] = await db.select({ value: count() }).from(auditLogs).where(auditWhere(filter));
  return row?.value ?? 0;
}

export type AuditExportRow = AuditLogRow & { actorEmail: string | null };

/**
 * Toutes les entrées qui répondent aux filtres, par lots, de la plus récente à
 * la plus ancienne : c'est la lecture de l'export.
 *
 * Pagination par curseur `(created_at, id)` et non par décalage : le journal
 * grossit pendant qu'on le lit — l'export lui-même y écrit une ligne — et un
 * décalage ferait alors glisser les pages. `limit` borne le total.
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
    const rows: Array<{ auditLog: AuditLogRow; actorEmail: string | null }> = await db
      .select({ auditLog: auditLogs, actorEmail: users.email })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.actorId))
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
    yield rows.map((row) => ({ ...row.auditLog, actorEmail: row.actorEmail }));
    remaining -= rows.length;
    const last = rows[rows.length - 1]!.auditLog;
    cursor = { createdAt: last.createdAt, id: last.id };
    if (rows.length < batchSize) return;
  }
}

/**
 * Les personnes qui apparaissent au journal, pour le filtre « Acteur ».
 *
 * Tirées du journal et non de la table des utilisateurs : proposer quelqu'un
 * qui n'a jamais rien fait donnerait une liste vide à chaque fois. Un compte
 * supprimé n'y figure plus — ses entrées ont perdu leur acteur (`set null`).
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

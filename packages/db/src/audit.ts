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
  /**
   * Absent : lu dans la requête en cours par le fournisseur de contexte (voir
   * `setAuditContextProvider`). Coupé plutôt que refusé au-delà de 512
   * caractères — un en-tête trop long ne doit pas coûter la ligne d'audit.
   */
  userAgent: z
    .string()
    .nullable()
    .optional()
    .transform((value) => (value ? value.slice(0, 512) : value)),
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
  var __tpAuditObservers: Map<string, AuditObserver> | undefined;
}

/**
 * Ce que la requête en cours dit d'elle-même, pour les entrées qui ne le
 * précisent pas : le `User-Agent`, et le jeton d'API par lequel elle s'est
 * authentifiée — c'est ce qui distingue, au journal, ce qu'une personne a fait
 * de ce que sa CI a fait en son nom.
 *
 * Un fournisseur plutôt qu'un champ ajouté à chaque appel : `logAudit()` est
 * appelé depuis une centaine d'endroits, et un navigateur oublié à l'un d'eux
 * serait un trou silencieux dans le journal. Le panel installe le sien au
 * démarrage (il lit les en-têtes de la requête) ; le worker n'en installe pas
 * — ses actions n'ont pas de requête derrière elles. Même rangement que
 * l'observateur, sur `globalThis`, et pour la même raison.
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
 * Un observateur de plus, sous un nom — le temps réel, à côté des
 * notifications. Mêmes trois précautions : appelé après l'écriture, jamais
 * bloquant, jamais capable de faire échouer l'audit. Réinstaller sous le même
 * nom remplace (le HMR de `next dev` réexécute l'installation).
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
 * Écrit une ligne d'audit. Retourne `null` si l'écriture a échoué —
 * l'appelant n'a rien à gérer, l'échec est déjà journalisé en erreur.
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
  /** `high,critical` : une ou plusieurs criticités ; vide, toutes. */
  severity: z
    .string()
    .max(60)
    .optional()
    .transform((value) => parseAuditSeverities(value)),
  /** Recherche libre : action, ressource, acteur, IP, charge utile. */
  q: z.string().trim().min(1).max(200).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export type AuditQuery = z.infer<typeof auditQuerySchema>;

/** Les filtres seuls, sans pagination ni ordre : ce que l'export reprend de la liste. */
export type AuditFilter = Pick<
  AuditQuery,
  'actorId' | 'action' | 'resourceType' | 'from' | 'to' | 'q'
> & { severity?: AuditSeverity[] };

/**
 * La criticité d'une entrée, calculée en base depuis la table de
 * `@pupitre/core` — celle dont l'écran se sert : la liste filtrée et les
 * pastilles ne peuvent pas se contredire. Les motifs sont écrits en clair dans
 * la requête (ce sont nos constantes, vérifiées ci-dessous), pour que
 * l'expression soit identique partout où elle sert, `GROUP BY` compris.
 */
const severityExpression: SQL<AuditSeverity> = (() => {
  const literal = (value: string) => {
    if (!/^[a-z0-9_.%\\]+$/.test(value)) throw new Error(`motif de criticité invalide : ${value}`);
    return `'${value}'`;
  };
  const branches = AUDIT_SEVERITY_RULES.map(
    ([pattern, severity]) =>
      `when "audit_logs"."action" like ${literal(auditSeverityLikePattern(pattern))} then ${literal(severity)}`,
  );
  return sql.raw(`(case ${branches.join(' ')} else 'low' end)`) as SQL<AuditSeverity>;
})();

/** `%terme%`, jokers de l'utilisateur échappés : on cherche ce qu'il a tapé. */
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
      /** Le nom du jeton d'API qui a porté l'action, s'il y en a eu un. */
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

/** Nombre d'entrées qui répondent aux filtres. */
export async function countAuditLogs(filter: AuditFilter, db: Database = getDb()): Promise<number> {
  const [row] = await db.select({ value: count() }).from(auditLogs).where(auditWhere(filter));
  return row?.value ?? 0;
}

/**
 * Combien d'entrées par criticité, sous les autres filtres : ce que disent les
 * pastilles du filtre. La criticité choisie n'y entre pas — sinon les autres
 * tomberaient à zéro dès qu'on en coche une.
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

/**
 * Comment une connexion a été achevée : le mot de passe seul, un second
 * facteur, ou la connexion unique.
 */
export type SignInMethod = 'password' | 'totp' | 'backup_code' | 'sso';

/**
 * La dernière connexion réussie d'un utilisateur, lue dans le journal — le
 * seul endroit où la méthode est gardée : `auth.login.succeeded` porte
 * `method` quand un second facteur a conclu, rien quand le mot de passe a suffi ;
 * une connexion unique s'écrit `auth.sso.login.succeeded`.
 *
 * `before` écarte les connexions plus récentes : « Mon compte » y passe le
 * début de la session en cours pour obtenir la connexion **précédente**.
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

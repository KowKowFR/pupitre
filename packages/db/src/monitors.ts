import {
  MONITOR_FAILURE_THRESHOLD_DEFAULT,
  MONITOR_INTERVAL_CEILING_SECONDS,
  MONITOR_INTERVAL_FLOOR_SECONDS,
  MONITOR_PRUNE_BATCH,
  MONITOR_RECOVERY_THRESHOLD_DEFAULT,
  MONITOR_THRESHOLD_MAX,
  MONITOR_THRESHOLD_MIN,
  decrypt,
  describeMonitorTarget,
  encrypt,
  formatCadence,
  isMonitorType,
  monitorOutcomeSchema,
  monitorTargetLink,
  monitorTypeDefinition,
  monitorTypeSchema,
  monitorUrlSchema,
  nextMonitorState,
  uptimeRatio,
  type CheckMetrics,
  type CheckResult,
  type MonitorTransition,
  type MonitorType,
  type UptimeWindow,
} from '@pupitre/core';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type Database } from './client.js';
import { applications } from './schema/infra.js';
import { deployments } from './schema/deployments.js';
import {
  monitorCaptures,
  monitorChecks,
  monitorIncidents,
  monitors,
} from './schema/monitors.js';

/**
 * Persistance de la supervision de sites.
 *
 * Tout ce qui décide vit dans `@pupitre/core` : la machine à états
 * (`nextMonitorState`) et la validation par type (le catalogue). Ce module
 * écrit. La seule intelligence qui reste ici est transactionnelle : une mesure,
 * l'avancement de l'état et l'ouverture — ou la fermeture — d'un incident
 * doivent tomber ensemble, ou pas du tout.
 *
 * Aucun `if (type === 'http')` nulle part : le type est une donnée, son schéma
 * de configuration et sa cadence minimale viennent du catalogue.
 */

export type Monitor = typeof monitors.$inferSelect;
export type MonitorCheck = typeof monitorChecks.$inferSelect;
export type MonitorIncident = typeof monitorIncidents.$inferSelect;

/** Une cadence refusée par le type, ou une configuration invalide : 422, pas 500. */
export class MonitorConfigError extends Error {
  override readonly name = 'MonitorConfigError';
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
  }
}

// ─── validation ───────────────────────────────────────────────────────────────

const intervalSchema = z
  .number()
  .int()
  .min(MONITOR_INTERVAL_FLOOR_SECONDS)
  .max(MONITOR_INTERVAL_CEILING_SECONDS);

const thresholdSchema = z.number().int().min(MONITOR_THRESHOLD_MIN).max(MONITOR_THRESHOLD_MAX);

/**
 * Le corps commun. `config` reste `unknown` ici : il est validé par le schéma du
 * type, une fois le type connu — c'est `resolveConfig()` qui s'en charge, et
 * c'est le seul endroit où ça se produit.
 */
export const createMonitorSchema = z.object({
  name: z.string().trim().min(1).max(120),
  type: monitorTypeSchema.default('http'),
  config: z.unknown().default({}),
  /** Absent = la cadence par défaut du type. */
  intervalSeconds: intervalSchema.optional(),
  failureThreshold: thresholdSchema.default(MONITOR_FAILURE_THRESHOLD_DEFAULT),
  recoveryThreshold: thresholdSchema.default(MONITOR_RECOVERY_THRESHOLD_DEFAULT),
  enabled: z.boolean().default(true),
  applicationId: z.string().uuid().nullable().default(null),
  /** `null` retire le webhook. Absent = on n'y touche pas. */
  webhookUrl: monitorUrlSchema.nullable().optional(),
});

export type CreateMonitorInput = z.infer<typeof createMonitorSchema>;

export const updateMonitorSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    config: z.unknown().optional(),
    intervalSeconds: intervalSchema.optional(),
    failureThreshold: thresholdSchema.optional(),
    recoveryThreshold: thresholdSchema.optional(),
    enabled: z.boolean().optional(),
    applicationId: z.string().uuid().nullable().optional(),
    webhookUrl: monitorUrlSchema.nullable().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, { message: 'aucun champ à modifier' });

export type UpdateMonitorInput = z.infer<typeof updateMonitorSchema>;

/**
 * Valide une configuration contre le schéma de **son** type, et fait respecter
 * la cadence minimale que ce type déclare.
 *
 * La cadence minimale est par type parce qu'elle est une propriété du type : ce
 * qu'il coûte à l'autre bout, et la vitesse à laquelle ce qu'il observe peut
 * changer. Une sonde HTTP à la minute est raisonnable ; interroger un registre
 * de domaines à la minute ferait du panel un nuisible.
 */
export function resolveConfig(
  type: MonitorType,
  rawConfig: unknown,
  intervalSeconds: number | undefined,
): { config: Record<string, unknown>; intervalSeconds: number } {
  const definition = monitorTypeDefinition(type);

  const parsed = definition.schema.safeParse(rawConfig ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.join('.') ?? 'config';
    throw new MonitorConfigError(
      `configuration de sonde « ${definition.label} » invalide — ${path} : ${first?.message ?? 'valeur refusée'}`,
      `config.${path}`,
    );
  }

  const interval = intervalSeconds ?? definition.defaultIntervalSeconds;
  if (interval < definition.minIntervalSeconds) {
    throw new MonitorConfigError(
      `une sonde « ${definition.label} » ne se lance pas plus souvent que ` +
        `${formatCadence(definition.minIntervalSeconds)} — ${formatCadence(interval)} demandé`,
      'intervalSeconds',
    );
  }

  return { config: parsed.data as Record<string, unknown>, intervalSeconds: interval };
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export async function createMonitor(
  input: CreateMonitorInput,
  createdBy: string | null,
  db: Database = getDb(),
): Promise<Monitor> {
  const resolved = resolveConfig(input.type, input.config, input.intervalSeconds);

  const [row] = await db
    .insert(monitors)
    .values({
      name: input.name,
      type: input.type,
      config: resolved.config,
      intervalSeconds: resolved.intervalSeconds,
      failureThreshold: input.failureThreshold,
      recoveryThreshold: input.recoveryThreshold,
      enabled: input.enabled,
      applicationId: input.applicationId,
      webhookUrlEncrypted: input.webhookUrl ? encrypt(input.webhookUrl) : null,
      createdBy,
      // Une sonde neuve est due tout de suite : on ne fait pas attendre une
      // cadence entière à qui vient de la créer pour savoir si sa cible répond.
      nextCheckAt: new Date(),
    })
    .returning();
  if (!row) throw new Error('insertion de la sonde sans retour');
  return row;
}

export async function updateMonitor(
  id: string,
  patch: UpdateMonitorInput,
  db: Database = getDb(),
): Promise<Monitor | null> {
  const current = await getMonitor(id, db);
  if (!current) return null;

  // Le type ne se modifie pas : changer le type d'une sonde, c'est en créer une
  // autre. L'historique et les incidents porteraient sur autre chose.
  const type = monitorTypeSchema.parse(current.type);

  const values: Partial<typeof monitors.$inferInsert> = { updatedAt: new Date() };
  let identityChanged = false;

  if (patch.config !== undefined || patch.intervalSeconds !== undefined) {
    const resolved = resolveConfig(
      type,
      patch.config ?? current.config,
      patch.intervalSeconds ?? current.intervalSeconds,
    );
    if (patch.config !== undefined) {
      values.config = resolved.config;
      identityChanged =
        JSON.stringify(resolved.config) !== JSON.stringify(current.config);
    }
    values.intervalSeconds = resolved.intervalSeconds;
  }

  if (patch.name !== undefined) values.name = patch.name;
  if (patch.failureThreshold !== undefined) values.failureThreshold = patch.failureThreshold;
  if (patch.recoveryThreshold !== undefined) values.recoveryThreshold = patch.recoveryThreshold;
  if (patch.applicationId !== undefined) values.applicationId = patch.applicationId;
  if (patch.webhookUrl !== undefined) {
    values.webhookUrlEncrypted = patch.webhookUrl === null ? null : encrypt(patch.webhookUrl);
  }
  if (patch.enabled !== undefined) {
    values.enabled = patch.enabled;
    // Une reprise à la main efface le motif de suspension automatique, et rend
    // la sonde due immédiatement.
    if (patch.enabled) {
      values.pausedReason = null;
      values.nextCheckAt = new Date();
    }
  }

  // Changer ce qu'on observe change ce que l'état confirmé veut dire : il
  // portait sur autre chose. On repart de `unknown` plutôt que d'hériter d'un
  // verdict devenu faux.
  if (identityChanged) {
    values.status = 'unknown';
    values.lastOutcome = null;
    values.consecutiveFailures = 0;
    values.consecutiveSuccesses = 0;
    values.nextCheckAt = new Date();
  }

  /**
   * Et si c'est la **page** qui a changé, la référence visuelle ne vaut plus
   * rien : elle montrerait un autre site que celui qu'on supervise désormais,
   * et la prochaine comparaison avant/après serait un mensonge parfaitement
   * crédible — deux images côte à côte, dont l'une n'a rien à voir.
   *
   * « La page a-t-elle changé » se demande au **catalogue** (`linkFor`), pas à
   * un `if (type === 'http')` : relever le code attendu ou le délai
   * d'expiration ne change pas ce qu'on photographie, changer l'URL si.
   *
   * Les références déjà **épinglées** à un incident ne bougent pas : elles
   * documentent ce qui était supervisé à ce moment-là, et récrire le passé
   * serait pire que de le garder.
   */
  if (values.config !== undefined) {
    const pageBefore = monitorTargetLink(type, current.config);
    const pageAfter = monitorTargetLink(type, values.config);
    if (pageBefore !== pageAfter) {
      await db
        .delete(monitorCaptures)
        .where(
          and(
            eq(monitorCaptures.monitorId, id),
            eq(monitorCaptures.kind, 'reference'),
            isNull(monitorCaptures.incidentId),
          ),
        );
    }
  }

  const [row] = await db.update(monitors).set(values).where(eq(monitors.id, id)).returning();
  return row ?? null;
}

export async function deleteMonitor(id: string, db: Database = getDb()): Promise<boolean> {
  const [row] = await db.delete(monitors).where(eq(monitors.id, id)).returning({ id: monitors.id });
  return row !== undefined;
}

export async function getMonitor(id: string, db: Database = getDb()): Promise<Monitor | null> {
  const [row] = await db.select().from(monitors).where(eq(monitors.id, id)).limit(1);
  return row ?? null;
}

export async function listMonitors(db: Database = getDb()): Promise<Monitor[]> {
  return db.select().from(monitors).orderBy(monitors.name);
}

/** L'URL du webhook, déchiffrée. Réservée au worker, au moment d'alerter. */
export function monitorWebhookUrl(monitor: Monitor): string | null {
  if (!monitor.webhookUrlEncrypted) return null;
  return decrypt(monitor.webhookUrlEncrypted);
}

/** La cible d'une sonde, en une ligne. Passe par le catalogue, jamais par un `switch`. */
export function monitorTarget(monitor: Monitor): string {
  if (!isMonitorType(monitor.type)) return '(type inconnu)';
  return describeMonitorTarget(monitor.type, monitor.config);
}

// ─── balayage ─────────────────────────────────────────────────────────────────

/**
 * Réclame les sondes dues et **avance leur échéance dans le même geste**.
 *
 * L'ordre compte : si on sondait avant d'avancer `next_check_at`, une sonde qui
 * met trente secondes à expirer serait reprise par le balayage suivant, et on
 * aurait deux requêtes en vol vers la même cible. `FOR UPDATE SKIP LOCKED`
 * permet en outre à deux workers de se partager le travail sans se marcher
 * dessus — la file `supervision` a plusieurs slots.
 */
export async function claimDueMonitors(limit: number, db: Database = getDb()): Promise<Monitor[]> {
  // En deux temps, et c'est délibéré. La réclamation a besoin de SQL brut —
  // `FOR UPDATE SKIP LOCKED` et `make_interval` n'ont pas d'équivalent dans le
  // constructeur de requêtes — mais `RETURNING m.*` rendrait des colonnes en
  // snake_case, que Drizzle ne remappe pas. Les champs seraient `undefined`, et
  // `consecutiveSuccesses + 1` vaudrait `NaN` : une sonde que le balayage
  // casserait en silence, là où « sonder maintenant » (qui passe par
  // `getMonitor`) fonctionnerait. Le bug a existé ; il ne repassera pas.
  //
  // L'atomicité tient quand même : c'est l'`UPDATE` qui réclame, et il n'a lieu
  // qu'une fois. La relecture qui suit ne fait que typer ce qui est déjà à nous.
  const claimed = await db.execute<{ id: string }>(sql`
    update ${monitors} as m
       set next_check_at = now() + make_interval(secs => m.interval_seconds)
     where m.id in (
       select id from ${monitors}
        where enabled
          and next_check_at <= now()
        order by next_check_at
        limit ${limit}
        for update skip locked
     )
    returning m.id
  `);

  const ids = readRows<{ id: string }>(claimed).map((row) => row.id);
  if (ids.length === 0) return [];

  return db.select().from(monitors).where(inArray(monitors.id, ids));
}

/** Rend une sonde due immédiatement, sans attendre son échéance. */
export async function markMonitorDue(id: string, db: Database = getDb()): Promise<void> {
  await db.update(monitors).set({ nextCheckAt: new Date() }).where(eq(monitors.id, id));
}

/** Suspend une sonde, avec son motif. Le panel le fait ; un humain peut la reprendre. */
export async function suspendMonitor(
  id: string,
  reason: string,
  db: Database = getDb(),
): Promise<void> {
  await db
    .update(monitors)
    .set({ enabled: false, pausedReason: reason, updatedAt: new Date() })
    .where(eq(monitors.id, id));
}

/**
 * `db.execute()` rend soit un tableau, soit un `{ rows }` selon le pilote.
 * Drizzle ne le type pas de façon stable entre versions : on normalise ici, une
 * fois, plutôt que de parsemer des casts.
 */
function readRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result !== null && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows: unknown }).rows;
    if (Array.isArray(rows)) return rows as T[];
  }
  return [];
}

// ─── enregistrement d'une mesure ──────────────────────────────────────────────

export type AppliedCheck = {
  monitor: Monitor;
  check: MonitorCheck;
  transition: MonitorTransition;
  /** Incident ouvert ou refermé par cette mesure. `null` sans transition. */
  incident: MonitorIncident | null;
};

/**
 * Une mesure, l'état qui en découle et l'incident éventuel — dans une seule
 * transaction. Sans quoi un worker tué entre l'insertion de la mesure et
 * l'ouverture de l'incident laisserait une sonde en panne dont personne n'aurait
 * jamais été prévenu.
 *
 * `CheckResult` est le contrat commun à tous les types de sonde : ce code ne
 * sait pas, et n'a pas à savoir, si la mesure venait d'une requête HTTP ou d'une
 * poignée de main TLS.
 */
export async function applyCheck(
  monitor: Monitor,
  result: CheckResult,
  at: Date = new Date(),
  db: Database = getDb(),
): Promise<AppliedCheck> {
  const outcome = monitorOutcomeSchema.parse(result.outcome);
  const metrics: CheckMetrics = result.metrics ?? {};

  return db.transaction(async (tx) => {
    const [check] = await tx
      .insert(monitorChecks)
      .values({
        monitorId: monitor.id,
        checkedAt: at,
        outcome,
        latencyMs: result.latencyMs,
        detail: result.detail,
        metrics,
      })
      .returning();
    if (!check) throw new Error('insertion de la mesure sans retour');

    const step = nextMonitorState(
      {
        status: monitor.status,
        consecutiveFailures: monitor.consecutiveFailures,
        consecutiveSuccesses: monitor.consecutiveSuccesses,
      },
      outcome,
      {
        failureThreshold: monitor.failureThreshold,
        recoveryThreshold: monitor.recoveryThreshold,
      },
    );

    const [updated] = await tx
      .update(monitors)
      .set({
        status: step.status,
        lastOutcome: outcome,
        consecutiveFailures: step.consecutiveFailures,
        consecutiveSuccesses: step.consecutiveSuccesses,
        lastCheckedAt: at,
        lastLatencyMs: result.latencyMs,
        lastDetail: result.detail,
        lastMetrics: metrics,
        updatedAt: at,
      })
      .where(eq(monitors.id, monitor.id))
      .returning();
    if (!updated) throw new Error('mise à jour de la sonde sans retour');

    let incident: MonitorIncident | null = null;

    if (step.transition === 'down') {
      // `onConflictDoNothing` s'appuie sur l'index unique partiel : même si deux
      // workers concluaient à la panne en même temps, il n'y aurait qu'un
      // incident, donc qu'une alerte.
      const [opened] = await tx
        .insert(monitorIncidents)
        .values({
          monitorId: monitor.id,
          startedAt: at,
          cause: outcome,
          detail: result.detail,
          metrics,
          failureCount: step.consecutiveFailures,
        })
        .onConflictDoNothing()
        .returning();
      incident = opened ?? null;
    }

    if (step.transition === 'up') {
      const [closed] = await tx
        .update(monitorIncidents)
        .set({ resolvedAt: at })
        .where(and(eq(monitorIncidents.monitorId, monitor.id), isNull(monitorIncidents.resolvedAt)))
        .returning();
      incident = closed ?? null;
    }

    return { monitor: updated, check, transition: step.transition, incident };
  });
}

export async function markIncidentAlerted(
  incidentId: string,
  kind: 'open' | 'resolve',
  delivery: { ok: boolean; error?: string },
  db: Database = getDb(),
): Promise<void> {
  const now = new Date();
  const values =
    kind === 'open'
      ? { alertSentAt: delivery.ok ? now : null, alertError: delivery.error ?? null }
      : { resolveAlertSentAt: delivery.ok ? now : null, resolveAlertError: delivery.error ?? null };
  await db.update(monitorIncidents).set(values).where(eq(monitorIncidents.id, incidentId));
}

// ─── lectures d'écran ─────────────────────────────────────────────────────────

export async function listChecks(
  monitorId: string,
  limit = 100,
  db: Database = getDb(),
): Promise<MonitorCheck[]> {
  return db
    .select()
    .from(monitorChecks)
    .where(eq(monitorChecks.monitorId, monitorId))
    .orderBy(desc(monitorChecks.checkedAt))
    .limit(limit);
}

export async function listIncidents(
  monitorId: string,
  limit = 50,
  db: Database = getDb(),
): Promise<MonitorIncident[]> {
  return db
    .select()
    .from(monitorIncidents)
    .where(eq(monitorIncidents.monitorId, monitorId))
    .orderBy(desc(monitorIncidents.startedAt))
    .limit(limit);
}

export async function openIncidentFor(
  monitorId: string,
  db: Database = getDb(),
): Promise<MonitorIncident | null> {
  const [row] = await db
    .select()
    .from(monitorIncidents)
    .where(and(eq(monitorIncidents.monitorId, monitorId), isNull(monitorIncidents.resolvedAt)))
    .limit(1);
  return row ?? null;
}

/**
 * Taux de disponibilité sur une fenêtre, pour plusieurs sondes d'un coup.
 *
 * Rend le **dénominateur** avec le taux : « 100 % sur 3 mesures » n'est pas
 * « 100 % sur 1 440 », et l'écran doit pouvoir le dire. Une sonde sans aucune
 * mesure dans la fenêtre rend `ratio: null` — jamais 0 %.
 */
export async function uptimeWindows(
  monitorIds: readonly string[],
  hours: number,
  db: Database = getDb(),
): Promise<Map<string, UptimeWindow>> {
  const out = new Map<string, UptimeWindow>();
  for (const id of monitorIds) out.set(id, { hours, samples: 0, up: 0, ratio: null });
  if (monitorIds.length === 0) return out;

  const rows = await db
    .select({
      monitorId: monitorChecks.monitorId,
      samples: sql<number>`count(*)::int`,
      up: sql<number>`count(*) filter (where ${monitorChecks.outcome} = 'healthy')::int`,
    })
    .from(monitorChecks)
    .where(
      and(
        inArray(monitorChecks.monitorId, [...monitorIds]),
        sql`${monitorChecks.checkedAt} >= now() - make_interval(hours => ${hours})`,
      ),
    )
    .groupBy(monitorChecks.monitorId);

  for (const row of rows) {
    out.set(row.monitorId, {
      hours,
      samples: row.samples,
      up: row.up,
      ratio: uptimeRatio(row.up, row.samples),
    });
  }
  return out;
}

// ─── lien avec les déploiements ───────────────────────────────────────────────

export type AdoptableApp = {
  applicationId: string;
  slug: string;
  name: string;
  url: string;
  targetId: string;
};

/**
 * Les applications déployées, joignables, et pas encore supervisées.
 *
 * Le panel **connaît déjà l'URL de tout ce qu'il déploie** : c'est son avantage
 * sur un outil externe. Il ne crée pourtant pas la sonde tout seul — le
 * raisonnement est dans la route `/api/monitors`. Il propose, en un clic.
 */
export async function listAdoptableApps(db: Database = getDb()): Promise<AdoptableApp[]> {
  const rows = await db.execute<AdoptableApp>(sql`
    select distinct on (d.application_id)
           d.application_id as "applicationId",
           a.slug           as "slug",
           a.name           as "name",
           d.url            as "url",
           d.target_id      as "targetId"
      from ${deployments} d
      join ${applications} a on a.id = d.application_id
     where d.status in ('success', 'rolled_back')
       and d.url is not null
       and not exists (
         select 1 from ${monitors} m where m.application_id = d.application_id
       )
     order by d.application_id, d.version desc
  `);
  return readRows<AdoptableApp>(rows);
}

/**
 * Suspend les sondes dont l'application rattachée n'a plus de déploiement en
 * service.
 *
 * Sans cela, détruire une application volontairement déclencherait une alerte
 * de panne — le pire faux positif qui soit, parce qu'il apprend à ignorer les
 * alertes. La sonde n'est pas supprimée : elle est suspendue avec son motif, et
 * se reprend d'un clic.
 */
export async function suspendOrphanedMonitors(db: Database = getDb()): Promise<number> {
  const rows = await db.execute<{ id: string }>(sql`
    update ${monitors} as m
       set enabled = false,
           paused_reason = 'application plus déployée — sonde suspendue automatiquement',
           updated_at = now()
     where m.enabled
       and m.application_id is not null
       and not exists (
         select 1 from ${deployments} d
          where d.application_id = m.application_id
            and d.status in ('success', 'rolled_back')
            and d.url is not null
       )
    returning m.id
  `);
  return readRows<{ id: string }>(rows).length;
}

// ─── rétention ────────────────────────────────────────────────────────────────

/**
 * Purge la série temporelle au-delà de la rétention.
 *
 * Par lots : un `DELETE` de plusieurs millions de lignes tiendrait la table
 * pendant toute sa durée, et la sonde suivante attendrait derrière. Les
 * **incidents ne sont jamais purgés** — ils sont rares et ce sont eux qui
 * racontent l'histoire ; une chronologie amputée ne vaut rien.
 */
export async function pruneMonitorChecks(
  days: number,
  batch: number = MONITOR_PRUNE_BATCH,
  db: Database = getDb(),
): Promise<number> {
  const rows = await db.execute<{ id: string }>(sql`
    delete from ${monitorChecks}
     where id in (
       select id from ${monitorChecks}
        where checked_at < now() - make_interval(days => ${days})
        limit ${batch}
     )
    returning id
  `);
  return readRows<{ id: string }>(rows).length;
}

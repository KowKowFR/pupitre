import type { CheckMetrics, MonitorType } from '@tp/core';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { healthStatusEnum } from '../enums.js';
import { users } from './auth.js';
import { applications } from './infra.js';

/**
 * Supervision de sites — sondée depuis le worker, vers la cible publique.
 *
 * À ne pas confondre avec `deployments.health_status`, que remplit la tâche
 * `health:periodic` en interrogeant la machine cible par SSH. Celle-ci part de
 * l'extérieur : c'est le seul moyen de voir un pare-feu refermé, un proxy
 * cassé, un certificat expiré ou un DNS mort.
 *
 * ── Pourquoi la table ne décrit pas une requête HTTP ─────────────────────────
 * Six types de surveillance sont visés (HTTP, mot-clé, TLS, DNS, expiration de
 * domaine, empreinte de contenu). Ce ne sont pas six fonctionnalités mais une
 * abstraction et six implémentations. La table porte donc **le commun** — type,
 * cadence, état, seuils, rattachement — et la configuration propre au type vit
 * dans `config`, en JSONB, validée par le schéma Zod de ce type
 * (`packages/core/src/monitors/catalog.ts`). Ajouter un type ne touche pas
 * cette table.
 */
export const monitors = pgTable(
  'monitors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /**
     * Type de sonde. Volontairement du `text` et non un enum Postgres : un enum
     * ajouterait une migration à la liste de ce qu'il faut faire pour ajouter un
     * type, et c'est précisément la chirurgie qu'on veut éviter. Le vocabulaire
     * reste fermé — il vit dans `MONITOR_TYPES` et Zod le fait respecter à
     * chaque entrée. Une valeur inconnue en base (retour arrière du code) fait
     * suspendre la sonde avec son motif, jamais planter le balayage.
     */
    type: text('type').$type<MonitorType>().notNull().default('http'),
    /** Configuration propre au type, validée par le schéma Zod de ce type. */
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),

    intervalSeconds: integer('interval_seconds').notNull().default(60),
    /**
     * Seuil de confirmation. Un rebond — une mesure qui rate puis repasse — ne
     * doit pas produire d'incident ni de message : il faut `failure_threshold`
     * échecs consécutifs pour ouvrir, `recovery_threshold` succès pour refermer.
     */
    failureThreshold: integer('failure_threshold').notNull().default(3),
    recoveryThreshold: integer('recovery_threshold').notNull().default(2),
    enabled: boolean('enabled').notNull().default(true),
    /** Renseigné quand la sonde a été suspendue par le panel, pas par un humain. */
    pausedReason: text('paused_reason'),
    /**
     * Rattachement à une application déployée par le panel. `null` = sonde
     * libre, sur un site qu'il n'a pas déployé. La cible reste copiée dans
     * `config` : une sonde doit survivre à la version qui l'a inspirée.
     */
    applicationId: uuid('application_id').references(() => applications.id, {
      onDelete: 'cascade',
    }),
    /**
     * URL du webhook d'alerte, chiffrée AES-256-GCM sous `MASTER_KEY` — même
     * traitement que les credentials SSH. Une URL de webhook Slack ou Discord
     * *est* le secret : qui la détient poste dans le salon. Jamais rendue par
     * l'API, jamais journalisée.
     */
    webhookUrlEncrypted: text('webhook_url_encrypted'),

    /** État **confirmé**. Ne bouge qu'aux transitions, jamais au premier échec. */
    status: healthStatusEnum('status').notNull().default('unknown'),
    /** Dernier verdict brut, confirmé ou non. C'est lui qui dit « 1 échec sur 3 ». */
    lastOutcome: healthStatusEnum('last_outcome'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    consecutiveSuccesses: integer('consecutive_successes').notNull().default(0),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastLatencyMs: integer('last_latency_ms'),
    lastDetail: text('last_detail'),
    /**
     * Mesures du dernier relevé. En JSONB, et non en colonnes : une sonde HTTP
     * rend une latence et un code, une sonde TLS des jours restants et un
     * émetteur. Le catalogue dit à l'écran comment afficher chaque clé.
     */
    lastMetrics: jsonb('last_metrics').$type<CheckMetrics>(),
    /**
     * Échéance de la prochaine mesure. C'est la colonne que le balayage
     * interroge, et qu'il avance **avant** de sonder : une sonde lente n'est
     * pas reprise par le balayage suivant.
     */
    nextCheckAt: timestamp('next_check_at', { withTimezone: true }).notNull().defaultNow(),

    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // La requête du balayage, et la seule qui tourne en boucle : « les sondes
    // actives dont l'échéance est passée ». Index partiel : une sonde suspendue
    // n'a aucune raison d'occuper l'index de travail.
    index('monitors_due_idx').on(t.nextCheckAt).where(sql`${t.enabled}`),
    index('monitors_application_id_idx').on(t.applicationId),
    // Bornes **absolues**, tous types confondus. La cadence minimale propre à
    // chaque type (30 s pour HTTP, 1 h pour TLS) vit dans le catalogue : c'est
    // une connaissance du type, pas de la table, et elle changerait avec lui.
    check(
      'monitors_interval_check',
      sql`${t.intervalSeconds} >= 30 and ${t.intervalSeconds} <= 2592000`,
    ),
    check(
      'monitors_threshold_check',
      sql`${t.failureThreshold} between 1 and 10 and ${t.recoveryThreshold} between 1 and 10`,
    ),
  ],
);

/**
 * La série temporelle.
 *
 * Elle grandit sans fin par nature : une sonde à la minute écrit 43 200 lignes
 * par mois. Sa rétention est de **30 jours** (`MONITOR_CHECK_RETENTION_DAYS`),
 * appliquée par le balayage — voir le commentaire de la constante pour le
 * raisonnement. Une table qui gonfle en silence est un défaut.
 */
export const monitorChecks = pgTable(
  'monitor_checks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    monitorId: uuid('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
    /** Jamais `unknown` : une mesure a toujours tranché. */
    outcome: healthStatusEnum('outcome').notNull(),
    /** `null` quand rien n'a répondu — il n'y a alors pas de durée à mesurer. */
    latencyMs: integer('latency_ms'),
    detail: text('detail'),
    /** Les mesures du type : code HTTP et redirections, ou jours restants et émetteur. */
    metrics: jsonb('metrics').$type<CheckMetrics>().notNull().default({}),
  },
  (t) => [
    // Les deux seules requêtes que l'écran fait vraiment :
    //   « les N derniers résultats d'une sonde »   → ORDER BY checked_at DESC LIMIT n
    //   « le taux sur 24 h / 7 j »                 → WHERE checked_at >= now() - …
    // Un seul index composite les sert toutes les deux.
    index('monitor_checks_monitor_time_idx').on(t.monitorId, t.checkedAt.desc()),
    // La purge, elle, balaie toutes sondes confondues : elle a besoin du temps
    // seul, sinon elle relit la table entière chaque heure.
    index('monitor_checks_checked_at_idx').on(t.checkedAt),
  ],
);

/**
 * Les incidents. **Une table, pas une dérivation à la lecture.**
 *
 * Trois raisons, dans l'ordre d'importance :
 *
 *  1. L'alerte doit partir **une seule fois**. Cela demande une trace durable
 *     du « j'ai déjà prévenu », et cette trace, c'est la ligne d'incident. Un
 *     calcul à la lecture ne saurait pas si le message est parti.
 *  2. Le seuil de confirmation est réglable **par sonde**. Dériver les
 *     incidents à la lecture ferait que baisser le seuil réécrirait le passé :
 *     des incidents apparaîtraient rétroactivement dans une chronologie qu'un
 *     humain avait déjà lue. Un incident est une décision prise à un instant,
 *     avec les réglages de cet instant ; elle doit être immuable.
 *  3. Le coût. Dériver, c'est rejouer la machine à états sur toute la série à
 *     chaque affichage — sur la table précisément conçue pour grandir.
 *
 * L'index unique **partiel** sur `(monitor_id) where resolved_at is null` est
 * la garantie qu'une sonde n'a jamais deux incidents ouverts. Comme
 * l'anti-collision de ports : une contrainte, pas un `if`.
 */
export const monitorIncidents = pgTable(
  'monitor_incidents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    monitorId: uuid('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    /** Nature de la panne à l'ouverture : `unhealthy` ou `unreachable`. */
    cause: healthStatusEnum('cause').notNull(),
    detail: text('detail'),
    metrics: jsonb('metrics').$type<CheckMetrics>().notNull().default({}),
    /** Combien d'échecs consécutifs ont confirmé l'ouverture. */
    failureCount: integer('failure_count').notNull().default(1),
    alertSentAt: timestamp('alert_sent_at', { withTimezone: true }),
    alertError: text('alert_error'),
    resolveAlertSentAt: timestamp('resolve_alert_sent_at', { withTimezone: true }),
    resolveAlertError: text('resolve_alert_error'),
  },
  (t) => [
    uniqueIndex('monitor_incidents_open_idx')
      .on(t.monitorId)
      .where(sql`${t.resolvedAt} is null`),
    index('monitor_incidents_monitor_started_idx').on(t.monitorId, t.startedAt.desc()),
  ],
);

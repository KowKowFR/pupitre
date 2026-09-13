import type { CaptureKind, CheckMetrics, MonitorType } from '@pupitre/core';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
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

/**
 * `bytea` — Drizzle ne le fournit pas en natif ; le pilote `pg` rend déjà un
 * `Buffer` et en accepte un, il n'y a donc rien à transformer.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * **Ce que la sonde a vu.**
 *
 * Une image de la page, prise au moment où un incident s'ouvre ou se referme,
 * plus une image de référence prise pendant que tout allait bien. Le
 * raisonnement — pourquoi trois moments et pas un, pourquoi du JPEG, pourquoi
 * une borne dure de taille — vit dans `packages/core/src/monitors/capture.ts`,
 * avec le reste du vocabulaire. Ici : où les octets habitent, et comment la
 * table reste bornée.
 *
 * ── Pourquoi les octets sont dans Postgres et non dans un volume ────────────
 * Un volume serait plus léger pour la base. Il ajouterait en revanche une
 * **seconde chose à sauvegarder**, et ce projet n'a aujourd'hui *aucune*
 * histoire de sauvegarde : ajouter un second support à ne pas oublier quand on
 * n'en sauvegarde déjà pas un, c'est choisir de perdre les images. En base, la
 * capture suit l'incident partout où il va — le `pg_dump` que quelqu'un finira
 * par écrire, la copie de la base vers un poste de test, la suppression en
 * cascade d'une sonde. Et il n'y a pas de volume à monter dans deux conteneurs
 * (le worker écrit, le panel sert), donc pas de chemin partagé à tenir d'accord.
 *
 * Le coût est réel, et il est **borné par construction** :
 *   — une seule référence vivante par sonde (l'index unique partiel ci-dessous) ;
 *   — au plus deux images par incident ;
 *   — les octets purgés à 90 jours, la ligne conservée.
 * Cinquante sondes et cent incidents dans l'année, ce sont quelques dizaines de
 * mégaoctets — à comparer au vidage d'une base qui porte déjà tout l'historique
 * des déploiements.
 *
 * ⚠ `image` ne doit **jamais** partir dans un `select *` : les écrans listent
 * des dizaines de captures et n'ont besoin que des métadonnées. Les lectures
 * passent par `packages/db/src/captures.ts`, qui nomme ses colonnes et ne charge
 * les octets que pour la route qui sert l'image.
 */
export const monitorCaptures = pgTable(
  'monitor_captures',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    monitorId: uuid('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    /**
     * `null` = référence **vivante**, celle qui servira de « avant » au prochain
     * incident. Renseigné = image rattachée à cet incident, conservée avec lui.
     * C'est ce qui « épingle » la référence à l'instant où la panne commence :
     * la comparaison avant/après reste vraie même quand une référence plus
     * fraîche est prise ensuite.
     */
    incidentId: uuid('incident_id').references(() => monitorIncidents.id, {
      onDelete: 'cascade',
    }),
    /** `reference` | `incident_open` | `incident_resolved`. */
    kind: text('kind').$type<CaptureKind>().notNull(),
    takenAt: timestamp('taken_at', { withTimezone: true }).notNull().defaultNow(),

    /** L'URL demandée, et celle réellement rendue après redirections. */
    url: text('url').notNull(),
    finalUrl: text('final_url'),
    /** Code de la réponse principale, quand le navigateur l'a vu passer. */
    httpStatus: integer('http_status'),
    pageTitle: text('page_title'),

    width: integer('width').notNull(),
    height: integer('height').notNull(),
    format: text('format').notNull().default('jpeg'),
    /** Taille en octets. Conservée après la purge : elle documente ce qui a été. */
    bytes: integer('bytes').notNull(),
    /** La page était plus haute que la borne de rendu. Dit, jamais caché. */
    truncated: boolean('truncated').notNull().default(false),
    /** Durée de la capture. Une page qui met 20 s à rendre est une information. */
    elapsedMs: integer('elapsed_ms'),

    /**
     * Les octets. `null` après la purge de rétention — la ligne, elle, reste :
     * une chronologie qui dit ce qu'elle a perdu vaut mieux qu'une chronologie
     * amputée en silence.
     */
    image: bytea('image'),
    purgedAt: timestamp('purged_at', { withTimezone: true }),
  },
  (t) => [
    /**
     * **Une seule référence vivante par sonde.** Une contrainte, pas un `if` —
     * même discipline que l'anti-collision de ports et que l'incident ouvert
     * unique. C'est elle qui borne la table : sans elle, une référence toutes
     * les six heures ferait cent vingt images par sonde et par mois.
     *
     * Épingler la référence à un incident (`incident_id` renseigné) la fait
     * sortir de l'index, ce qui libère la place pour la suivante. La rotation
     * est donc un effet de la contrainte, pas une tâche de ménage.
     */
    uniqueIndex('monitor_captures_live_reference_idx')
      .on(t.monitorId)
      .where(sql`${t.kind} = 'reference' and ${t.incidentId} is null`),
    // Ce que l'écran de détail demande : les images d'un incident.
    index('monitor_captures_incident_idx').on(t.incidentId),
    index('monitor_captures_monitor_taken_idx').on(t.monitorId, t.takenAt.desc()),
    // La purge balaie toutes sondes confondues : il lui faut le temps seul, et
    // seulement les lignes qui portent encore des octets.
    index('monitor_captures_taken_at_idx')
      .on(t.takenAt)
      .where(sql`${t.image} is not null`),
    check(
      'monitor_captures_kind_check',
      sql`${t.kind} in ('reference', 'incident_open', 'incident_resolved')`,
    ),
    /**
     * Une image d'incident sans incident n'a pas de sens. Le couple est
     * contraint ici plutôt que dans le code qui insère.
     */
    check(
      'monitor_captures_incident_check',
      sql`(${t.kind} = 'reference') or (${t.incidentId} is not null)`,
    ),
  ],
);

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { targets } from './infra.js';

/**
 * Mémoire de la supervision des serveurs.
 *
 * ── Le défaut qu'on corrige ─────────────────────────────────────────────────
 * Le relevé d'hôte (`target:metrics`) était déclenché par l'écran et mourait
 * avec la réponse du job. On voyait « disque : 89 % » sans savoir si c'était
 * 11 % la semaine dernière. Un relevé n'est pas une supervision : il manque le
 * passé, et il manque le seuil qui dit quand ce passé devient un problème.
 *
 * ── Pourquoi ce n'est pas une réinvention ───────────────────────────────────
 * La forme est **copiée sur la supervision de sites** (`schema/monitors.ts`),
 * délibérément, parce qu'elle a déjà tranché les mêmes questions :
 *
 *   `monitor_checks`     → `target_metric_samples`   la série temporelle brute,
 *                                                    30 jours, purgée par lots
 *   `monitor_incidents`  → `target_metric_breaches`  l'épisode, une ligne, avec
 *                                                    l'index unique partiel qui
 *                                                    garantit UNE alerte
 *   `monitors.*_threshold` → `target_metric_thresholds`  les seuils, réglables
 *
 * Deux modèles différents pour deux séries temporelles du même panel auraient
 * coûté deux rétentions à retenir, deux purges à surveiller et deux façons de
 * lire une chronologie.
 *
 * ── La seule divergence assumée : des colonnes, pas du JSONB ────────────────
 * `monitor_checks.metrics` est en JSONB parce qu'une sonde TLS et une sonde
 * HTTP ne mesurent pas les mêmes choses — le catalogue des types est ouvert.
 * Ici les dimensions sont fermées : une machine Linux a une charge, une
 * mémoire, un disque et un uptime, et cela ne dépend ni du runtime ni de rien
 * d'autre (c'est déjà l'argument de `packages/core/src/host-metrics.ts`). Des
 * colonnes typées permettent en outre à Postgres d'agréger — `max(disk_use_percent)`
 * sur une fenêtre — ce qu'un JSONB rendrait illisible et non indexable.
 */

/**
 * La série temporelle des relevés d'hôte.
 *
 * Elle grandit sans fin par nature. Cadence par défaut : un relevé toutes les
 * 5 minutes et par machine (`HOST_SAMPLE_INTERVAL_SECONDS`), rétention 30 jours
 * (`HOST_SAMPLE_RETENTION_DAYS`, qui vaut celle des sondes de site, et le dit).
 * Soit ~8 600 lignes par machine et par mois : trois fois moins qu'une sonde de
 * site à la minute, pour une donnée qui bouge trois fois moins vite.
 *
 * **Un relevé injoignable est enregistré aussi**, avec sa raison et sans
 * métrique. C'est une information : un trou dans la chronologie ne dit pas si
 * la machine était éteinte ou si le panel dormait.
 */
export const targetMetricSamples = pgTable(
  'target_metric_samples',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'cascade' }),
    sampledAt: timestamp('sampled_at', { withTimezone: true }).notNull().defaultNow(),

    /** Qui a payé ce relevé : le balayage, ou quelqu'un qui a cliqué « Relever ». */
    source: text('source').notNull().default('sweep'),

    reachable: boolean('reachable').notNull(),
    /** Établissement de la session SSH. `null` quand elle n'a pas abouti. */
    latencyMs: integer('latency_ms'),
    /** Renseigné uniquement quand la machine n'a pas répondu. */
    error: text('error'),

    /**
     * Les trois charges moyennes, et pas seulement celle d'une minute.
     * C'est ce qui rend une cadence de 5 minutes honnête : `load15` couvre
     * l'intervalle entre deux relevés, là où `load1` seule laisserait des pics
     * de quatre minutes parfaitement invisibles.
     */
    loadOne: real('load_one'),
    loadFive: real('load_five'),
    loadFifteen: real('load_fifteen'),
    cores: integer('cores'),
    /**
     * `load1 / cores`, **en pourcentage de la capacité** (100 = un cœur plein
     * par cœur). Le pourcentage n'est pas cosmétique : il met la charge dans la
     * même unité que la mémoire et le disque, ce qui permet **un seul type de
     * seuil** et une seule colonne de seuil pour les trois métriques. `null`
     * quand `nproc` manque — jamais 0, jamais 1 cœur supposé.
     */
    loadPercent: real('load_percent'),

    /** Kibioctets, tels que `/proc/meminfo` les donne. */
    memoryTotalKb: bigint('memory_total_kb', { mode: 'number' }),
    memoryUsedKb: bigint('memory_used_kb', { mode: 'number' }),
    memoryPercent: real('memory_percent'),

    /** La partition qui porte les déploiements, pas forcément `/`. */
    diskPath: text('disk_path'),
    diskSizeKb: bigint('disk_size_kb', { mode: 'number' }),
    diskUsedKb: bigint('disk_used_kb', { mode: 'number' }),
    diskPercent: real('disk_percent'),

    uptimeSeconds: bigint('uptime_seconds', { mode: 'number' }),
  },
  (t) => [
    // Les deux seules requêtes de l'écran :
    //   « la fenêtre 24 h / 7 j d'une machine »  → WHERE target_id = … AND sampled_at >= …
    //   « le dernier relevé connu »              → ORDER BY sampled_at DESC LIMIT 1
    // Un index composite les sert toutes les deux.
    index('target_metric_samples_target_time_idx').on(t.targetId, t.sampledAt.desc()),
    // La purge, elle, balaie toutes machines confondues : il lui faut le temps
    // seul, sinon elle relit la table entière chaque heure.
    index('target_metric_samples_sampled_at_idx').on(t.sampledAt),
  ],
);

/**
 * Les seuils. **Un défaut global, surchargeable par machine.**
 *
 * Pourquoi les deux, et pas l'un des deux :
 *
 *   — un seuil uniquement global ne survit pas au parc réel. Un serveur de
 *     build vit à 95 % de disque par construction ; l'alerter tous les jours
 *     apprend à ignorer l'alerte ;
 *   — un seuil uniquement par machine oblige à régler dix machines pour
 *     obtenir un comportement qui devrait être celui de la boîte.
 *
 * `target_id is null` **est** la ligne globale : ce n'est pas une convention
 * molle, ce sont deux index uniques partiels qui la font respecter. Sans eux,
 * `unique(target_id, metric)` laisserait passer autant de lignes globales
 * qu'on veut — deux `NULL` ne sont jamais égaux en SQL.
 *
 * Et une troisième couche, en code : quand aucune ligne n'existe, le catalogue
 * (`HOST_METRIC_CATALOG`) donne la valeur. La table n'a donc jamais besoin
 * d'être pré-remplie, et une instance neuve alerte quand même.
 */
export const targetMetricThresholds = pgTable(
  'target_metric_thresholds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** `null` = le défaut de l'instance, celui qui s'applique à toute machine. */
    targetId: uuid('target_id').references(() => targets.id, { onDelete: 'cascade' }),
    /**
     * Clé de métrique — `disk`, `memory`, `load`. Du `text` et non un enum, pour
     * la raison qui a fait choisir `text` pour `monitors.type` : un enum
     * ajouterait une migration à la liste de ce qu'il faut faire pour surveiller
     * une dimension de plus. Le vocabulaire reste fermé, dans le catalogue, et
     * Zod le fait respecter à chaque écriture.
     */
    metric: text('metric').notNull(),

    /** Au-delà (strictement) duquel la métrique est en dépassement. En pourcentage. */
    limitPercent: real('limit_percent').notNull(),
    /**
     * Relevés consécutifs au-dessus du seuil avant d'ouvrir l'épisode, et
     * relevés consécutifs en dessous avant de le refermer. Même vocabulaire que
     * `monitors.failure_threshold` / `recovery_threshold`, et même raison : un
     * rebond ne doit produire ni épisode ni message.
     */
    breachSamples: integer('breach_samples').notNull().default(1),
    clearSamples: integer('clear_samples').notNull().default(2),
    /** Un seuil désactivé n'alerte plus, mais l'historique continue d'être écrit. */
    enabled: boolean('enabled').notNull().default(true),

    updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('target_metric_thresholds_target_idx')
      .on(t.targetId, t.metric)
      .where(sql`${t.targetId} is not null`),
    uniqueIndex('target_metric_thresholds_global_idx')
      .on(t.metric)
      .where(sql`${t.targetId} is null`),
    // Plafond à 1000 et non 100 : la charge par cœur s'exprime en pourcentage de
    // la capacité et dépasse légitimement 100 % sur une machine surchargée.
    check(
      'target_metric_thresholds_limit_check',
      sql`${t.limitPercent} > 0 and ${t.limitPercent} <= 1000`,
    ),
    check(
      'target_metric_thresholds_samples_check',
      sql`${t.breachSamples} between 1 and 10 and ${t.clearSamples} between 1 and 10`,
    ),
  ],
);

/**
 * Les dépassements. **Une table, pas une dérivation à la lecture.**
 *
 * Le raisonnement est celui de `monitor_incidents`, et il tient mot pour mot :
 *
 *  1. l'alerte doit partir **une seule fois**, ce qui demande une trace durable
 *     du « j'ai déjà prévenu » — c'est cette ligne. Une machine dont le disque
 *     reste à 92 % pendant trois jours produit **un** épisode, donc **une**
 *     entrée d'audit, et non une par relevé ;
 *  2. le seuil est réglable : dériver les épisodes à la lecture ferait
 *     apparaître rétroactivement des dépassements dans une chronologie qu'un
 *     humain a déjà lue. `limit_percent` est donc **recopié dans la ligne** au
 *     moment de l'ouverture : l'épisode dit sous quel seuil il a été décidé,
 *     même si le seuil a bougé depuis ;
 *  3. le coût : dériver, c'est rejouer la règle sur toute la série à chaque
 *     affichage, sur la table faite pour grandir.
 *
 * L'index unique **partiel** sur `(target_id, metric) where resolved_at is null`
 * est la garantie qu'une machine n'a jamais deux dépassements ouverts sur la
 * même métrique — y compris si le balayage et un « Relever » manuel concluent
 * en même temps. Comme l'anti-collision de ports : une contrainte, pas un `if`.
 */
export const targetMetricBreaches = pgTable(
  'target_metric_breaches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'cascade' }),
    metric: text('metric').notNull(),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),

    /** Le seuil **tel qu'il était** au franchissement. Jamais relu depuis la table. */
    limitPercent: real('limit_percent').notNull(),
    /** La valeur qui a fait basculer. */
    openedValue: real('opened_value').notNull(),
    /** La pire valeur atteinte pendant l'épisode — ce qu'on veut lire après coup. */
    peakValue: real('peak_value').notNull(),
    lastValue: real('last_value').notNull(),
    /** Relevés observés depuis l'ouverture. Dit la durée en nombre de mesures. */
    samples: integer('samples').notNull().default(1),
  },
  (t) => [
    uniqueIndex('target_metric_breaches_open_idx')
      .on(t.targetId, t.metric)
      .where(sql`${t.resolvedAt} is null`),
    index('target_metric_breaches_target_started_idx').on(t.targetId, t.startedAt.desc()),
  ],
);

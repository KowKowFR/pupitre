import {
  MONITOR_CHECK_RETENTION_DAYS,
  MONITOR_PRUNE_BATCH,
  type HostMetrics,
} from '@pupitre/core';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type Database } from './client.js';
import { targets } from './schema/infra.js';
import {
  targetMetricBreaches,
  targetMetricSamples,
  targetMetricThresholds,
} from './schema/target-metrics.js';

/**
 * Mémoire de la supervision des serveurs — écriture, lecture, seuils.
 *
 * ── Où vit la décision ──────────────────────────────────────────────────────
 * Dans ce projet, ce qui décide vit dans `@pupitre/core` et ce module écrit
 * (voir l'en-tête de `monitors.ts`). Le catalogue et la règle de franchissement
 * ci-dessous devraient donc être dans `@pupitre/core/host-metrics.ts`, à côté
 * des types de relevé qu'ils commentent. Ils sont ici parce que `packages/core`
 * était hors périmètre pour ce chantier — quatre autres tournaient en parallèle.
 * **C'est une dette, elle est nommée** : le déplacement est un couper-coller,
 * ces fonctions sont pures et ne touchent ni à `getDb()` ni à Drizzle.
 */

// ─── cadence et rétention ─────────────────────────────────────────────────────

/**
 * Un relevé toutes les 5 minutes et par machine.
 *
 * **Pourquoi pas la minute.** Une minute sur cinq machines pendant trente jours,
 * ce sont 216 000 lignes pour une information que personne ne lit à la seconde
 * près : un disque ne passe pas de 40 % à 90 % en soixante secondes, et une
 * mémoire non plus. Cinq minutes ramènent le volume à ~8 600 lignes par machine
 * et par mois — trois fois moins qu'une sonde de site à la minute, ce que ce
 * panel écrit déjà sans que personne s'en émeuve.
 *
 * **Pourquoi ce n'est pas aveugle pour autant.** La seule métrique qui bouge
 * vite est la charge. C'est exactement pour ça que le relevé enregistre les
 * *trois* moyennes : `load15` couvre les quinze dernières minutes, donc les
 * quatre minutes qu'on ne regarde pas. Un pic invisible sur `load1` reste
 * lisible sur `load15` du relevé suivant.
 *
 * **Pourquoi pas non plus une cadence réglable par machine.** Ce serait un
 * quatrième bouton à comprendre pour un gain nul : contrairement à une sonde de
 * site — dont la cadence coûte à un tiers et dépend de ce qu'elle observe — un
 * relevé SSH ne coûte qu'à nous, et toutes les machines observent la même chose.
 */
export const HOST_SAMPLE_INTERVAL_SECONDS = 300;

/**
 * Rétention de la série, en jours. **Exactement celle des sondes de site**, et
 * pas par hasard : deux rétentions différentes dans le même panel obligeraient
 * l'exploitant à retenir deux chiffres et à se demander lequel s'applique à ce
 * qu'il regarde. La constante est dérivée, pas recopiée — bouger l'une bouge
 * l'autre.
 */
export const HOST_SAMPLE_RETENTION_DAYS = MONITOR_CHECK_RETENTION_DAYS;

/** Taille d'un lot de purge. Même valeur, même raison : ne pas tenir la table. */
export const HOST_SAMPLE_PRUNE_BATCH = MONITOR_PRUNE_BATCH;

/**
 * Machines relevées par un même balayage. Large : un relevé dure ~1 s sur une
 * machine qui répond, et le budget de temps du balayage borne déjà le reste.
 */
export const HOST_SWEEP_BATCH = 50;

/** Relevés menés de front. Deux : la même prudence que l'écran, pour la même raison. */
export const HOST_SWEEP_CONCURRENCY = 2;

/**
 * Budget de temps d'un balayage. Sous la cadence d'installation (60 s) : ce qui
 * n'a pas été relevé reste dû et part au balayage suivant.
 */
export const HOST_SWEEP_BUDGET_MS = 45_000;

/** Cadence d'installation du balayage. Cinq fois plus fine que la cadence de
 *  relevé : c'est ce qui permet à une machine ajoutée d'être relevée vite. */
export const HOST_SWEEP_EVERY_MS = 60_000;

// ─── le catalogue des métriques surveillées ───────────────────────────────────

export const HOST_METRIC_KEYS = ['disk', 'memory', 'load'] as const;
export type HostMetricKey = (typeof HOST_METRIC_KEYS)[number];
export const hostMetricKeySchema = z.enum(HOST_METRIC_KEYS);

export function isHostMetricKey(value: string): value is HostMetricKey {
  return (HOST_METRIC_KEYS as readonly string[]).includes(value);
}

export type HostMetricDefinition = {
  key: HostMetricKey;
  label: string;
  /**
   * Seuil par défaut, en pourcentage. **Ce sont les valeurs que l'écran affiche
   * déjà en rouge** (`host-readouts.tsx`, `saturationTone`) : le seuil d'alerte
   * ne fabrique pas un second vocabulaire à côté de la couleur.
   */
  defaultLimitPercent: number;
  /** Relevés consécutifs au-dessus avant d'ouvrir. Propre à la métrique. */
  defaultBreachSamples: number;
  /** Relevés consécutifs en dessous avant de refermer. */
  defaultClearSamples: number;
  /** Extrait de la ligne la valeur comparable au seuil. `null` = non mesurée. */
  read: (sample: TargetMetricSample) => number | null;
  /** Une phrase de dépassement, pour le journal et pour l'écran. */
  describe: (value: number, sample: TargetMetricSample) => string;
};

/**
 * Les trois dimensions surveillées, et le réglage qui va avec.
 *
 * **Le nombre de relevés consécutifs n'est pas le même partout, et c'est le
 * cœur du réglage.** Un disque est une quantité lente et monotone : un seul
 * relevé au-dessus de 90 % est déjà la vérité, exiger trois confirmations ne
 * ferait que retarder l'alerte d'un quart d'heure. Une charge, à l'inverse, est
 * du bruit : un pic isolé à 4 sur une machine à 11 cœurs ne veut rien dire, et
 * n'a aucune raison de réveiller qui que ce soit. Trois relevés d'affilée
 * au-dessus de la capacité, en revanche, c'est une machine en peine.
 *
 * Ajouter une dimension (I/O, nombre de processus, température) = une entrée
 * ici et une colonne dans la table. Rien d'autre à modifier : ni le balayage,
 * ni l'écran, ni les routes.
 */
export const HOST_METRIC_CATALOG: Record<HostMetricKey, HostMetricDefinition> = {
  disk: {
    key: 'disk',
    label: 'Disque',
    defaultLimitPercent: 90,
    // Un seul relevé suffit : le disque ne rebondit pas.
    defaultBreachSamples: 1,
    defaultClearSamples: 2,
    read: (sample) => sample.diskPercent,
    describe: (value, sample) =>
      `disque ${sample.diskPath ?? ''} à ${value.toFixed(1)} %`.replace('  ', ' '),
  },
  memory: {
    key: 'memory',
    label: 'Mémoire',
    defaultLimitPercent: 90,
    // Deux : un pic de mémoire d'un instant est courant, deux relevés à cinq
    // minutes d'écart ne le sont plus.
    defaultBreachSamples: 2,
    defaultClearSamples: 2,
    read: (sample) => sample.memoryPercent,
    describe: (value) => `mémoire utilisée à ${value.toFixed(1)} %`,
  },
  load: {
    key: 'load',
    label: 'Charge',
    // 100 % = un cœur plein par cœur. C'est la valeur au-delà de laquelle
    // l'écran affiche déjà la charge en rouge.
    defaultLimitPercent: 100,
    defaultBreachSamples: 3,
    defaultClearSamples: 3,
    read: (sample) => sample.loadPercent,
    describe: (value, sample) =>
      `charge à ${(value / 100).toFixed(2)} par cœur` +
      (sample.cores === null ? '' : ` (${sample.loadOne?.toFixed(2) ?? '?'} sur ${sample.cores} cœurs)`),
  },
};

export const HOST_METRIC_LIST: readonly HostMetricDefinition[] = HOST_METRIC_KEYS.map(
  (key) => HOST_METRIC_CATALOG[key],
);

// ─── types ────────────────────────────────────────────────────────────────────

export type TargetMetricSample = typeof targetMetricSamples.$inferSelect;
export type TargetMetricBreach = typeof targetMetricBreaches.$inferSelect;
export type TargetMetricThresholdRow = typeof targetMetricThresholds.$inferSelect;

/** D'où vient un relevé. Un « Relever » manuel vaut autant qu'un balayage. */
export const sampleSourceSchema = z.enum(['sweep', 'manual']);
export type SampleSource = z.infer<typeof sampleSourceSchema>;

/** Un seuil effectif, et d'où il vient. L'écran doit pouvoir le dire. */
export type ResolvedThreshold = {
  metric: HostMetricKey;
  limitPercent: number;
  breachSamples: number;
  clearSamples: number;
  enabled: boolean;
  /** `default` = le catalogue, `global` = la ligne d'instance, `target` = la machine. */
  origin: 'default' | 'global' | 'target';
};

/** Une bascule : le seul moment où quelque chose est dit à l'extérieur. */
export type BreachTransition = {
  kind: 'opened' | 'cleared';
  metric: HostMetricKey;
  breach: TargetMetricBreach;
  threshold: ResolvedThreshold;
  value: number;
  /** Renseigné quand l'épisode se referme parce que le seuil a été désactivé. */
  reason: 'crossed' | 'threshold_disabled';
};

// ─── écriture d'un relevé ─────────────────────────────────────────────────────

/**
 * Enregistre un relevé.
 *
 * **Tout relevé est enregistré, quel qu'en soit le déclencheur.** Le balayage
 * et le bouton « Relever » de l'écran écrivent la même ligne, avec `source` pour
 * seule différence. C'est ce qui fait qu'un clic n'est plus une dépense perdue :
 * la session SSH a été payée, la valeur reste.
 *
 * Une machine injoignable produit une ligne aussi — `reachable = false`, la
 * raison, aucune métrique. Un trou dans une chronologie ne dit pas s'il y avait
 * une panne ou pas de superviseur.
 */
export async function recordTargetSample(
  metrics: HostMetrics,
  source: SampleSource = 'sweep',
  db: Database = getDb(),
): Promise<TargetMetricSample> {
  const load = metrics.load;
  const memory = metrics.memory;
  const disk = metrics.disk;

  const [row] = await db
    .insert(targetMetricSamples)
    .values({
      targetId: metrics.targetId,
      sampledAt: new Date(metrics.checkedAt),
      source,
      reachable: metrics.reachable,
      latencyMs: metrics.latencyMs,
      error: metrics.error,
      loadOne: load?.one ?? null,
      loadFive: load?.five ?? null,
      loadFifteen: load?.fifteen ?? null,
      cores: load?.cores ?? null,
      // `perCore` est déjà `null` quand `nproc` manque : on ne suppose pas un cœur.
      loadPercent: load?.perCore === null || load?.perCore === undefined ? null : load.perCore * 100,
      memoryTotalKb: memory?.totalKb ?? null,
      memoryUsedKb: memory?.usedKb ?? null,
      memoryPercent: memory?.usedPercent ?? null,
      diskPath: disk?.path ?? null,
      diskSizeKb: disk?.sizeKb ?? null,
      diskUsedKb: disk?.usedKb ?? null,
      diskPercent: disk?.usePercent ?? null,
      uptimeSeconds: metrics.uptimeSeconds === null ? null : Math.round(metrics.uptimeSeconds),
    })
    .returning();
  if (!row) throw new Error('insertion du relevé sans retour');
  return row;
}

// ─── seuils ───────────────────────────────────────────────────────────────────

export const upsertThresholdSchema = z.object({
  metric: hostMetricKeySchema,
  limitPercent: z.number().positive().max(1000),
  breachSamples: z.number().int().min(1).max(10).optional(),
  clearSamples: z.number().int().min(1).max(10).optional(),
  enabled: z.boolean().optional(),
});
export type UpsertThresholdInput = z.infer<typeof upsertThresholdSchema>;

/**
 * Le seuil effectif d'une machine, métrique par métrique.
 *
 * Trois couches, de la plus faible à la plus forte : le catalogue (toujours
 * présent, donc une instance neuve alerte sans qu'on ait rien réglé), la ligne
 * globale (`target_id is null`), puis la ligne de la machine. La résolution est
 * faite **ici et nulle part ailleurs** — un `?? défaut` recopié dans l'écran et
 * dans le balayage serait deux vérités qui finiraient par diverger.
 */
export async function resolveThresholds(
  targetId: string,
  db: Database = getDb(),
): Promise<Record<HostMetricKey, ResolvedThreshold>> {
  const rows = await db
    .select()
    .from(targetMetricThresholds)
    .where(
      sql`${targetMetricThresholds.targetId} is null or ${targetMetricThresholds.targetId} = ${targetId}`,
    );

  const out = {} as Record<HostMetricKey, ResolvedThreshold>;
  for (const definition of HOST_METRIC_LIST) {
    out[definition.key] = {
      metric: definition.key,
      limitPercent: definition.defaultLimitPercent,
      breachSamples: definition.defaultBreachSamples,
      clearSamples: definition.defaultClearSamples,
      enabled: true,
      origin: 'default',
    };
  }

  // Le global d'abord, la machine ensuite : le second écrase le premier.
  for (const scope of ['global', 'target'] as const) {
    for (const row of rows) {
      if (!isHostMetricKey(row.metric)) continue;
      const isGlobal = row.targetId === null;
      if ((scope === 'global') !== isGlobal) continue;
      out[row.metric] = {
        metric: row.metric,
        limitPercent: row.limitPercent,
        breachSamples: row.breachSamples,
        clearSamples: row.clearSamples,
        enabled: row.enabled,
        origin: scope,
      };
    }
  }
  return out;
}

/** Les seuils explicites en base, tels quels. Sert à l'écran de réglage. */
export async function listThresholdRows(
  db: Database = getDb(),
): Promise<TargetMetricThresholdRow[]> {
  return db.select().from(targetMetricThresholds);
}

/**
 * Pose ou remplace un seuil. `targetId = null` règle le défaut de l'instance.
 *
 * `onConflictDoUpdate` sur l'index unique partiel : deux réglages simultanés de
 * la même métrique ne peuvent pas créer deux lignes concurrentes.
 */
export async function upsertThreshold(
  targetId: string | null,
  input: UpsertThresholdInput,
  updatedBy: string | null,
  db: Database = getDb(),
): Promise<TargetMetricThresholdRow> {
  const definition = HOST_METRIC_CATALOG[input.metric];
  const values = {
    targetId,
    metric: input.metric,
    limitPercent: input.limitPercent,
    breachSamples: input.breachSamples ?? definition.defaultBreachSamples,
    clearSamples: input.clearSamples ?? definition.defaultClearSamples,
    enabled: input.enabled ?? true,
    updatedBy,
    updatedAt: new Date(),
  };

  const [row] = await db
    .insert(targetMetricThresholds)
    .values(values)
    .onConflictDoUpdate({
      // L'index visé dépend de la portée : les deux index sont partiels, et
      // Postgres exige que le prédicat de l'index soit satisfait par la ligne.
      target:
        targetId === null
          ? [targetMetricThresholds.metric]
          : [targetMetricThresholds.targetId, targetMetricThresholds.metric],
      targetWhere:
        targetId === null
          ? sql`${targetMetricThresholds.targetId} is null`
          : sql`${targetMetricThresholds.targetId} is not null`,
      set: {
        limitPercent: values.limitPercent,
        breachSamples: values.breachSamples,
        clearSamples: values.clearSamples,
        enabled: values.enabled,
        updatedBy,
        updatedAt: values.updatedAt,
      },
    })
    .returning();
  if (!row) throw new Error('écriture du seuil sans retour');
  return row;
}

/** Retire un réglage : la couche du dessous reprend la main. */
export async function deleteThreshold(
  targetId: string | null,
  metric: HostMetricKey,
  db: Database = getDb(),
): Promise<boolean> {
  const [row] = await db
    .delete(targetMetricThresholds)
    .where(
      and(
        eq(targetMetricThresholds.metric, metric),
        targetId === null
          ? isNull(targetMetricThresholds.targetId)
          : eq(targetMetricThresholds.targetId, targetId),
      ),
    )
    .returning({ id: targetMetricThresholds.id });
  return row !== undefined;
}

// ─── la règle de franchissement ───────────────────────────────────────────────

/**
 * Combien de relevés il faut relire pour trancher, tous seuils confondus.
 * Borné par les contraintes de la table (`between 1 and 10`), et pris large :
 * un relevé injoignable ne compte pas, il faut donc de la marge.
 */
const RECENT_WINDOW = 40;

/**
 * Décide, à partir des derniers relevés, si un seuil est franchi ou libéré.
 *
 * ── Pourquoi les compteurs ne sont pas stockés ──────────────────────────────
 * La supervision de sites tient `consecutive_failures` sur la ligne de sonde.
 * Ici, ils sont **relus de la série** à chaque évaluation. Deux raisons :
 *
 *   1. la série existe déjà et elle est indexée par `(target_id, sampled_at)` ;
 *      un compteur serait une seconde vérité, qu'un worker tué au mauvais
 *      moment ferait diverger de la première ;
 *   2. baisser un seuil doit produire l'alerte **tout de suite** si la machine
 *      est déjà au-dessus, pas dans quinze minutes. Un compteur stocké aurait
 *      été remis à zéro par le changement de réglage.
 *
 * L'objection de `monitor_incidents` — « un incident est une décision prise à
 * un instant, avec les réglages de cet instant, elle doit être immuable » —
 * porte sur l'**épisode**, pas sur les compteurs. Elle est tenue : l'épisode est
 * une ligne, et il recopie le seuil qui l'a ouvert.
 *
 * ── Un relevé qui n'a rien mesuré ne compte pas ─────────────────────────────
 * Machine éteinte, `df` absent : la valeur est `null`. Elle n'est comptée ni
 * comme un dépassement, ni comme un retour à la normale — elle est **sautée**.
 * La compter comme un retour à la normale refermerait tout seul l'épisode d'une
 * machine dont le disque plein est peut-être la cause de la panne.
 */
export function decideBreach(
  values: readonly (number | null)[],
  threshold: ResolvedThreshold,
  hasOpenBreach: boolean,
): 'open' | 'clear' | null {
  const measured = values.filter((value): value is number => value !== null);

  if (!hasOpenBreach) {
    if (measured.length < threshold.breachSamples) return null;
    const streak = measured.slice(0, threshold.breachSamples);
    return streak.every((value) => value > threshold.limitPercent) ? 'open' : null;
  }

  if (measured.length < threshold.clearSamples) return null;
  const streak = measured.slice(0, threshold.clearSamples);
  return streak.every((value) => value <= threshold.limitPercent) ? 'clear' : null;
}

/**
 * Applique la règle à un relevé qui vient d'être écrit, et rend les bascules.
 *
 * Tout tient dans une transaction : sans elle, un worker tué entre l'ouverture
 * de l'épisode et sa lecture laisserait un dépassement dont personne ne serait
 * prévenu — exactement l'argument de `applyCheck()` pour les sondes.
 *
 * **Cette fonction n'alerte pas et n'audite pas.** Elle constate. C'est
 * l'appelant (le worker) qui écrit l'entrée d'audit, comme
 * `notifyMonitorTransition()` le fait pour les sondes : un seul endroit dans le
 * projet où une transition devient un message.
 */
export async function evaluateThresholds(
  targetId: string,
  db: Database = getDb(),
): Promise<BreachTransition[]> {
  const thresholds = await resolveThresholds(targetId, db);

  return db.transaction(async (tx) => {
    const recent = await tx
      .select()
      .from(targetMetricSamples)
      .where(eq(targetMetricSamples.targetId, targetId))
      .orderBy(desc(targetMetricSamples.sampledAt))
      .limit(RECENT_WINDOW);

    if (recent.length === 0) return [];
    const latest = recent[0] as TargetMetricSample;

    const open = await tx
      .select()
      .from(targetMetricBreaches)
      .where(
        and(
          eq(targetMetricBreaches.targetId, targetId),
          isNull(targetMetricBreaches.resolvedAt),
        ),
      );
    const openByMetric = new Map(open.map((row) => [row.metric, row]));

    const transitions: BreachTransition[] = [];
    const now = latest.sampledAt;

    for (const definition of HOST_METRIC_LIST) {
      const threshold = thresholds[definition.key];
      const current = openByMetric.get(definition.key) ?? null;
      const values = recent.map((sample) => definition.read(sample));
      const value = values[0] ?? null;

      // Seuil désactivé : on ne juge plus, mais on ne laisse pas un épisode
      // ouvert pour l'éternité — il se referme, et le journal dit pourquoi.
      if (!threshold.enabled) {
        if (current) {
          const [closed] = await tx
            .update(targetMetricBreaches)
            .set({ resolvedAt: now })
            .where(eq(targetMetricBreaches.id, current.id))
            .returning();
          if (closed) {
            transitions.push({
              kind: 'cleared',
              metric: definition.key,
              breach: closed,
              threshold,
              value: closed.lastValue,
              reason: 'threshold_disabled',
            });
          }
        }
        continue;
      }

      // L'épisode ouvert suit la métrique même sans bascule : c'est là qu'on
      // apprend « 92 % au pire, depuis 3 h » — sans écrire une ligne d'audit.
      if (current && value !== null) {
        await tx
          .update(targetMetricBreaches)
          .set({
            lastValue: value,
            peakValue: Math.max(current.peakValue, value),
            samples: current.samples + 1,
          })
          .where(eq(targetMetricBreaches.id, current.id));
      }

      const verdict = decideBreach(values, threshold, current !== null);
      if (verdict === null) continue;

      if (verdict === 'open' && value !== null) {
        // `onConflictDoNothing` s'appuie sur l'index unique partiel : même si le
        // balayage et un « Relever » manuel concluaient en même temps, il n'y
        // aurait qu'un épisode, donc qu'une entrée d'audit.
        const [opened] = await tx
          .insert(targetMetricBreaches)
          .values({
            targetId,
            metric: definition.key,
            startedAt: now,
            limitPercent: threshold.limitPercent,
            openedValue: value,
            peakValue: value,
            lastValue: value,
            samples: 1,
          })
          .onConflictDoNothing()
          .returning();
        if (opened) {
          transitions.push({
            kind: 'opened',
            metric: definition.key,
            breach: opened,
            threshold,
            value,
            reason: 'crossed',
          });
        }
        continue;
      }

      if (verdict === 'clear' && current) {
        const [closed] = await tx
          .update(targetMetricBreaches)
          .set({ resolvedAt: now, lastValue: value ?? current.lastValue })
          .where(eq(targetMetricBreaches.id, current.id))
          .returning();
        if (closed) {
          transitions.push({
            kind: 'cleared',
            metric: definition.key,
            breach: closed,
            threshold,
            value: value ?? closed.lastValue,
            reason: 'crossed',
          });
        }
      }
    }

    return transitions;
  });
}

// ─── joignabilité ─────────────────────────────────────────────────────────────

/**
 * Relevés manqués de suite avant de déclarer une machine injoignable. Deux, et
 * non un : un redémarrage, une coupure de quelques secondes ne réveillent
 * personne. À la cadence du balayage, c'est cinq à dix minutes de silence.
 */
export const UNREACHABLE_CONFIRM_SAMPLES = 2;

export type ReachabilityTransition =
  | { kind: 'unreachable'; since: Date; at: Date; failures: number; error: string | null }
  | { kind: 'reachable'; since: Date; at: Date };

/**
 * Applique la règle de joignabilité au relevé qui vient d'être écrit, et rend
 * la bascule s'il y en a une.
 *
 * L'épisode vit sur la machine (`targets.unreachable_since`) : il s'ouvre au
 * deuxième relevé manqué de suite, daté du premier, et se ferme au premier
 * relevé réussi. La ligne de la machine est verrouillée le temps de décider :
 * un balayage et un « Relever » qui concluraient à la même seconde ne font
 * qu'une bascule, donc qu'une alerte.
 *
 * Comme `evaluateThresholds()`, elle constate et n'audite pas : c'est le
 * worker qui fait de la bascule un message.
 */
export async function evaluateReachability(
  targetId: string,
  db: Database = getDb(),
): Promise<ReachabilityTransition | null> {
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({ since: targets.unreachableSince })
      .from(targets)
      .where(eq(targets.id, targetId))
      .for('update');
    if (!target) return null;

    const recent = await tx
      .select({
        reachable: targetMetricSamples.reachable,
        error: targetMetricSamples.error,
        sampledAt: targetMetricSamples.sampledAt,
      })
      .from(targetMetricSamples)
      .where(eq(targetMetricSamples.targetId, targetId))
      .orderBy(desc(targetMetricSamples.sampledAt))
      .limit(UNREACHABLE_CONFIRM_SAMPLES);
    const latest = recent[0];
    if (!latest) return null;

    if (latest.reachable) {
      if (!target.since) return null;
      await tx.update(targets).set({ unreachableSince: null }).where(eq(targets.id, targetId));
      return { kind: 'reachable', since: target.since, at: latest.sampledAt };
    }

    if (target.since) return null;
    if (recent.length < UNREACHABLE_CONFIRM_SAMPLES) return null;
    if (recent.some((sample) => sample.reachable)) return null;
    const since = recent[recent.length - 1]!.sampledAt;
    await tx.update(targets).set({ unreachableSince: since }).where(eq(targets.id, targetId));
    return {
      kind: 'unreachable',
      since,
      at: latest.sampledAt,
      failures: recent.length,
      error: latest.error,
    };
  });
}

// ─── balayage ─────────────────────────────────────────────────────────────────

/**
 * Les machines dont le dernier relevé est plus vieux que la cadence.
 *
 * **Pas de colonne d'échéance sur `targets`.** La supervision de sites en a une
 * (`next_check_at`) parce que plusieurs workers réclament les sondes en
 * concurrence et doivent avancer l'échéance *avant* de sonder. Ici, un verrou
 * Redis garantit un seul balayage à la fois, et la date du dernier relevé est
 * déjà dans la série : une colonne serait une seconde vérité, qui divergerait le
 * jour où un relevé est écrit sans passer par le balayage — ce qui est
 * précisément ce que fait le bouton « Relever ».
 *
 * Effet de bord souhaitable : un clic manuel repousse naturellement le balayage
 * de cette machine. Deux relevés à trois secondes d'intervalle n'apprennent rien.
 */
export async function listDueTargets(
  options: {
    intervalSeconds?: number;
    limit?: number;
    /** Restreint à une machine. Le filtre est **dans** la requête, pas après :
     *  filtrer un lot de 50 laisserait passer à côté d'une machine due en 51ᵉ. */
    targetId?: string | null;
  } = {},
  db: Database = getDb(),
): Promise<Array<{ id: string; name: string; lastSampleAt: Date | null }>> {
  const intervalSeconds = options.intervalSeconds ?? HOST_SAMPLE_INTERVAL_SECONDS;
  const limit = options.limit ?? HOST_SWEEP_BATCH;
  const only = options.targetId ?? null;

  const last = db
    .select({
      targetId: targetMetricSamples.targetId,
      lastSampleAt: sql<Date | null>`max(${targetMetricSamples.sampledAt})`.as('last_sample_at'),
    })
    .from(targetMetricSamples)
    .groupBy(targetMetricSamples.targetId)
    .as('last');

  const rows = await db
    .select({ id: targets.id, name: targets.name, lastSampleAt: last.lastSampleAt })
    .from(targets)
    .leftJoin(last, eq(last.targetId, targets.id))
    .where(
      and(
        sql`${last.lastSampleAt} is null or ${last.lastSampleAt} <= now() - make_interval(secs => ${intervalSeconds})`,
        only === null ? undefined : eq(targets.id, only),
      ),
    )
    // Les jamais relevées d'abord : une machine qu'on vient de déclarer doit
    // apparaître à l'écran avec un passé, pas attendre son tour.
    .orderBy(sql`${last.lastSampleAt} asc nulls first`)
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    lastSampleAt: row.lastSampleAt === null ? null : new Date(row.lastSampleAt),
  }));
}

/**
 * Purge la série au-delà de la rétention, par lots.
 *
 * Les **dépassements ne sont jamais purgés** : ils sont rares, ce sont eux qui
 * racontent l'histoire, et une chronologie amputée ne vaut rien. Même arbitrage
 * que les incidents de sonde.
 */
export async function pruneTargetSamples(
  days: number = HOST_SAMPLE_RETENTION_DAYS,
  batch: number = HOST_SAMPLE_PRUNE_BATCH,
  db: Database = getDb(),
): Promise<number> {
  const rows = await db
    .delete(targetMetricSamples)
    .where(
      sql`${targetMetricSamples.id} in (
        select id from ${targetMetricSamples}
         where sampled_at < now() - make_interval(days => ${days})
         limit ${batch}
      )`,
    )
    .returning({ id: targetMetricSamples.id });
  return rows.length;
}

// ─── lectures d'écran ─────────────────────────────────────────────────────────

/** Un point de la courbe : un intervalle de temps, et le **pire** de ses relevés. */
export type HistoryPoint = {
  at: string;
  samples: number;
  reachable: number;
  diskPercent: number | null;
  memoryPercent: number | null;
  loadPercent: number | null;
};

export type MetricSummary = {
  /** Dernière valeur connue de la fenêtre. */
  last: number | null;
  /** Le pire relevé de la fenêtre — la question qu'on se pose vraiment. */
  worst: number | null;
  /** Dernière valeur moins la première : le sens dans lequel ça va. */
  trend: number | null;
};

export type TargetHistory = {
  targetId: string;
  hours: number;
  bucketSeconds: number;
  /** Nombre de relevés réellement pris dans la fenêtre. Un taux sans dénominateur ment. */
  samples: number;
  /** Relevés où la machine a répondu. */
  reachable: number;
  points: HistoryPoint[];
  summary: Record<HostMetricKey, MetricSummary>;
};

const EMPTY_SUMMARY: MetricSummary = { last: null, worst: null, trend: null };

function summarise(points: readonly HistoryPoint[], key: HostMetricKey): MetricSummary {
  const field =
    key === 'disk' ? 'diskPercent' : key === 'memory' ? 'memoryPercent' : 'loadPercent';
  const values = points
    .map((point) => point[field])
    .filter((value): value is number => value !== null);
  if (values.length === 0) return EMPTY_SUMMARY;
  const first = values[0] as number;
  const last = values[values.length - 1] as number;
  return { last, worst: Math.max(...values), trend: last - first };
}

/**
 * L'historique de plusieurs machines, agrégé **à la lecture**.
 *
 * ── Pourquoi pas de table de pré-agrégation ─────────────────────────────────
 * Sept jours à cinq minutes font 2 016 points par machine : illisible sur une
 * courbe de 120 pixels, et inutile à transporter. La réponse habituelle est une
 * table de rollups horaires. Elle n'est pas prise ici : elle demanderait une
 * seconde écriture, une seconde purge et une histoire de cohérence entre les
 * deux, pour faire tenir un `max()` sur quelques milliers de lignes déjà
 * indexées par `(target_id, sampled_at)`. Postgres agrège ça sans transpirer.
 * Le jour où le parc rendrait ce calcul cher, la table de rollups se pose
 * *au-dessus* de la série brute sans rien changer à ce qui l'écrit.
 *
 * ── Pourquoi `max()` et pas `avg()` ─────────────────────────────────────────
 * On regarde une saturation. Une moyenne sur trente minutes noie exactement le
 * moment qui intéresse — le pic à 100 % qui a fait tomber l'application. Le pire
 * relevé de l'intervalle est la seule agrégation honnête pour cette question.
 */
export async function targetHistories(
  targetIds: readonly string[],
  hours: number,
  buckets = 48,
  db: Database = getDb(),
): Promise<Map<string, TargetHistory>> {
  const bucketSeconds = Math.max(60, Math.round((hours * 3600) / buckets));
  const out = new Map<string, TargetHistory>();

  for (const id of targetIds) {
    out.set(id, {
      targetId: id,
      hours,
      bucketSeconds,
      samples: 0,
      reachable: 0,
      points: [],
      summary: { disk: EMPTY_SUMMARY, memory: EMPTY_SUMMARY, load: EMPTY_SUMMARY },
    });
  }
  if (targetIds.length === 0) return out;

  // Le seau est exprimé en secondes d'époque : aucun fuseau n'entre dans le
  // calcul, et deux machines partagent exactement les mêmes bornes.
  //
  // `sql.raw` et non un paramètre lié, et ce n'est pas un raccourci : la même
  // expression apparaît dans le SELECT, dans le GROUP BY et dans le ORDER BY.
  // Liée, elle produirait `$1`, `$5` et `$7` — trois placeholders que Postgres
  // ne peut pas reconnaître comme une seule expression, et il refuse la requête
  // (« column sampled_at must appear in the GROUP BY clause »). Le bug a existé.
  // Aucune injection possible : `bucketSeconds` est le résultat d'un
  // `Math.round` sur des entiers déjà validés par Zod, jamais une chaîne.
  const seconds = sql.raw(String(bucketSeconds));
  const bucket = sql<string>`to_timestamp(floor(extract(epoch from ${targetMetricSamples.sampledAt}) / ${seconds}) * ${seconds})`;

  const rows = await db
    .select({
      targetId: targetMetricSamples.targetId,
      at: bucket,
      samples: sql<number>`count(*)::int`,
      reachable: sql<number>`count(*) filter (where ${targetMetricSamples.reachable})::int`,
      diskPercent: sql<number | null>`max(${targetMetricSamples.diskPercent})`,
      memoryPercent: sql<number | null>`max(${targetMetricSamples.memoryPercent})`,
      loadPercent: sql<number | null>`max(${targetMetricSamples.loadPercent})`,
    })
    .from(targetMetricSamples)
    .where(
      and(
        inArray(targetMetricSamples.targetId, [...targetIds]),
        sql`${targetMetricSamples.sampledAt} >= now() - make_interval(hours => ${hours})`,
      ),
    )
    .groupBy(targetMetricSamples.targetId, bucket)
    .orderBy(asc(bucket));

  for (const row of rows) {
    const history = out.get(row.targetId);
    if (!history) continue;
    history.points.push({
      at: new Date(row.at).toISOString(),
      samples: row.samples,
      reachable: row.reachable,
      diskPercent: row.diskPercent,
      memoryPercent: row.memoryPercent,
      loadPercent: row.loadPercent,
    });
    history.samples += row.samples;
    history.reachable += row.reachable;
  }

  for (const history of out.values()) {
    history.summary = {
      disk: summarise(history.points, 'disk'),
      memory: summarise(history.points, 'memory'),
      load: summarise(history.points, 'load'),
    };
  }

  return out;
}

/** Les dépassements en cours, toutes machines ou une seule. */
export async function listOpenBreaches(
  targetIds?: readonly string[],
  db: Database = getDb(),
): Promise<TargetMetricBreach[]> {
  const where =
    targetIds === undefined
      ? isNull(targetMetricBreaches.resolvedAt)
      : and(
          isNull(targetMetricBreaches.resolvedAt),
          inArray(targetMetricBreaches.targetId, [...targetIds]),
        );
  if (targetIds !== undefined && targetIds.length === 0) return [];
  return db
    .select()
    .from(targetMetricBreaches)
    .where(where)
    .orderBy(desc(targetMetricBreaches.startedAt));
}

/** La chronologie des dépassements d'une machine, ouverts et refermés. */
export async function listBreaches(
  targetId: string,
  limit = 50,
  db: Database = getDb(),
): Promise<TargetMetricBreach[]> {
  return db
    .select()
    .from(targetMetricBreaches)
    .where(eq(targetMetricBreaches.targetId, targetId))
    .orderBy(desc(targetMetricBreaches.startedAt))
    .limit(limit);
}

/** Les derniers relevés bruts d'une machine. Sert au détail et à la preuve. */
export async function listTargetSamples(
  targetId: string,
  limit = 100,
  db: Database = getDb(),
): Promise<TargetMetricSample[]> {
  return db
    .select()
    .from(targetMetricSamples)
    .where(eq(targetMetricSamples.targetId, targetId))
    .orderBy(desc(targetMetricSamples.sampledAt))
    .limit(limit);
}

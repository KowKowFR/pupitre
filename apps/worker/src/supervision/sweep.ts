import {
  HOST_SAMPLE_INTERVAL_SECONDS,
  HOST_SAMPLE_PRUNE_BATCH,
  HOST_SAMPLE_RETENTION_DAYS,
  HOST_SWEEP_BATCH,
  HOST_SWEEP_BUDGET_MS,
  HOST_SWEEP_CONCURRENCY,
  listDueTargets,
  pruneTargetSamples,
} from '@pupitre/db';
import { z } from 'zod';
import { logger } from '../logger.js';
import { getRedis } from '../redis.js';
import { collectAndRecord } from './collect.js';
import { judgeAndAnnounce } from './judge.js';
import { judgeReachability } from './reachability.js';

/**
 * Le balayage des serveurs — l'horloge qui donne une mémoire à la supervision.
 *
 * ── Qui déclenche le relevé, et pourquoi ce n'est plus l'écran ──────────────
 * L'écran déclenchait, et c'était le défaut : un historique qui ne se remplit
 * que quand quelqu'un regarde n'est pas un historique, c'est un reflet. Pire, il
 * est vide exactement quand on en a besoin — le lundi matin, pour comprendre ce
 * qui s'est passé pendant le week-end où personne n'avait l'onglet ouvert.
 *
 * ── Une tâche répétable unique, pas une par machine ─────────────────────────
 * Exactement l'arbitrage — et les mêmes raisons — que le balayage des sondes de
 * site, dont ce fichier est le jumeau : un repeatable job par cible, ce serait
 * une réconciliation Redis ↔ base à chaque cible créée ou supprimée, et autant
 * de tâches qui se battraient pour les slots de la file. Le parallélisme et le
 * budget de temps se décident **à un seul endroit**, et un balayage est cet
 * endroit.
 *
 * ── Pas de cron Linux ───────────────────────────────────────────────────────
 * Décision déjà tranchée du projet. BullMQ est la seule horloge.
 *
 * ── Trois gardes, chacune nécessaire ────────────────────────────────────────
 *   1. **Un verrou Redis** : un seul balayage à la fois, tous workers
 *      confondus. C'est aussi lui qui remplace la colonne `next_check_at` des
 *      sondes — voir `listDueTargets()`.
 *   2. **Un budget de temps et un parallélisme bornés.** Deux relevés de front,
 *      45 secondes de travail. Une machine éteinte coûte 8 secondes de garde
 *      SSH : cinq machines mortes ne doivent pas monopoliser la file.
 *   3. **L'échéance est la donnée elle-même** : une machine relevée à la main
 *      il y a une minute n'est pas due. Le clic ne se paie pas deux fois.
 */

/**
 * Nom de la tâche de balayage.
 *
 * Volontairement **pas** dans `@pupitre/core/queue.ts`, contrairement à
 * `target:metrics`. Ce contrat-là est partagé parce que le panel enfile la
 * tâche et que le worker la consomme. Celui-ci n'a qu'un producteur et qu'un
 * consommateur, tous deux dans ce processus : le panel ne l'enfile jamais, il
 * lit l'historique en SQL. Le sortir dans le paquet partagé serait du
 * vocabulaire exporté que personne n'importe.
 */
export const HOST_SWEEP_JOB = 'target:metrics_sweep' as const;

/** Clé du scheduler BullMQ. Sans deux-points : c'est une clé, pas un nom de tâche. */
export const HOST_SWEEP_SCHEDULER_KEY = 'target-metrics-sweep';

const SWEEP_LOCK_KEY = 'target:metrics:sweep:lock';
const PRUNE_MARK_KEY = 'target:metrics:prune:last';

/** La purge ne tourne qu'une fois par heure : elle balaie toutes machines confondues. */
const PRUNE_EVERY_SECONDS = 3600;

export const hostSweepJobDataSchema = z.object({
  /** Restreint le balayage à une machine. Sert au déclenchement de vérification. */
  targetId: z.string().uuid().nullable().default(null),
  /** Passe outre la cadence : « relever maintenant, quoi qu'il en soit ». */
  force: z.boolean().default(false),
});

export const hostSweepJobResultSchema = z.object({
  due: z.number().int().nonnegative(),
  sampled: z.number().int().nonnegative(),
  reachable: z.number().int().nonnegative(),
  unreachable: z.number().int().nonnegative(),
  breached: z.number().int().nonnegative(),
  cleared: z.number().int().nonnegative(),
  pruned: z.number().int().nonnegative(),
  /** Le balayage a rendu la main sur son budget ; le suivant reprendra. */
  budgetExhausted: z.boolean(),
  /** Un balayage tournait déjà : cette occurrence n'a rien fait, et c'est normal. */
  skipped: z.boolean(),
});

export type HostSweepJobResult = z.infer<typeof hostSweepJobResultSchema>;

const EMPTY: HostSweepJobResult = {
  due: 0,
  sampled: 0,
  reachable: 0,
  unreachable: 0,
  breached: 0,
  cleared: 0,
  pruned: 0,
  budgetExhausted: false,
  skipped: false,
};

type Counters = {
  sampled: number;
  reachable: number;
  unreachable: number;
  breached: number;
  cleared: number;
};

/**
 * Relève une machine, écrit, juge, et n'annonce que les bascules.
 *
 * L'ordre compte : le relevé est **écrit avant d'être jugé**, parce que la règle
 * de franchissement relit la série — les compteurs de relevés consécutifs ne
 * sont pas stockés, ils sont dérivés. Le raisonnement est dans
 * `evaluateThresholds()`.
 */
async function sampleOne(target: { id: string; name: string }, counters: Counters): Promise<void> {
  const { metrics, recorded } = await collectAndRecord(target.id, 'sweep');
  counters.sampled += 1;
  if (metrics.reachable) counters.reachable += 1;
  else counters.unreachable += 1;

  if (!recorded) return;

  await judgeReachability(target);
  const verdict = await judgeAndAnnounce(target);
  counters.breached += verdict.breached;
  counters.cleared += verdict.cleared;
}

/** Exécute par paquets de `concurrency`, en respectant une échéance. */
async function pool<T>(
  items: readonly T[],
  concurrency: number,
  deadline: number,
  run: (item: T) => Promise<void>,
): Promise<{ exhausted: boolean }> {
  let cursor = 0;
  let exhausted = false;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      if (Date.now() >= deadline) {
        exhausted = true;
        return;
      }
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) return;
      await run(item);
    }
  });

  await Promise.all(workers);
  return { exhausted };
}

/**
 * Purge la rétention, au plus une fois par heure.
 *
 * Le marqueur est dans Redis et non en base : c'est un détail de cadence, pas
 * une donnée du domaine, et le perdre ne coûte qu'une purge de trop. Copié sur
 * la purge des sondes, jusqu'au rattrapage en dix lots — une instance laissée
 * un mois sans purge ne doit pas mettre un mois à se remettre à jour.
 */
async function pruneIfDue(): Promise<number> {
  const redis = getRedis();
  const claimed = await redis.set(
    PRUNE_MARK_KEY,
    String(Date.now()),
    'EX',
    PRUNE_EVERY_SECONDS,
    'NX',
  );
  if (claimed !== 'OK') return 0;

  let total = 0;
  for (let pass = 0; pass < 10; pass += 1) {
    const removed = await pruneTargetSamples(HOST_SAMPLE_RETENTION_DAYS, HOST_SAMPLE_PRUNE_BATCH);
    total += removed;
    if (removed < HOST_SAMPLE_PRUNE_BATCH) break;
  }
  if (total > 0) {
    logger.info(
      { removed: total, retentionDays: HOST_SAMPLE_RETENTION_DAYS },
      "relevés d'hôte purgés",
    );
  }
  return total;
}

export type HostSweepOptions = {
  targetId?: string | null;
  force?: boolean;
};

export async function sweepHosts(options: HostSweepOptions = {}): Promise<HostSweepJobResult> {
  const single = options.targetId ?? null;
  const redis = getRedis();

  // Le verrou ne couvre que le balayage général : une demande ciblée doit
  // aboutir tout de suite, même pendant un balayage. Elle ne touche qu'une
  // machine, et l'index unique partiel protège de toute façon les épisodes.
  if (single === null) {
    const lock = await redis.set(
      SWEEP_LOCK_KEY,
      String(process.pid),
      'PX',
      HOST_SWEEP_BUDGET_MS + 15_000,
      'NX',
    );
    if (lock !== 'OK') {
      logger.debug('un balayage de serveurs est déjà en cours — occurrence ignorée');
      return { ...EMPTY, skipped: true };
    }
  }

  const counters: Counters = {
    sampled: 0,
    reachable: 0,
    unreachable: 0,
    breached: 0,
    cleared: 0,
  };

  try {
    // `force` ramène la cadence à zéro seconde : tout est dû. C'est le seul
    // usage, et il sert aux vérifications — jamais au fonctionnement normal.
    const interval = options.force === true ? 0 : HOST_SAMPLE_INTERVAL_SECONDS;
    const due = await listDueTargets({
      intervalSeconds: interval,
      limit: HOST_SWEEP_BATCH,
      targetId: single,
    });

    const deadline = Date.now() + HOST_SWEEP_BUDGET_MS;
    const { exhausted } = await pool(due, HOST_SWEEP_CONCURRENCY, deadline, async (target) => {
      try {
        await sampleOne(target, counters);
      } catch (error) {
        // Une machine en erreur ne fait pas tomber le balayage des autres.
        logger.error({ err: error, targetId: target.id }, "relevé d'hôte en erreur");
      }
    });

    const pruned = single === null ? await pruneIfDue() : 0;

    return { due: due.length, ...counters, pruned, budgetExhausted: exhausted, skipped: false };
  } finally {
    if (single === null) await redis.del(SWEEP_LOCK_KEY).catch(() => {});
  }
}

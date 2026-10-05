import {
  MONITOR_CAPTURE_JOB,
  MONITOR_CAPTURE_REFERENCE_SWEEP_EVERY_SECONDS,
  MONITOR_CAPTURE_RETENTION_DAYS,
  MONITOR_CHECK_RETENTION_DAYS,
  MONITOR_PRUNE_BATCH,
  MONITOR_SWEEP_BATCH,
  MONITOR_SWEEP_BUDGET_MS,
  MONITOR_SWEEP_CONCURRENCY,
  isMonitorType,
  monitorCaptureJobDataSchema,
  monitorPauseUnknownType,
  type MonitorSweepJobResult,
} from '@pupitre/core';
import { getMonitorProbe } from '@pupitre/core/probe';
import {
  applyCheck,
  claimDueMonitors,
  getMonitor,
  pruneCaptureImages,
  pruneMonitorChecks,
  suspendMonitor,
  suspendOrphanedMonitors,
  type Monitor,
  type MonitorIncident,
} from '@pupitre/db';
import { instanceLanguage } from '../language.js';
import { logger } from '../logger.js';
import { getSupervisionQueue } from '../queue.js';
import { getRedis } from '../redis.js';
import { captureEnabled } from './capture.js';
import { notifyMonitorTransition } from './notify.js';
import { allowedCidrs } from './policy.js';

/**
 * Le balayage des sondes.
 *
 * ── Ce qu'il fait, et ce qu'il ne fait pas ──────────────────────────────────
 * Il constate et alerte. Il ne redéploie rien, ne redémarre rien, ne rollback
 * rien — même règle que les tâches planifiées.
 *
 * ── Le problème de temps, qui est le vrai sujet ─────────────────────────────
 * Cinquante sondes à trente secondes de délai, c'est vingt-cinq minutes si on
 * les enchaîne — soit cinquante balayages qui se marchent dessus. Trois gardes,
 * chacune nécessaire :
 *
 *   1. **Un verrou Redis.** Un seul balayage à la fois, tous workers confondus.
 *      Une occurrence qui arrive alors qu'une autre travaille rend la main
 *      immédiatement plutôt que de doubler la charge.
 *   2. **La réclamation avance l'échéance avant de sonder** (`claimDueMonitors`).
 *      Une sonde lente n'est donc pas reprise par le balayage suivant : il n'y a
 *      jamais deux requêtes en vol vers le même site.
 *   3. **Un budget de temps et un parallélisme bornés.** Dix sondes de front,
 *      vingt-deux secondes de travail. Ce qui n'a pas été fait reste dû et part
 *      au balayage suivant — une sonde en retard est un moindre mal devant un
 *      worker saturé.
 */

const SWEEP_LOCK_KEY = 'monitor:sweep:lock';
const PRUNE_MARK_KEY = 'monitor:prune:last';
const CAPTURE_REFERENCE_MARK_KEY = 'monitor:capture:references:last';

/** La purge ne tourne qu'une fois par heure : elle balaie toutes sondes confondues. */
const PRUNE_EVERY_SECONDS = 3600;

type SweepCounters = {
  probed: number;
  healthy: number;
  unhealthy: number;
  unreachable: number;
  opened: number;
  resolved: number;
  alerts: number;
};

/**
 * Sonde une sonde, enregistre, et alerte si — et seulement si — l'état bascule.
 *
 * Aucun `if (type === 'http')` ici : le balayage demande sa sonde à la fabrique
 * et lui parle par l'interface, exactement comme les tâches planifiées parlent
 * aux drivers. C'est ce qui fait qu'ajouter un type de surveillance ne touche
 * pas ce fichier.
 */
async function runOne(monitor: Monitor, counters: SweepCounters): Promise<void> {
  const before = monitor.status;

  if (!isMonitorType(monitor.type)) {
    // Retour arrière du code, ou ligne écrite à la main : on suspend avec le
    // motif plutôt que de faire tomber le balayage des quarante-neuf autres.
    // Le motif est une clé — la colonne survit à la suspension, une phrase y
    // aurait figé la langue du jour du balayage.
    await suspendMonitor(monitor.id, monitorPauseUnknownType(monitor.type));
    logger.warn({ monitorId: monitor.id, type: monitor.type }, 'type de sonde inconnu — suspendue');
    return;
  }

  const result = await getMonitorProbe(monitor.type).run(monitor.config, {
    allowlist: allowedCidrs(),
    language: await instanceLanguage(),
  });

  const applied = await applyCheck(monitor, result);

  counters.probed += 1;
  counters[result.outcome] += 1;

  if (applied.transition === null) return;
  if (applied.transition === 'down') counters.opened += 1;
  if (applied.transition === 'up') counters.resolved += 1;

  if (!applied.incident) {
    // L'index unique partiel a refusé un second incident ouvert, ou il n'y en
    // avait aucun à refermer. Dans les deux cas il n'y a rien à annoncer.
    logger.warn(
      { monitorId: monitor.id, transition: applied.transition },
      'transition sans incident : rien à alerter',
    );
    return;
  }

  const sent = await notifyMonitorTransition(
    applied.monitor,
    before,
    applied.monitor.status,
    applied.incident,
  );
  if (sent) counters.alerts += 1;

  // **Après** l'alerte, jamais avant : la capture est un supplément, l'alerte
  // est l'essentiel. Et enfilée, pas exécutée — voir `requestIncidentCapture()`.
  requestIncidentCapture(applied.monitor.id, applied.incident, applied.transition);
}

/**
 * Demande la capture de la page pour un incident qui vient de basculer.
 *
 * `void` et non `await` : le balayage a fini son travail, l'incident est écrit,
 * l'alerte est partie. Attendre l'accusé de réception de Redis pour une image
 * reviendrait à faire dépendre le chemin critique du confort. Un échec d'enfilage
 * est journalisé et rien de plus — une capture manquante n'est pas un incident.
 */
function requestIncidentCapture(
  monitorId: string,
  incident: MonitorIncident,
  transition: 'down' | 'up',
): void {
  if (!captureEnabled()) return;
  const data = monitorCaptureJobDataSchema.parse({
    scope: 'incident',
    monitorId,
    incidentId: incident.id,
    kind: transition === 'down' ? 'incident_open' : 'incident_resolved',
  });
  void getSupervisionQueue()
    .add(MONITOR_CAPTURE_JOB, data, { attempts: 1 })
    .catch((error: unknown) => {
      logger.warn({ err: error, monitorId, incidentId: incident.id }, 'capture non enfilée');
    });
}

/**
 * Enfile le rafraîchissement des références, au plus une fois toutes les cinq
 * minutes.
 *
 * Le marqueur est dans Redis, comme celui de la purge : c'est une cadence, pas
 * une donnée du domaine, et le perdre ne coûte qu'un passage de trop. La tâche
 * elle-même choisit *quelles* sondes en ont besoin — cinq au plus — parce que
 * cette question est une requête SQL, pas une décision du balayage.
 */
async function requestReferenceRefresh(): Promise<void> {
  if (!captureEnabled()) return;
  const redis = getRedis();
  const claimed = await redis.set(
    CAPTURE_REFERENCE_MARK_KEY,
    String(Date.now()),
    'EX',
    MONITOR_CAPTURE_REFERENCE_SWEEP_EVERY_SECONDS,
    'NX',
  );
  if (claimed !== 'OK') return;
  await getSupervisionQueue().add(
    MONITOR_CAPTURE_JOB,
    monitorCaptureJobDataSchema.parse({ scope: 'references' }),
    { attempts: 1 },
  );
}

/** Exécute `tasks` par paquets de `concurrency`, en respectant une échéance. */
async function pool<T>(
  items: readonly T[],
  concurrency: number,
  deadline: number,
  run: (item: T) => Promise<void>,
): Promise<{ done: number; exhausted: boolean }> {
  let cursor = 0;
  let done = 0;
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
      done += 1;
    }
  });

  await Promise.all(workers);
  return { done, exhausted };
}

/**
 * Purge la rétention, au plus une fois par heure.
 *
 * Le marqueur est dans Redis et non en base : c'est un détail de cadence, pas
 * une donnée du domaine, et le perdre ne coûte qu'une purge de trop.
 */
async function pruneIfDue(): Promise<number> {
  const redis = getRedis();
  const claimed = await redis.set(PRUNE_MARK_KEY, String(Date.now()), 'EX', PRUNE_EVERY_SECONDS, 'NX');
  if (claimed !== 'OK') return 0;

  let total = 0;
  // Plusieurs lots d'affilée au premier passage : une instance laissée sans
  // purge pendant un mois ne doit pas mettre un mois à se rattraper.
  for (let pass = 0; pass < 10; pass += 1) {
    const removed = await pruneMonitorChecks(MONITOR_CHECK_RETENTION_DAYS, MONITOR_PRUNE_BATCH);
    total += removed;
    if (removed < MONITOR_PRUNE_BATCH) break;
  }
  if (total > 0) {
    logger.info(
      { removed: total, retentionDays: MONITOR_CHECK_RETENTION_DAYS },
      'mesures de supervision purgées',
    );
  }

  /**
   * Même créneau horaire pour les octets des captures — mais on **reprend les
   * octets sans supprimer la ligne** : les incidents ne sont jamais purgés, et
   * une chronologie qui dit « image purgée le … » vaut mieux qu'une chronologie
   * amputée en silence. Compté à part de `pruned`, qui compte des mesures.
   */
  let images = 0;
  for (let pass = 0; pass < 10; pass += 1) {
    const purged = await pruneCaptureImages(MONITOR_CAPTURE_RETENTION_DAYS);
    images += purged;
    if (purged === 0) break;
  }
  if (images > 0) {
    logger.info(
      { purged: images, retentionDays: MONITOR_CAPTURE_RETENTION_DAYS },
      'octets de captures repris par la rétention',
    );
  }

  return total;
}

export type SweepOptions = {
  /** Restreint le balayage à une sonde. */
  monitorId?: string | null;
  /** Passe outre l'échéance : « sonder maintenant ». */
  force?: boolean;
};

const EMPTY: MonitorSweepJobResult = {
  claimed: 0,
  probed: 0,
  healthy: 0,
  unhealthy: 0,
  unreachable: 0,
  opened: 0,
  resolved: 0,
  alerts: 0,
  suspended: 0,
  pruned: 0,
  budgetExhausted: false,
};

export async function sweepMonitors(options: SweepOptions = {}): Promise<MonitorSweepJobResult> {
  const single = options.monitorId ?? null;
  const redis = getRedis();

  // Le verrou ne couvre que le balayage général. Une demande « sonder
  // maintenant » sur une sonde précise doit aboutir tout de suite, même si un
  // balayage tourne : elle ne touche qu'une ligne, déjà réclamée.
  if (single === null) {
    const lock = await redis.set(
      SWEEP_LOCK_KEY,
      String(process.pid),
      'PX',
      MONITOR_SWEEP_BUDGET_MS + 10_000,
      'NX',
    );
    if (lock !== 'OK') {
      logger.debug('un balayage de supervision est déjà en cours — occurrence ignorée');
      return EMPTY;
    }
  }

  const counters: SweepCounters = {
    probed: 0,
    healthy: 0,
    unhealthy: 0,
    unreachable: 0,
    opened: 0,
    resolved: 0,
    alerts: 0,
  };

  try {
    // Une application détruite ne doit pas déclencher une alerte de panne : le
    // pire faux positif, celui qui apprend à ignorer les alertes.
    const suspended = single === null ? await suspendOrphanedMonitors() : 0;

    let due: Monitor[];
    if (single !== null) {
      const row = await getMonitor(single);
      due = row && (options.force === true || row.enabled) ? [row] : [];
    } else {
      due = await claimDueMonitors(MONITOR_SWEEP_BATCH);
    }

    const deadline = Date.now() + MONITOR_SWEEP_BUDGET_MS;
    const { exhausted } = await pool(due, MONITOR_SWEEP_CONCURRENCY, deadline, async (monitor) => {
      try {
        await runOne(monitor, counters);
      } catch (error) {
        // Une sonde en erreur ne fait pas tomber le balayage : les quarante-neuf
        // autres doivent passer.
        logger.error({ err: error, monitorId: monitor.id }, 'sonde de supervision en erreur');
      }
    });

    const pruned = single === null ? await pruneIfDue() : 0;

    if (single === null) {
      // Les références « avant » : enfilées, jamais prises ici. Un échec
      // d'enfilage ne doit pas faire échouer un balayage qui a fait son travail.
      await requestReferenceRefresh().catch((error: unknown) => {
        logger.warn({ err: error }, 'rafraîchissement des références non enfilé');
      });
    }

    return { claimed: due.length, ...counters, suspended, pruned, budgetExhausted: exhausted };
  } finally {
    if (single === null) await redis.del(SWEEP_LOCK_KEY).catch(() => {});
  }
}

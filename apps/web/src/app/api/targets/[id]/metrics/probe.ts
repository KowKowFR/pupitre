import 'server-only';
import {
  SUPERVISION_QUEUE,
  TARGET_METRICS_JOB,
  hostMetricsSchema,
  targetMetricsJobDataSchema,
  type HostMetrics,
} from '@tp/core';
import { QueueEvents } from 'bullmq';
import { HttpError } from '@/lib/errors';
import { getRedis } from '@/lib/redis';
import { getSupervisionQueue } from '@/lib/supervision-queue';

/**
 * Relevé des métriques d'une cible, vu depuis le panel.
 *
 * **Pourquoi une lecture passe par la file.** Même raison que l'inventaire des
 * charges, et le motif est repris tel quel : le panel Next n'ouvre aucune
 * session SSH et n'en ouvrira jamais — `ssh2` est délibérément tenu hors de son
 * graphe de dépendances (voir `packages/core/src/index.ts`). « Combien de cœurs
 * a cette machine ? » n'a donc pas de réponse locale : la question se pose au
 * worker.
 *
 * **Pourquoi la route attend.** La règle est que le *travail* long n'a pas sa
 * place dans une route HTTP — pas que la route doive rendre la main avant de
 * savoir. Elle n'exécute rien : elle enfile, puis attend, comme elle attend une
 * requête SQL.
 *
 * **Pourquoi 20 secondes.** Le relevé, c'est une ouverture de session SSH
 * (garde de 8 s, une seule tentative — voir `collectHostMetrics`) puis six
 * lectures de `/proc` plafonnées à 5 s chacune et lancées ensemble : le pire
 * cas d'une machine qui répond mal tient sous 15 s. La marge restante couvre
 * l'attente en file. Au-delà, ce n'est plus la cible qui est lente, c'est le
 * worker qui ne consomme pas — et l'appelant mérite un 504 franc plutôt qu'une
 * connexion tenue ouverte. Une cible simplement éteinte, elle, ne consomme
 * jamais cette borne : elle rend en ~8 s un rapport `reachable:false`.
 */
const METRICS_TIMEOUT_MS = 20_000;

declare global {
  var __tpMetricsQueueEvents: QueueEvents | undefined;
}

/** Écoute des fins de tâches de la file de supervision. Partagée, comme la queue. */
function queueEvents(): QueueEvents {
  globalThis.__tpMetricsQueueEvents ??= new QueueEvents(SUPERVISION_QUEUE, {
    connection: getRedis(),
  });
  return globalThis.__tpMetricsQueueEvents;
}

export async function fetchHostMetrics(
  targetId: string,
  actorId: string,
  ip: string | null,
): Promise<HostMetrics> {
  const data = targetMetricsJobDataSchema.parse({ targetId, actorId, ip });

  // Aucun identifiant de tâche personnalisé : BullMQ refuse un « Custom Id »
  // contenant un `:`, et le nom de cette tâche en contient un.
  const job = await getSupervisionQueue().add(TARGET_METRICS_JOB, data, { attempts: 1 });

  let raw: unknown;
  try {
    raw = await job.waitUntilFinished(queueEvents(), METRICS_TIMEOUT_MS);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // `waitUntilFinished` ne distingue le dépassement du délai de l'échec de la
    // tâche que par son message — deux situations, deux codes.
    if (/timed out/i.test(message)) {
      throw new HttpError(
        504,
        'host_metrics_timeout',
        "Le relevé n'a pas abouti dans le délai imparti. Le worker est peut-être saturé.",
      );
    }
    throw new HttpError(502, 'host_metrics_failed', `Relevé impossible : ${message}`);
  }

  const parsed = hostMetricsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(502, 'host_metrics_failed', 'Le worker a renvoyé un relevé illisible');
  }

  return parsed.data;
}

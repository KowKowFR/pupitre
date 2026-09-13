import 'server-only';
import {
  SUPERVISION_QUEUE,
  WORKLOAD_LIST_JOB,
  encodeWorkloadRef,
  workloadListJobDataSchema,
  workloadListSchema,
  type Workload,
  type WorkloadList,
} from '@pupitre/core';
import { QueueEvents } from 'bullmq';
import { targets as messages } from '@/i18n/messages/targets';
import { HttpError, msg } from '@/lib/errors';
import { getRedis } from '@/lib/redis';
import { getSupervisionQueue } from '@/lib/supervision-queue';

/**
 * Inventaire des charges d'une cible, vu depuis le panel.
 *
 * **Pourquoi une lecture passe quand même par la file.** Le panel Next n'ouvre
 * aucune session SSH, et n'en ouvrira jamais : `ssh2` est délibérément tenu
 * hors de son graphe de dépendances (voir `packages/core/src/index.ts`), et les
 * drivers ne sont importables que sous `@pupitre/core/drivers`, côté worker. La
 * question « qu'est-ce qui tourne sur cette machine ? » n'a donc pas de réponse
 * locale : elle se pose au worker, comme `target:preflight`.
 *
 * **Pourquoi la route attend malgré tout.** La règle est que le *travail* long
 * n'a pas sa place dans une route HTTP — pas que la route doive rendre la main
 * avant de savoir. Ici la route n'exécute rien : elle enfile, puis attend une
 * réponse, exactement comme elle attend une requête SQL. `docker ps` est
 * l'affaire d'une seconde, et faire poster puis sonder un client pour afficher
 * une table serait payer en complexité un problème qu'on n'a pas. La garde de
 * 25 s est là pour le cas où la machine ne répond plus : au-delà, la route
 * rend un 504 plutôt que de tenir la connexion.
 *
 * Le résultat ne transite par aucune table : un inventaire est vrai à la
 * seconde où il est pris. Il voyage par la valeur de retour BullMQ.
 */

const INVENTORY_TIMEOUT_MS = 25_000;

declare global {
  var __tpWorkloadQueueEvents: QueueEvents | undefined;
}

/** Écoute des fins de tâches de la file de supervision. Partagée, comme la queue. */
function queueEvents(): QueueEvents {
  globalThis.__tpWorkloadQueueEvents ??= new QueueEvents(SUPERVISION_QUEUE, {
    connection: getRedis(),
  });
  return globalThis.__tpWorkloadQueueEvents;
}

export async function fetchWorkloads(
  targetId: string,
  actorId: string,
  ip: string | null,
): Promise<WorkloadList> {
  const data = workloadListJobDataSchema.parse({ targetId, actorId, ip });

  // Aucun identifiant de tâche personnalisé : BullMQ refuse un « Custom Id »
  // contenant un `:`, et nos références en contiennent toutes.
  const job = await getSupervisionQueue().add(WORKLOAD_LIST_JOB, data, { attempts: 1 });

  let raw: unknown;
  try {
    raw = await job.waitUntilFinished(queueEvents(), INVENTORY_TIMEOUT_MS);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // `waitUntilFinished` ne distingue pas l'échec de la tâche du dépassement
    // du délai autrement que par son message : les deux méritent pourtant deux
    // codes différents pour l'appelant.
    if (/timed out/i.test(message)) {
      throw new HttpError(504, 'workload_list_timeout', msg(messages, 'error.inventoryTimeout'));
    }
    throw new HttpError(
      502,
      'workload_list_failed',
      msg(messages, 'error.inventoryFailed', { message }),
    );
  }

  const parsed = workloadListSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(502, 'workload_list_failed', msg(messages, 'error.inventoryUnreadable'));
  }

  return parsed.data;
}

/** Retrouve une charge par sa référence transportable. */
export function findWorkload(list: WorkloadList, encodedRef: string): Workload | null {
  return list.items.find((item) => encodeWorkloadRef(item) === encodedRef) ?? null;
}

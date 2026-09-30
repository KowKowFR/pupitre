import 'server-only';
import { cache } from 'react';
import { getOpsQueue } from './queue';

/**
 * Le worker est-il là ? La réponse de la pastille « Worker actif » de la
 * barre haute.
 *
 * BullMQ nomme les connexions de ses workers ; `getWorkers()` les relit dans
 * la liste des clients Redis. C'est une lecture seule, sans rien demander au
 * worker : s'il consomme la file, sa connexion est là, et `idle` dit depuis
 * combien de secondes elle n'a rien envoyé à Redis — son dernier battement.
 *
 * La lecture est bornée à 800 ms : une pastille ne vaut pas qu'un Redis lent
 * retienne le rendu de chaque page. Sans réponse, l'état est « inconnu », et
 * la pastille le dit plutôt que d'affirmer quoi que ce soit.
 */

export type WorkerStatus =
  { state: 'active'; idleSeconds: number } | { state: 'idle' } | { state: 'unknown' };

const TIMEOUT_MS = 800;

export const workerStatus = cache(async (): Promise<WorkerStatus> => {
  try {
    const workers = await Promise.race([
      getOpsQueue().getWorkers(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), TIMEOUT_MS)),
    ]);
    if (workers === null) return { state: 'unknown' };
    if (workers.length === 0) return { state: 'idle' };
    const idle = Math.min(
      ...workers.map((worker) => {
        const value = Number((worker as Record<string, unknown>).idle);
        return Number.isFinite(value) ? value : 0;
      }),
    );
    return { state: 'active', idleSeconds: idle };
  } catch {
    return { state: 'unknown' };
  }
});

import 'server-only';
import { getRedis } from './redis';

/**
 * À qui appartient une exécution sur une charge — une lecture de journal, une
 * commande.
 *
 * Leurs lignes passent par le canal temps réel de la cible, que tout
 * abonné à `workload:read` écoute. Or la sortie d'une commande ou un journal
 * de conteneur peut porter des secrets : elle ne doit aller qu'à la personne
 * qui l'a demandée. L'identifiant d'exécution est tiré par le navigateur, qui
 * ouvre son flux **avant** de lancer la tâche (sinon les premières lignes se
 * perdraient) ; la première ouverture le réserve, pour un quart d'heure.
 */

const TTL_SECONDS = 15 * 60;

const keyOf = (run: string) => `workload-run:${run}`;

/** Réserve l'exécution pour cette personne, ou confirme qu'elle est déjà à elle. */
export async function claimWorkloadRun(run: string, userId: string): Promise<boolean> {
  const redis = getRedis();
  const claimed = await redis.set(keyOf(run), userId, 'EX', TTL_SECONDS, 'NX');
  if (claimed === 'OK') return true;
  return (await redis.get(keyOf(run))) === userId;
}

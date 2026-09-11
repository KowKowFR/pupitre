import { parseCidrList, type Cidr } from '@tp/core';
import { env } from '../env.js';
import { logger } from '../logger.js';

/**
 * La liste d'autorisation SSRF du worker, lue une fois.
 *
 * Elle vient de l'environnement, pas des paramètres d'instance ni d'une
 * permission — le raisonnement complet est dans `packages/core/src/monitoring.ts`.
 * En résumé : ouvrir une plage interne à la supervision est une décision de
 * déploiement, prise par qui tient le `.env`, pas par qui clique dans l'écran.
 */
let cached: Cidr[] | null = null;

export function allowedCidrs(): readonly Cidr[] {
  if (cached === null) {
    cached = parseCidrList(env.MONITOR_ALLOWED_CIDRS);
    if (cached.length > 0) {
      logger.info(
        { cidrs: cached.map((cidr) => cidr.text) },
        'plages internes autorisées à la supervision',
      );
    }
  }
  return cached;
}

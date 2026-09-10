import 'server-only';
import { HttpError } from './errors';
import { getRedis } from './redis';
import { logger } from './logger';

/**
 * Limitation de débit, en fenêtre fixe, dans Redis.
 *
 * Il n'existait rien de tel dans le panel : celle de Better Auth ne couvre que
 * l'authentification. Le jalon 8 en a besoin parce qu'une route de génération
 * appelle un fournisseur payant — sans garde-fou, un utilisateur légitime qui
 * clique douze fois brûle un quota, et un compte compromis brûle le reste.
 *
 * Fenêtre fixe plutôt que fenêtre glissante : `INCR` + `EXPIRE` sur une clé
 * horodatée tient en deux commandes atomiques, sans script Lua ni structure à
 * purger. Le défaut connu — deux rafales à cheval sur la frontière de fenêtre
 * peuvent passer — est sans conséquence ici : on protège un budget, pas une
 * primitive de sécurité.
 *
 * Le compteur est **par utilisateur**, pas par IP : derrière un NAT
 * d'entreprise, tout le monde partage une IP, et la session est de toute façon
 * obligatoire sur ces routes.
 */

export type RateLimitRule = {
  /** Préfixe de clé Redis, ex. `appspec:generate`. */
  name: string;
  /** Nombre d'autorisations par fenêtre. */
  limit: number;
  windowSec: number;
};

export type RateLimitVerdict = {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Secondes avant réouverture de la fenêtre. */
  resetSec: number;
};

export class RateLimitedError extends HttpError {
  constructor(readonly verdict: RateLimitVerdict) {
    super(
      429,
      'rate_limited',
      `Trop de requêtes : ${verdict.limit} par ${verdict.resetSec > 0 ? 'fenêtre' : 'période'}. ` +
        `Réessayez dans ${verdict.resetSec} s.`,
      { limit: verdict.limit, resetSec: verdict.resetSec },
    );
    this.name = 'RateLimitedError';
  }
}

/** Génération d'AppSpec : coûteuse, lente, et facturée par le fournisseur. */
export const APPSPEC_GENERATION_RULE: RateLimitRule = {
  name: 'appspec:generate',
  limit: 10,
  windowSec: 600,
};

export async function consume(rule: RateLimitRule, subject: string): Promise<RateLimitVerdict> {
  const window = Math.floor(Date.now() / 1000 / rule.windowSec);
  const key = `ratelimit:${rule.name}:${subject}:${window}`;

  try {
    const redis = getRedis();
    const count = await redis.incr(key);
    if (count === 1) {
      // Posé seulement à la création : un `EXPIRE` à chaque appel ferait
      // glisser la fenêtre et la rendrait infinie sous charge soutenue.
      await redis.expire(key, rule.windowSec);
    }

    const ttl = await redis.ttl(key);
    return {
      allowed: count <= rule.limit,
      limit: rule.limit,
      remaining: Math.max(0, rule.limit - count),
      resetSec: ttl > 0 ? ttl : rule.windowSec,
    };
  } catch (error) {
    // Redis indisponible : on laisse passer. Un compteur en panne ne doit pas
    // couper une fonctionnalité — mais il doit se voir dans les logs.
    logger.error({ err: error, rule: rule.name }, 'limitation de débit indisponible');
    return { allowed: true, limit: rule.limit, remaining: rule.limit, resetSec: 0 };
  }
}

/** Consomme une autorisation, ou lève un 429. */
export async function enforceRateLimit(
  rule: RateLimitRule,
  subject: string,
): Promise<RateLimitVerdict> {
  const verdict = await consume(rule, subject);
  if (!verdict.allowed) throw new RateLimitedError(verdict);
  return verdict;
}

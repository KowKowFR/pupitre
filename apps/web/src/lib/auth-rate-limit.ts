/**
 * La limitation de débit de Better Auth, comptée dans Redis.
 *
 * Better Auth la garde par défaut en mémoire du processus : juste pour un panel
 * seul, faux dès qu'on en met deux derrière un répartiteur — chaque réplique
 * comptait pour elle, et trois essais de mot de passe par dix secondes en
 * devenaient six. Le compteur vit maintenant là où vivent déjà les files et le
 * temps réel, sous `ratelimit:auth:<clé de Better Auth>` (l'IP et le chemin).
 *
 * Par `rateLimit.customStorage`, et non par un `secondaryStorage` : celui-ci
 * déplacerait aussi les sessions dans Redis. Elles restent en base.
 *
 * Fenêtre fixe, ouverte par la première requête : `INCR` et `PEXPIRE` dans un
 * seul script, donc atomiques — deux requêtes simultanées ne lisent jamais le
 * même compte. Le défaut connu de la fenêtre fixe (deux rafales à cheval sur
 * sa fin) reste borné à deux fois la limite.
 *
 * **Redis muet** : la connexion du panel attend Redis au lieu d'échouer
 * (`maxRetriesPerRequest: null`) — une connexion resterait pendue. L'appel est
 * donc borné à une seconde ; au-delà, ou sur erreur, le compte se fait en
 * mémoire, comme avant : chaque réplique pour elle, mais jamais sans limite, ni
 * sans connexion possible. Pendant dix secondes ensuite, on ne réessaie pas
 * Redis — chaque connexion paierait sinon la seconde d'attente. Le premier
 * repli et le retour se disent dans les logs.
 *
 * Sans `server-only` ni connexion importée : `auth.ts` fournit Redis, les
 * tests un faux.
 */

/** Ce que Better Auth attend de `rateLimit.customStorage`. */
export type AuthRateLimitStorage = {
  consume: (
    key: string,
    rule: { window: number; max: number },
  ) => Promise<{ allowed: boolean; retryAfter: number | null }>;
};

/** Le peu de Redis qu'il faut : un script. `ioredis` le fournit tel quel. */
export type RateLimitRedis = {
  eval: (script: string, numKeys: number, ...args: Array<string | number>) => Promise<unknown>;
};

type Log = {
  warn: (object: Record<string, unknown>, message: string) => void;
  info: (object: Record<string, unknown>, message: string) => void;
};

export const AUTH_RATE_LIMIT_PREFIX = 'ratelimit:auth:';

/** Au-delà, Redis est tenu pour muet : on compte en mémoire. */
export const AUTH_RATE_LIMIT_REDIS_TIMEOUT_MS = 1000;

/** Après un échec, le temps pendant lequel on compte en mémoire sans réessayer Redis. */
export const AUTH_RATE_LIMIT_RETRY_MS = 10_000;

/** Assez pour un flot d'IP, pas assez pour qu'un balayage remplisse la mémoire. */
const MEMORY_MAX_KEYS = 10_000;

/**
 * Compte une requête, ouvre la fenêtre à la première, et rend le compte avec ce
 * qu'il reste de la fenêtre. Une clé sans échéance — posée par autre chose —
 * en reçoit une : un compteur éternel bloquerait pour toujours.
 */
const CONSUME_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

function verdict(count: number, remainingMs: number, max: number) {
  return count <= max
    ? { allowed: true, retryAfter: null }
    : { allowed: false, retryAfter: Math.max(1, Math.ceil(remainingMs / 1000)) };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Redis muet depuis ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createAuthRateLimitStorage(
  redis: () => RateLimitRedis,
  logger: Log,
  options: { now?: () => number; timeoutMs?: number; retryMs?: number } = {},
): AuthRateLimitStorage {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? AUTH_RATE_LIMIT_REDIS_TIMEOUT_MS;
  const retryMs = options.retryMs ?? AUTH_RATE_LIMIT_RETRY_MS;
  const memory = new Map<string, { count: number; resetAt: number }>();
  let degraded = false;
  /** Avant cet instant, Redis n'est pas réessayé. */
  let retryAt = 0;

  function inMemory(key: string, rule: { window: number; max: number }) {
    const at = now();
    if (memory.size >= MEMORY_MAX_KEYS) {
      for (const [stale, entry] of memory) if (entry.resetAt <= at) memory.delete(stale);
      if (memory.size >= MEMORY_MAX_KEYS) memory.clear();
    }
    let entry = memory.get(key);
    if (!entry || entry.resetAt <= at) {
      entry = { count: 0, resetAt: at + rule.window * 1000 };
      memory.set(key, entry);
    }
    entry.count += 1;
    return verdict(entry.count, entry.resetAt - at, rule.max);
  }

  return {
    async consume(key, rule) {
      if (now() < retryAt) return inMemory(key, rule);
      const windowMs = Math.max(1, Math.round(rule.window * 1000));
      try {
        const answer = (await withTimeout(
          redis().eval(CONSUME_SCRIPT, 1, `${AUTH_RATE_LIMIT_PREFIX}${key}`, windowMs),
          timeoutMs,
        )) as [number | string, number | string];
        if (degraded) {
          degraded = false;
          logger.info({}, 'limitation de débit de la connexion : Redis répond de nouveau');
        }
        return verdict(Number(answer[0]), Number(answer[1]), rule.max);
      } catch (error) {
        retryAt = now() + retryMs;
        if (!degraded) {
          degraded = true;
          logger.warn(
            { err: error },
            'limitation de débit de la connexion : Redis indisponible, comptée en mémoire',
          );
        }
        return inMemory(key, rule);
      }
    },
  };
}

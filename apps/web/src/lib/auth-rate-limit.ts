/**
 * Better Auth's rate limiting, counted in Redis.
 *
 * Better Auth keeps it by default in the process's memory: right for a single
 * panel, wrong as soon as two are put behind a load balancer — each replica
 * counted for itself, and three password attempts per ten seconds became six.
 * The counter now lives where the queues and real time already live, under
 * `ratelimit:auth:<Better Auth's key>` (the IP and the path).
 *
 * Through `rateLimit.customStorage`, and not through a `secondaryStorage`: that
 * one would also move the sessions into Redis. They stay in the database.
 *
 * A fixed window, opened by the first request: `INCR` and `PEXPIRE` in a single
 * script, hence atomic — two simultaneous requests never read the same count.
 * The fixed window's known flaw (two bursts straddling its end) stays bounded to
 * twice the limit.
 *
 * **Silent Redis**: the panel's connection waits for Redis instead of failing
 * (`maxRetriesPerRequest: null`) — a sign-in would hang. The call is therefore
 * bounded to one second; beyond that, or on error, the count is done in memory,
 * as before: each replica for itself, but never without a limit, nor without a
 * possible sign-in. For ten seconds afterwards, Redis is not retried — each
 * sign-in would otherwise pay the second of waiting. The first fallback and the
 * return are said in the logs.
 *
 * Without `server-only` nor an imported connection: `auth.ts` provides Redis, the
 * tests a fake one.
 */

/** What Better Auth expects from `rateLimit.customStorage`. */
export type AuthRateLimitStorage = {
  consume: (
    key: string,
    rule: { window: number; max: number },
  ) => Promise<{ allowed: boolean; retryAfter: number | null }>;
};

/** The little of Redis that is needed: a script. `ioredis` provides it as is. */
export type RateLimitRedis = {
  eval: (script: string, numKeys: number, ...args: Array<string | number>) => Promise<unknown>;
};

type Log = {
  warn: (object: Record<string, unknown>, message: string) => void;
  info: (object: Record<string, unknown>, message: string) => void;
};

export const AUTH_RATE_LIMIT_PREFIX = 'ratelimit:auth:';

/** Beyond this, Redis is held silent: we count in memory. */
export const AUTH_RATE_LIMIT_REDIS_TIMEOUT_MS = 1000;

/** After a failure, the time during which we count in memory without retrying Redis. */
export const AUTH_RATE_LIMIT_RETRY_MS = 10_000;

/** Enough for a stream of IPs, not enough for a scan to fill the memory. */
const MEMORY_MAX_KEYS = 10_000;

/**
 * Counts a request, opens the window at the first one, and returns the count with
 * what is left of the window. A key without expiry — set by something else —
 * receives one: an eternal counter would block forever.
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
    timer = setTimeout(() => reject(new Error(`Redis silent for ${ms} ms`)), ms);
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
  /** Before this instant, Redis is not retried. */
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
          logger.info({}, 'sign-in rate limiting: Redis answers again');
        }
        return verdict(Number(answer[0]), Number(answer[1]), rule.max);
      } catch (error) {
        retryAt = now() + retryMs;
        if (!degraded) {
          degraded = true;
          logger.warn(
            { err: error },
            'sign-in rate limiting: Redis unavailable, counted in memory',
          );
        }
        return inMemory(key, rule);
      }
    },
  };
}

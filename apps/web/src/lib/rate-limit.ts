import 'server-only';
import { errors } from '@/i18n/messages/errors';
import { HttpError, msg } from './errors';
import { getRedis } from './redis';
import { logger } from './logger';

/**
 * Rate limiting, as a fixed window, in Redis.
 *
 * Nothing of the kind existed in the panel: Better Auth's only covers
 * authentication. AI generation needs it because a generation route calls a paid
 * provider — without a guardrail, a legitimate user who clicks twelve times burns
 * a quota, and a compromised account burns the rest.
 *
 * A fixed window rather than a sliding window: `INCR` + `EXPIRE` on a timestamped
 * key fits in two atomic commands, without a Lua script or a structure to purge.
 * The known flaw — two bursts straddling the window boundary can get through — is
 * without consequence here: we protect a budget, not a security primitive.
 *
 * The counter is **per user**, not per IP: behind a corporate NAT, everyone shares
 * an IP, and the session is required on these routes anyway.
 */

export type RateLimitRule = {
  /** The Redis key prefix, e.g. `appspec:generate`. */
  name: string;
  /** The number of authorizations per window. */
  limit: number;
  windowSec: number;
};

export type RateLimitVerdict = {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds before the window reopens. */
  resetSec: number;
};

class RateLimitedError extends HttpError {
  constructor(readonly verdict: RateLimitVerdict) {
    super(
      429,
      'rate_limited',
      msg(errors, verdict.resetSec > 0 ? 'rate_limited.window' : 'rate_limited.period', {
        limit: verdict.limit,
        seconds: verdict.resetSec,
      }),
      { limit: verdict.limit, resetSec: verdict.resetSec },
    );
    this.name = 'RateLimitedError';
  }
}

/** AppSpec generation: costly, slow, and billed by the provider. */
export const APPSPEC_GENERATION_RULE: RateLimitRule = {
  name: 'appspec:generate',
  limit: 10,
  windowSec: 600,
};

async function consume(rule: RateLimitRule, subject: string): Promise<RateLimitVerdict> {
  const window = Math.floor(Date.now() / 1000 / rule.windowSec);
  const key = `ratelimit:${rule.name}:${subject}:${window}`;

  try {
    const redis = getRedis();
    const count = await redis.incr(key);
    if (count === 1) {
      // Only set at creation: an `EXPIRE` at each call would slide the window and make
      // it infinite under sustained load.
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
    // Redis unavailable: we let it through. A broken counter must not cut a feature —
    // but it must show in the logs.
    logger.error({ err: error, rule: rule.name }, 'rate limiting unavailable');
    return { allowed: true, limit: rule.limit, remaining: rule.limit, resetSec: 0 };
  }
}

/** Consumes an authorization, or throws a 429. */
export async function enforceRateLimit(
  rule: RateLimitRule,
  subject: string,
): Promise<RateLimitVerdict> {
  const verdict = await consume(rule, subject);
  if (!verdict.allowed) throw new RateLimitedError(verdict);
  return verdict;
}

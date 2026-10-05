import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AUTH_RATE_LIMIT_PREFIX, createAuthRateLimitStorage } from '../src/lib/auth-rate-limit.ts';

/**
 * The sign-in rate limiting, counted in Redis: two panels count together, the
 * window reopens, and a broken Redis — whether it answers with an error or no
 * longer answers — lets neither everyone through, nor nobody.
 */

/** A Redis reduced to the counter's script, on a clock moved forward by hand. */
function fakeRedis(clock) {
  const keys = new Map();
  const calls = [];
  return {
    keys,
    calls,
    async eval(_script, numKeys, key, windowMs) {
      calls.push({ numKeys, key, windowMs });
      const at = clock.now;
      let entry = keys.get(key);
      if (!entry || entry.expiresAt <= at) entry = { count: 0, expiresAt: at + Number(windowMs) };
      entry.count += 1;
      keys.set(key, entry);
      return [entry.count, entry.expiresAt - at];
    },
  };
}

function silentLog() {
  const lines = [];
  return {
    lines,
    warn: (_object, message) => lines.push(`warn ${message}`),
    info: (_object, message) => lines.push(`info ${message}`),
  };
}

const SIGN_IN = { window: 10, max: 3 };
const KEY = '203.0.113.7|/sign-in/email';

describe('sign-in rate limiting — in Redis', () => {
  it('three attempts go through, the fourth waits for the end of the window', async () => {
    const clock = { now: 1_000_000 };
    const redis = fakeRedis(clock);
    const storage = createAuthRateLimitStorage(() => redis, silentLog(), { now: () => clock.now });
    for (let i = 0; i < 3; i += 1) {
      assert.deepEqual(await storage.consume(KEY, SIGN_IN), { allowed: true, retryAfter: null });
    }
    clock.now += 4_000;
    assert.deepEqual(await storage.consume(KEY, SIGN_IN), { allowed: false, retryAfter: 6 });
    assert.deepEqual(redis.calls[0], {
      numKeys: 1,
      key: `${AUTH_RATE_LIMIT_PREFIX}${KEY}`,
      windowMs: 10_000,
    });
  });

  it('two panels behind a load balancer count together', async () => {
    const clock = { now: 0 };
    const redis = fakeRedis(clock);
    const first = createAuthRateLimitStorage(() => redis, silentLog(), { now: () => clock.now });
    const second = createAuthRateLimitStorage(() => redis, silentLog(), { now: () => clock.now });
    assert.equal((await first.consume(KEY, SIGN_IN)).allowed, true);
    assert.equal((await second.consume(KEY, SIGN_IN)).allowed, true);
    assert.equal((await first.consume(KEY, SIGN_IN)).allowed, true);
    assert.equal((await second.consume(KEY, SIGN_IN)).allowed, false);
  });

  it('once the window is past, one can try again; another IP has its own count', async () => {
    const clock = { now: 0 };
    const redis = fakeRedis(clock);
    const storage = createAuthRateLimitStorage(() => redis, silentLog(), { now: () => clock.now });
    for (let i = 0; i < 4; i += 1) await storage.consume(KEY, SIGN_IN);
    assert.equal((await storage.consume('198.51.100.2|/sign-in/email', SIGN_IN)).allowed, true);
    clock.now += 10_000;
    assert.equal((await storage.consume(KEY, SIGN_IN)).allowed, true);
  });
});

describe('sign-in rate limiting — Redis down', () => {
  it('an error: the count is done in memory, and the limit holds', async () => {
    const log = silentLog();
    let tries = 0;
    const storage = createAuthRateLimitStorage(
      () => ({
        eval: async () => {
          tries += 1;
          throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
        },
      }),
      log,
    );
    const answers = [];
    for (let i = 0; i < 4; i += 1) answers.push((await storage.consume(KEY, SIGN_IN)).allowed);
    assert.deepEqual(answers, [true, true, true, false]);
    assert.equal(tries, 1, 'Redis is not retried at each sign-in');
    assert.deepEqual(log.lines, [
      'warn sign-in rate limiting: Redis unavailable, counted in memory',
    ]);
  });

  it('a silent Redis: the sign-in waits no longer than the delay, then counts in memory', async () => {
    const storage = createAuthRateLimitStorage(
      () => ({ eval: () => new Promise(() => {}) }),
      silentLog(),
      { timeoutMs: 20 },
    );
    const started = Date.now();
    assert.deepEqual(await storage.consume(KEY, SIGN_IN), { allowed: true, retryAfter: null });
    assert.ok(Date.now() - started < 1000);
  });

  it('Redis back: retried once the delay is past, the count goes back to it, and the return is said', async () => {
    const clock = { now: 0 };
    const redis = fakeRedis(clock);
    let down = true;
    const log = silentLog();
    const storage = createAuthRateLimitStorage(
      () => ({
        eval: (...args) => (down ? Promise.reject(new Error('down')) : redis.eval(...args)),
      }),
      log,
      { now: () => clock.now },
    );
    await storage.consume(KEY, SIGN_IN);
    down = false;
    clock.now += 5_000;
    await storage.consume(KEY, SIGN_IN);
    assert.equal(redis.keys.size, 0, 'not before ten seconds');
    clock.now += 5_000;
    await storage.consume(KEY, SIGN_IN);
    assert.equal(redis.keys.get(`${AUTH_RATE_LIMIT_PREFIX}${KEY}`)?.count, 1);
    assert.equal(log.lines.at(-1), 'info sign-in rate limiting: Redis answers again');
  });
});

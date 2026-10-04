import 'server-only';
import {
  PRESENCE_STALE_MS,
  REALTIME_CHANNEL,
  effectivePresence,
  liveTopicOfResource,
  realtimeEventSchema,
  type PresenceChoice,
  type PresenceStatus,
  type RealtimeEvent,
} from '@pupitre/core';
import { setNamedAuditObserver } from '@pupitre/db';
import { Redis } from 'ioredis';
import { getEnv } from './env';
import { logger } from './logger';
import { getRedis } from './redis';

/**
 * Real time, panel side.
 *
 * ── One subscriber per process, not per tab ─────────────────────────────────
 * A deployment's logs stream opens its own Redis connection: it lives a few
 * minutes. The real-time stream, for its part, stays open as long as a tab is.
 * One connection per tab would make as many Redis connections as signed-in
 * people; here, a single connection subscribes to the channel and distributes in
 * memory to the process's SSE streams.
 *
 * ── Presence ────────────────────────────────────────────────────────────────
 * Stored in Redis, not in the database: it changes every minute and has no value
 * an hour later. Five keys, one per cause — the shown state is **deduced**
 * (`effectivePresence`) and only kept to know whether it changed since the last
 * announcement.
 */

type Listener = (event: RealtimeEvent) => void;

type Hub = { subscriber: Redis; listeners: Set<Listener>; sweeper: NodeJS.Timeout };

declare global {
  var __tpRealtimeHub: Hub | undefined;
}

const KEY = {
  connections: 'presence:connections',
  seen: 'presence:seen',
  input: 'presence:input',
  choice: 'presence:choice',
  shown: 'presence:shown',
  sweepLock: 'presence:sweep-lock',
} as const;

/** The presence sweep: away after inactivity, offline after an abrupt stop. */
const SWEEP_EVERY_MS = 20_000;

function hub(): Hub {
  if (globalThis.__tpRealtimeHub) return globalThis.__tpRealtimeHub;

  const subscriber = new Redis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
  const listeners = new Set<Listener>();
  subscriber.on('message', (_channel, raw: string) => {
    let event: RealtimeEvent;
    try {
      const parsed = realtimeEventSchema.safeParse(JSON.parse(raw) as unknown);
      if (!parsed.success) return;
      event = parsed.data;
    } catch {
      return;
    }
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        logger.warn({ err: error, type: event.type }, 'real-time listener failed');
      }
    }
  });
  subscriber.on('error', (error) => {
    logger.warn({ err: error }, 'real-time subscription failed');
  });
  subscriber.subscribe(REALTIME_CHANNEL).catch((error: unknown) => {
    logger.error({ err: error }, 'real-time channel subscription failed');
  });

  const sweeper = setInterval(() => {
    void sweepPresence().catch((error: unknown) => {
      logger.warn({ err: error }, 'presence sweep failed');
    });
  }, SWEEP_EVERY_MS);
  sweeper.unref();

  globalThis.__tpRealtimeHub = { subscriber, listeners, sweeper };
  return globalThis.__tpRealtimeHub;
}

/** Subscribes to the channel's events. Returns what it takes to unsubscribe. */
export function onRealtime(listener: Listener): () => void {
  const current = hub();
  current.listeners.add(listener);
  return () => {
    current.listeners.delete(listener);
  };
}

export async function publishRealtime(event: RealtimeEvent): Promise<void> {
  await getRedis().publish(REALTIME_CHANNEL, JSON.stringify(realtimeEventSchema.parse(event)));
}

/** Publishes without waiting or failing: a lost signal must never break an action. */
function signalRealtime(event: RealtimeEvent): void {
  publishRealtime(event).catch((error: unknown) => {
    logger.warn({ err: error, type: event.type }, 'real-time event not published');
  });
}

// ─── Presence ────────────────────────────────────────────────────────────────

function toNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toChoice(value: string | null | undefined): PresenceChoice | null {
  return value === 'away' || value === 'busy' ? value : null;
}

async function statusOf(userId: string, now: number): Promise<PresenceStatus> {
  const [[, connections], [, seen], [, input], [, choice]] = (await getRedis()
    .multi()
    .hget(KEY.connections, userId)
    .zscore(KEY.seen, userId)
    .zscore(KEY.input, userId)
    .hget(KEY.choice, userId)
    .exec()) as Array<[Error | null, string | null]>;
  return effectivePresence(
    {
      connections: toNumber(connections) ?? 0,
      lastSeen: toNumber(seen),
      lastInput: toNumber(input),
      choice: toChoice(choice),
    },
    now,
  );
}

/** Computes a person's state again; announces it if it changed. */
async function refreshPresence(userId: string): Promise<PresenceStatus> {
  const now = Date.now();
  const status = await statusOf(userId, now);
  const previous = await getRedis().hget(KEY.shown, userId);
  if (previous !== status) {
    await getRedis().hset(KEY.shown, userId, status);
    await publishRealtime({ type: 'presence', userId, status, at: now });
  }
  return status;
}

/** A tab just opened its stream. */
export async function presenceConnected(userId: string): Promise<void> {
  const now = Date.now();
  await getRedis()
    .multi()
    .hincrby(KEY.connections, userId, 1)
    .zadd(KEY.seen, now, userId)
    .zadd(KEY.input, now, userId)
    .exec();
  await refreshPresence(userId);
}

/** The stream is still there: a sign of life, without an announcement. */
export async function presenceTouched(userId: string): Promise<void> {
  await getRedis().zadd(KEY.seen, Date.now(), userId);
}

/** A tab closed. The last one closed switches to offline right away. */
export async function presenceDisconnected(userId: string): Promise<void> {
  const remaining = await getRedis().hincrby(KEY.connections, userId, -1);
  if (remaining <= 0) await getRedis().hdel(KEY.connections, userId);
  await refreshPresence(userId);
}

/** Keyboard, mouse, tab back in the foreground. */
export async function presenceInput(userId: string): Promise<PresenceStatus> {
  await getRedis().zadd(KEY.input, Date.now(), userId);
  return refreshPresence(userId);
}

export async function setPresenceChoice(
  userId: string,
  choice: PresenceChoice | null,
): Promise<PresenceStatus> {
  if (choice) await getRedis().hset(KEY.choice, userId, choice);
  else await getRedis().hdel(KEY.choice, userId);
  return refreshPresence(userId);
}

export async function getPresenceChoice(userId: string): Promise<PresenceChoice | null> {
  return toChoice(await getRedis().hget(KEY.choice, userId));
}

/** Who is there, right now: the state of each person known to Redis. */
export async function presenceSnapshot(): Promise<Record<string, PresenceStatus>> {
  const now = Date.now();
  const redis = getRedis();
  const [connections, seen, input, choice] = await Promise.all([
    redis.hgetall(KEY.connections),
    redis.zrange(KEY.seen, '0', '-1', 'WITHSCORES'),
    redis.zrange(KEY.input, '0', '-1', 'WITHSCORES'),
    redis.hgetall(KEY.choice),
  ]);
  const scores = (flat: string[]) => {
    const map = new Map<string, number>();
    for (let index = 0; index < flat.length; index += 2) {
      map.set(flat[index] ?? '', Number(flat[index + 1]));
    }
    return map;
  };
  const seenBy = scores(seen);
  const inputBy = scores(input);
  const snapshot: Record<string, PresenceStatus> = {};
  for (const userId of seenBy.keys()) {
    snapshot[userId] = effectivePresence(
      {
        connections: toNumber(connections[userId]) ?? 0,
        lastSeen: seenBy.get(userId) ?? null,
        lastInput: inputBy.get(userId) ?? null,
        choice: toChoice(choice[userId]),
      },
      now,
    );
  }
  return snapshot;
}

/**
 * The sweep: what time alone changes — inactivity that makes away, the silence of
 * a killed process that makes offline. Only one process sweeps at a time (a Redis
 * lock): without it, each panel instance would announce the same changes.
 */
async function sweepPresence(): Promise<void> {
  const redis = getRedis();
  const locked = await redis.set(KEY.sweepLock, '1', 'PX', SWEEP_EVERY_MS - 2_000, 'NX');
  if (locked !== 'OK') return;

  const shown = await redis.hgetall(KEY.shown);
  const staleBefore = Date.now() - PRESENCE_STALE_MS;
  for (const [userId, status] of Object.entries(shown)) {
    if (status === 'offline') continue;
    const seen = toNumber(await redis.zscore(KEY.seen, userId));
    // A killed process did not count down its tabs: the silence is authoritative.
    if (seen === null || seen < staleBefore) await redis.hdel(KEY.connections, userId);
    await refreshPresence(userId);
  }
}

// ─── Audit log ───────────────────────────────────────────────────────────────

/**
 * Each log line written by the panel becomes a signal. The same construction as
 * on the worker side (`apps/worker/src/realtime.ts`): both processes write to
 * `audit_logs`, both announce.
 */
export function installRealtimeAudit(): void {
  setNamedAuditObserver('realtime', (row) => {
    signalRealtime({
      type: 'activity',
      id: String(row.id),
      action: row.action,
      resourceType: row.resourceType,
      resourceId: row.resourceId ?? null,
      actorId: row.actorId ?? null,
      at: row.createdAt.toISOString(),
    });
    const topic = liveTopicOfResource(row.resourceType);
    if (topic) {
      signalRealtime({ type: 'live', topic, source: 'audit', detail: row.action.slice(0, 120) });
    }
  });
}

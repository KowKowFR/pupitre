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
 * Le temps réel, côté panel.
 *
 * ── Un abonné par processus, pas par onglet ─────────────────────────────────
 * Le flux des logs d'un déploiement ouvre sa propre connexion Redis : il vit
 * quelques minutes. Le flux temps réel, lui, reste ouvert tant qu'un onglet
 * l'est. Une connexion par onglet ferait autant de connexions Redis que de
 * personnes connectées ; ici, une seule connexion s'abonne au canal et
 * distribue en mémoire aux flux SSE du processus.
 *
 * ── La présence ─────────────────────────────────────────────────────────────
 * Rangée dans Redis, pas en base : elle change toutes les minutes et n'a
 * aucune valeur une heure plus tard. Cinq clés, une par cause — l'état affiché
 * se **déduit** (`effectivePresence`) et n'est gardé que pour savoir s'il a
 * changé depuis la dernière annonce.
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

/** Le balayage des présences : absent après inactivité, hors ligne après un arrêt brutal. */
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
        logger.warn({ err: error, type: event.type }, 'auditeur temps réel en erreur');
      }
    }
  });
  subscriber.on('error', (error) => {
    logger.warn({ err: error }, 'abonnement temps réel en erreur');
  });
  subscriber.subscribe(REALTIME_CHANNEL).catch((error: unknown) => {
    logger.error({ err: error }, 'abonnement au canal temps réel impossible');
  });

  const sweeper = setInterval(() => {
    void sweepPresence().catch((error: unknown) => {
      logger.warn({ err: error }, 'balayage des présences impossible');
    });
  }, SWEEP_EVERY_MS);
  sweeper.unref();

  globalThis.__tpRealtimeHub = { subscriber, listeners, sweeper };
  return globalThis.__tpRealtimeHub;
}

/** S'abonne aux événements du canal. Retourne de quoi se désabonner. */
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

/** Publie sans attendre ni échouer : un signal perdu ne doit jamais casser une action. */
function signalRealtime(event: RealtimeEvent): void {
  publishRealtime(event).catch((error: unknown) => {
    logger.warn({ err: error, type: event.type }, 'événement temps réel non publié');
  });
}

// ─── Présence ────────────────────────────────────────────────────────────────

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

/** Recalcule l'état d'une personne ; l'annonce s'il a changé. */
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

/** Un onglet vient d'ouvrir son flux. */
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

/** Le flux est toujours là : un signe de vie, sans annonce. */
export async function presenceTouched(userId: string): Promise<void> {
  await getRedis().zadd(KEY.seen, Date.now(), userId);
}

/** Un onglet s'est fermé. Le dernier fermé fait passer hors ligne tout de suite. */
export async function presenceDisconnected(userId: string): Promise<void> {
  const remaining = await getRedis().hincrby(KEY.connections, userId, -1);
  if (remaining <= 0) await getRedis().hdel(KEY.connections, userId);
  await refreshPresence(userId);
}

/** Clavier, souris, onglet revenu au premier plan. */
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

/** Qui est là, en ce moment : l'état de chaque personne connue de Redis. */
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
 * Le balayage : ce que le temps seul fait changer — l'inactivité qui rend
 * absent, le silence d'un processus tué qui rend hors ligne. Un seul processus
 * balaie à la fois (verrou Redis) : sans lui, chaque instance du panel
 * annoncerait les mêmes changements.
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
    // Un processus tué n'a pas décompté ses onglets : le silence fait foi.
    if (seen === null || seen < staleBefore) await redis.hdel(KEY.connections, userId);
    await refreshPresence(userId);
  }
}

// ─── Journal d'audit ─────────────────────────────────────────────────────────

/**
 * Chaque ligne du journal écrite par le panel devient un signal. Même
 * construction que côté worker (`apps/worker/src/realtime.ts`) : les deux
 * processus écrivent dans `audit_logs`, les deux annoncent.
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

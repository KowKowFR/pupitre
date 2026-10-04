import 'server-only';
import { Redis } from 'ioredis';
import { getEnv } from './env';

declare global {
  var __tpRedis: Redis | undefined;
}

/** A shared connection, survives `next dev`'s HMR. */
export function getRedis(): Redis {
  globalThis.__tpRedis ??= new Redis(getEnv().REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
  return globalThis.__tpRedis;
}

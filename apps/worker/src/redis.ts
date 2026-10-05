import { Redis } from 'ioredis';
import { env } from './env.js';

/**
 * BullMQ requires `maxRetriesPerRequest: null` on a Worker's connection,
 * otherwise blocking commands are interrupted.
 */
export function createRedisConnection(): Redis {
  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
}

let publisher: Redis | null = null;

/**
 * Connection dedicated to publishing logs. Separate from BullMQ's: a connection
 * busy with blocking commands cannot be used to publish.
 */
export function getPublisher(): Redis {
  publisher ??= new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  return publisher;
}

let reader: Redis | null = null;

/**
 * Read connection, for the keys the worker consults while it works — a viewer's
 * presence, for example. Distinct from the publishing one: a connection busy
 * publishing must not be blocked by a read, nor the reverse.
 */
export function getRedis(): Redis {
  reader ??= new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  return reader;
}

export async function closePublisher(): Promise<void> {
  if (reader) {
    await reader.quit();
    reader = null;
  }
  if (publisher) {
    await publisher.quit();
    publisher = null;
  }
}

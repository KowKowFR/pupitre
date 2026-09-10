import { Redis } from 'ioredis';
import { env } from './env.js';

/**
 * BullMQ exige `maxRetriesPerRequest: null` sur la connexion d'un Worker,
 * sinon les commandes bloquantes sont interrompues.
 */
export function createRedisConnection(): Redis {
  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
}

let publisher: Redis | null = null;

/**
 * Connexion dédiée à la publication des logs.
 * Séparée de celle de BullMQ : une connexion occupée par des commandes
 * bloquantes ne peut pas servir à publier.
 */
export function getPublisher(): Redis {
  publisher ??= new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  return publisher;
}

let reader: Redis | null = null;

/**
 * Connexion de lecture, pour les clés que le worker consulte pendant qu'il
 * travaille — la présence d'un spectateur, par exemple. Distincte de celle de
 * publication : une connexion occupée à publier ne doit pas être bloquée par
 * une lecture, ni l'inverse.
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

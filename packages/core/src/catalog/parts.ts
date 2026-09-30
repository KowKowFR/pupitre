import type { AppSpecInput } from '../spec/index.js';
import type { CatalogParams } from './types.js';

/**
 * Les pièces que les modèles partagent : les bases de données, l'ingress,
 * l'URL publique. Écrites une fois, pour que deux modèles qui embarquent
 * PostgreSQL l'embarquent de la même façon — même image, même sonde, même
 * volume.
 */

type ServiceInput = AppSpecInput['services'][number];

/** L'URL publique de l'application, quand elle a un domaine. */
export function publicUrl(params: CatalogParams): string | null {
  if (!params.host) return null;
  return `${params.tls ? 'https' : 'http'}://${params.host}`;
}

/** `env` qui ne pose une variable que si la valeur existe. */
export function envWhen(
  entries: Record<string, string | null | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(entries).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

/** L'AppSpec d'un modèle : le nom choisi, et l'ingress seulement s'il y a un domaine. */
export function appSpec(params: CatalogParams, services: ServiceInput[]): AppSpecInput {
  const exposed = services.find((service) => service.exposed);
  return {
    name: params.name,
    version: '1.0.0',
    services,
    ...(params.host && exposed
      ? { ingress: { host: params.host, tls: params.tls, targetService: exposed.name } }
      : {}),
  };
}

/**
 * PostgreSQL, service interne. Le mot de passe est `POSTGRES_PASSWORD` : le
 * service applicatif le lit sous son propre nom par un alias `{ name, from }`.
 */
export function postgres(database: string, size = '10Gi'): ServiceInput {
  return {
    name: 'postgres',
    source: { type: 'image', ref: 'postgres:17-alpine' },
    port: 5432,
    env: { POSTGRES_DB: database, POSTGRES_USER: database },
    secrets: ['POSTGRES_PASSWORD'],
    resources: { cpuMilli: 500, memoryMi: 512 },
    healthcheck: { intervalSec: 5, timeoutSec: 3, retries: 20 },
    volumes: [{ name: 'data', mountPath: '/var/lib/postgresql/data', size }],
  };
}

/** MariaDB, service interne. Même principe : `MARIADB_PASSWORD` porte la valeur. */
export function mariadb(database: string, size = '10Gi'): ServiceInput {
  return {
    name: 'mariadb',
    source: { type: 'image', ref: 'mariadb:11' },
    port: 3306,
    env: { MARIADB_DATABASE: database, MARIADB_USER: database },
    secrets: ['MARIADB_PASSWORD', 'MARIADB_ROOT_PASSWORD'],
    resources: { cpuMilli: 500, memoryMi: 512 },
    healthcheck: { intervalSec: 5, timeoutSec: 3, retries: 20 },
    volumes: [{ name: 'data', mountPath: '/var/lib/mysql', size }],
  };
}

/** Redis sans persistance : une file ou un cache, jamais une donnée à garder. */
export function redis(): ServiceInput {
  return {
    name: 'redis',
    source: { type: 'image', ref: 'redis:7-alpine' },
    port: 6379,
    resources: { cpuMilli: 250, memoryMi: 256 },
    healthcheck: { intervalSec: 5, timeoutSec: 3, retries: 10 },
  };
}

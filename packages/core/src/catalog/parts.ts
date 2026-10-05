import type { AppSpecInput } from '../spec/index.js';
import type { CatalogParams } from './types.js';

/**
 * The pieces the templates share: the databases, the ingress, the public URL.
 * Written once, so that two templates that ship PostgreSQL ship it the same way
 * — same image, same probe, same volume.
 */

type ServiceInput = AppSpecInput['services'][number];

/** The application's public URL, when it has a domain. */
export function publicUrl(params: CatalogParams): string | null {
  if (!params.host) return null;
  return `${params.tls ? 'https' : 'http'}://${params.host}`;
}

/** `env` that only sets a variable if the value exists. */
export function envWhen(
  entries: Record<string, string | null | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(entries).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

/** A template's AppSpec: the chosen name, and the ingress only if there is a domain. */
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
 * PostgreSQL, internal service. The password is `POSTGRES_PASSWORD`: the
 * application service reads it under its own name through a `{ name, from }`
 * alias.
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

/** MariaDB, internal service. Same principle: `MARIADB_PASSWORD` carries the value. */
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

/** Redis without persistence: a queue or a cache, never data to keep. */
export function redis(): ServiceInput {
  return {
    name: 'redis',
    source: { type: 'image', ref: 'redis:7-alpine' },
    port: 6379,
    resources: { cpuMilli: 250, memoryMi: 256 },
    healthcheck: { intervalSec: 5, timeoutSec: 3, retries: 10 },
  };
}

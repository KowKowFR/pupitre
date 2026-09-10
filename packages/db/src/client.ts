import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { z } from 'zod';
import * as schema from './schema/index.js';

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
});

export type Database = NodePgDatabase<typeof schema>;

let pool: Pool | null = null;
let database: Database | null = null;

function createPool(): Pool {
  const env = envSchema.parse({
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX,
  });
  return new Pool({ connectionString: env.DATABASE_URL, max: env.DATABASE_POOL_MAX });
}

/** Pool partagé. Créé à la première utilisation, jamais à l'import. */
export function getPool(): Pool {
  pool ??= createPool();
  return pool;
}

/** Client Drizzle partagé par `apps/web` et `apps/worker`. */
export function getDb(): Database {
  database ??= drizzle(getPool(), { schema });
  return database;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    database = null;
  }
}

/** Sonde de vivacité utilisée par `/api/health`. */
export async function pingDb(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('select 1');
  } finally {
    client.release();
  }
}

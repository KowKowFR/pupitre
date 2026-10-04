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

/** Shared pool. Created at first use, never at import. */
export function getPool(): Pool {
  pool ??= createPool();
  return pool;
}

/** Drizzle client shared by `apps/web` and `apps/worker`. */
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

/** Liveness probe used by `/api/health`. */
export async function pingDb(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('select 1');
  } finally {
    client.release();
  }
}

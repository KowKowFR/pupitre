import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { closeDb, getDb } from './client.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** `dist/migrate.js` → `packages/db/migrations` ; en dev `src/` → idem. */
export const migrationsFolder = path.resolve(here, '..', 'migrations');

export async function runMigrations(): Promise<void> {
  await migrate(getDb(), { migrationsFolder });
}

const isDirectRun =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  runMigrations()
    .then(async () => {
      // eslint-disable-next-line no-console
      console.log(`[db] migrations applied from ${migrationsFolder}`);
      await closeDb();
    })
    .catch(async (error: unknown) => {
      // eslint-disable-next-line no-console
      console.error('[db] migrations failed', error);
      await closeDb();
      process.exit(1);
    });
}

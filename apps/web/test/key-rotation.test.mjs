import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * `MASTER_KEY` rotation encrypts again the columns `ENCRYPTED_COLUMNS` lists.
 * A column added to the schema without being listed there would stay on the old
 * key — and become unreadable the day `MASTER_KEY_PREVIOUS` is removed. Every
 * column whose name says it is encrypted must therefore be in the list.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..', '..');
// drizzle-orm is a dependency of the database package, not of the panel's tests.
const fromDb = createRequire(path.join(repoRoot, 'packages/db/package.json'));
const drizzle = await import(pathToFileURL(fromDb.resolve('drizzle-orm')).href);
const pgCore = await import(pathToFileURL(fromDb.resolve('drizzle-orm/pg-core')).href);
const { getTableColumns, getTableName, is } = drizzle;
const { PgTable } = pgCore;

describe('MASTER_KEY rotation', () => {
  it('knows every encrypted column of the schema', async () => {
    const schema = await import(path.join(repoRoot, 'packages/db/src/schema/index.ts'));
    const { ENCRYPTED_COLUMNS } = await import(
      path.join(repoRoot, 'packages/db/src/key-rotation.ts')
    );
    const listed = new Set(ENCRYPTED_COLUMNS.map((entry) => entry.name));

    const inSchema = [];
    for (const table of Object.values(schema)) {
      if (!is(table, PgTable)) continue;
      for (const column of Object.values(getTableColumns(table))) {
        if (/encrypt/.test(column.name)) inSchema.push(`${getTableName(table)}.${column.name}`);
      }
    }

    assert.ok(inSchema.length >= 10, `only ${inSchema.length} encrypted column(s) found`);
    assert.deepEqual(
      inSchema.filter((name) => !listed.has(name)),
      [],
      'encrypted columns missing from ENCRYPTED_COLUMNS',
    );
    assert.deepEqual(
      [...listed].filter((name) => !inSchema.includes(name)),
      [],
      'ENCRYPTED_COLUMNS lists a column the schema no longer has',
    );
  });
});

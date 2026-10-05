/* eslint-disable no-console -- a command-line tool speaks on the console */
import { assertMasterKey } from '@pupitre/core';
import {
  closeDb,
  keyRotationStatus,
  logAudit,
  rotateEncryptedValues,
  type KeyRotationStatus,
} from '@pupitre/db';

/**
 * `MASTER_KEY` rotation, from the command line.
 *
 *   crypto status
 *       Which key each encrypted value and each kept backup depends on.
 *
 *   crypto rotate [--yes]
 *       Encrypts again, under MASTER_KEY, everything still on a previous key.
 *       Without --yes, says what it would do and writes nothing.
 *
 * The procedure, in full:
 *   1. generate a new key: `openssl rand -hex 32`;
 *   2. in `.env`, the old one goes to `MASTER_KEY_PREVIOUS`, the new one to
 *      `MASTER_KEY`; restart the panel and the worker — everything stays
 *      readable, everything new is written under the new key;
 *   3. `crypto rotate --yes` encrypts again what was written before;
 *   4. `crypto status` says when `MASTER_KEY_PREVIOUS` can go: nothing left in
 *      the database, and no kept backup made under the old key.
 *
 * In Docker: `docker compose run --rm worker crypto <command>`. Nothing has to
 * be stopped: a value the panel changes meanwhile is not overwritten.
 */

/** A previous key by its fingerprint — and whether `MASTER_KEY_PREVIOUS` still holds it. */
function describeKey(status: KeyRotationStatus, keyId: string): string {
  if (keyId === 'v1') return 'the first format';
  return status.previousKeyIds.includes(keyId)
    ? `key ${keyId}`
    : `key ${keyId}, missing from MASTER_KEY_PREVIOUS — unreadable`;
}

function printStatus(status: KeyRotationStatus): void {
  console.log(`current key   ${status.currentKeyId}`);
  console.log(
    `previous keys ${status.previousKeyIds.length > 0 ? status.previousKeyIds.join(', ') : '(none)'}`,
  );
  console.log('');
  for (const column of status.columns) {
    const elsewhere = Object.entries(column.previous)
      .map(([keyId, count]) => `${count} on ${describeKey(status, keyId)}`)
      .join(', ');
    const unknown = column.unknown > 0 ? `, ${column.unknown} unreadable` : '';
    console.log(
      `${column.name.padEnd(42)} ${String(column.current).padStart(4)} current` +
        (elsewhere ? ` — ${elsewhere}` : '') +
        unknown,
    );
  }
  console.log('');
  const backups = Object.entries(status.backups);
  if (backups.length === 0) console.log('backups: none kept');
  for (const [keyId, count] of backups) {
    const which =
      keyId === status.currentKeyId
        ? 'the current key'
        : keyId === 'v1'
          ? 'a key their files do not name (made before rotation existed)'
          : describeKey(status, keyId);
    console.log(`backups: ${count} under ${which}`);
  }
  console.log('');
  const missing = (keyIds: string[]) =>
    [
      ...new Set(
        keyIds.filter(
          (keyId) =>
            keyId !== 'v1' &&
            keyId !== status.currentKeyId &&
            !status.previousKeyIds.includes(keyId),
        ),
      ),
    ].join(', ');
  const missingValues = missing(status.columns.flatMap((column) => Object.keys(column.previous)));
  const missingBackups = missing(Object.keys(status.backups));
  if (missingValues) {
    console.log(
      `✗ values are under ${missingValues}, which MASTER_KEY_PREVIOUS does not hold: ` +
        'put that key back in it, or they stay unreadable',
    );
  }
  if (missingBackups) {
    console.log(
      `✗ backups are under ${missingBackups}, which MASTER_KEY_PREVIOUS does not hold: ` +
        'put that key back in it to restore them',
    );
  }
  if (missingValues) return;
  if (status.previousRemovable) {
    console.log(
      status.previousKeyIds.length > 0
        ? '✓ nothing depends on MASTER_KEY_PREVIOUS any more: it can be removed from .env'
        : '✓ everything is under the current key',
    );
  } else if (!status.databaseDone) {
    console.log('→ values are still on a previous key: run `crypto rotate --yes`');
  } else if (!missingBackups) {
    console.log(
      '→ the database is done; kept backups still need MASTER_KEY_PREVIOUS — keep it until ' +
        'they expire, or delete them',
    );
  }
}

async function rotate(confirmed: boolean): Promise<void> {
  const report = await rotateEncryptedValues({ dryRun: !confirmed });
  let rotated = 0;
  let failed = 0;
  for (const column of report) {
    rotated += column.rotated;
    failed += column.failed.length;
    if (column.rotated + column.raced + column.failed.length === 0) continue;
    console.log(
      `${column.name.padEnd(42)} ${confirmed ? 'rotated' : 'to rotate'} ${column.rotated}` +
        (column.raced > 0 ? `, ${column.raced} changed meanwhile (run again)` : ''),
    );
    for (const failure of column.failed) {
      console.log(`  ✗ row ${failure.id}: ${failure.error}`);
    }
  }
  if (rotated + failed === 0) console.log('nothing to rotate: everything is under the current key');
  // A value no key opens cannot be encrypted again: it needs a key that is
  // missing from MASTER_KEY_PREVIOUS, or it was damaged.
  if (failed > 0) process.exitCode = 1;

  if (!confirmed) {
    if (rotated > 0) console.log('\ndry run — run again with --yes to write');
    return;
  }
  if (rotated + failed === 0) return;
  await logAudit({
    actorId: null,
    action: 'settings.master_key.rotated',
    resourceType: 'settings',
    after: {
      rotated,
      failed,
      columns: report.map((column) => ({ name: column.name, rotated: column.rotated })),
    },
  });
  console.log('');
  printStatus(await keyRotationStatus());
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  // The keys first: a missing or too short key, current or previous, stops here.
  assertMasterKey();
  switch (command) {
    case 'status':
      printStatus(await keyRotationStatus());
      return;
    case 'rotate':
      return rotate(args.includes('--yes'));
    default:
      console.log('usage: crypto status | crypto rotate [--yes]');
      process.exitCode = command ? 1 : 0;
  }
}

main()
  .catch((error: unknown) => {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => closeDb().catch(() => undefined));

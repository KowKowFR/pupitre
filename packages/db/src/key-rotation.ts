import {
  currentKeyId,
  encryptionKeyOf,
  isOnCurrentKey,
  previousKeyIds,
  reencrypt,
} from '@pupitre/core';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { getDb, type Database } from './client.js';
import {
  appSettings,
  applicationSecrets,
  backupDestinations,
  backups,
  monitors,
  notificationChannels,
  proxies,
  sourceConnections,
  targets,
} from './schema/index.js';

/**
 * `MASTER_KEY` rotation, on the database side.
 *
 * Every value encrypted under `MASTER_KEY` lives in one of the columns below.
 * Encrypting them again is reading each one with whichever key opens it —
 * current or previous —, then writing it back under the current key. A column
 * added without being listed here would stay on the old key, and would become
 * unreadable the day `MASTER_KEY_PREVIOUS` is removed: a test compares this list
 * with the schema (`encrypted` in the column's name).
 */
export type EncryptedColumn = {
  /** `table.column`, as `crypto status` prints it. */
  name: string;
  table: PgTable;
  id: AnyPgColumn;
  column: AnyPgColumn;
};

export const ENCRYPTED_COLUMNS: readonly EncryptedColumn[] = [
  {
    name: 'targets.encrypted_credential',
    table: targets,
    id: targets.id,
    column: targets.encryptedCredential,
  },
  {
    name: 'application_secrets.encrypted_value',
    table: applicationSecrets,
    id: applicationSecrets.id,
    column: applicationSecrets.encryptedValue,
  },
  {
    name: 'app_settings.ai_api_key_encrypted',
    table: appSettings,
    id: appSettings.id,
    column: appSettings.aiApiKeyEncrypted,
  },
  {
    name: 'app_settings.sso_client_secret_encrypted',
    table: appSettings,
    id: appSettings.id,
    column: appSettings.ssoClientSecretEncrypted,
  },
  {
    name: 'notification_channels.encrypted_secrets',
    table: notificationChannels,
    id: notificationChannels.id,
    column: notificationChannels.encryptedSecrets,
  },
  {
    name: 'monitors.webhook_url_encrypted',
    table: monitors,
    id: monitors.id,
    column: monitors.webhookUrlEncrypted,
  },
  {
    name: 'proxies.encrypted_secrets',
    table: proxies,
    id: proxies.id,
    column: proxies.encryptedSecrets,
  },
  {
    name: 'backup_destinations.encrypted_secrets',
    table: backupDestinations,
    id: backupDestinations.id,
    column: backupDestinations.encryptedSecrets,
  },
  {
    name: 'source_connections.private_key_encrypted',
    table: sourceConnections,
    id: sourceConnections.id,
    column: sourceConnections.privateKeyEncrypted,
  },
  {
    name: 'source_connections.token_encrypted',
    table: sourceConnections,
    id: sourceConnections.id,
    column: sourceConnections.tokenEncrypted,
  },
];

/** How many values of a column each key holds. */
export type ColumnKeyStatus = {
  name: string;
  /** Values encrypted under the current key, in the current format. */
  current: number;
  /** Per previous key's fingerprint; `v1` for the first format, which does not name its key. */
  previous: Record<string, number>;
  /** Values whose format is not recognized. */
  unknown: number;
};

export type KeyRotationStatus = {
  currentKeyId: string;
  previousKeyIds: string[];
  columns: ColumnKeyStatus[];
  /** Successful backups still on the destinations, per key; `v1` when the file does not say. */
  backups: Record<string, number>;
  /** Nothing in the database depends on a previous key any more. */
  databaseDone: boolean;
  /** Neither the database nor a kept backup needs `MASTER_KEY_PREVIOUS`. */
  previousRemovable: boolean;
};

async function encryptedValues(
  entry: EncryptedColumn,
  db: Database,
): Promise<Array<{ id: unknown; value: string }>> {
  const rows = await db
    .select({ id: entry.id, value: entry.column })
    .from(entry.table)
    .where(isNotNull(entry.column));
  return rows as Array<{ id: unknown; value: string }>;
}

/** Where each encrypted value stands, without decrypting anything. */
export async function keyRotationStatus(db: Database = getDb()): Promise<KeyRotationStatus> {
  const current = currentKeyId();
  const columns: ColumnKeyStatus[] = [];
  for (const entry of ENCRYPTED_COLUMNS) {
    const status: ColumnKeyStatus = { name: entry.name, current: 0, previous: {}, unknown: 0 };
    for (const { value } of await encryptedValues(entry, db)) {
      const info = encryptionKeyOf(value);
      if (info.version === 'v2' && info.keyId === current) status.current += 1;
      else if (info.version === 'v2')
        status.previous[info.keyId] = (status.previous[info.keyId] ?? 0) + 1;
      else if (info.version === 'v1') status.previous.v1 = (status.previous.v1 ?? 0) + 1;
      else status.unknown += 1;
    }
    columns.push(status);
  }

  const kept = await db
    .select({ keyId: backups.keyId, count: sql<number>`count(*)::int` })
    .from(backups)
    .where(eq(backups.status, 'success'))
    .groupBy(backups.keyId);
  const backupsByKey: Record<string, number> = {};
  for (const row of kept) backupsByKey[row.keyId ?? 'v1'] = row.count;

  const previous = previousKeyIds();
  const databaseDone = columns.every(
    (column) => Object.keys(column.previous).length === 0 && column.unknown === 0,
  );
  // A backup that does not name its key was made under the current key or one of
  // the previous ones: with no previous key, it can only be the current one.
  const backupsDone = Object.keys(backupsByKey).every(
    (keyId) => keyId === current || (keyId === 'v1' && previous.length === 0),
  );
  return {
    currentKeyId: current,
    previousKeyIds: previous,
    columns,
    backups: backupsByKey,
    databaseDone,
    previousRemovable: databaseDone && backupsDone,
  };
}

export type ColumnRotation = {
  name: string;
  /** Encrypted again under the current key. */
  rotated: number;
  /** Already on the current key. */
  unchanged: number;
  /** Changed by someone else meanwhile: left as is, the next pass takes it. */
  raced: number;
  /** Opened by no key: their row identifier, never their value. */
  failed: Array<{ id: string; error: string }>;
};

/**
 * Encrypts again, under the current key, every value that is not on it yet.
 *
 * Row by row, with a conditional write — `where column = <the value read>`: a
 * value changed in between by the panel (already under the current key, since
 * it writes with it) is not overwritten with the old content. Idempotent: a
 * second pass finds nothing to do. `dryRun` counts without writing.
 */
export async function rotateEncryptedValues(
  options: { dryRun?: boolean } = {},
  db: Database = getDb(),
): Promise<ColumnRotation[]> {
  const report: ColumnRotation[] = [];
  for (const entry of ENCRYPTED_COLUMNS) {
    const outcome: ColumnRotation = {
      name: entry.name,
      rotated: 0,
      unchanged: 0,
      raced: 0,
      failed: [],
    };
    for (const { id, value } of await encryptedValues(entry, db)) {
      if (isOnCurrentKey(value)) {
        outcome.unchanged += 1;
        continue;
      }
      let next: string;
      try {
        next = reencrypt(value);
      } catch (error) {
        outcome.failed.push({
          id: String(id),
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (options.dryRun) {
        outcome.rotated += 1;
        continue;
      }
      const written = await db
        .update(entry.table)
        .set({ [columnKey(entry)]: next })
        .where(and(eq(entry.id, id), eq(entry.column, value)))
        .returning({ id: entry.id });
      if (written.length === 1) outcome.rotated += 1;
      else outcome.raced += 1;
    }
    report.push(outcome);
  }
  return report;
}

/** The column's property name in its table, as `update().set()` expects it. */
function columnKey(entry: EncryptedColumn): string {
  const columns = entry.table as unknown as Record<string, unknown>;
  const key = Object.keys(columns).find((name) => columns[name] === entry.column);
  if (!key) throw new Error(`column ${entry.name} not found in its table`);
  return key;
}

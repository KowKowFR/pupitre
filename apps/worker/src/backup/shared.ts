import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { PassThrough, Transform, type Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { errorMessage, type UiLanguage } from '@pupitre/core';
import {
  createDecryptStream,
  createEncryptStream,
  withBackupKeys,
  expiredBackups,
  openBackupStore,
  type BackupRetention,
  type BackupStore,
} from '@pupitre/core/backup';
import {
  deleteBackupRecords,
  listRetainedBackups,
  pruneFailedBackups,
  resolveBackupDestination,
} from '@pupitre/db';
import { instanceLanguage } from '../language.js';
import { workerSay } from '../messages.js';

/**
 * What backup and restore share: opening the destination, placing an encrypted
 * piece, reading one back while verifying it, applying retention.
 */

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

export type OpenedStore = { id: string; name: string; store: BackupStore };

/** The active destination — or an existing backup's, even if disabled since. */
export async function openStore(destinationId?: string | null): Promise<OpenedStore> {
  const language = await instanceLanguage();
  const resolved = await resolveBackupDestination(destinationId ?? null);
  if (!resolved) {
    const say = workerSay(language);
    throw new BackupError(
      destinationId ? say('backup.destinationGone') : say('backup.noDestination'),
    );
  }
  return {
    id: resolved.id,
    name: resolved.name,
    store: openBackupStore(resolved.destination, language),
  };
}

/**
 * Places a piece: what `produce` writes is (compressed,) encrypted, then sent to
 * the destination, all as a stream. Returns the size and the hash of what was
 * **placed** — it is the one the restore checks again.
 *
 * Three things move together — production on the target, encryption, upload —
 * and the first that fails stops the other two: a failing upload does not let
 * the target write into the void, a failing command does not let a truncated
 * piece pass for good.
 */
export async function storePiece(
  store: BackupStore,
  key: string,
  produce: (sink: Writable) => Promise<void>,
  options: { gzip: boolean },
): Promise<{ bytes: number; sha256: string }> {
  const raw = new PassThrough();
  const out = new PassThrough();
  const hash = createHash('sha256');
  let bytes = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      bytes += chunk.length;
      callback(null, chunk);
    },
  });

  // The **first** error is the cause; the following ones are only its echo — an
  // unreachable destination closes the pipe, and the target then complains about
  // writing into a closed pipe. It is the first one we report.
  let cause: unknown;
  const first = (error: unknown) => {
    cause ??= error;
    return error instanceof Error ? error : new Error(errorMessage(error));
  };

  const encoding = (
    options.gzip
      ? pipeline(raw, createGzip({ level: 6 }), createEncryptStream(), tap, out)
      : pipeline(raw, createEncryptStream(), tap, out)
  ).catch((error: unknown) => {
    throw first(error);
  });
  const production = produce(raw).catch((error: unknown) => {
    raw.destroy(first(error));
    throw error;
  });
  const upload = store.put(key, out).catch((error: unknown) => {
    out.destroy(first(error));
    throw error;
  });

  const outcomes = await Promise.allSettled([production, encoding, upload]);
  if (outcomes.some((outcome) => outcome.status === 'rejected')) throw cause;
  return { bytes, sha256: hash.digest('hex') };
}

/**
 * Reads a piece back into a local file, decrypted, **verified**: the hash of
 * what was placed, then the encryption's tag. Nothing is applied before both
 * match.
 *
 * A piece made before rotation existed does not name its key: it is downloaded
 * again for each key that could have encrypted it (`withBackupKeys()`).
 */
export async function fetchPiece(
  store: BackupStore,
  key: string,
  expectedSha256: string,
  destination: string,
  language: UiLanguage,
): Promise<void> {
  const actual = await withBackupKeys(async (masterKeys) => {
    const source: Readable = await store.get(key);
    const hash = createHash('sha256');
    const tap = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(
      source,
      tap,
      createDecryptStream(masterKeys, language),
      createWriteStream(destination),
    );
    return hash.digest('hex');
  });
  if (actual !== expectedSha256) {
    throw new BackupError(
      workerSay(language)('backup.changed', { key, hash: actual.slice(0, 12) }),
    );
  }
}

/** How long the history keeps a failed backup. */
const FAILED_BACKUPS_KEPT_MS = 30 * 24 * 3600 * 1000;

/** Erases from the destination, then from the index, what retention no longer keeps. */
export async function applyRetention(
  store: BackupStore,
  scope: { kind: 'panel' } | { kind: 'application'; applicationId: string },
  destinationId: string,
  retention: BackupRetention,
  onLog: (line: string) => void,
): Promise<number> {
  const say = workerSay(await instanceLanguage());
  const retained = await listRetainedBackups(scope, destinationId);
  const expired = expiredBackups(retained, retention);
  const removed: string[] = [];
  for (const backup of expired) {
    try {
      await store.removePrefix(`${backup.location}/`);
      removed.push(backup.id);
    } catch (error) {
      // A failed deletion stays in the index: it will be retried next time.
      onLog(
        say('backup.retentionFailed', { location: backup.location, error: errorMessage(error) }),
      );
    }
  }
  await deleteBackupRecords(removed);
  if (removed.length > 0) onLog(say('backup.retentionDone', { count: removed.length }));
  await pruneFailedBackups(scope, new Date(Date.now() - FAILED_BACKUPS_KEPT_MS));
  return removed.length;
}

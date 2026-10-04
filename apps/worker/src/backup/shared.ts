import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { PassThrough, Transform, type Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { DEFAULT_UI_LANGUAGE, errorMessage, type UiLanguage } from '@pupitre/core';
import {
  createDecryptStream,
  createEncryptStream,
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
 * Ce que partagent sauvegarde et restauration : ouvrir la destination,
 * déposer un morceau chiffré, en relire un en le vérifiant, appliquer la
 * rétention.
 */

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

export type OpenedStore = { id: string; name: string; store: BackupStore };

/** La destination active — ou celle d'une sauvegarde existante, même désactivée depuis. */
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
 * Dépose un morceau : ce que `produce` écrit est (compressé,) chiffré, puis
 * envoyé à la destination, le tout en flux. Rend la taille et l'empreinte de ce
 * qui a été **déposé** — c'est elle que la restauration revérifie.
 *
 * Trois choses avancent ensemble — la production sur la cible, le chiffrement,
 * l'envoi — et la première qui échoue arrête les deux autres : un envoi qui
 * tombe ne laisse pas la cible écrire dans le vide, une commande qui échoue ne
 * laisse pas un morceau tronqué passer pour bon.
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

  // La **première** erreur est la cause ; les suivantes n'en sont que l'écho —
  // une destination injoignable ferme le tube, et la cible se plaint alors
  // d'écrire dans un tube fermé. C'est la première qu'on rapporte.
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
 * Relit un morceau dans un fichier local, déchiffré, **vérifié** : l'empreinte
 * de ce qui a été déposé, puis l'étiquette du chiffrement. Rien n'est appliqué
 * avant que les deux concordent.
 */
export async function fetchPiece(
  store: BackupStore,
  key: string,
  expectedSha256: string,
  destination: string,
  language: UiLanguage = DEFAULT_UI_LANGUAGE,
): Promise<void> {
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
    createDecryptStream(undefined, language),
    createWriteStream(destination),
  );
  const actual = hash.digest('hex');
  if (actual !== expectedSha256) {
    throw new BackupError(
      workerSay(language)('backup.changed', { key, hash: actual.slice(0, 12) }),
    );
  }
}

/** Combien de temps l'historique garde une sauvegarde en échec. */
const FAILED_BACKUPS_KEPT_MS = 30 * 24 * 3600 * 1000;

/** Efface de la destination, puis de l'index, ce que la rétention ne garde plus. */
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
      // Une suppression ratée reste dans l'index : elle sera retentée à la prochaine.
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

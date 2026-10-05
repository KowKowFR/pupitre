import { createCipheriv, createDecipheriv, randomBytes, type DecipherGCM } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';
import { backupMasterKeys, deriveBackupKey, keyIdOf } from '../crypto.js';
import type { UiLanguage } from '../i18n.js';
import { backupSay } from './messages.js';

/**
 * The format of a backup file, `.pupb`:
 *
 *   header    "PUPB", version (1 byte) = 2, key (4), salt (16), nonce (12)
 *   body      AES-256-GCM, the header as associated data
 *   end       the authentication tag (16)
 *
 * `key` is the fingerprint of the `MASTER_KEY` the file's key was drawn from
 * (`keyIdOf()`): after a rotation, the reader picks the right one among
 * `MASTER_KEY` and `MASTER_KEY_PREVIOUS`. Version 1, without it, is still read:
 * its key is tried in turn (`withBackupKeys()`).
 *
 * Encrypted **as a stream**: an archive of several gigabytes never goes whole
 * through memory. The downside of streaming GCM: authenticity is only known at
 * the last byte. A restore therefore downloads and verifies **before** applying
 * anything — a tampered file is refused, never half restored.
 */

const MAGIC = Buffer.from('PUPB', 'ascii');
const VERSION = 2;
const KEY_ID_BYTES = 4;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** The header's size in each version: the key's fingerprint came with version 2. */
const HEADER_BYTES: Record<number, number> = {
  1: MAGIC.length + 1 + SALT_BYTES + IV_BYTES,
  2: MAGIC.length + 1 + KEY_ID_BYTES + SALT_BYTES + IV_BYTES,
};
/** The header of the files written today. */
export const BACKUP_HEADER_BYTES = HEADER_BYTES[VERSION] as number;

export class BackupFormatError extends Error {
  constructor(
    message: string,
    /** `auth`: the tag does not match — a tampered file, or another key. */
    readonly reason: 'format' | 'truncated' | 'auth' | 'unknownKey' = 'format',
    /** The file's format version, once its header has been read. */
    readonly formatVersion: number | null = null,
  ) {
    super(message);
    this.name = 'BackupFormatError';
  }
}

/**
 * Runs a decryption — one pass over the file — until it is not a key problem.
 * A version 2 file names its key: one pass is enough. A version 1 file does not:
 * it is read with the first key, and on an authentication failure, again with
 * the next one. `attempt` receives the keys in the order to use them.
 */
export async function withBackupKeys<T>(
  attempt: (masterKeys: readonly string[]) => Promise<T>,
  masterKeys: readonly string[] = backupMasterKeys(),
): Promise<T> {
  for (let index = 0; ; index += 1) {
    const ordered = [...masterKeys.slice(index), ...masterKeys.slice(0, index)];
    try {
      return await attempt(ordered);
    } catch (error) {
      const anotherKey =
        error instanceof BackupFormatError &&
        error.reason === 'auth' &&
        error.formatVersion === 1 &&
        index + 1 < masterKeys.length;
      if (!anotherKey) throw error;
    }
  }
}

export function createEncryptStream(
  masterKey: string | undefined = process.env.MASTER_KEY,
): Transform {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const keyId = Buffer.from(keyIdOf(masterKey as string), 'hex');
  const header = Buffer.concat([MAGIC, Buffer.from([VERSION]), keyId, salt, iv]);
  const cipher = createCipheriv('aes-256-gcm', deriveBackupKey(salt, masterKey), iv);
  cipher.setAAD(header);
  let started = false;

  return new Transform({
    transform(chunk: Buffer, _encoding, callback: TransformCallback) {
      if (!started) {
        started = true;
        this.push(header);
      }
      callback(null, cipher.update(chunk));
    },
    flush(callback: TransformCallback) {
      if (!started) this.push(header);
      this.push(cipher.final());
      callback(null, cipher.getAuthTag());
    },
  });
}

/**
 * Decrypts as a stream. The last sixteen bytes are held back until the end: it
 * is the tag. A wrong tag — truncated file, tampered with, or a different
 * `MASTER_KEY` — fails the stream at the last moment, as a `BackupFormatError`.
 */
export function createDecryptStream(
  masterKeys: string | readonly string[] | undefined,
  language: UiLanguage,
): Transform {
  const say = backupSay(language);
  const keys =
    masterKeys === undefined
      ? backupMasterKeys()
      : typeof masterKeys === 'string'
        ? [masterKeys]
        : masterKeys;
  let header: Buffer = Buffer.alloc(0);
  let decipher: DecipherGCM | null = null;
  let version: number | null = null;
  let held: Buffer = Buffer.alloc(0);

  return new Transform({
    transform(chunk: Buffer, _encoding, callback: TransformCallback) {
      try {
        let data = chunk;
        if (!decipher) {
          header = Buffer.concat([header, data]);
          if (header.length < MAGIC.length + 1) return callback();
          if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
            throw new BackupFormatError(say('format.notPupitre'));
          }
          const declared = header[MAGIC.length] as number;
          const size = HEADER_BYTES[declared];
          if (size === undefined) {
            throw new BackupFormatError(
              say('format.unknownVersion', { version: String(declared) }),
            );
          }
          if (header.length < size) return callback();
          data = header.subarray(size);
          header = header.subarray(0, size);
          version = declared;

          let offset = MAGIC.length + 1;
          let masterKey: string | undefined = keys[0];
          if (declared >= 2) {
            const keyId = header.subarray(offset, offset + KEY_ID_BYTES).toString('hex');
            offset += KEY_ID_BYTES;
            masterKey = keys.find((candidate) => keyIdOf(candidate) === keyId);
            if (masterKey === undefined) {
              throw new BackupFormatError(say('format.unknownKey', { keyId }), 'unknownKey', 2);
            }
          }
          const salt = header.subarray(offset, offset + SALT_BYTES);
          const iv = header.subarray(offset + SALT_BYTES);
          decipher = createDecipheriv('aes-256-gcm', deriveBackupKey(salt, masterKey), iv);
          decipher.setAAD(header);
        }
        const combined = Buffer.concat([held, data]);
        const usable = Math.max(0, combined.length - TAG_BYTES);
        held = combined.subarray(usable);
        callback(null, usable > 0 ? decipher.update(combined.subarray(0, usable)) : undefined);
      } catch (error) {
        callback(error as Error);
      }
    },
    flush(callback: TransformCallback) {
      if (!decipher || held.length !== TAG_BYTES) {
        return callback(new BackupFormatError(say('format.truncated'), 'truncated', version));
      }
      try {
        decipher.setAuthTag(held);
        callback(null, decipher.final());
      } catch {
        callback(new BackupFormatError(say('format.authFailed'), 'auth', version));
      }
    },
  });
}

/** Encrypts short content — the manifest. */
export async function encryptBuffer(plain: Buffer, masterKey?: string): Promise<Buffer> {
  return collect(createEncryptStream(masterKey), plain);
}

export async function decryptBuffer(
  sealed: Buffer,
  masterKeys: string | readonly string[] | undefined,
  language: UiLanguage,
): Promise<Buffer> {
  const keys =
    masterKeys === undefined
      ? backupMasterKeys()
      : typeof masterKeys === 'string'
        ? [masterKeys]
        : masterKeys;
  return withBackupKeys((ordered) => collect(createDecryptStream(ordered, language), sealed), keys);
}

function collect(transform: Transform, input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    transform.on('data', (chunk: Buffer) => chunks.push(chunk));
    transform.on('end', () => resolve(Buffer.concat(chunks)));
    transform.on('error', reject);
    transform.end(input);
  });
}

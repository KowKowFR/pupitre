import { createCipheriv, createDecipheriv, randomBytes, type DecipherGCM } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';
import { deriveBackupKey } from '../crypto.js';
import type { UiLanguage } from '../i18n.js';
import { backupSay } from './messages.js';

/**
 * The format of a backup file, `.pupb`:
 *
 *   header    "PUPB", version (1 byte), salt (16), nonce (12)
 *   body      AES-256-GCM, the header as associated data
 *   end       the authentication tag (16)
 *
 * Encrypted **as a stream**: an archive of several gigabytes never goes whole
 * through memory. The downside of streaming GCM: authenticity is only known at
 * the last byte. A restore therefore downloads and verifies **before** applying
 * anything — a tampered file is refused, never half restored.
 */

const MAGIC = Buffer.from('PUPB', 'ascii');
const VERSION = 1;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const BACKUP_HEADER_BYTES = MAGIC.length + 1 + SALT_BYTES + IV_BYTES;

export class BackupFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupFormatError';
  }
}

export function createEncryptStream(masterKey?: string): Transform {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const header = Buffer.concat([MAGIC, Buffer.from([VERSION]), salt, iv]);
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
  masterKey: string | undefined,
  language: UiLanguage,
): Transform {
  const say = backupSay(language);
  let header: Buffer = Buffer.alloc(0);
  let decipher: DecipherGCM | null = null;
  let held: Buffer = Buffer.alloc(0);

  return new Transform({
    transform(chunk: Buffer, _encoding, callback: TransformCallback) {
      try {
        let data = chunk;
        if (!decipher) {
          header = Buffer.concat([header, data]);
          if (header.length < BACKUP_HEADER_BYTES) return callback();
          data = header.subarray(BACKUP_HEADER_BYTES);
          header = header.subarray(0, BACKUP_HEADER_BYTES);
          if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
            throw new BackupFormatError(say('format.notPupitre'));
          }
          if (header[MAGIC.length] !== VERSION) {
            throw new BackupFormatError(
              say('format.unknownVersion', { version: String(header[MAGIC.length]) }),
            );
          }
          const salt = header.subarray(MAGIC.length + 1, MAGIC.length + 1 + SALT_BYTES);
          const iv = header.subarray(MAGIC.length + 1 + SALT_BYTES);
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
        return callback(new BackupFormatError(say('format.truncated')));
      }
      try {
        decipher.setAuthTag(held);
        callback(null, decipher.final());
      } catch {
        callback(new BackupFormatError(say('format.authFailed')));
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
  masterKey: string | undefined,
  language: UiLanguage,
): Promise<Buffer> {
  return collect(createDecryptStream(masterKey, language), sealed);
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
